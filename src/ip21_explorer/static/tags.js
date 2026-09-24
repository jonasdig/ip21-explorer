/* Tags on a tab: adding and removing, units and descriptions, and the one
   setter every tag setting goes through. */

import {
  apiGetDescription, apiGetMaps, apiGetUnit, ensureFavorites, orderedMaps,
} from "./api.js";
import { renderChart } from "./chart.js";
import { isComputed } from "./computed.js";
import { PALETTE } from "./constants.js";
import { loadData, rebuildJoined, recomputeFormulas } from "./data.js";
import { ensureNavData, renderNavigator } from "./navigator.js";
import { positionScooters } from "./scooters.js";
import {
  activeTab, byUid, newUid, normalizeInterval, normalizeTagName,
  reqName, rt, saveState, state,
} from "./state.js";
import { renderTagTable, revealTagRow } from "./tag-table.js";
import { enforceLiveGuard } from "./timerange.js";
import { renderToolbar } from "./toolbar.js";
import { showError, showNotice } from "./util.js";

// Display name. Several tags may share a reqName (same tag, same map, e.g.
// straight after a duplicate), so those get an ordinal to tell them apart.
export function tagLabel(tab, tag) {
  // A formula is named by the short description when it has one - the
  // expression is the definition, not a label - and never gets an ordinal:
  // two identical formulas are two deliberate rows, not twins on one tag.
  if (isComputed(tag)) return (tag.description || "").trim() || tag.name.replace(/^=\s*/, "");
  const name = reqName(tag);
  const twins = tab.tags.filter((t) => reqName(t) === name);
  if (twins.length < 2) return name;
  return `${name} #${twins.indexOf(tag) + 1}`;
}

// What the readout boxes show, per the label mode. Falls back to the name
// when a tag has no description, so a readout row is never blank. The table
// shows the bare tag.name instead: that cell is editable.
// tagLabel() stays the machine-facing name, for CSV headers and exports.
export function tagDisplay(tab, tag) {
  const name = tagLabel(tab, tag);
  // The label modes are about a tag's description from the historian; a
  // formula's description is its name, so showing both would say it twice.
  if (isComputed(tag)) return name;
  const desc = (tag.description || "").trim();
  if (!desc || state.labelMode === "tag") return name;
  return state.labelMode === "desc" ? desc : `${name} \u00b7 ${desc}`;
}

export function nextColor(tab) {
  const used = new Set(tab.tags.map((t) => t.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[tab.tags.length % PALETTE.length];
}

// Fills in a tag's unit once its map is known. Map units are not fetched in
// bulk (a live tag can have 30+ maps, one request each), so this asks for the
// selected map only, and the answer is then stored on the tag.
//
// _unitChecked stops a tag the historian has no unit for from asking again on
// every live tick; applyMapUnit() re-arms it when the map changes.
async function ensureUnit(tab, tag) {
  if (tag.unit || tag._unitChecked || isComputed(tag)) return;
  tag._unitChecked = true; // set before awaiting: loadData may call again
  const unit = await apiGetUnit(reqName(tag)).catch(() => "");
  if (!unit || tag.unit) return;
  tag.unit = unit;
  renderTags();
  positionScooters(); // readout boxes are built with the unit baked in
  saveState();
}

// Descriptions come with a search hit only where that was cheap (Aspen fills
// in the first few), and share links drop them to stay short, so the label
// modes ask for the ones that are missing - one request per tag, once.
//
// A description belongs to the tag, not the map, so the copies of one tag on
// different maps (a controller's PV, SP and OUT) share a single lookup.
async function fetchDescription(tab, name) {
  for (const tag of tab.tags) {
    if (tag.name === name) tag._descChecked = true; // set before awaiting
  }
  const description = await apiGetDescription(name).catch(() => "");
  if (!description) return;
  let filled = false;
  for (const tag of tab.tags) {
    if (tag.name === name && !tag.description) {
      tag.description = description;
      filled = true;
    }
  }
  if (!filled) return;
  renderTags();
  positionScooters();
  saveState();
}

// Only worth paying for while a description is actually on screen.
export function ensureDescriptions(tab) {
  if (state.labelMode === "tag") return;
  const wanted = new Set();
  for (const tag of tab.tags) {
    if (!tag.description && !tag._descChecked && !isComputed(tag)) wanted.add(tag.name);
  }
  for (const name of wanted) fetchDescription(tab, name);
}

// Tags can arrive with no unit at all - Aspen leaves it off search hits
// because each one costs a request - and only the source can fill it in.
// Every tab passes through loadData(), so that is where the gaps get closed.
export function ensureUnits(tab) {
  for (const tag of tab.tags) ensureUnit(tab, tag);
}

// The unit belongs to the selected map, so the two are set together and the
// on-demand lookup is re-armed for the new map.
function applyMapUnit(tag, mapInfo) {
  tag.unit = (mapInfo && mapInfo.unit) || "";
  tag._unitChecked = false;
  // A unit typed over the old map's does not describe the new one.
  tag.unitEdited = false;
}

// The first map not yet plotted for this tag name, or undefined when they are
// all taken. maps[0] is the default and is stored as map = null.
function nextFreeMap(tab, name, maps) {
  const used = new Set(
    tab.tags.filter((t) => t.name === name).map((t) => t.map || (maps[0] || {}).name)
  );
  const free = orderedMaps(maps).find((m) => !used.has(m.name));
  return free ? free.name : undefined;
}

// Moves a copy onto a record map that is not plotted yet, so that adding or
// duplicating a tag compares maps instead of drawing the same trace twice.
// The map list is often not cached (shared links and the live Aspen source
// carry none), so it is looked up when missing.
async function assignFreeMap(tab, tag) {
  await ensureFavorites();
  if (!tag.maps.length) {
    const sibling = tab.tags.find(
      (t) => t !== tag && t.name === tag.name && t.maps.length
    );
    tag.maps = sibling
      ? sibling.maps.slice()
      : await apiGetMaps(tag.name).catch(() => []);
    tag._mapsChecked = true;
  }
  if (!tag.maps.length) return "unknown"; // free-text map, let the user type one
  const free = nextFreeMap(tab, tag.name, tag.maps);
  if (!free) return "exhausted";
  tag.map = free;
  applyMapUnit(tag, tag.maps.find((m) => m.name === free));
  ensureUnit(tab, tag);
  return "assigned";
}

// Places already-built tags in the tab, remapping any that would otherwise
// duplicate a trace, and returns the ones that made it in.
//
// The batch is the primitive rather than the single insert because loadData()
// groups tags by sample|interval and issues one request per group: adding N
// tags one at a time would fire N loads and let the abort guard throw all but
// the last away, which is pure waste against a slow historian.
export async function insertTags(tab, tags, at) {
  const added = [], exhausted = [], unknown = [];
  let index = at ?? tab.tags.length;
  for (const tag of tags) {
    // nextColor() and assignFreeMap() both read the current tab.tags, so each
    // tag has to be in place before the next one picks a colour and a map.
    const duplicate = !isComputed(tag) && tab.tags.some((t) => reqName(t) === reqName(tag));
    tag.color = nextColor(tab);
    tab.tags.splice(index++, 0, tag);
    if (!tab.axisUid) tab.axisUid = tag.uid;
    if (duplicate) {
      const outcome = await assignFreeMap(tab, tag);
      if (outcome === "exhausted") {
        tab.tags.splice(--index, 1);
        exhausted.push(tag.name);
        continue;
      }
      if (outcome === "unknown") unknown.push(tag.name);
    }
    added.push(tag);
  }
  renderTags();
  if (added.length) {
    revealTagRow(added[0].uid); // a long table hides where they landed
    loadData(tab);
    saveState();
  }
  if (exhausted.length) {
    showError(`${exhausted.join(", ")} already plotted with every map`);
  }
  // No map list to choose from, so one has to be typed into the tag table.
  if (unknown.length) {
    showNotice(`${unknown.join(", ")}: could not list record maps - pick one in the tag table`);
  }
  return added;
}

export async function duplicateTag(uid) {
  const tab = activeTab();
  const src = byUid(tab, uid);
  if (!src) return;
  const copy = { ...src, uid: newUid(), maps: src.maps.slice() };
  await insertTags(tab, [copy], tab.tags.indexOf(src) + 1);
}

export function removeTags(tab, uids) {
  const dropped = new Set(uids);
  const gone = tab.tags.filter((t) => dropped.has(t.uid));
  if (!gone.length) return;
  tab.tags = tab.tags.filter((t) => !dropped.has(t.uid));
  if (dropped.has(tab.axisUid)) {
    tab.axisUid = tab.tags.length ? tab.tags[0].uid : null;
  }
  renderTags();
  const r = rt(tab);
  if (r.raw) { // drop locally, no refetch needed
    for (const tag of gone) delete r.raw[tag.uid];
    // A formula that used one of them now refers to a tag with no row, which
    // the server reads on its own from here on.
    rebuildJoined(tab, r);
    if (tab.tags.some(isComputed)) recomputeFormulas(tab);
  }
  renderChart();
  renderNavigator();
  saveState();
}

export function removeTag(uid) {
  removeTags(activeTab(), [uid]);
}

// The settings table is the only view of the tag list, so rendering the tags
// is rendering the table. Kept as its own name because half the app calls it.
export function renderTags() {
  renderTagTable();
}

// Maps cost a request per tag, so they are fetched the first time a row that
// can show them is drawn.
export function ensureMaps(tab, tag) {
  if (tag.maps.length || tag._mapsChecked || isComputed(tag)) return;
  tag._mapsChecked = true;
  apiGetMaps(tag.name).then((maps) => {
    if (!maps.length) return;
    tag.maps = maps;
    // Sources that don't report units up front (Aspen) supply them here.
    const current = maps.find((m) => m.name === (tag.map || maps[0].name));
    if (!tag.unit) {
      if (current && current.unit) tag.unit = current.unit;
      else ensureUnit(tab, tag);
    }
    saveState();
    renderTags();
  }).catch(() => {});
}

// Tag order decides how the stacked axis gutter piles its values and the order
// of the scooter readouts, so it is worth being able to group related tags.
export function moveTag(tab, from, to) {
  if (to < 0 || to >= tab.tags.length || from === to) return;
  const [tag] = tab.tags.splice(from, 1);
  tab.tags.splice(to, 0, tag);
  // r.tagOrder and the joined data columns are derived from tab.tags, so
  // without this the chart would keep drawing each series against its old
  // column - every trace showing the wrong tag's data.
  // Row order decides which row a bare reference in a formula resolves to,
  // so the values can change even though nothing was fetched.
  rebuildJoined(tab, rt(tab));
  if (tab.tags.some(isComputed)) recomputeFormulas(tab);
  renderTags();
  renderChart();
  // navTag() falls back to the first tag when axisUid does not resolve, so
  // reordering can hand the band to someone else.
  ensureNavData(tab);
  renderNavigator();
  saveState();
}

// Every tag setting goes through here, so the settings table and anything
// else that edits a tag agree on what a change actually costs:
// colour and scale only redraw, while sampling, interval and map mean a new
// request to the historian.
export function setTagFields(tab, tag, patch) {
  let redraw = false, refetch = false, recalc = false, live = false, nav = false;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "visible") {
      tag.visible = value !== false;
      redraw = true;
    } else if (key === "color") {
      tag.color = value;
      // The navigator band draws from a snapshot of the colour, taken when its
      // context was fetched, so a recolour has to be handed to it directly.
      const r = rt(tab);
      if (r.navTagUid === tag.uid) r.navColor = value;
      redraw = nav = true;
    } else if (key === "step") {
      tag.step = !!value;
      // Stepped means "hold the last value", which is also how a formula must
      // read this tag between its samples.
      if (tab.tags.some(isComputed)) recalc = true;
      redraw = true;
    } else if (key === "min" || key === "max") {
      tag[key] = Number.isFinite(value) ? value : null;
      redraw = true;
    } else if (key === "unit") {
      const text = String(value).trim();
      tag.unit = text;
      if (!isComputed(tag)) {
        // Typed over the historian's, which can be wrong. Emptying the field
        // hands it back: the lookup is re-armed and fills it in again.
        tag.unitEdited = !!text;
        if (!text) { tag._unitChecked = false; ensureUnit(tab, tag); }
      }
      redraw = true;
    } else if (key === "description") {
      const text = String(value).trim();
      tag.description = text;
      if (!isComputed(tag)) {
        tag.descEdited = !!text;
        if (!text) fetchDescription(tab, tag.name);
      }
      // The description is a formula's name, and another formula may refer to
      // it, so renaming one can make or break the other.
      if (tab.tags.some(isComputed)) recalc = true;
      redraw = true;
    } else if (key === "lineStyle" || key === "lineWidth" || key === "points" ||
               key === "symbol" || key === "pointColor") {
      // How the trace is drawn: nothing to fetch, nothing to recompute.
      tag[key] = value;
      redraw = true;
    } else if (key === "sample") {
      tag.sample = value;
      refetch = true;
    } else if (key === "interval") {
      tag.interval = normalizeInterval(value);
      refetch = live = true;
    } else if (key === "name") {
      const next = normalizeTagName(String(value).trim());
      if (!next || next === tag.name) continue;
      const wasComputed = isComputed(tag);
      tag.name = next;
      if (!isComputed(tag)) {
        // A plain tag's unit, description and maps all described the old name.
        // A formula's are the user's own words and survive an edit.
        tag.description = wasComputed ? tag.description : "";
        tag.unit = wasComputed ? tag.unit : "";
        tag.descEdited = wasComputed && !!tag.description;
        tag.unitEdited = wasComputed && !!tag.unit;
        tag.maps = [];
        tag.map = null;
        tag._mapsChecked = tag._unitChecked = tag._descChecked = false;
      }
      tag._error = null;
      // Drop the old trace now rather than at the next answer: leaving it up
      // would read as if the new name had worked.
      const r = rt(tab);
      if (r.raw) {
        delete r.raw[tag.uid];
        // An edited formula is computed again over the window in hand; the
        // server has the tags it needs cached, or reads the new ones.
        if (isComputed(tag)) {
          rebuildJoined(tab, r);
          redraw = recalc = true;
          continue;
        }
        rebuildJoined(tab, r);
        redraw = true;
      }
      refetch = true;
    } else if (key === "map") {
      // maps[0] is the default and is stored as null, so the two spellings of
      // "the default map" cannot read as two different traces.
      const defaultName = tag.maps.length ? tag.maps[0].name : "";
      tag.map = !value || value === defaultName ? null : value;
      applyMapUnit(tag, tag.maps.find((m) => m.name === (tag.map || defaultName)));
      ensureUnit(tab, tag);
      refetch = true;
    }
  }
  // A manually pinned interval decides whether live is allowed at all.
  if (live) { enforceLiveGuard(tab); renderToolbar(); }
  renderTags();
  // A redraw and a refetch together only happen on a rename, which has just
  // taken the old trace away: everything else leaves the old data on screen
  // until the answer lands, which is what keeps a sampling change from
  // flickering.
  if (redraw) renderChart();
  if (refetch) loadData(tab);
  else if (recalc) recomputeFormulas(tab);
  if (nav) renderNavigator();
  saveState();
}

export function setTagField(tab, tag, key, value) {
  setTagFields(tab, tag, { [key]: value });
}

export function autoScale(tab, tag) {
  setTagFields(tab, tag, { min: null, max: null });
}

// Which tag the navigator band follows. Stored as axisUid, the name it had
// when it also chose the plot's gridlines, because saved plots carry it.
export function setNavTag(tab, uid) {
  tab.axisUid = uid;
  renderTags();
  ensureNavData(tab);
  renderNavigator();
  saveState();
}
