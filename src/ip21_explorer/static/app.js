/* IP21 Explorer frontend: tabs, tag search, uPlot chart, scooters, save/open. */
"use strict";

import {
  apiGetDescription, apiGetMaps, apiGetUnit, apiSearchTags, ensureFavorites,
  favoriteMaps, orderedMaps, saveFavorites,
} from "./api.js";
import {
  drawStackedGrid, drawStackedLabels, stackedGutter,
} from "./axis-gutter.js";
import {
  INTERVALS, MAX_SPAN_S, MIN_SPAN_S, PALETTE, SAMPLES,
} from "./constants.js";
import { loadData, rebuildJoined } from "./data.js";
import {
  hideContextMenu, openSwatchMenu, showContextMenu, showPillMenu,
} from "./menu.js";
import { ensureNavData, initNavigator, renderNavigator } from "./navigator.js";
import { initDialogs } from "./plots.js";
import {
  addScooterAt, forgetScooterEls, mountScooters, positionScooters,
} from "./scooters.js";
import { initSearch } from "./search.js";
import { openSharedPlot } from "./share.js";
import {
  activeTab, byUid, loadState, makeTag, newUid, normalizeInterval,
  persistState, reqName, rt, saveState, saveTimer, state,
} from "./state.js";
import { initTabbar, renderTabs } from "./tabs.js";
import { enforceLiveGuard, setAbsoluteRange } from "./timerange.js";
import { initToolbar, renderToolbar } from "./toolbar.js";
import {
  $, el, fmtTime, fmtVal, intervalLabel, nearestValue, pad2, showError,
  showNotice,
} from "./util.js";

export let chart = null;           // uPlot instance for the active tab

// Display name. Several tags may share a reqName (same tag, same map, e.g.
// straight after a duplicate), so those get an ordinal to tell them apart.
export function tagLabel(tab, tag) {
  const name = reqName(tag);
  const twins = tab.tags.filter((t) => reqName(t) === name);
  if (twins.length < 2) return name;
  return `${name} #${twins.indexOf(tag) + 1}`;
}

// What the tag bar and the readout boxes show, per the label mode. Falls back
// to the name when a tag has no description, so a row is never blank.
// tagLabel() stays the machine-facing name, for CSV headers and exports.
export function tagDisplay(tab, tag) {
  const name = tagLabel(tab, tag);
  const desc = (tag.description || "").trim();
  if (!desc || state.labelMode === "tag") return name;
  return state.labelMode === "desc" ? desc : `${name} \u00b7 ${desc}`;
}

function chartSize() {
  const wrap = $("chart-wrap");
  return { width: Math.max(200, wrap.clientWidth - 8), height: Math.max(150, wrap.clientHeight - 8) };
}

function scaleRangeFn(tag) {
  return (u, min, max) => {
    if (tag.min != null && tag.max != null) return [tag.min, tag.max];
    if (min == null || max == null) return [0, 100];
    const pad = (max - min) * 0.07 || Math.abs(max || 1) * 0.05 || 1;
    return [tag.min != null ? tag.min : min - pad, tag.max != null ? tag.max : max + pad];
  };
}

// 24h clock tick labels; a tick where the local date changes (and the first
// tick) carries the date on a second line.
function xAxisValues(u, splits, axisIdx, foundSpace, foundIncr) {
  let prevDay = null;
  return splits.map((t) => {
    const d = new Date(t * 1000);
    const dayLabel = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
    let label;
    if (foundIncr >= 86400) {
      label = dayLabel;
    } else {
      label = foundIncr < 60
        ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
        : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      if (prevDay === null || d.getDate() !== prevDay) label += `\n${dayLabel}`;
    }
    prevDay = d.getDate();
    return label;
  });
}

function gridTag(tab, r) {
  const byAxis = byUid(tab, tab.axisUid);
  if (byAxis && r.tagOrder.includes(byAxis.uid)) return byAxis;
  const first = tab.tags.find((t) => r.tagOrder.includes(t.uid));
  return first || null;
}

function makeOpts(tab, r) {
  const size = chartSize();
  const grid = gridTag(tab, r);

  const scales = { x: { time: true, range: [r.start, r.end] } };
  const series = [{}];
  for (const uid of r.tagOrder) {
    const tag = byUid(tab, uid);
    scales[uid] = { range: scaleRangeFn(tag) };
    series.push({
      label: reqName(tag),
      stroke: tag.color,
      width: 1.6,
      scale: uid,
      spanGaps: true,
      show: tag.visible !== false,
      points: { show: false },
      // Step rendering holds the previous value until the next sample,
      // which is the honest shape for discrete/status tags.
      paths: tag.step ? uPlot.paths.stepped({ align: 1 }) : undefined,
    });
  }

  const axes = [{
    stroke: "#8b93a3",
    grid: { stroke: "#232834", width: 1 },
    ticks: { stroke: "#2e3442" },
    values: xAxisValues,
  }];
  let padding;
  if (tab.axisMode === "stacked") {
    padding = [10, 12, 0, stackedGutter(tab, r)];
  } else {
    const axisTags = tab.axisMode === "single"
      ? (grid ? [grid] : [])
      : tab.tags.filter((t) => t.visible !== false && r.tagOrder.includes(t.uid));
    for (const tag of axisTags) {
      const isGrid = grid && tag.uid === grid.uid;
      axes.push({
        scale: tag.uid,
        stroke: tag.color,
        grid: { show: isGrid, stroke: "#232834", width: 1 },
        ticks: { stroke: "#2e3442" },
        size: tab.axisMode === "single" ? 68 : 54,
      });
    }
  }

  return {
    width: size.width,
    height: size.height,
    scales,
    series,
    axes,
    padding,
    legend: { show: false },
    cursor: {
      drag: { x: true, y: false, setScale: false },
      points: { size: 6 },
      // uPlot's built-in dblclick resets the zoom; we use dblclick for scooters.
      bind: { dblclick: () => null },
    },
    hooks: {
      setSelect: [onSelectZoom],
      setCursor: [onCursorMove],
      drawClear: [drawStackedGrid],
      draw: [() => positionScooters(), drawStackedLabels],
      ready: [onChartReady],
    },
  };
}

export function renderChart() {
  const tab = activeTab();
  const r = rt(tab);
  const target = $("chart");

  if (chart) { chart.destroy(); chart = null; }
  forgetScooterEls();
  target.innerHTML = "";
  $("hover-box").classList.add("hidden");

  if (!tab.tags.length) {
    $("empty-hint").classList.remove("hidden");
    return;
  }
  $("empty-hint").classList.add("hidden");

  if (!r.data) { loadData(tab); return; }
  chart = new uPlot(makeOpts(tab, r), r.data, target);
  mountScooters();
}

function onChartReady(u) {
  u.over.addEventListener("wheel", (e) => {
    e.preventDefault();
    const tab = activeTab();
    const factor = e.deltaY < 0 ? 0.7 : 1.4;
    const cur = currentXRange();
    const tc = u.posToVal(e.offsetX, "x");
    let span = (cur.end - cur.start) * factor;
    span = Math.max(MIN_SPAN_S, Math.min(MAX_SPAN_S, span));
    const frac = (tc - cur.start) / (cur.end - cur.start);
    setAbsoluteRange(tab, tc - span * frac, tc + span * (1 - frac), true);
  }, { passive: false });

  u.over.addEventListener("click", (e) => {
    if (e.altKey) addScooterAt(u.posToVal(e.offsetX, "x"));
  });

  u.over.addEventListener("dblclick", (e) => {
    addScooterAt(u.posToVal(e.offsetX, "x"));
  });

  u.over.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e, u.posToVal(e.offsetX, "x"));
  });
}

export function currentXRange() {
  const tab = activeTab();
  const r = rt(tab);
  if (chart && chart.scales.x.min != null) {
    return { start: chart.scales.x.min, end: chart.scales.x.max };
  }
  return { start: r.start, end: r.end };
}

function onSelectZoom(u) {
  if (u.select.width < 5) return;
  const start = u.posToVal(u.select.left, "x");
  const end = u.posToVal(u.select.left + u.select.width, "x");
  u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
  setAbsoluteRange(activeTab(), start, end, false);
}

function onCursorMove(u) {
  const box = $("hover-box");
  const { idx, left, top } = u.cursor;
  if (idx == null || left < 0 || top < 0) { box.classList.add("hidden"); return; }
  const tab = activeTab();
  const r = rt(tab);
  const t = u.data[0][idx];
  if (t == null) { box.classList.add("hidden"); return; }

  box.innerHTML = "";
  box.appendChild(el("div", "time", fmtTime(t, true)));
  appendValueRows(box, tab, r, t);
  box.classList.remove("hidden");
}

// Rows of (color dot, tag label, value at time t) for every visible tag.
export function appendValueRows(parent, tab, r, t) {
  for (const tag of tab.tags) {
    const series = r.raw && r.raw[tag.uid];
    if (tag.visible === false || !series) continue;
    const near = nearestValue(series.t, series.v, t);
    const row = el("div", "row");
    const dot = el("span", "dot");
    dot.style.background = tag.color;
    row.appendChild(dot);
    row.appendChild(el("span", "name", tagDisplay(tab, tag)));
    row.appendChild(el("span", "val", near ? `${fmtVal(near.v)} ${tag.unit}` : "–"));
    parent.appendChild(row);
  }
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
  if (tag.unit || tag._unitChecked) return;
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
    if (!tag.description && !tag._descChecked) wanted.add(tag.name);
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
    const duplicate = tab.tags.some((t) => reqName(t) === reqName(tag));
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

async function insertTag(tab, tag, at) {
  return (await insertTags(tab, [tag], at)).length > 0;
}

async function addTag(info) {
  const tab = activeTab();
  await insertTag(tab, makeTag(info));
}

export async function duplicateTag(uid) {
  const tab = activeTab();
  const src = byUid(tab, uid);
  if (!src) return;
  const copy = { ...src, uid: newUid(), maps: src.maps.slice() };
  await insertTag(tab, copy, tab.tags.indexOf(src) + 1);
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
    rebuildJoined(tab, r);
  }
  renderChart();
  renderNavigator();
  saveState();
}

export function removeTag(uid) {
  removeTags(activeTab(), [uid]);
}

// The tag list lives in two places - the pill strip and the settings table -
// and they must never disagree, so nothing renders one without the other.
export function renderTags() {
  renderTagbar();
  renderTagTable();
}

function renderTagbar() {
  const bar = $("tagbar");
  bar.innerHTML = "";
  const tab = activeTab();
  for (const tag of tab.tags) {
    const pill = el("div", "pill" + (tag.uid === tab.axisUid ? " axis" : "") +
      (tag.visible === false ? " hidden-tag" : ""));
    pill.style.color = tag.color;
    pill.title = `${tag.description} [${tag.unit}]\nClick: use for grid · Dot: hide/show · ⚙: settings, in the tag table`;

    const dot = el("span", "dot");
    dot.style.background = tag.color;
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      setTagField(tab, tag, "visible", tag.visible === false);
    });
    pill.appendChild(dot);
    pill.appendChild(el("span", "name", tagDisplay(tab, tag)));

    const notes = [];
    if (tag.sample !== "INT") notes.push(tag.sample);
    if (tag.interval !== "auto") notes.push(intervalLabel(tag.interval));
    if (tag.min != null || tag.max != null) {
      notes.push(`[${tag.min ?? "auto"}…${tag.max ?? "auto"}]`);
    }
    if (notes.length) pill.appendChild(el("span", "range-note", notes.join(" ")));

    const gear = el("button", "gear", "⚙");
    gear.title = "Settings for this tag, in the table below";
    gear.addEventListener("click", (e) => { e.stopPropagation(); openTagTable(tag); });
    pill.appendChild(gear);

    const close = el("button", "close", "×");
    close.title = "Remove tag";
    close.addEventListener("click", (e) => { e.stopPropagation(); removeTag(tag.uid); });
    pill.appendChild(close);

    pill.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showPillMenu(e, tag);
    });

    pill.addEventListener("click", () => setAxisOwner(tab, tag.uid));
    bar.appendChild(pill);
  }
}

// A row is a grid of its own rather than one grid for the whole table, so a
// row can carry hover, a border and a drag ghost. The columns still line up
// because every row uses this same template.
const TAG_COLUMNS = [
  { key: "grip", label: "", width: "20px" },
  { key: "visible", label: "", width: "22px" },
  { key: "axis", label: "Grid", width: "32px" },
  { key: "color", label: "", width: "24px" },
  { key: "name", label: "Tag", width: "minmax(110px, 1fr)" },
  { key: "map", label: "Map", width: "142px" },
  { key: "sample", label: "Type", width: "72px" },
  { key: "interval", label: "Period", width: "80px" },
  { key: "step", label: "Step", width: "36px" },
  { key: "min", label: "Min", width: "68px" },
  { key: "max", label: "Max", width: "68px" },
  { key: "auto", label: "", width: "38px" },
  { key: "unit", label: "Unit", width: "56px" },
  { key: "desc", label: "Description", width: "minmax(120px, 2fr)" },
  { key: "remove", label: "", width: "24px" },
];

export const TAG_TABLE_DEFAULT_H = 200;
const TAG_TABLE_MIN_H = 96;

// Never so tall that the chart it is docked under has nothing left.
export function clampTableHeight(h) {
  const max = Math.max(TAG_TABLE_MIN_H, window.innerHeight - 240);
  return Math.min(max, Math.max(TAG_TABLE_MIN_H, Number(h) || TAG_TABLE_DEFAULT_H));
}

// Rows are kept and patched rather than rebuilt, so an edit in progress keeps
// its caret, its selection and its undo history. tagRowEls maps uid -> row.
let tagRowEls = new Map();
let tagRowsTabId = null;

function renderTagTable() {
  const panel = $("tag-table");
  const tab = activeTab();
  panel.classList.toggle("hidden", !tab.tagTable);
  // Closed is the common case and every setting change renders, so cost
  // nothing while it is shut.
  if (!tab.tagTable) {
    tagRowEls.clear();
    tagRowsTabId = null;
    return;
  }
  panel.style.height = `${clampTableHeight(state.tagTableHeight)}px`;

  const head = panel.querySelector(".head");
  if (!head.childElementCount) {
    head.style.gridTemplateColumns = TAG_COLUMNS.map((c) => c.width).join(" ");
    for (const col of TAG_COLUMNS) head.appendChild(el("span", null, col.label));
  }

  const body = panel.querySelector(".body");
  // uids are unique per tab, so a tab switch starts from a clean slate.
  if (tagRowsTabId !== tab.id) {
    body.innerHTML = "";
    tagRowEls.clear();
    tagRowsTabId = tab.id;
  }

  const live = new Set(tab.tags.map((t) => t.uid));
  for (const [uid, row] of tagRowEls) {
    if (!live.has(uid)) { row.remove(); tagRowEls.delete(uid); }
  }

  let previous = null;
  for (const tag of tab.tags) {
    let row = tagRowEls.get(tag.uid);
    if (!row) {
      row = buildTagRow(tag.uid);
      tagRowEls.set(tag.uid, row);
      body.appendChild(row);
    }
    // Moving a focused node blurs it in Chrome, so only touch the order when
    // it actually differs - which is only just after a drag.
    const expected = previous ? previous.nextSibling : body.firstChild;
    if (row !== expected) body.insertBefore(row, expected);
    previous = row;
    updateTagRow(tab, tag, row);
  }

  body.classList.toggle("empty", !tab.tags.length);
}

function cellOf(row, key) {
  return row.children[TAG_COLUMNS.findIndex((c) => c.key === key)];
}

// Cells and their listeners are built exactly once per tag. Listeners close
// over the uid and look the tag up when they fire, so a row survives anything
// that reorders or replaces the tag objects.
function buildTagRow(uid) {
  const row = el("div", "row");
  row.dataset.uid = uid;
  row.style.gridTemplateColumns = TAG_COLUMNS.map((c) => c.width).join(" ");
  const tagOf = () => byUid(activeTab(), uid);

  for (const col of TAG_COLUMNS) {
    const cell = el("span", `cell ${col.key}`);
    row.appendChild(cell);
  }

  const mark = (control, key) => {
    control.dataset.uid = uid;
    control.dataset.col = key;
    return control;
  };

  const grip = el("span", "handle", "⠿");
  grip.title = "Drag to reorder (or Alt+Up / Alt+Down from any cell)";
  grip.addEventListener("pointerdown", (ev) => beginRowDrag(ev, uid));
  cellOf(row, "grip").appendChild(grip);

  const visible = el("input");
  visible.type = "checkbox";
  visible.title = "Show this tag on the plot";
  visible.addEventListener("change", () =>
    setTagField(activeTab(), tagOf(), "visible", visible.checked));
  cellOf(row, "visible").appendChild(mark(visible, "visible"));

  const axis = el("input");
  axis.type = "radio";
  axis.title = "Use this tag's scale for the gridlines";
  axis.addEventListener("change", () => {
    if (axis.checked) setAxisOwner(activeTab(), uid);
  });
  cellOf(row, "axis").appendChild(mark(axis, "axis"));

  const color = el("button", "swatch");
  color.title = "Trend colour";
  color.addEventListener("click", () =>
    openSwatchMenu(color, activeTab(), tagOf()));
  cellOf(row, "color").appendChild(mark(color, "color"));

  const sample = el("select");
  sample.title = "Sampling type";
  for (const s of SAMPLES) {
    const opt = el("option", null, s.label);
    opt.value = s.value;
    sample.appendChild(opt);
  }
  sample.addEventListener("change", () =>
    setTagField(activeTab(), tagOf(), "sample", sample.value));
  cellOf(row, "sample").appendChild(mark(sample, "sample"));

  const interval = el("select");
  interval.title = "Aggregate interval";
  for (const item of INTERVALS) {
    const opt = el("option", null, item.label);
    opt.value = item.value;
    interval.appendChild(opt);
  }
  interval.addEventListener("change", () =>
    setTagField(activeTab(), tagOf(), "interval", interval.value));
  cellOf(row, "interval").appendChild(mark(interval, "interval"));

  const step = el("input");
  step.type = "checkbox";
  step.title = "Hold the last value instead of drawing a line between samples";
  step.addEventListener("change", () =>
    setTagField(activeTab(), tagOf(), "step", step.checked));
  cellOf(row, "step").appendChild(mark(step, "step"));

  // Text rather than number: a number input steals ArrowUp/Down to step its
  // value, and those keys move between rows here.
  for (const key of ["min", "max"]) {
    const input = el("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "auto";
    input.title = `Scale ${key} - leave empty for auto`;
    input.addEventListener("change", () => commitScale(tagOf(), key, input));
    cellOf(row, key).appendChild(mark(input, key));
  }

  // Not the word "auto": it would sit right beside two fields whose own
  // placeholder is already "auto", and read as a third one.
  const auto = el("button", null, "\u21ba");
  auto.title = "Back to an automatic scale";
  auto.addEventListener("click", () => autoScale(activeTab(), tagOf()));
  cellOf(row, "auto").appendChild(mark(auto, "auto"));

  const remove = el("button", "close", "×");
  remove.title = "Remove tag";
  remove.addEventListener("click", () => removeTag(uid));
  cellOf(row, "remove").appendChild(mark(remove, "remove"));

  return row;
}

// Writing the scale has to be idempotent: a keyboard move commits before it
// leaves the cell, and the browser then fires change on the way out anyway.
function commitScale(tag, key, input) {
  if (!tag) return;
  const text = input.value.trim();
  const value = text === "" ? null : parseFloat(text);
  const next = Number.isFinite(value) ? value : null;
  if (next === tag[key]) return;
  setTagField(activeTab(), tag, key, next);
}

function updateTagRow(tab, tag, row) {
  const busy = (control) => control === document.activeElement;
  const set = (key, fn) => {
    const control = cellOf(row, key).firstElementChild;
    // Never rewrite the control under the caret: it would lose the edit.
    if (control && !busy(control)) fn(control);
  };

  row.classList.toggle("hidden-tag", tag.visible === false);
  set("visible", (c) => { c.checked = tag.visible !== false; });
  set("axis", (c) => { c.checked = tab.axisUid === tag.uid; c.name = `axis-owner-${tab.id}`; });
  set("color", (c) => { c.style.background = tag.color || "transparent"; });
  set("sample", (c) => { c.value = tag.sample; });
  set("interval", (c) => { c.value = tag.interval; });
  set("step", (c) => { c.checked = !!tag.step; });
  set("min", (c) => { c.value = tag.min == null ? "" : tag.min; });
  set("max", (c) => { c.value = tag.max == null ? "" : tag.max; });

  const name = cellOf(row, "name");
  name.textContent = tagDisplay(tab, tag);
  name.title = tag.description ? `${tag.name} - ${tag.description}` : tag.name;
  cellOf(row, "unit").textContent = tag.unit || "";
  const desc = cellOf(row, "desc");
  desc.textContent = tag.description || "";
  desc.title = tag.description || "";

  updateMapCell(tab, tag, cellOf(row, "map"), row.dataset.uid);
}

// The map list arrives late (one request per tag) and the favourite order can
// change under it, so the options are rebuilt only when they would differ.
function updateMapCell(tab, tag, cell, uid) {
  ensureMaps(tab, tag);

  if (!tag.maps.length) {
    // A source that cannot list maps (live Aspen): type one in.
    let input = cell.querySelector("input");
    if (!input) {
      cell.innerHTML = "";
      input = el("input");
      input.type = "text";
      input.placeholder = "default map";
      input.dataset.uid = uid;
      input.dataset.col = "map";
      input.addEventListener("change", () =>
        setTagField(activeTab(), byUid(activeTab(), uid), "map", input.value.trim()));
      cell.appendChild(input);
    }
    if (input !== document.activeElement) input.value = tag.map || "";
    return;
  }

  const selected = tag.map || tag.maps[0].name;
  const signature = `${tag.maps.map((m) => m.name).join(",")}|${favoriteMaps.join(",")}`;
  let select = cell.querySelector("select");
  if (!select || select.dataset.signature !== signature) {
    if (select === document.activeElement) return; // rebuilding would drop the menu
    cell.innerHTML = "";
    select = el("select");
    select.dataset.signature = signature;
    select.dataset.uid = uid;
    select.dataset.col = "map";
    const mkOption = (m) => {
      const opt = el("option", null, m.name);
      opt.value = m.name;
      return opt;
    };
    const favoured = tag.maps.filter((m) => favoriteMaps.includes(m.name));
    if (favoured.length && favoured.length < tag.maps.length) {
      // Favourites first, without touching tag.maps itself.
      const favGroup = document.createElement("optgroup");
      favGroup.label = "Favourites";
      for (const m of orderedMaps(favoured)) favGroup.appendChild(mkOption(m));
      select.appendChild(favGroup);
      const restGroup = document.createElement("optgroup");
      restGroup.label = "All maps";
      for (const m of tag.maps) {
        if (!favoriteMaps.includes(m.name)) restGroup.appendChild(mkOption(m));
      }
      select.appendChild(restGroup);
    } else {
      for (const m of tag.maps) select.appendChild(mkOption(m));
    }
    select.addEventListener("change", () =>
      setTagField(activeTab(), byUid(activeTab(), uid), "map", select.value));
    cell.appendChild(select);

    // Starring sorts a map first for every tag that has it, so the cell has to
    // be rebuilt afterwards - the signature above sees to that.
    const star = el("button", "star");
    star.dataset.uid = uid;
    star.dataset.col = "star";
    star.title = "Favourite maps sort first everywhere, and are stored in the server's env file";
    star.addEventListener("click", async () => {
      const current = select.value;
      const names = favoriteMaps.includes(current)
        ? favoriteMaps.filter((n) => n !== current)
        : [...favoriteMaps, current];
      if (await saveFavorites(names)) renderTags();
    });
    cell.appendChild(star);
  }
  if (select !== document.activeElement) select.value = selected;
  const star = cell.querySelector(".star");
  if (star) {
    const on = favoriteMaps.includes(selected);
    star.classList.toggle("on", on);
    star.textContent = on ? "★" : "☆";
  }
}

// Maps cost a request per tag, so they are fetched the first time a row that
// can show them is drawn.
function ensureMaps(tab, tag) {
  if (tag.maps.length || tag._mapsChecked) return;
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

// Puts the caret back where the user was, addressed by tag and column rather
// than by any element that a re-render might have replaced.
export function focusTagCell(uid, col) {
  const control = $("tag-table").querySelector(`[data-uid="${uid}"][data-col="${col}"]`);
  if (control) control.focus();
  return control;
}

// Tag order decides how the stacked axis gutter piles its values and the order
// of the scooter readouts, so it is worth being able to group related tags.
function moveTag(tab, from, to) {
  if (to < 0 || to >= tab.tags.length || from === to) return;
  const [tag] = tab.tags.splice(from, 1);
  tab.tags.splice(to, 0, tag);
  // r.tagOrder and the joined data columns are derived from tab.tags, so
  // without this the chart would keep drawing each series against its old
  // column - every trace showing the wrong tag's data.
  rebuildJoined(tab, rt(tab));
  renderTags();
  renderChart();
  // gridTag() and navTag() fall back to the first tag when axisUid does not
  // resolve, so reordering can hand the grid and the band to someone else.
  ensureNavData(tab);
  renderNavigator();
  saveState();
}

// Pointer events rather than HTML5 drag-and-drop: the app already drags
// scooters, readout boxes and the navigator window this way, and draggable
// rows full of inputs behave badly. The DOM is left alone until the drop, so
// the row reconciler and the hit test stay out of each other's way.
function beginRowDrag(e, uid) {
  const body = $("tag-table").querySelector(".body");
  const rows = [...body.querySelectorAll(".row")];
  const from = rows.findIndex((r) => r.dataset.uid === uid);
  if (from < 0) return;
  const row = rows[from];
  const height = row.getBoundingClientRect().height || 26;

  e.preventDefault();
  e.target.setPointerCapture(e.pointerId);
  row.classList.add("dragging");
  const line = el("div", "drop-line");
  body.appendChild(line);

  const startY = e.clientY;
  let to = from;

  const place = (clientY) => {
    const box = body.getBoundingClientRect();
    const offset = clientY - box.top + body.scrollTop;
    to = Math.max(0, Math.min(rows.length - 1, Math.floor(offset / height)));
    row.style.transform = `translateY(${clientY - startY}px)`;
    line.style.top = `${(to > from ? to + 1 : to) * height}px`;
    // Drag past the edge and the list follows.
    if (clientY < box.top + 24) body.scrollTop -= 8;
    else if (clientY > box.bottom - 24) body.scrollTop += 8;
  };
  place(e.clientY);

  const onMove = (ev) => place(ev.clientY);
  const onUp = () => {
    e.target.removeEventListener("pointermove", onMove);
    e.target.removeEventListener("pointerup", onUp);
    row.classList.remove("dragging");
    row.style.transform = "";
    line.remove();
    moveTag(activeTab(), from, to);
  };
  e.target.addEventListener("pointermove", onMove);
  e.target.addEventListener("pointerup", onUp);
}

// The global shortcuts must stand aside for an edit in progress. Form controls
// were always exempt; the table adds buttons - colour, star, auto, remove -
// where Ctrl+C would otherwise copy every tag instead of the selection.
export function isEditingContext(node) {
  if (!node) return false;
  return ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName) || !!node.closest("#tag-table");
}

// Tab and Shift+Tab are left to the browser: its own order already runs left
// to right along a row and on into the next, skips the read-only spans, and
// lets focus out of the panel at either end. Enter and the arrows are what
// move between rows.
export function onTagTableKey(e) {
  const cell = e.target.closest("[data-col]");
  if (!cell) return;

  if (e.key === "Escape") {
    // Without this it reaches the global handler, which reads Escape as
    // "zoom back" and would move the chart out from under the edit.
    if (!$("context-menu").classList.contains("hidden")) return;
    e.stopPropagation();
    cell.blur();
    return;
  }

  const vertical = e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp";
  if (!vertical) return;

  const rows = [...$("tag-table").querySelectorAll(".row")];
  const index = rows.indexOf(cell.closest(".row"));
  if (index < 0) return;

  if (e.altKey && e.key !== "Enter") {
    // Alt+Arrow moves the row itself - the keyboard equivalent of dragging.
    e.preventDefault();
    e.stopPropagation();
    moveTag(activeTab(), index, index + (e.key === "ArrowDown" ? 1 : -1));
    focusTagCell(cell.dataset.uid, cell.dataset.col);
    return;
  }

  e.preventDefault();
  e.stopPropagation();
  // keydown runs before change, so an edit in progress has to be banked before
  // the caret leaves - otherwise the move would discard it.
  if (cell.tagName === "INPUT" && cell.type === "text") {
    cell.dispatchEvent(new Event("change"));
  }
  const down = e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1;
  const target = rows[Math.max(0, Math.min(rows.length - 1, index + down))];
  if (!target || target === rows[index]) return;
  const next = focusTagCell(target.dataset.uid, cell.dataset.col);
  if (next && next.select) next.select();
}

// Dragging the top edge trades chart height for table height. The chart is
// flex: 1 and gives the space up on its own; its ResizeObserver does the rest.
export function beginTableResize(e) {
  const panel = $("tag-table");
  e.preventDefault();
  e.target.setPointerCapture(e.pointerId);
  const startY = e.clientY;
  const startH = panel.getBoundingClientRect().height;
  const onMove = (ev) => {
    state.tagTableHeight = clampTableHeight(startH + (startY - ev.clientY));
    panel.style.height = `${state.tagTableHeight}px`;
  };
  const onUp = () => {
    e.target.removeEventListener("pointermove", onMove);
    e.target.removeEventListener("pointerup", onUp);
    saveState();
  };
  e.target.addEventListener("pointermove", onMove);
  e.target.addEventListener("pointerup", onUp);
}

// The gear on a pill is now a way into the table rather than a popover of its
// own: open it if it is shut, put the row in view, and start the caret on the
// first setting that is actually worth changing.
function openTagTable(tag) {
  const tab = activeTab();
  if (!tab.tagTable) {
    tab.tagTable = true;
    renderToolbar();
    renderTagTable();
    saveState();
  }
  const row = tagRowEls.get(tag.uid);
  if (row) {
    row.scrollIntoView({ block: "nearest" });
    row.classList.remove("flash");
    void row.offsetWidth; // restart the animation on a repeat click
    row.classList.add("flash");
  }
  focusTagCell(tag.uid, "color");
}

export function toggleTagTable() {
  const tab = activeTab();
  tab.tagTable = !tab.tagTable;
  renderToolbar();
  renderTagTable();
  saveState();
}

// Every tag setting goes through here, so the pills, the settings table and
// anything else that edits a tag agree on what a change actually costs:
// colour and scale only redraw, while sampling, interval and map mean a new
// request to the historian.
function setTagFields(tab, tag, patch) {
  let redraw = false, refetch = false, live = false, nav = false;
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
      redraw = true;
    } else if (key === "min" || key === "max") {
      tag[key] = Number.isFinite(value) ? value : null;
      redraw = true;
    } else if (key === "sample") {
      tag.sample = value;
      refetch = true;
    } else if (key === "interval") {
      tag.interval = normalizeInterval(value);
      refetch = live = true;
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
  // Never both: a refetch leaves the old data on screen until the answer
  // lands, which is what keeps a sampling change from flickering.
  if (refetch) loadData(tab);
  else if (redraw) renderChart();
  if (nav) renderNavigator();
  saveState();
}

export function setTagField(tab, tag, key, value) {
  setTagFields(tab, tag, { [key]: value });
}

function autoScale(tab, tag) {
  setTagFields(tab, tag, { min: null, max: null });
}

// Which tag owns the gridlines - and with them the navigator band.
function setAxisOwner(tab, uid) {
  tab.axisUid = uid;
  renderTags();
  renderChart();
  ensureNavData(tab);
  renderNavigator();
  saveState();
}

document.addEventListener("pointerdown", (e) => {
  const menu = $("context-menu");
  if (!menu.classList.contains("hidden") && !menu.contains(e.target)) {
    hideContextMenu();
  }
});

export function renderAll() {
  renderTabs();
  renderToolbar();
  renderTags();
  renderChart();
  renderNavigator();
}

function init() {
  loadState();
  initSearch();
  initToolbar();
  initTabbar();
  initDialogs();
  initNavigator();
  ensureFavorites();
  renderAll();
  // A #p=... link adds its plot as a new tab on top of the restored state.
  openSharedPlot();

  const resizeObserver = new ResizeObserver(() => {
    if (chart) {
      chart.setSize(chartSize());
      positionScooters();
    }
    renderNavigator(); // the canvas is sized from its own box, so redraw it
  });
  resizeObserver.observe($("chart-wrap"));

  window.addEventListener("beforeunload", () => {
    clearTimeout(saveTimer);
    persistState();
  });
}

init();

// Module code keeps its names out of window, so the browser console needs a
// way in. Getters, because state and chart are replaced rather than mutated.
window.ip21 = {
  get state() { return state; },
  get chart() { return chart; },
  activeTab, rt, byUid, makeTag, renderAll, loadData, apiSearchTags,
  insertTags, removeTags, setTagFields, moveTag,
};
