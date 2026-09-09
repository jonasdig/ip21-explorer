/* IP21 Explorer frontend: tabs, tag search, uPlot chart, scooters, save/open. */
"use strict";

/* ---------------------------------------------------------------- constants */

const PALETTE = [
  "#4FC3F7", "#FFB74D", "#81C784", "#E57373", "#BA68C8", "#FFD54F",
  "#4DD0E1", "#F06292", "#AED581", "#90A4AE", "#FF8A65", "#7986CB",
];

const PRESETS = [
  { label: "1h", s: 3600 },
  { label: "8h", s: 8 * 3600 },
  { label: "24h", s: 24 * 3600 },
  { label: "3d", s: 3 * 24 * 3600 },
  { label: "7d", s: 7 * 24 * 3600 },
  { label: "30d", s: 30 * 24 * 3600 },
];

const SAMPLES = [
  { label: "Interpolated", value: "INT" },
  { label: "Average", value: "AVG" },
  { label: "Minimum", value: "MIN" },
  { label: "Maximum", value: "MAX" },
];

// The 4 s floor matches the server's NICE_INTERVALS: IP21 stores no sample
// finer than that, so asking for less only costs bandwidth.
const INTERVALS = [
  { label: "Auto", value: "auto" },
  { label: "4 s", value: "4" },
  { label: "8 s", value: "8" },
  { label: "30 s", value: "30" },
  { label: "1 min", value: "60" },
  { label: "5 min", value: "300" },
  { label: "10 min", value: "600" },
  { label: "30 min", value: "1800" },
  { label: "1 h", value: "3600" },
  { label: "6 h", value: "21600" },
  { label: "1 d", value: "86400" },
];

const STORAGE_KEY = "ip21explorer.v1";
// Each search is real work for the IP21 server: keep them specific and rare.
const MIN_QUERY_LEN = 2;
const SEARCH_DEBOUNCE_MS = 350;
// Finest sample IP21 holds; the server's NICE_INTERVALS floor matches it.
const MIN_INTERVAL_S = 4;
// One minute is 15 samples at the 4 s floor; anything tighter is a flat line.
const MIN_SPAN_S = 60;
const MAX_SPAN_S = 5 * 366 * 24 * 3600;
const HISTORY_MAX = 50;
const LIVE_INTERVAL_MS = 10_000;
// Above this, "Open all" asks first: each listed plot becomes its own tab.
const OPEN_ALL_CONFIRM = 8;

// What the tag bar and the readout boxes name a tag by, and the cycle order.
const LABEL_MODES = {
  tag: { label: "Labels: tag", next: "desc" },
  desc: { label: "Labels: description", next: "both" },
  both: { label: "Labels: both", next: "tag" },
};
// Live refuses a refresh that would ask for more points than /api/data will
// ever serve in one go. Span is not the measure - liveTick already refreshes
// once per bucket, so a wide window is the cheapest one - request size is.
const LIVE_MAX_POINTS = 20000;
// The server refuses more than this per tag in one request (see MAX_POINTS in
// sources/simulator.py); a pinned interval over a wide window is the only way
// to reach it.
const DATA_MAX_POINTS = 200000;

/* ------------------------------------------------------------------- state */

let state = null;      // { tabs: [...], activeTabId }
let tabSeq = 0;
let uidSeq = 0;
const runtime = new Map();  // tab.id -> {raw, data, tagOrder, start, end, seq, abort}
let chart = null;           // uPlot instance for the active tab
let scooterEls = [];        // [{line, box}] for the active tab
let saveTimer = null;
let zoomTimer = null;

function newUid() {
  uidSeq += 1;
  // The random suffix matters: uids are persisted but uidSeq restarts at 0 on
  // every load, and a collision would make two tags share one data slot.
  return `u${Date.now().toString(36)}_${uidSeq}_${Math.random().toString(36).slice(2, 7)}`;
}

function newTab(name) {
  tabSeq += 1;
  return {
    id: `t${Date.now()}_${tabSeq}`,
    name: name || `Plot ${state ? state.tabs.length + 1 : 1}`,
    tags: [],                 // see makeTag()
    range: { preset: "24h" }, // or {start, end, fromPreset}
    linked: false,            // participates in the shared time range
    axisMode: "stacked",      // "stacked" (PE-style gutter) | "single" | "all"
    axisUid: null,            // tag whose grid (and single axis) is shown
    labels: [],               // free-text labels for grouping saved plots
    scooters: [],             // {t: epoch seconds, dy: readout box y-offset px}
    live: true,               // follow "now", refreshing every LIVE_INTERVAL_MS
    history: [],              // previous ranges, for zoom-back (not persisted)
  };
}

function makeTag(info) {
  return {
    uid: newUid(),
    name: info.name,
    description: info.description || "",
    unit: info.unit || "",
    maps: info.maps || [],    // [{name, unit}], first = default
    map: null,                // selected map name, null = default
    color: null,
    min: null,
    max: null,
    visible: true,
    step: false,              // draw as steps (hold last value) instead of a line
    sample: "INT",
    interval: "auto",
  };
}

// Old catalog names carried role suffixes (TI-101.PV); maps replace them now.
function normalizeTagName(name) {
  return name.replace(/\.(PV|SP|OUT)$/, "");
}

// Plots saved before the 4 s floor carry intervals this list no longer offers
// (1 s, 5 s, 10 s). Left alone, the dropdown would read "Auto" while the tag
// went on requesting 1 s, so snap anything unknown to the nearest offered
// value - which also enforces the floor, since 4 s is the smallest one.
function normalizeInterval(value) {
  if (value === "auto" || INTERVALS.some((i) => i.value === value)) return value;
  const seconds = Number(value);
  if (!(seconds > 0)) return "auto";
  const offered = INTERVALS.filter((i) => i.value !== "auto").map((i) => Number(i.value));
  return String(offered.reduce((best, n) =>
    Math.abs(n - seconds) < Math.abs(best - seconds) ? n : best));
}

function migrateTab(tab, oldState) {
  tab.linked = tab.linked ?? oldState.linkRanges ?? false;
  // "multi" was the old side-by-side default; the PE-style gutter replaces it
  // as default ("all" is the stored name for side-by-side from now on).
  tab.axisMode = !tab.axisMode || tab.axisMode === "multi" ? "stacked" : tab.axisMode;
  tab.history = [];
  for (const tag of tab.tags) {
    tag.uid = tag.uid || newUid();
    tag.name = normalizeTagName(tag.name);
    tag.maps = tag.maps || [];
    tag.map = tag.map ?? null;
    tag.sample = tag.sample || tab.sample || "INT";
    tag.interval = normalizeInterval(tag.interval || tab.interval || "auto");
  }
  if (!tab.axisUid && tab.axisTag) {
    const match = tab.tags.find((t) => t.name === normalizeTagName(tab.axisTag));
    tab.axisUid = match ? match.uid : null;
  }
  delete tab.sample;
  delete tab.interval;
  delete tab.axisTag;
}

function defaultState() {
  // labelMode is a display preference for every tab ("tag" | "desc" | "both"),
  // deliberately not part of a plot config so a shared plot cannot change it.
  state = { tabs: [], activeTabId: null, labelMode: "tag", navigator: true };
  const tab = newTab("Plot 1");
  state.tabs.push(tab);
  state.activeTabId = tab.id;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed.tabs || !parsed.tabs.length) return defaultState();
    state = parsed;
    if (!LABEL_MODES[state.labelMode]) state.labelMode = "tag";
    if (typeof state.navigator !== "boolean") state.navigator = true;
    for (const tab of state.tabs) migrateTab(tab, parsed);
    delete state.linkRanges;
    if (!state.tabs.some((t) => t.id === state.activeTabId)) {
      state.activeTabId = state.tabs[0].id;
    }
  } catch (e) {
    defaultState();
  }
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistState, 300);
}

function persistState() {
  try {
    const json = JSON.stringify(state, (key, value) =>
      key === "history" || key === "_wheeling" || key === "_mapsChecked" ||
      key === "_unitChecked" || key === "_descChecked"
        ? undefined : value
    );
    localStorage.setItem(STORAGE_KEY, json);
  } catch (e) { /* storage unavailable - ad-hoc state just won't survive reload */ }
}

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

function rt(tab) {
  let r = runtime.get(tab.id);
  if (!r) {
    r = { raw: null, data: null, tagOrder: [], start: 0, end: 0, seq: 0, abort: null };
    runtime.set(tab.id, r);
  }
  return r;
}

/* ------------------------------------------------------------------ helpers */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function $(id) { return document.getElementById(id); }

function pad2(n) { return String(n).padStart(2, "0"); }

// Full "TAG;MAP" request identifier for a tag entry (bare name = default map).
function reqName(tag) {
  return tag.map ? `${tag.name};${tag.map}` : tag.name;
}

// Display name. Several tags may share a reqName (same tag, same map, e.g.
// straight after a duplicate), so those get an ordinal to tell them apart.
function tagLabel(tab, tag) {
  const name = reqName(tag);
  const twins = tab.tags.filter((t) => reqName(t) === name);
  if (twins.length < 2) return name;
  return `${name} #${twins.indexOf(tag) + 1}`;
}

// What the tag bar and the readout boxes show, per the label mode. Falls back
// to the name when a tag has no description, so a row is never blank.
// tagLabel() stays the machine-facing name, for CSV headers and exports.
function tagDisplay(tab, tag) {
  const name = tagLabel(tab, tag);
  const desc = (tag.description || "").trim();
  if (!desc || state.labelMode === "tag") return name;
  return state.labelMode === "desc" ? desc : `${name} \u00b7 ${desc}`;
}

function byName(tab, name) {
  return tab.tags.find((t) => t.name === name);
}

function byUid(tab, uid) {
  return tab.tags.find((t) => t.uid === uid);
}

function fmtTime(t, withSeconds) {
  const d = new Date(t * 1000);
  const date = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}` +
    (withSeconds ? `:${pad2(d.getSeconds())}` : "");
  return `${date} ${time}`;
}

function fmtVal(v) {
  if (v == null || Number.isNaN(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

// A span as the largest unit that reads cleanly, for messages about limits.
function fmtSpan(seconds) {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} d`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds)} s`;
}

function intervalLabel(value) {
  const item = INTERVALS.find((i) => i.value === value);
  return item ? item.label : `${value} s`;
}

// Reads what the time fields accept, in the same 24h dd.mm.yyyy format
// fmtTime() writes. A native datetime-local was formatted by the browser's
// locale - AM/PM and all - which the page cannot override, so the fields are
// plain text and this is what turns them back into a timestamp.
//
// Deliberately forgiving, since these are typed by hand: the date may drop its
// year, and either half may be left out entirely.
//   01.09.2026 14:30:00   01.09.2026 14:30   01.09.2026
//   01.09 14:30           14:30              14:30:05
//   2026-09-01T14:30:00   2026-09-01 14:30
// Returns epoch seconds, or null when it cannot be read.
function parseTimeInput(text, now) {
  const value = String(text == null ? "" : text).trim();
  if (!value) return null;
  const today = new Date((now == null ? Date.now() / 1000 : now) * 1000);

  const iso = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (iso) {
    const [, y, mo, d, h, mi, sec] = iso;
    return mk(+y, +mo, +d, +(h || 0), +(mi || 0), +(sec || 0));
  }

  const parts = value.split(/\s+/);
  const datePart = parts.length > 1 || parts[0].includes(".") ? parts[0] : null;
  const timePart = parts.length > 1 ? parts[1] : (datePart ? null : parts[0]);

  let y = today.getFullYear(), mo = today.getMonth() + 1, d = today.getDate();
  if (datePart) {
    const m = datePart.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\.?$/);
    if (!m) return null;
    d = +m[1];
    mo = +m[2];
    if (m[3]) y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  }

  let h = 0, mi = 0, sec = 0;
  if (timePart) {
    const m = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    h = +m[1];
    mi = +m[2];
    sec = +(m[3] || 0);
  }
  return mk(y, mo, d, h, mi, sec);

  function mk(year, month, day, hour, minute, second) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const dt = new Date(year, month - 1, day, hour, minute, second, 0);
    // Rejects the likes of 31.02: the Date constructor rolls those over.
    if (dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
    return dt.getTime() / 1000;
  }
}

// Which part of "dd.mm.yyyy HH:MM:SS" the caret sits in, so the arrow keys can
// step that unit. Positions are fixed, the format has no variable-width parts.
const TIME_SEGMENTS = [
  { from: 0, to: 2, unit: "day" },
  { from: 3, to: 5, unit: "month" },
  { from: 6, to: 10, unit: "year" },
  { from: 11, to: 13, unit: "hour" },
  { from: 14, to: 16, unit: "minute" },
  { from: 17, to: 19, unit: "second" },
];

function segmentAt(caret) {
  const seg = TIME_SEGMENTS.find((s) => caret >= s.from && caret <= s.to);
  return seg || TIME_SEGMENTS[TIME_SEGMENTS.length - 1];
}

// One step of `unit` on a timestamp. Months and years go through Date so that
// the 31st of a short month lands on a real date.
function stepTime(t, unit, delta) {
  const d = new Date(t * 1000);
  if (unit === "year") d.setFullYear(d.getFullYear() + delta);
  else if (unit === "month") d.setMonth(d.getMonth() + delta);
  else if (unit === "day") d.setDate(d.getDate() + delta);
  else if (unit === "hour") d.setHours(d.getHours() + delta);
  else if (unit === "minute") d.setMinutes(d.getMinutes() + delta);
  else d.setSeconds(d.getSeconds() + delta);
  return d.getTime() / 1000;
}

function nearestValue(ts, vs, t) {
  // Binary search for the sample nearest to time t.
  if (!ts || !ts.length) return null;
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid; else hi = mid;
  }
  const i = Math.abs(ts[lo] - t) <= Math.abs(ts[hi] - t) ? lo : hi;
  return { t: ts[i], v: vs[i] };
}

function resolveRange(tab) {
  if (tab.range.preset) {
    const preset = PRESETS.find((p) => p.label === tab.range.preset);
    const end = Date.now() / 1000;
    return { start: end - (preset ? preset.s : 86400), end };
  }
  return { start: tab.range.start, end: tab.range.end };
}

// A successful fetch clears this box, so a message that is not about a failed
// request needs protecting from that - hence showNotice() below.
let errorHoldUntil = 0;

function showError(msg, holdMs) {
  const box = $("error-box");
  if (msg) {
    box.textContent = msg;
    box.classList.remove("hidden");
    errorHoldUntil = holdMs ? Date.now() + holdMs : 0;
  } else if (Date.now() >= errorHoldUntil) {
    box.classList.add("hidden");
    errorHoldUntil = 0;
  }
}

// Something worth saying that is not an error: stays put for a few seconds
// even if a fetch finishes in the meantime, then clears itself.
function showNotice(msg, ms = 4000) {
  showError(msg, ms);
  setTimeout(() => showError(null), ms);
}

/* --------------------------------------------------------------------- API */

// Returns the whole body: besides the hits it may carry a note explaining an
// incomplete answer, e.g. a description scan that ran out of budget.
async function apiSearchTags(q, signal) {
  const resp = await fetch(
    `/api/tags?${new URLSearchParams({ q, limit: "40" })}`, { signal }
  );
  if (!resp.ok) throw new Error(`tag search failed (${resp.status})`);
  return await resp.json();
}

// Favourite record maps, shared across tags and stored server-side in the env
// file. Real tags have 30+ maps but only a few are ever used.
let favoriteMaps = [];
let favoritesPromise = null;

function ensureFavorites() {
  if (!favoritesPromise) {
    favoritesPromise = fetch("/api/favorites")
      .then((r) => (r.ok ? r.json() : { favorites: [] }))
      .then((data) => { favoriteMaps = data.favorites || []; })
      .catch(() => {});
  }
  return favoritesPromise;
}

async function saveFavorites(names) {
  const resp = await fetch("/api/favorites", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorites: names }),
  });
  if (!resp.ok) {
    const detail = (await resp.json().catch(() => ({}))).detail;
    showError(detail || "could not save favourite maps");
    return false;
  }
  favoriteMaps = (await resp.json()).favorites || [];
  return true;
}

// Favourites first (in favourite order), then the rest as the server sent
// them. Never used to rewrite tag.maps: maps[0] is the default map there, and
// reordering it would silently change which map counts as the default.
function orderedMaps(maps) {
  if (!favoriteMaps.length) return maps;
  const favored = [];
  for (const name of favoriteMaps) {
    const found = maps.find((m) => m.name === name);
    if (found) favored.push(found);
  }
  if (!favored.length) return maps;
  return [...favored, ...maps.filter((m) => !favored.includes(m))];
}

async function apiGetUnit(name) {
  const resp = await fetch(`/api/unit?${new URLSearchParams({ tag: name })}`);
  if (!resp.ok) throw new Error(`unit lookup failed (${resp.status})`);
  return (await resp.json()).unit;
}

async function apiGetDescription(name) {
  const resp = await fetch(`/api/description?${new URLSearchParams({ tag: name })}`);
  if (!resp.ok) throw new Error(`description lookup failed (${resp.status})`);
  return (await resp.json()).description;
}

async function apiGetMaps(tagName) {
  const resp = await fetch(`/api/maps?${new URLSearchParams({ tag: tagName })}`);
  if (!resp.ok) throw new Error(`map lookup failed (${resp.status})`);
  return (await resp.json()).maps;
}

async function loadData(tab) {
  const r = rt(tab);
  if (!tab.tags.length) { r.raw = null; r.data = null; renderChart(); return; }
  ensureUnits(tab);
  ensureDescriptions(tab);
  ensureNavData(tab);

  const { start, end } = resolveRange(tab);
  if (r.abort) r.abort.abort();
  r.abort = new AbortController();
  const seq = ++r.seq;

  const width = $("chart-wrap").clientWidth || 1200;
  const points = Math.max(300, Math.min(4000, Math.round(width * 1.2)));

  // Sample type and interval are individual per tag: fetch one request per
  // distinct (sample, interval) group, in parallel.
  const groups = new Map();
  for (const tag of tab.tags) {
    const key = `${tag.sample}|${tag.interval}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tag);
  }

  if (tab.id === state.activeTabId) $("loading").classList.remove("hidden");
  try {
    const results = await Promise.all(
      [...groups.values()].map(async (groupTags) => {
        const params = new URLSearchParams({
          tags: [...new Set(groupTags.map(reqName))].join(","),
          start: String(start),
          end: String(end),
          sample: groupTags[0].sample,
          interval: groupTags[0].interval,
          points: String(points),
        });
        const resp = await fetch(`/api/data?${params}`, { signal: r.abort.signal });
        if (!resp.ok) {
          const detail = (await resp.json().catch(() => ({}))).detail;
          throw new Error(detail || `data request failed (${resp.status})`);
        }
        // Map the response back per tag: several tags can share one reqName
        // (same tag, same map), and each needs its own runtime slot.
        const body = await resp.json();
        const out = {};
        for (const tag of groupTags) {
          const s = body.series[reqName(tag)];
          if (s) out[tag.uid] = s; // read-only, so twins may share one object
        }
        return { series: out, intervalS: body.interval_s };
      })
    );
    if (seq !== r.seq) return; // superseded by a newer request

    // Keyed by tag.uid, so groups can never overwrite each other's entries.
    r.raw = Object.assign({}, ...results.map((g) => g.series));
    r.start = start;
    r.end = end;
    // Smallest aggregate interval that was served: liveTick skips refetches
    // until at least one new plot bucket can exist.
    const intervals = results.map((g) => g.intervalS).filter((i) => i > 0);
    r.intervalS = intervals.length ? Math.min(...intervals) : null;
    rebuildJoined(tab, r);
    showError(null);
    if (tab.id === state.activeTabId) renderChart();
  } catch (err) {
    if (err.name === "AbortError") return;
    if (tab.id === state.activeTabId) showError(err.message);
  } finally {
    // Hide even if the active tab changed mid-fetch, so it can't get stuck.
    if (seq === r.seq) $("loading").classList.add("hidden");
  }
}

function rebuildJoined(tab, r) {
  r.tagOrder = tab.tags.map((t) => t.uid).filter((uid) => r.raw && r.raw[uid]);
  const tables = r.tagOrder.map((uid) => [r.raw[uid].t, r.raw[uid].v]);
  r.data = tables.length === 0 ? null
    : tables.length === 1 ? tables[0] : uPlot.join(tables);
}

/* ------------------------------------------------------------------- chart */

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

/* -- stacked axis mode (Process Explorer style) ---------------------------
   All tags share a few horizontal gridlines; at each gridline the value of
   every visible tag is printed in a single narrow gutter, stacked vertically
   in the tag's color. Values are each tag's linear interpolation at that
   height, so they are not round numbers - exactly like Process Explorer. */

const STACKED_FONT = '11px -apple-system, "Segoe UI", Roboto, sans-serif';
const measureCtx = document.createElement("canvas").getContext("2d");

function stackedDecimals(span) {
  if (span >= 200) return 0;
  if (span >= 20) return 1;
  return 2;
}

function stackedFmt(v, span) {
  return v.toFixed(stackedDecimals(Math.abs(span) || 1));
}

function stackedDivisions(cssHeight) {
  return Math.max(3, Math.min(8, Math.round(cssHeight / 90)));
}

function stackedTags(tab, r) {
  return r.tagOrder
    .map((uid) => byUid(tab, uid))
    .filter((t) => t && t.visible !== false);
}

// Gutter width from the widest label, estimated from the loaded data range.
function stackedGutter(tab, r) {
  measureCtx.font = STACKED_FONT;
  let maxW = 24;
  for (const tag of stackedTags(tab, r)) {
    const values = r.raw[tag.uid].v;
    let lo = Infinity, hi = -Infinity;
    for (const v of values) {
      if (v == null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo > hi) continue;
    if (tag.min != null) lo = tag.min;
    if (tag.max != null) hi = tag.max;
    const span = hi - lo || 1;
    for (const v of [lo, hi]) {
      const w = measureCtx.measureText(stackedFmt(v, span)).width;
      if (w > maxW) maxW = w;
    }
  }
  return Math.ceil(maxW) + 14;
}

function drawStackedGrid(u) {
  const tab = activeTab();
  if (!tab || tab.axisMode !== "stacked") return;
  const { ctx, bbox } = u;
  const dpr = window.devicePixelRatio || 1;
  const n = stackedDivisions(bbox.height / dpr);
  ctx.save();
  ctx.strokeStyle = "#232834";
  ctx.lineWidth = dpr;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const y = Math.round(bbox.top + (bbox.height * i) / n);
    ctx.moveTo(bbox.left, y);
    ctx.lineTo(bbox.left + bbox.width, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawStackedLabels(u) {
  const tab = activeTab();
  if (!tab || tab.axisMode !== "stacked") return;
  const r = rt(tab);
  const { ctx, bbox } = u;
  const dpr = window.devicePixelRatio || 1;
  const n = stackedDivisions(bbox.height / dpr);
  const rowH = 13 * dpr;
  const xRight = bbox.left - 6 * dpr;
  const tags = stackedTags(tab, r);

  ctx.save();
  ctx.font = `${11 * dpr}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= n; i++) {
    const gy = bbox.top + (bbox.height * i) / n;
    const downward = i < n; // the bottom gridline's stack grows upward
    tags.forEach((tag, row) => {
      const scale = u.scales[tag.uid];
      if (!scale || scale.min == null) return;
      const span = scale.max - scale.min;
      const v = scale.max - (i / n) * span;
      const y = downward
        ? gy + (row + 0.5) * rowH
        : gy - (tags.length - row - 0.5) * rowH;
      ctx.fillStyle = tag.color;
      ctx.fillText(stackedFmt(v, span), xRight, y);
    });
  }
  ctx.restore();
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

function renderChart() {
  const tab = activeTab();
  const r = rt(tab);
  const target = $("chart");

  if (chart) { chart.destroy(); chart = null; }
  scooterEls = [];
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

function currentXRange() {
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
function appendValueRows(parent, tab, r, t) {
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

/* ------------------------------------------------------------- time ranges */

function pushHistory(tab) {
  tab.history = tab.history || [];
  tab.history.push(JSON.parse(JSON.stringify(tab.range)));
  if (tab.history.length > HISTORY_MAX) tab.history.shift();
}

function popHistory() {
  const tab = activeTab();
  if (!tab.history || !tab.history.length) return;
  tab.live = false;
  tab.range = tab.history.pop();
  propagateRange(tab);
  loadData(tab);
  renderToolbar();
  saveState();
}

function resetZoom() {
  const tab = activeTab();
  const preset = tab.range.preset || tab.range.fromPreset;
  if (preset && PRESETS.some((p) => p.label === preset)) {
    setPreset(preset);
  } else if (tab.history && tab.history.length) {
    tab.range = tab.history[0];
    tab.history = [];
    propagateRange(tab);
    loadData(tab);
    renderToolbar();
    saveState();
  }
}

function setPreset(label) {
  const tab = activeTab();
  pushHistory(tab);
  tab.range = { preset: label };
  propagateRange(tab);
  loadData(tab);
  renderToolbar();
  saveState();
}

function setAbsoluteRange(tab, start, end, debounced, keepLive) {
  if (end - start < MIN_SPAN_S) end = start + MIN_SPAN_S;
  // A tag pinned to a fine interval caps how wide a window can be asked for.
  // Clamp around the centre so dragging the navigator wide just stops, rather
  // than failing the request with "too many points requested".
  const maxSpan = maxSpanFor(tab);
  if (end - start > maxSpan) {
    const centre = (start + end) / 2;
    start = centre - maxSpan / 2;
    end = centre + maxSpan / 2;
    showNotice(`Window capped at ${fmtSpan(maxSpan)} by the pinned sample interval`);
  }
  // Zooming or panning to an absolute window means the user wants to look at
  // something specific: stop following now.
  if (!keepLive && tab.live) tab.live = false;
  // A continuous wheel-zoom session collapses to one history entry.
  if (!debounced || !tab._wheeling) pushHistory(tab);
  if (debounced) tab._wheeling = true;
  const fromPreset = tab.range.preset || tab.range.fromPreset || null;
  tab.range = { start, end, fromPreset };
  propagateRange(tab);
  if (chart) chart.setScale("x", { min: start, max: end }); // instant visual feedback
  clearTimeout(zoomTimer);
  if (debounced) {
    zoomTimer = setTimeout(() => { tab._wheeling = false; loadData(tab); }, 300);
  } else {
    loadData(tab);
  }
  renderToolbar();
  renderNavigator();
  saveState();
}

function jumpToNow() {
  const tab = activeTab();
  if (tab.range.preset) { // presets are relative: just re-resolve
    loadData(tab);
    renderToolbar();
    return;
  }
  const span = tab.range.end - tab.range.start;
  const now = Date.now() / 1000;
  setAbsoluteRange(tab, now - span, now, false, true);
}

function toggleLive() {
  const tab = activeTab();
  if (!tab.live && liveDisabledReason(tab)) return; // button is disabled
  tab.live = !tab.live;
  if (tab.live) jumpToNow();
  renderToolbar();
  saveState();
}

// Auto intervals are sized by the server from the points budget, so they can
// never run away however wide the window. A manual interval bypasses that
// budget - it is the only way a request can ask for millions of points - and
// the finest one in the tab decides.
function finestManualInterval(tab) {
  const manual = tab.tags.map((t) => Number(t.interval)).filter((n) => n > 0);
  return manual.length ? Math.min(...manual) : null;
}

// Widest window that can still be fetched. Beyond this the server rejects the
// request outright ("too many points requested"), so panning and zooming clamp
// to it rather than letting the fetch fail.
function maxSpanFor(tab) {
  const step = finestManualInterval(tab);
  return step == null ? Infinity : step * DATA_MAX_POINTS;
}

function liveDisabledReason(tab) {
  const step = finestManualInterval(tab);
  if (step == null) return null;
  const { start, end } = resolveRange(tab);
  const points = (end - start) / step;
  if (points <= LIVE_MAX_POINTS) return null;
  return `Live is off: each refresh would ask for ${Math.round(points).toLocaleString("no")} points per tag`;
}

// Pinning a tag to a finer interval can make an already-live tab illegal.
// Switch it off there and then, rather than leaving the button green with a
// contradictory tooltip until the next tick notices.
function enforceLiveGuard(tab) {
  if (!tab.live || !liveDisabledReason(tab)) return false;
  tab.live = false;
  return true;
}

// One global ticker; only the active tab follows now. Skipped while the page
// is hidden - the next visible tick catches up because the window is
// recomputed from the wall clock.
function liveTick() {
  const tab = activeTab();
  if (!tab || !tab.live || document.hidden) return;
  if (enforceLiveGuard(tab)) { // a manual interval turned the refresh huge
    renderToolbar();
    saveState();
    return;
  }
  // Skip ticks that cannot contain a new plot bucket yet: with a 60 s
  // aggregate interval only every sixth 10 s tick can show a new point.
  const r = rt(tab);
  if (r.end && r.intervalS && Date.now() / 1000 - r.end < r.intervalS) return;
  if (tab.range.preset) { // presets are relative: just re-resolve
    loadData(tab);
    renderToolbar();
    return;
  }
  // Slide the absolute window to end at now, without touching zoom history.
  const span = tab.range.end - tab.range.start;
  const now = Date.now() / 1000;
  tab.range = { start: now - span, end: now, fromPreset: tab.range.fromPreset };
  propagateRange(tab);
  if (chart) chart.setScale("x", { min: now - span, max: now });
  loadData(tab);
  renderToolbar();
}

function propagateRange(fromTab) {
  if (!fromTab.linked) return;
  for (const tab of state.tabs) {
    if (tab.id === fromTab.id || !tab.linked) continue;
    tab.range = JSON.parse(JSON.stringify(fromTab.range));
    const r = runtime.get(tab.id);
    if (r) { r.data = null; r.raw = null; } // refetch lazily when activated
  }
}

/* -------------------------------------------------------------------- tabs */

function renderTabs() {
  const container = $("tabs");
  container.innerHTML = "";
  for (const tab of state.tabs) {
    const node = el("div", "tab" + (tab.id === state.activeTabId ? " active" : ""));
    node.title = tab.name; // names ellipsize when the strip gets tight
    node.appendChild(el("span", "name", tab.name));
    const close = el("button", "close", "×");
    close.title = "Close tab";
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab.id); });
    node.appendChild(close);
    node.addEventListener("click", () => switchTab(tab.id));
    node.addEventListener("dblclick", () => {
      const name = prompt("Tab name:", tab.name);
      if (name) { tab.name = name.trim().slice(0, 60) || tab.name; renderTabs(); saveState(); }
    });
    container.appendChild(node);
  }
  $("link-ranges-cb").checked = !!activeTab().linked;
  // innerHTML was rebuilt, so the strip scrolled back to the start: put the
  // active tab back in view before measuring what ends up clipped.
  revealActiveTab();
}

function revealActiveTab() {
  const active = $("tabs").querySelector(".tab.active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  updateTabOverflow();
}

// Tabs shrink to a floor (see .tab in style.css) and only then does the strip
// scroll, so past a certain count some tabs sit outside it. Measured with
// client rects because #tabs is not a positioned ancestor, which would make
// offsetLeft and scrollLeft refer to different origins.
function clippedTabs() {
  const container = $("tabs");
  const box = container.getBoundingClientRect();
  const out = [];
  state.tabs.forEach((tab, i) => {
    const node = container.children[i];
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.left < box.left - 1 || rect.right > box.right + 1) out.push(tab);
  });
  return out;
}

// Keeps the edge fades and the "» N" button in sync with what is out of view.
function updateTabOverflow() {
  const container = $("tabs");
  const maxScroll = container.scrollWidth - container.clientWidth;
  container.classList.toggle("fade-left", container.scrollLeft > 1);
  container.classList.toggle("fade-right", container.scrollLeft < maxScroll - 1);
  const hidden = clippedTabs().length;
  const btn = $("tab-overflow");
  btn.textContent = `» ${hidden}`;
  btn.classList.toggle("hidden", hidden === 0);
}

// Doubles as a tab switcher: every tab is listed, the ones out of view marked.
// Nothing is disabled - the active tab can itself be scrolled out of sight,
// and picking it then has to be the way back to it.
function openTabMenu(e) {
  const clipped = new Set(clippedTabs().map((t) => t.id));
  openMenu(e, state.tabs.map((tab) => [
    tab.name,
    tab.id === state.activeTabId ? "active" : clipped.has(tab.id) ? "out of view" : null,
    () => (tab.id === state.activeTabId ? revealActiveTab() : switchTab(tab.id)),
  ]));
}

function initTabbar() {
  const container = $("tabs");
  $("tab-overflow").addEventListener("click", openTabMenu);
  container.addEventListener("scroll", updateTabOverflow);
  new ResizeObserver(updateTabOverflow).observe(container);
  // A horizontal strip with no horizontal wheel is awkward to reach, so map
  // vertical wheel movement onto it.
  container.addEventListener("wheel", (e) => {
    if (container.scrollWidth <= container.clientWidth) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // real sideways wheel
    e.preventDefault();
    container.scrollLeft += e.deltaY;
    updateTabOverflow(); // don't wait for the scroll event to be delivered
  }, { passive: false });
}

function switchTab(id) {
  if (state.activeTabId === id) return;
  state.activeTabId = id;
  renderAll();
  saveState();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  state.tabs.splice(idx, 1);
  runtime.delete(id);
  if (!state.tabs.length) {
    const tab = newTab("Plot 1");
    state.tabs.push(tab);
    state.activeTabId = tab.id;
  } else if (state.activeTabId === id) {
    state.activeTabId = state.tabs[Math.min(idx, state.tabs.length - 1)].id;
  }
  renderAll();
  saveState();
}

function addTab(tab) {
  tab = tab || newTab();
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  renderAll();
  saveState();
  return tab;
}

function setLinked(checked) {
  const tab = activeTab();
  tab.linked = checked;
  if (checked) {
    // Join the group: adopt the range of an already-linked tab.
    const other = state.tabs.find((t) => t.id !== tab.id && t.linked);
    if (other) {
      pushHistory(tab);
      tab.range = JSON.parse(JSON.stringify(other.range));
      loadData(tab);
      renderToolbar();
    }
  }
  saveState();
}

/* -------------------------------------------------------------------- tags */

function nextColor(tab) {
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
function ensureDescriptions(tab) {
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
function ensureUnits(tab) {
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
async function insertTags(tab, tags, at) {
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

async function duplicateTag(uid) {
  const tab = activeTab();
  const src = byUid(tab, uid);
  if (!src) return;
  const copy = { ...src, uid: newUid(), maps: src.maps.slice() };
  await insertTag(tab, copy, tab.tags.indexOf(src) + 1);
}

function removeTags(tab, uids) {
  const dropped = new Set(uids);
  const gone = tab.tags.filter((t) => dropped.has(t.uid));
  if (!gone.length) return;
  tab.tags = tab.tags.filter((t) => !dropped.has(t.uid));
  if (dropped.has(tab.axisUid)) {
    tab.axisUid = tab.tags.length ? tab.tags[0].uid : null;
  }
  hidePopover();
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

function removeTag(uid) {
  removeTags(activeTab(), [uid]);
}

// The tag list will exist in two places - the pill strip and the settings
// table - and they must never disagree, so nothing renders one without the
// other. renderTagTable() joins this in step 4.
function renderTags() {
  renderTagbar();
}

function renderTagbar() {
  const bar = $("tagbar");
  bar.innerHTML = "";
  const tab = activeTab();
  for (const tag of tab.tags) {
    const pill = el("div", "pill" + (tag.uid === tab.axisUid ? " axis" : "") +
      (tag.visible === false ? " hidden-tag" : ""));
    pill.style.color = tag.color;
    pill.title = `${tag.description} [${tag.unit}]\nClick: use for grid · Dot: hide/show · ⚙: scale, sampling, map`;

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
    gear.title = "Tag settings";
    gear.addEventListener("click", (e) => { e.stopPropagation(); showPopover(tag, pill); });
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

/* -- tag settings popover ------------------------------------------------- */

// The pill currently representing a tag. renderTagbar() rebuilds every pill,
// so an element captured earlier can be detached - and a detached element
// measures as 0x0 at the origin, which would throw the popover into the
// top-left corner.
function pillFor(tag) {
  const index = activeTab().tags.indexOf(tag);
  return index >= 0 ? $("tagbar").children[index] : null;
}

function showPopover(tag, anchor) {
  const tab = activeTab();
  const pop = $("pill-popover");
  pop.innerHTML = "";

  const title = el("div", "row");
  title.appendChild(el("strong", null, tag.name));
  title.appendChild(el("span", "dim", tag.unit));
  pop.appendChild(title);

  const mkRow = (label, control) => {
    const row = el("div", "row");
    row.appendChild(el("span", null, label));
    row.appendChild(control);
    pop.appendChild(row);
  };

  // Colour is pure presentation: nothing is refetched when it changes.
  const swatches = el("div", "swatches");
  const applyColor = (value) => {
    setTagField(tab, tag, "color", value);
    showPopover(tag, anchor); // move the marker onto the new colour
  };
  const taken = new Set(tab.tags.filter((t) => t !== tag).map((t) => t.color));
  for (const color of PALETTE) {
    const swatch = el("button", "swatch" + (color === tag.color ? " on" : "") +
      (taken.has(color) ? " taken" : ""));
    swatch.style.background = color;
    swatch.title = taken.has(color) ? `${color} (used by another tag)` : color;
    swatch.addEventListener("click", () => applyColor(color));
    swatches.appendChild(swatch);
  }
  mkRow("Colour", swatches);

  const custom = el("input");
  custom.type = "color";
  custom.value = tag.color || PALETTE[0];
  custom.title = "Any colour outside the palette";
  custom.addEventListener("change", () => applyColor(custom.value));
  mkRow("Custom", custom);

  // Maps cost a server call per tag, so they are looked up when first needed.
  if (!tag.maps.length && !tag._mapsChecked) {
    tag._mapsChecked = true;
    apiGetMaps(tag.name).then((maps) => {
      if (maps.length) {
        tag.maps = maps;
        // Sources that don't report units up front (Aspen) supply them here.
        const current = maps.find((m) => m.name === (tag.map || maps[0].name));
        if (!tag.unit) {
          if (current && current.unit) {
            tag.unit = current.unit;
            renderTags();
          } else {
            ensureUnit(tab, tag);
          }
        }
        saveState();
        if (!pop.classList.contains("hidden")) showPopover(tag, anchor);
      }
    }).catch(() => {});
  }

  // Map selection (IP21 record map, e.g. CA_I OUTPUT)
  if (tag.maps.length > 1) {
    const select = el("select");
    const favored = tag.maps.filter((m) => favoriteMaps.includes(m.name));
    const mkOption = (m) => {
      const opt = el("option", null, m.name);
      opt.value = m.name;
      return opt;
    };
    if (favored.length && favored.length < tag.maps.length) {
      // Favourites first, without touching tag.maps itself.
      const favGroup = document.createElement("optgroup");
      favGroup.label = "Favourites";
      for (const m of orderedMaps(favored)) favGroup.appendChild(mkOption(m));
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
    const selected = tag.map || tag.maps[0].name;
    select.value = selected;
    select.addEventListener("change", () => setTagField(tab, tag, "map", select.value));

    // Star the selected map so it sorts first for every tag that has it.
    const star = el("button", "star" + (favoriteMaps.includes(selected) ? " on" : ""),
      favoriteMaps.includes(selected) ? "\u2605" : "\u2606");
    star.title = "Favourite maps sort first everywhere, and are stored in the server's env file";
    star.addEventListener("click", async () => {
      const names = favoriteMaps.includes(selected)
        ? favoriteMaps.filter((n) => n !== selected)
        : [...favoriteMaps, selected];
      if (await saveFavorites(names)) showPopover(tag, anchor);
    });

    const wrap = el("span", "map-row");
    wrap.appendChild(select);
    wrap.appendChild(star);
    mkRow("Map", wrap);
  } else if (!tag.maps.length) {
    // Live Aspen source does not list maps: free-text entry.
    const input = el("input");
    input.type = "text";
    input.placeholder = "default map";
    if (tag.map) input.value = tag.map;
    input.addEventListener("change", () => setTagField(tab, tag, "map", input.value.trim()));
    mkRow("Map", input);
  }

  // Sample type + aggregate interval (individual per tag)
  const sampleSel = el("select");
  for (const s of SAMPLES) {
    const opt = el("option", null, s.label);
    opt.value = s.value;
    sampleSel.appendChild(opt);
  }
  sampleSel.value = tag.sample;
  sampleSel.addEventListener("change", () =>
    setTagField(tab, tag, "sample", sampleSel.value));
  mkRow("Sampling", sampleSel);

  const intervalSel = el("select");
  for (const item of INTERVALS) {
    const opt = el("option", null, item.label);
    opt.value = item.value;
    intervalSel.appendChild(opt);
  }
  intervalSel.value = tag.interval;
  intervalSel.addEventListener("change", () =>
    setTagField(tab, tag, "interval", intervalSel.value));
  mkRow("Interval", intervalSel);

  const stepCb = el("input");
  stepCb.type = "checkbox";
  stepCb.checked = !!tag.step;
  stepCb.addEventListener("change", () =>
    setTagField(tab, tag, "step", stepCb.checked));
  mkRow("Stepped", stepCb);

  const mkNum = (label, key) => {
    const input = el("input");
    input.type = "number";
    input.step = "any";
    input.placeholder = "auto";
    if (tag[key] != null) input.value = tag[key];
    input.addEventListener("change", () =>
      setTagField(tab, tag, key, parseFloat(input.value)));
    mkRow(label, input);
  };
  mkNum("Scale min", "min");
  mkNum("Scale max", "max");

  const auto = el("button", null, "Auto scale");
  auto.addEventListener("click", () => {
    autoScale(tab, tag);
    hidePopover();
  });
  pop.appendChild(auto);

  const anchorEl = anchor && anchor.isConnected ? anchor : pillFor(tag);
  if (!anchorEl) { hidePopover(); return; }
  const rect = anchorEl.getBoundingClientRect();
  pop.style.left = `${Math.min(rect.left, window.innerWidth - 230)}px`;
  pop.style.top = `${rect.bottom + 6}px`;
  pop.classList.remove("hidden");
}

/* -- tag settings --------------------------------------------------------- */

// Every tag setting goes through here, so the pills, the settings table and
// anything else that edits a tag agree on what a change actually costs:
// colour and scale only redraw, while sampling, interval and map mean a new
// request to the historian.
function setTagFields(tab, tag, patch) {
  let chart = false, fetch = false, live = false, nav = false;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "visible") {
      tag.visible = value !== false;
      chart = true;
    } else if (key === "color") {
      tag.color = value;
      // The navigator band draws from a snapshot of the colour, taken when its
      // context was fetched, so a recolour has to be handed to it directly.
      const r = rt(tab);
      if (r.navTagUid === tag.uid) r.navColor = value;
      chart = nav = true;
    } else if (key === "step") {
      tag.step = !!value;
      chart = true;
    } else if (key === "min" || key === "max") {
      tag[key] = Number.isFinite(value) ? value : null;
      chart = true;
    } else if (key === "sample") {
      tag.sample = value;
      fetch = true;
    } else if (key === "interval") {
      tag.interval = normalizeInterval(value);
      fetch = live = true;
    } else if (key === "map") {
      // maps[0] is the default and is stored as null, so the two spellings of
      // "the default map" cannot read as two different traces.
      const defaultName = tag.maps.length ? tag.maps[0].name : "";
      tag.map = !value || value === defaultName ? null : value;
      applyMapUnit(tag, tag.maps.find((m) => m.name === (tag.map || defaultName)));
      ensureUnit(tab, tag);
      fetch = true;
    }
  }
  // A manually pinned interval decides whether live is allowed at all.
  if (live) { enforceLiveGuard(tab); renderToolbar(); }
  renderTags();
  // Never both: a refetch leaves the old data on screen until the answer
  // lands, which is what keeps a sampling change from flickering.
  if (fetch) loadData(tab);
  else if (chart) renderChart();
  if (nav) renderNavigator();
  saveState();
}

function setTagField(tab, tag, key, value) {
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

function hidePopover() { $("pill-popover").classList.add("hidden"); }

document.addEventListener("pointerdown", (e) => {
  const pop = $("pill-popover");
  if (!pop.classList.contains("hidden") && !pop.contains(e.target) &&
      !e.target.closest(".pill")) {
    hidePopover();
  }
  const menu = $("context-menu");
  if (!menu.classList.contains("hidden") && !menu.contains(e.target) &&
      !e.target.closest(".pill")) {
    hideContextMenu();
  }
});

/* ------------------------------------------------------------ context menu */

// Opens #context-menu at the event position with the given items, where an
// item is [label, shortcut, action, disabled] and null is a separator.
function openMenu(e, items) {
  const menu = $("context-menu");
  menu.innerHTML = "";
  for (const spec of items) {
    if (!spec) { menu.appendChild(el("div", "sep")); continue; }
    const [label, key, action, disabled] = spec;
    const item = el("div", "menu-item" + (disabled ? " disabled" : ""));
    item.appendChild(el("span", null, label));
    if (key) item.appendChild(el("span", "key", key));
    item.addEventListener("click", () => { hideContextMenu(); action(); });
    menu.appendChild(item);
  }
  // Measure the menu while invisible so the clamp tracks its real size.
  menu.style.visibility = "hidden";
  menu.classList.remove("hidden");
  const left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
  const top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;
  menu.style.visibility = "";
}

function showContextMenu(e, tAtCursor) {
  const tab = activeTab();
  const items = [];
  const mkItem = (label, key, action, disabled) =>
    items.push([label, key, action, disabled]);

  mkItem("Add scooter here", "dbl-click", () => addScooterAt(tAtCursor));
  mkItem("Delete all scooters", null, () => {
    tab.scooters = [];
    mountScooters();
    saveState();
  }, !tab.scooters.length);
  items.push(null);
  mkItem("Zoom back", "Esc", popHistory, !(tab.history && tab.history.length));
  mkItem("Reset zoom", null, resetZoom);
  items.push(null);

  const r = rt(tab);
  const noData = !r.raw || !exportTags(tab, r).length;
  const pair = outermostScooters(tab);
  mkItem("Export CSV (visible window)", null, () => {
    const cur = currentXRange();
    exportCsvRange(cur.start, cur.end);
  }, noData);
  mkItem("Export CSV (between scooters)", null, () => {
    exportCsvRange(pair.t0, pair.t1);
  }, noData || !pair);
  mkItem("Average between scooters", null, () => {
    showAverageDialog(pair.t0, pair.t1);
  }, noData || !pair);

  openMenu(e, items);
}

/* ------------------------------------------------------- tag clipboard */

// Fallback for when the system clipboard is unavailable or unreadable.
let tagClipboard = null;

const CLIP_KEY = "ip21ExplorerTags";

// Tags travel as plain JSON text, so they can be pasted between tabs, windows
// and even machines. uid and color are dropped: copies always get fresh ones.
function tagsToClipText(tags) {
  const strip = ({ uid, color, _mapsChecked, ...rest }) => rest;
  return JSON.stringify({ [CLIP_KEY]: tags.map(strip) }, null, 2);
}

function tagsFromClipText(text) {
  try {
    const parsed = JSON.parse(text);
    const tags = parsed && parsed[CLIP_KEY];
    return Array.isArray(tags) && tags.every((t) => t && t.name) ? tags : null;
  } catch (e) {
    return null;
  }
}

function copyTags(tags) {
  if (!tags.length) return;
  const text = tagsToClipText(tags);
  tagClipboard = text;
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

// Pasted tags keep their settings but get fresh identity, and move onto a free
// map when they would otherwise land on one that is already plotted.
async function pasteTags(tags) {
  if (!tags || !tags.length) return;
  const tab = activeTab();
  const built = [];
  for (const src of tags) {
    const tag = makeTag(src);
    tag.map = src.map ?? null;
    tag.min = src.min ?? null;
    tag.max = src.max ?? null;
    tag.visible = src.visible !== false;
    tag.step = src.step === true;
    tag.sample = src.sample || "INT";
    tag.interval = src.interval || "auto";
    built.push(tag);
  }
  await insertTags(tab, built);
}

async function pasteFromClipboard() {
  let text = null;
  if (navigator.clipboard && navigator.clipboard.readText) {
    text = await navigator.clipboard.readText().catch(() => null);
  }
  const tags = tagsFromClipText(text || "") || tagsFromClipText(tagClipboard || "");
  if (!tags) { showError("No copied tags on the clipboard"); return; }
  pasteTags(tags);
}

function showPillMenu(e, tag) {
  const tab = activeTab();
  openMenu(e, [
    ["Copy tag", "Ctrl+C", () => copyTags([tag])],
    ["Copy all tags", null, () => copyTags(tab.tags), !tab.tags.length],
    ["Duplicate tag", null, () => duplicateTag(tag.uid)],
    ["Paste tags", "Ctrl+V", pasteFromClipboard],
    null,
    ["Remove tag", null, () => removeTag(tag.uid)],
  ]);
}

function hideContextMenu() { $("context-menu").classList.add("hidden"); }

/* ---------------------------------------------------------------- scooters */

function addScooterAt(t) {
  const tab = activeTab();
  tab.scooters.push({ t });
  mountScooters();
  saveState();
}

function mountScooters() {
  if (!chart) return;
  for (const s of scooterEls) { s.line.remove(); s.box.remove(); }
  scooterEls = [];
  const tab = activeTab();
  tab.scooters.forEach((scooter, i) => {
    const line = el("div", "scooter-line");
    const box = el("div", "scooter-box");
    chart.over.appendChild(line);
    chart.over.appendChild(box);
    scooterEls.push({ line, box });
    line.addEventListener("pointerdown", (e) => beginScooterDrag(e, scooter, i));
    box.addEventListener("pointerdown", (e) => beginBoxDrag(e, scooter, i));
    // Keep uPlot's drag-select from starting when grabbing a scooter.
    line.addEventListener("mousedown", (e) => e.stopPropagation());
    box.addEventListener("mousedown", (e) => e.stopPropagation());
  });
  positionScooters();
}

function beginScooterDrag(e, scooter, index) {
  if (e.target.closest(".close")) return;
  e.preventDefault();
  e.stopPropagation();
  const els = scooterEls[index];
  els.line.classList.add("dragging");
  els.line.setPointerCapture(e.pointerId);
  const overRect = chart.over.getBoundingClientRect();
  const cur = currentXRange();

  const onMove = (ev) => {
    let t = chart.posToVal(ev.clientX - overRect.left, "x");
    t = Math.max(cur.start, Math.min(cur.end, t));
    scooter.t = t;
    positionScooter(index);
  };
  const onUp = (ev) => {
    els.line.classList.remove("dragging");
    els.line.releasePointerCapture(ev.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    saveState();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// Dragging the readout box moves it vertically, so it can be pulled out of
// the way of the trends. The offset is persisted per scooter.
function beginBoxDrag(e, scooter, index) {
  if (e.target.closest(".close")) return;
  e.preventDefault();
  e.stopPropagation();
  const els = scooterEls[index];
  els.box.classList.add("dragging");
  els.box.setPointerCapture(e.pointerId);
  const startY = e.clientY;
  const startDy = scooter.dy || 0;

  const onMove = (ev) => {
    scooter.dy = startDy + (ev.clientY - startY);
    positionScooter(index);
  };
  const onUp = (ev) => {
    els.box.classList.remove("dragging");
    els.box.releasePointerCapture(ev.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    saveState();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function positionScooters() {
  const tab = activeTab();
  if (!chart || !tab) return;
  tab.scooters.forEach((_, i) => positionScooter(i));
}

function positionScooter(index) {
  const tab = activeTab();
  const scooter = tab.scooters[index];
  const els = scooterEls[index];
  if (!scooter || !els || !chart) return;
  const r = rt(tab);
  const plotWidth = chart.over.clientWidth;
  const x = chart.valToPos(scooter.t, "x");

  if (x < 0 || x > plotWidth) {
    els.line.style.display = "none";
    els.box.style.display = "none";
    return;
  }
  els.line.style.display = "";
  els.box.style.display = "";
  els.line.style.left = `${x}px`;

  // Readout content
  els.box.innerHTML = "";
  const head = el("div", "head");
  head.appendChild(el("span", "time", fmtTime(scooter.t, true)));
  const close = el("button", "close", "×");
  close.title = "Remove scooter";
  close.addEventListener("pointerdown", (e) => e.stopPropagation());
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    tab.scooters.splice(index, 1);
    mountScooters();
    saveState();
  });
  head.appendChild(close);
  els.box.appendChild(head);
  appendValueRows(els.box, tab, r, scooter.t);

  // Place the box beside the line, flipping side near the right edge.
  const boxWidth = els.box.offsetWidth || 180;
  const left = x + 10 + boxWidth > plotWidth ? x - boxWidth - 10 : x + 10;
  els.box.style.left = `${Math.max(0, left)}px`;
  const maxTop = Math.max(0, chart.over.clientHeight - (els.box.offsetHeight || 60));
  const top = 8 + index * 26 + (scooter.dy || 0);
  els.box.style.top = `${Math.min(maxTop, Math.max(0, top))}px`;
}

/* -------------------------------------------------------- export / analysis */

// CSV dialect: semicolon separator + decimal comma, so the file opens
// directly in Norwegian Excel. Values keep full precision (no fmtVal).
const CSV_SEP = ";";

// Number.prototype.toString is locale-independent (always "."), so a plain
// replace is safe for the decimal comma.
function csvNum(v) {
  return String(v).replace(".", ",");
}

// RFC 4180 quoting. Mandatory for headers: tag keys are "TAG;MAP", which
// contains the separator.
function csvField(s) {
  if (/[";\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Local wall-clock time, unambiguous in Excel and matching the UI's display.
function fmtCsvTime(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Visible tags that have data, in plot order (same filter as appendValueRows).
function exportTags(tab, r) {
  return tab.tags.filter(
    (tag) => tag.visible !== false && r.raw && r.raw[tag.uid]
  );
}

// The two outermost scooters by time (creation order is arbitrary), or null
// when fewer than two exist.
function outermostScooters(tab) {
  if (tab.scooters.length < 2) return null;
  const ts = tab.scooters.map((s) => s.t);
  return { t0: Math.min(...ts), t1: Math.max(...ts) };
}

function downloadText(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// One aligned grid over the visible tags' raw tables (they may have different
// time bases), rows limited to [t0, t1] inclusive. Missing samples become
// empty cells.
function buildCsv(tab, r, t0, t1) {
  const tags = exportTags(tab, r);
  if (!tags.length) return null;
  const tables = tags.map((tag) => {
    const raw = r.raw[tag.uid];
    return [raw.t, raw.v];
  });
  const joined = tables.length === 1 ? tables[0] : uPlot.join(tables);
  const header = ["Time", ...tags.map((tag) => {
    const unit = tag.unit ? ` (${tag.unit})` : "";
    return csvField(`${tagLabel(tab, tag)}${unit}`);
  })];
  const lines = [header.join(CSV_SEP)];
  for (let i = 0; i < joined[0].length; i++) {
    const t = joined[0][i];
    if (t < t0 || t > t1) continue;
    const row = [fmtCsvTime(t)];
    for (let s = 1; s < joined.length; s++) {
      const v = joined[s][i];
      row.push(v == null ? "" : csvNum(v));
    }
    lines.push(row.join(CSV_SEP));
  }
  return lines.join("\r\n");
}

// Exports whatever is loaded: during the wheel-zoom debounce the visible
// range can be slightly ahead of the fetched data, which is acceptable.
function exportCsvRange(t0, t1) {
  const tab = activeTab();
  const r = rt(tab);
  const csv = buildCsv(tab, r, t0, t1);
  if (csv == null) { showError("No visible tags to export"); return; }
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  downloadText(`ip21-export_${stamp}.csv`, csv, "text/csv;charset=utf-8");
}

// Per-tag stats between two times, from each tag's own raw arrays (the joined
// grid would inject nulls for foreign timestamps and skew the counts).
function statsBetween(tab, r, t0, t1) {
  return exportTags(tab, r).map((tag) => {
    const { t: ts, v: vs } = r.raw[tag.uid];
    let sum = 0, min = Infinity, max = -Infinity, n = 0;
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] < t0 || ts[i] > t1) continue;
      const v = vs[i];
      if (v == null || Number.isNaN(v)) continue;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      n++;
    }
    return n
      ? { tag, avg: sum / n, min, max, n }
      : { tag, avg: null, min: null, max: null, n: 0 };
  });
}

function showAverageDialog(t0, t1) {
  const tab = activeTab();
  const r = rt(tab);
  const dialog = $("avg-dialog");
  $("avg-range").textContent = `${fmtTime(t0, true)}  \u2192  ${fmtTime(t1, true)}`;
  const rows = $("avg-rows");
  rows.innerHTML = "";

  const head = el("div", "row head");
  head.appendChild(el("span", "dot"));
  head.appendChild(el("span", "name", ""));
  for (const label of ["Avg", "Min", "Max", "n"]) {
    head.appendChild(el("span", "val", label));
  }
  rows.appendChild(head);

  for (const s of statsBetween(tab, r, t0, t1)) {
    const row = el("div", "row");
    const dot = el("span", "dot");
    dot.style.background = s.tag.color;
    row.appendChild(dot);
    row.appendChild(el("span", "name", tagDisplay(tab, s.tag)));
    const unit = s.tag.unit ? ` ${s.tag.unit}` : "";
    row.appendChild(el("span", "val", s.n ? `${fmtVal(s.avg)}${unit}` : "\u2013"));
    row.appendChild(el("span", "val", s.n ? fmtVal(s.min) : "\u2013"));
    row.appendChild(el("span", "val", s.n ? fmtVal(s.max) : "\u2013"));
    row.appendChild(el("span", "val", String(s.n)));
    rows.appendChild(row);
  }
  dialog.showModal();
}

/* ------------------------------------------------------------------ search */

let searchTimer = null;
let searchSelection = -1;
let searchItems = [];
let searchAbort = null;

function renderSearchHint(text) {
  const results = $("search-results");
  if (document.activeElement !== $("tag-search")) return;
  results.innerHTML = "";
  results.appendChild(el("div", "none", text));
  searchItems = [];
  searchSelection = -1;
  results.classList.remove("hidden");
}

function initSearch() {
  const input = $("tag-search");
  const results = $("search-results");

  // The answer to the last query, so refocusing the field (or retyping the
  // same text) reopens the dropdown without asking the server again.
  let lastQuery = null;
  let lastAnswer = null;

  const doSearch = async () => {
    const q = input.value.trim();
    // A short query matches most of the historian, and every search costs the
    // IP21 server real work, so wait until it is specific enough.
    if (q.length < MIN_QUERY_LEN) {
      renderSearchHint(`Type at least ${MIN_QUERY_LEN} characters to search`);
      return;
    }
    if (q === lastQuery && lastAnswer) {
      renderSearchResults(lastAnswer);
      return;
    }
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    try {
      const answer = await apiSearchTags(q, searchAbort.signal);
      lastQuery = q;
      lastAnswer = answer;
      renderSearchResults(answer);
    } catch (e) { /* aborted or transient search error */ }
  };

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener("focus", doSearch);
  input.addEventListener("keydown", (e) => {
    if (results.classList.contains("hidden")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      searchSelection = Math.max(0, Math.min(searchItems.length - 1, searchSelection + dir));
      renderSearchSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (searchItems[searchSelection >= 0 ? searchSelection : 0]) {
        pickSearchResult(searchItems[searchSelection >= 0 ? searchSelection : 0]);
      }
    } else if (e.key === "Escape") {
      clearTimeout(searchTimer);
      results.classList.add("hidden");
      input.blur();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#search-box")) results.classList.add("hidden");
  });
}

function renderSearchResults(answer) {
  const tags = answer.tags || [];
  const results = $("search-results");
  // A late response must not reopen the dropdown after the field lost focus.
  if (document.activeElement !== $("tag-search")) return;
  results.innerHTML = "";
  searchItems = tags;
  searchSelection = tags.length ? 0 : -1;
  if (!tags.length) {
    results.appendChild(el("div", "none", "No matching tags"));
  }
  const current = new Set(activeTab().tags.map((t) => t.name));
  tags.forEach((tag) => {
    const item = el("div", "item");
    item.appendChild(el("span", "name", tag.name + (current.has(tag.name) ? " ✓" : "")));
    item.appendChild(el("span", "desc", tag.description));
    item.appendChild(el("span", "unit", tag.unit));
    item.addEventListener("click", () => pickSearchResult(tag));
    results.appendChild(item);
  });
  // The historian cannot always answer in full; say so rather than pretending
  // the list is complete.
  if (answer.note) results.appendChild(el("div", "none", answer.note));
  renderSearchSelection();
  results.classList.remove("hidden");
}

function renderSearchSelection() {
  const nodes = $("search-results").querySelectorAll(".item");
  nodes.forEach((n, i) => n.classList.toggle("selected", i === searchSelection));
}

function pickSearchResult(tag) {
  addTag(tag);
  $("tag-search").value = "";
  $("search-results").classList.add("hidden");
  $("tag-search").focus();
}

/* ----------------------------------------------------------------- toolbar */

function renderToolbar() {
  const tab = activeTab();

  // Preset buttons
  const presets = $("presets");
  presets.innerHTML = "";
  for (const preset of PRESETS) {
    const btn = el("button", tab.range.preset === preset.label ? "active" : "", preset.label);
    btn.addEventListener("click", () => setPreset(preset.label));
    presets.appendChild(btn);
  }

  // Custom range inputs reflect the resolved range
  const { start, end } = resolveRange(tab);
  // Not while typing: rewriting the field under the caret loses the edit.
  for (const [id, t] of [["range-start", start], ["range-end", end]]) {
    if (document.activeElement !== $(id)) $(id).value = fmtTime(t, true);
  }

  const liveBlocked = liveDisabledReason(tab);
  $("live-btn").classList.toggle("active", !!tab.live);
  $("live-btn").disabled = !tab.live && !!liveBlocked;
  $("live-btn").title = liveBlocked || "Follow now, refreshing every 10 s";

  const axisModeLabels = { stacked: "Axes: stacked", single: "Axes: one", all: "Axes: all" };
  $("axis-mode").textContent = axisModeLabels[tab.axisMode] || axisModeLabels.stacked;
  $("label-mode").textContent = (LABEL_MODES[state.labelMode] || LABEL_MODES.tag).label;
  $("nav-toggle").classList.toggle("active", !!state.navigator);
  $("link-ranges-cb").checked = !!tab.linked;
}

/* ------------------------------------------------------------- navigator */

// The band under the chart shows a wider span with the visible window drawn on
// top, so a window that landed slightly wrong can be dragged into place.
//
// It costs the historian one extra request, so the terms are strict: a single
// tag (the one whose grid is shown), a coarse 240 points, and a context only
// rebuilt when the window leaves it or the span changes materially. Panning
// inside the context is free, and the band can be switched off entirely.
const NAV_CONTEXT_FACTOR = 8;   // context span, as a multiple of the window
const NAV_POINTS = 240;         // coarse on purpose: this is a thumbnail
const NAV_HANDLE_PX = 10;       // grab width of the two edge handles

let navDrag = null;             // {mode, startX, start, end} while dragging

// The band tracks one tag, not all of them: several traces at thumbnail height
// would be unreadable, and each one costs another request. It follows the grid
// tag - the one whose axis is shown, picked by clicking its pill - so the
// choice is already visible in the tag bar, and the band names it too.
function navTag(tab) {
  return byUid(tab, tab.axisUid) || tab.tags.find((t) => t.visible !== false);
}

// Context for a window, centred on it. Clamped so it never reaches into the
// future further than the window already does.
function navContextFor(start, end) {
  const span = Math.max(1, end - start);
  const pad = span * (NAV_CONTEXT_FACTOR - 1) / 2;
  const limit = Math.max(end, Date.now() / 1000);
  let ctxEnd = Math.min(end + pad, limit);
  return { start: ctxEnd - span * NAV_CONTEXT_FACTOR, end: ctxEnd };
}

// One coarse request, and only when the current context can no longer serve
// the window. Everything else - dragging, live ticks inside the context - is
// answered from what is already loaded.
async function ensureNavData(tab) {
  const r = rt(tab);
  if (!state.navigator || !tab.tags.length) return;
  const { start, end } = resolveRange(tab);
  const span = end - start;
  const tag = navTag(tab);
  if (!tag) return;
  const fits = r.navStart != null && r.navTagUid === tag.uid &&
    start >= r.navStart && end <= r.navEnd &&
    r.navSpan && span <= r.navSpan * 2 && span >= r.navSpan / 2;
  if (fits) return;
  const ctx = navContextFor(start, end);
  r.navStart = ctx.start;
  r.navEnd = ctx.end;
  r.navSpan = span;
  r.navColor = tag.color;
  r.navTagUid = tag.uid;

  if (r.navAbort) r.navAbort.abort();
  r.navAbort = new AbortController();
  const seq = (r.navSeq = (r.navSeq || 0) + 1);
  const params = new URLSearchParams({
    tags: reqName(tag),
    start: String(ctx.start),
    end: String(ctx.end),
    sample: tag.sample,
    interval: "auto",
    points: String(NAV_POINTS),
  });
  try {
    const resp = await fetch(`/api/data?${params}`, { signal: r.navAbort.signal });
    if (!resp.ok) return;
    const body = await resp.json();
    if (seq !== r.navSeq) return; // superseded
    r.navData = body.series[reqName(tag)] || null;
    renderNavigator();
  } catch (e) { /* aborted or transient - the band just stays as it was */ }
}

function navCanvasRect() {
  const canvas = $("nav-canvas");
  return canvas.getBoundingClientRect();
}

// `preview` draws a window that is not committed yet, so a drag can be shown
// without touching tab.range - and therefore without fetching.
function renderNavigator(preview) {
  const band = $("navigator");
  band.classList.toggle("hidden", !state.navigator);
  if (!state.navigator) return;
  const tab = activeTab();
  const canvas = $("nav-canvas");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx2d = canvas.getContext("2d");
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, rect.width, rect.height);

  const r = rt(tab);
  if (r.navStart == null || !tab.tags.length) {
    ctx2d.fillStyle = "#8b93a3";
    ctx2d.font = "11px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx2d.fillText(tab.tags.length ? "Loading overview…" : "No tags to show", 8, 20);
    return;
  }
  const x = (t) => ((t - r.navStart) / (r.navEnd - r.navStart)) * rect.width;

  // Coarse trace of the one tag the band tracks
  if (r.navData && r.navData.t && r.navData.t.length) {
    const vs = r.navData.v.filter((v) => v != null);
    const lo = Math.min(...vs), hi = Math.max(...vs);
    const range = hi - lo || 1;
    const y = (v) => rect.height - 4 - ((v - lo) / range) * (rect.height - 12);
    ctx2d.beginPath();
    let down = false;
    r.navData.t.forEach((t, i) => {
      const v = r.navData.v[i];
      if (v == null) { down = false; return; }
      if (down) ctx2d.lineTo(x(t), y(v)); else ctx2d.moveTo(x(t), y(v));
      down = true;
    });
    ctx2d.strokeStyle = r.navColor || "#4fc3f7";
    ctx2d.lineWidth = 1;
    ctx2d.stroke();
  }

  // Time ticks, so the band says where in the day you are
  ctx2d.fillStyle = "#8b93a3";
  ctx2d.font = "10px -apple-system, Segoe UI, Roboto, sans-serif";
  for (let i = 1; i < 6; i++) {
    const t = r.navStart + ((r.navEnd - r.navStart) * i) / 6;
    const px = x(t);
    ctx2d.fillStyle = "#2e3442";
    ctx2d.fillRect(px, 0, 1, rect.height);
    ctx2d.fillStyle = "#8b93a3";
    ctx2d.fillText(fmtTime(t, false), px + 3, rect.height - 3);
  }

  // Say which tag is drawn, so the band is never ambiguous about what it shows
  const shown = navTag(tab);
  if (shown) {
    ctx2d.fillStyle = shown.color || "#8b93a3";
    ctx2d.font = "10px -apple-system, Segoe UI, Roboto, sans-serif";
    ctx2d.fillText(tagLabel(tab, shown), 4, 11);
  }

  // Everything outside the window is dimmed; the window itself gets a frame
  const { start, end } = preview || resolveRange(tab);
  const x0 = Math.max(0, x(start)), x1 = Math.min(rect.width, x(end));
  ctx2d.fillStyle = "rgba(20, 22, 28, 0.66)";
  ctx2d.fillRect(0, 0, x0, rect.height);
  ctx2d.fillRect(x1, 0, rect.width - x1, rect.height);
  ctx2d.strokeStyle = "#4fc3f7";
  ctx2d.lineWidth = 1;
  ctx2d.strokeRect(x0 + 0.5, 0.5, Math.max(1, x1 - x0 - 1), rect.height - 1);
  // Handles drawn as wide as they are comfortable to grab.
  ctx2d.fillStyle = "#4fc3f7";
  ctx2d.fillRect(x0, 0, 3, rect.height);
  ctx2d.fillRect(x1 - 3, 0, 3, rect.height);
}

function navTimeAt(clientX) {
  const tab = activeTab();
  const r = rt(tab);
  const rect = navCanvasRect();
  const frac = (clientX - rect.left) / rect.width;
  return r.navStart + frac * (r.navEnd - r.navStart);
}

function onNavPointerDown(e) {
  const tab = activeTab();
  const r = rt(tab);
  if (r.navStart == null || !tab.tags.length) return;
  const rect = navCanvasRect();
  const { start, end } = resolveRange(tab);
  const x = (t) => ((t - r.navStart) / (r.navEnd - r.navStart)) * rect.width;
  const px = e.clientX - rect.left;
  const x0 = x(start), x1 = x(end);

  let mode;
  if (Math.abs(px - x0) <= NAV_HANDLE_PX) mode = "start";
  else if (Math.abs(px - x1) <= NAV_HANDLE_PX) mode = "end";
  else if (px > x0 && px < x1) mode = "move";
  else mode = "jump";

  if (mode === "jump") {
    // Clicking the empty part re-centres the window there.
    const span = end - start;
    const centre = navTimeAt(e.clientX);
    setAbsoluteRange(tab, centre - span / 2, centre + span / 2, false);
    return;
  }
  e.preventDefault();
  navDrag = { mode, startT: navTimeAt(e.clientX), start, end };
  $("nav-canvas").setPointerCapture(e.pointerId);
}

function onNavPointerMove(e) {
  if (!navDrag) return;
  const tab = activeTab();
  const delta = navTimeAt(e.clientX) - navDrag.startT;
  let start = navDrag.start, end = navDrag.end;
  if (navDrag.mode === "move") { start += delta; end += delta; }
  else if (navDrag.mode === "start") start = Math.min(navDrag.start + delta, end - MIN_SPAN_S);
  else end = Math.max(navDrag.end + delta, start + MIN_SPAN_S);
  // Preview only. The chart follows the drag for free, but nothing is asked of
  // the historian until the pointer is released, so one drag is exactly one
  // request however long it took - the wheel-zoom debounce would fire mid-drag
  // on anything slower than 300 ms.
  navDrag.preview = { start, end };
  if (chart) chart.setScale("x", { min: start, max: end });
  renderNavigator(navDrag.preview);
}

function onNavPointerUp(e) {
  if (!navDrag) return;
  const preview = navDrag.preview;
  navDrag = null;
  try { $("nav-canvas").releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
  if (preview) setAbsoluteRange(activeTab(), preview.start, preview.end, false);
}

function initNavigator() {
  const canvas = $("nav-canvas");
  canvas.addEventListener("pointerdown", onNavPointerDown);
  canvas.addEventListener("pointermove", onNavPointerMove);
  canvas.addEventListener("pointerup", onNavPointerUp);
  canvas.addEventListener("pointercancel", onNavPointerUp);
  // Cursor hints which of the three grabs is under the pointer.
  canvas.addEventListener("pointermove", (e) => {
    if (navDrag) return;
    const tab = activeTab();
    const r = rt(tab);
    if (r.navStart == null) { canvas.style.cursor = "default"; return; }
    const rect = navCanvasRect();
    const { start, end } = resolveRange(tab);
    const x = (t) => ((t - r.navStart) / (r.navEnd - r.navStart)) * rect.width;
    const px = e.clientX - rect.left;
    canvas.style.cursor =
      Math.abs(px - x(start)) <= NAV_HANDLE_PX || Math.abs(px - x(end)) <= NAV_HANDLE_PX
        ? "ew-resize"
        : (px > x(start) && px < x(end) ? "grab" : "pointer");
  });
  $("nav-toggle").addEventListener("click", () => {
    state.navigator = !state.navigator;
    renderToolbar();
    renderNavigator();
    if (state.navigator) ensureNavData(activeTab());
    saveState();
  });
}

/* -- time fields and calendar --------------------------------------------- */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
// Monday first, as the rest of Europe reads a calendar.
const WEEKDAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

let calendarField = null;   // the input the open calendar belongs to
let calendarMonth = null;   // first of the month on show

// Arrow keys step the unit under the caret, so the field keeps the one thing
// the native picker was actually good at.
function onTimeFieldKey(e) {
  const field = e.target;
  if (e.key === "Enter") { $("apply-range").click(); return; }
  if (e.key === "Escape") { hideCalendar(); field.blur(); return; }
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const t = parseTimeInput(field.value);
  if (t == null) return;
  e.preventDefault();
  const caret = field.selectionStart || 0;
  const seg = segmentAt(caret);
  const stepped = stepTime(t, seg.unit, e.key === "ArrowUp" ? 1 : -1);
  field.value = fmtTime(stepped, true);
  field.setSelectionRange(seg.from, seg.to);
  if (calendarField === field) showCalendar(field); // keep the grid in step
}

function hideCalendar() {
  $("calendar-popover").classList.add("hidden");
  calendarField = null;
}

// Writes back to the text field only - Apply stays the one thing that asks the
// historian for data, so a half-finished pick never triggers a fetch.
function showCalendar(field) {
  const pop = $("calendar-popover");
  const selected = parseTimeInput(field.value) ?? Date.now() / 1000;
  const sel = new Date(selected * 1000);
  if (calendarField !== field || !calendarMonth) {
    calendarMonth = new Date(sel.getFullYear(), sel.getMonth(), 1);
  }
  calendarField = field;
  pop.innerHTML = "";

  const setDate = (year, month, day) => {
    const cur = parseTimeInput(field.value) ?? Date.now() / 1000;
    const c = new Date(cur * 1000);
    const next = new Date(year, month, day, c.getHours(), c.getMinutes(), c.getSeconds());
    field.value = fmtTime(next.getTime() / 1000, true);
    showCalendar(field);
  };

  // Month header with the two steppers
  const head = el("div", "cal-head");
  const prev = el("button", "cal-nav", "\u2039");
  prev.title = "Previous month";
  prev.addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    showCalendar(field);
  });
  const next = el("button", "cal-nav", "\u203a");
  next.title = "Next month";
  next.addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    showCalendar(field);
  });
  head.appendChild(prev);
  head.appendChild(el("span", "cal-title",
    `${MONTH_NAMES[calendarMonth.getMonth()]} ${calendarMonth.getFullYear()}`));
  head.appendChild(next);
  pop.appendChild(head);

  // Day grid, six rows so the popover never changes height month to month
  const grid = el("div", "cal-grid");
  for (const name of WEEKDAY_NAMES) grid.appendChild(el("span", "cal-dow", name));
  const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const lead = (firstOfMonth.getDay() + 6) % 7; // getDay() is Sunday-first
  const today = new Date();
  const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  for (let i = 0; i < 42; i++) {
    const day = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1 + i - lead);
    const outside = day.getMonth() !== calendarMonth.getMonth();
    const cell = el("button",
      "cal-day" + (outside ? " outside" : "") +
      (isSameDay(day, today) ? " today" : "") +
      (isSameDay(day, sel) ? " on" : ""), String(day.getDate()));
    cell.addEventListener("click", () =>
      setDate(day.getFullYear(), day.getMonth(), day.getDate()));
    grid.appendChild(cell);
  }
  pop.appendChild(grid);

  // 24h clock, one box per unit
  const timeRow = el("div", "cal-time");
  const units = [
    ["hour", sel.getHours(), 23],
    ["minute", sel.getMinutes(), 59],
    ["second", sel.getSeconds(), 59],
  ];
  units.forEach(([unit, value, max], i) => {
    if (i) timeRow.appendChild(el("span", "dim", ":"));
    const box = el("input");
    box.type = "number";
    box.min = "0";
    box.max = String(max);
    box.value = pad2(value);
    box.addEventListener("change", () => {
      const n = Math.max(0, Math.min(max, parseInt(box.value, 10) || 0));
      const cur = parseTimeInput(field.value) ?? Date.now() / 1000;
      const c = new Date(cur * 1000);
      if (unit === "hour") c.setHours(n);
      else if (unit === "minute") c.setMinutes(n);
      else c.setSeconds(n);
      field.value = fmtTime(c.getTime() / 1000, true);
      showCalendar(field);
    });
    timeRow.appendChild(box);
  });
  pop.appendChild(timeRow);

  const nowBtn = el("button", null, "Now");
  nowBtn.addEventListener("click", () => {
    field.value = fmtTime(Date.now() / 1000, true);
    calendarMonth = null;
    showCalendar(field);
  });
  pop.appendChild(nowBtn);

  // Anchored under the field, kept inside the window like the pill popover.
  const rect = field.getBoundingClientRect();
  pop.classList.remove("hidden");
  pop.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 250))}px`;
  pop.style.top = `${rect.bottom + 6}px`;
}

function initTimeFields() {
  for (const id of ["range-start", "range-end"]) {
    const field = $(id);
    field.addEventListener("keydown", onTimeFieldKey);
    field.addEventListener("focus", () => showCalendar(field));
    field.addEventListener("click", () => showCalendar(field));
    // Normalise whatever was typed once the field is left, so the format the
    // fields show is always the one they document.
    field.addEventListener("blur", () => {
      const t = parseTimeInput(field.value);
      if (t != null) field.value = fmtTime(t, true);
    });
  }
  document.addEventListener("pointerdown", (e) => {
    const pop = $("calendar-popover");
    if (pop.classList.contains("hidden")) return;
    if (!pop.contains(e.target) && !e.target.closest(".timefield")) hideCalendar();
  });
}

function initToolbar() {
  initTimeFields();
  $("apply-range").addEventListener("click", () => {
    const start = parseTimeInput($("range-start").value);
    const end = parseTimeInput($("range-end").value);
    if (start == null || end == null || end <= start) {
      showError("Invalid custom time range");
      return;
    }
    setAbsoluteRange(activeTab(), start, end, false);
  });

  $("now-btn").addEventListener("click", jumpToNow);
  $("live-btn").addEventListener("click", toggleLive);
  setInterval(liveTick, LIVE_INTERVAL_MS);

  $("label-mode").addEventListener("click", () => {
    state.labelMode = (LABEL_MODES[state.labelMode] || LABEL_MODES.tag).next;
    ensureDescriptions(activeTab()); // nothing was fetched while in tag mode
    renderToolbar();
    renderTags();
    positionScooters();
    saveState();
  });

  $("axis-mode").addEventListener("click", () => {
    const tab = activeTab();
    const cycle = { stacked: "single", single: "all", all: "stacked" };
    tab.axisMode = cycle[tab.axisMode] || "stacked";
    renderToolbar();
    renderChart();
    saveState();
  });

  $("add-scooter").addEventListener("click", () => {
    if (!chart) return;
    const cur = currentXRange();
    addScooterAt((cur.start + cur.end) / 2);
  });

  $("add-tab").addEventListener("click", () => addTab());
  $("link-ranges-cb").addEventListener("change", (e) => setLinked(e.target.checked));

  // A paste event carries the clipboard text without a permission prompt,
  // unlike navigator.clipboard.readText().
  document.addEventListener("paste", (e) => {
    const active = document.activeElement;
    if (active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName)) return;
    const tags = tagsFromClipText(e.clipboardData.getData("text") || "");
    if (tags) { e.preventDefault(); pasteTags(tags); }
  });

  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    const typing = active && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key === "c" && !typing &&
        !window.getSelection().toString()) {
      copyTags(activeTab().tags);
      return;
    }
    if (e.key !== "Escape") return;
    if (typing) return;
    if ($("open-dialog").open || $("save-dialog").open) return; // dialogs close themselves
    if (!$("context-menu").classList.contains("hidden")) { hideContextMenu(); return; }
    if (!$("pill-popover").classList.contains("hidden")) { hidePopover(); return; }
    popHistory();
  });
}

/* -------------------------------------------------------------- save / open */

const CONFIG_VERSION = 3;

// A complete snapshot of a plot: everything needed to recreate it exactly,
// minus runtime-only identity (uid) and caches (_mapsChecked).
function tabToConfig(tab, name) {
  const strip = ({ uid, _mapsChecked, ...rest }) => rest;
  return {
    version: CONFIG_VERSION,
    name: name || tab.name,
    labels: (tab.labels || []).slice(),
    tags: tab.tags.map(strip),
    axisMode: tab.axisMode,
    axisTag: (byUid(tab, tab.axisUid) || {}).name || null,
    // Index disambiguates which copy of a repeated tag holds the grid.
    axisIndex: tab.tags.findIndex((t) => t.uid === tab.axisUid),
    linked: !!tab.linked,
    live: !!tab.live,
    scooters: (tab.scooters || []).map((sc) => ({ t: sc.t, dy: sc.dy || 0 })),
    range: tab.range.preset
      ? { preset: tab.range.preset }
      : { start: tab.range.start, end: tab.range.end, fromPreset: tab.range.fromPreset || null },
  };
}

function configToTab(name, config) {
  const tab = newTab(name);
  tab.tags = (config.tags || []).map((t) => {
    const tag = makeTag({
      name: normalizeTagName(t.name),
      description: t.description,
      unit: t.unit,
      maps: t.maps,
    });
    tag.map = t.map ?? null;
    tag.color = t.color || null;
    tag.min = t.min ?? null;
    tag.max = t.max ?? null;
    tag.visible = t.visible !== false;
    tag.step = t.step === true;
    tag.sample = t.sample || config.sample || "INT";
    tag.interval = normalizeInterval(t.interval || config.interval || "auto");
    return tag;
  });
  for (const tag of tab.tags) {
    if (!tag.color) tag.color = nextColor(tab);
  }
  tab.axisMode = !config.axisMode || config.axisMode === "multi"
    ? "stacked" : config.axisMode;
  // v3 stores the index, which survives repeated tag names; older files only
  // carry the name.
  const axisTag = config.axisIndex >= 0 && tab.tags[config.axisIndex]
    ? tab.tags[config.axisIndex]
    : tab.tags.find((t) => t.name === normalizeTagName(config.axisTag || ""));
  tab.axisUid = (axisTag || tab.tags[0] || {}).uid || null;
  tab.range = config.range && (config.range.preset || config.range.start != null)
    ? config.range : { preset: "24h" };
  tab.labels = Array.isArray(config.labels) ? config.labels.slice() : [];
  tab.linked = config.linked === true;
  tab.live = config.live === true;
  tab.scooters = Array.isArray(config.scooters)
    ? config.scooters.filter((sc) => sc && typeof sc.t === "number")
        .map((sc) => ({ t: sc.t, dy: sc.dy || 0 }))
    : [];
  return tab;
}

// Reads a plot config from any source (file, link, server) and warns when it
// comes from a newer build, whose extra fields we would silently drop.
function readConfig(name, config) {
  if (!config || typeof config !== "object" || !Array.isArray(config.tags)) {
    showError("Not a valid plot file");
    return null;
  }
  if (config.version > CONFIG_VERSION) {
    showError(`Plot "${name}" comes from a newer version; some settings may be lost`);
  }
  return configToTab(name, config);
}

function initDialogs() {
  $("save-plot").addEventListener("click", () => {
    $("save-name").value = activeTab().name;
    $("save-labels").value = (activeTab().labels || []).join(", ");
    $("save-dialog").showModal();
    $("save-name").select();
  });
  $("save-cancel").addEventListener("click", () => $("save-dialog").close());
  $("save-confirm").addEventListener("click", saveCurrentPlot);
  $("save-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveCurrentPlot(); }
  });

  $("save-labels").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveCurrentPlot(); }
  });

  $("open-plot").addEventListener("click", openPlotDialog);
  $("open-cancel").addEventListener("click", () => $("open-dialog").close());
  $("plot-search").addEventListener("input", renderPlotList);
  $("plot-open-all").addEventListener("click", openAllListedPlots);
  $("plot-download-all").addEventListener("click", downloadPlotBundle);
  $("plot-import").addEventListener("click", () => $("plot-file").click());
  $("plot-file").addEventListener("change", async (e) => {
    for (const file of e.target.files) await importPlotFile(file);
    e.target.value = "";
  });
  $("share-plot").addEventListener("click", copyShareLink);
  $("avg-close").addEventListener("click", () => $("avg-dialog").close());
}

/* -- plots API ----------------------------------------------------------- */

async function apiListPlots() {
  const resp = await fetch("/api/plots");
  return resp.ok ? (await resp.json()).plots : [];
}

async function apiGetPlot(name) {
  const resp = await fetch(`/api/plots/${encodeURIComponent(name)}`);
  return resp.ok ? resp.json() : null;
}

async function apiSavePlot(name, config) {
  const resp = await fetch(`/api/plots/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (resp.ok) return true;
  const detail = (await resp.json().catch(() => ({}))).detail;
  showError(detail || `could not save "${name}"`);
  return false;
}

async function apiDeletePlot(name) {
  await fetch(`/api/plots/${encodeURIComponent(name)}`, { method: "DELETE" });
}

function parseLabels(text) {
  return text.split(",").map((l) => l.trim()).filter(Boolean);
}

async function saveCurrentPlot() {
  const name = $("save-name").value.trim();
  if (!name) return;
  const tab = activeTab();
  tab.labels = parseLabels($("save-labels").value);
  // The name in the config must be the one it is saved under, not the old
  // tab name, or an exported file disagrees with itself.
  if (!(await apiSavePlot(name, tabToConfig(tab, name)))) return;
  tab.name = name;
  $("save-dialog").close();
  renderTabs();
  saveState();
}

let plotList = [];        // last listing from the server
let labelFilter = null;   // active label chip, null = show all

async function openPlotDialog() {
  if (!$("open-dialog").open) $("open-dialog").showModal();
  plotList = await apiListPlots();
  renderPlotList();
}

function filteredPlots() {
  const q = $("plot-search").value.trim().toLowerCase();
  return plotList.filter((p) =>
    (!labelFilter || (p.labels || []).includes(labelFilter)) &&
    (!q || p.name.toLowerCase().includes(q))
  );
}

function renderPlotList() {
  // Label chips, from every label in use
  const chips = $("plot-labels");
  chips.innerHTML = "";
  const all = [...new Set(plotList.flatMap((p) => p.labels || []))].sort();
  if (labelFilter && !all.includes(labelFilter)) labelFilter = null;
  for (const label of ["All", ...all]) {
    const value = label === "All" ? null : label;
    const chip = el("button", "chip" + (labelFilter === value ? " active" : ""), label);
    chip.addEventListener("click", () => { labelFilter = value; renderPlotList(); });
    chips.appendChild(chip);
  }

  const listNode = $("plot-list");
  listNode.innerHTML = "";
  const plots = filteredPlots();
  $("plot-open-all").textContent = plots.length ? `Open all (${plots.length})` : "Open all";
  $("plot-open-all").disabled = !plots.length;
  if (!plots.length) {
    listNode.appendChild(el("div", "none",
      plotList.length ? "No plots match the filter." : "No saved plots yet."));
    return;
  }
  for (const plot of plots) {
    const item = el("div", "plot-item");
    item.appendChild(el("span", "name", plot.name));
    for (const label of plot.labels || []) {
      item.appendChild(el("span", "tag-label", label));
    }
    item.appendChild(el("span", "date", fmtTime(plot.modified, false)));

    const dl = el("button", "del", "\u2b07");
    dl.title = "Download this plot";
    dl.addEventListener("click", async (e) => {
      e.stopPropagation();
      const config = await apiGetPlot(plot.name);
      if (config) {
        downloadText(`${plot.name}.ip21plot.json`,
          JSON.stringify(config, null, 2), "application/json");
      }
    });
    item.appendChild(dl);

    const del = el("button", "del", "\ud83d\uddd1");
    del.title = "Delete saved plot";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete saved plot "${plot.name}"?`)) return;
      await apiDeletePlot(plot.name);
      openPlotDialog();
    });
    item.appendChild(del);

    item.addEventListener("click", async () => {
      const tab = await loadSavedPlot(plot.name);
      if (!tab) return;
      $("open-dialog").close();
      addTab(tab);
    });
    listNode.appendChild(item);
  }
}

// A saved plot as a ready-to-add tab, or null if it cannot be read.
async function loadSavedPlot(name) {
  const config = await apiGetPlot(name);
  if (!config) return null;
  return readConfig(name, config);
}

// Opens every plot the dialog is currently listing - i.e. matching the label
// chip and the name filter - one tab each, the same set "Download all" acts on.
async function openAllListedPlots() {
  const plots = filteredPlots();
  if (!plots.length) { showError("No plots to open"); return; }
  if (plots.length > OPEN_ALL_CONFIRM &&
      !confirm(`Open ${plots.length} plots, one tab each?`)) return;
  const tabs = [];
  let skipped = 0;
  for (const plot of plots) {
    const tab = await loadSavedPlot(plot.name);
    if (tab) tabs.push(tab); else skipped++;
  }
  if (!tabs.length) { showError("Could not read any of the listed plots"); return; }
  $("open-dialog").close();
  // Added in one go: addTab() re-renders and re-activates per call, which
  // would leave only the last plot showing after a whole list.
  state.tabs.push(...tabs);
  state.activeTabId = tabs[0].id;
  renderAll();
  saveState();
  if (skipped) showError(`Opened ${tabs.length} plot(s), skipped ${skipped}`);
}

/* -- share links ---------------------------------------------------------- */

// Everything the plot needs travels in the URL fragment: there is no shared
// server to store links on, and a fragment is never sent to the server.
function b64urlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function gzip(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Cached catalog data (maps, descriptions) is dropped: it is re-fetched on
// demand and would otherwise dominate the link length.
function shareConfig(tab) {
  const config = tabToConfig(tab);
  config.tags = config.tags.map(({ maps, description, ...rest }) => rest);
  return config;
}

async function buildShareLink(tab) {
  const json = new TextEncoder().encode(JSON.stringify(shareConfig(tab)));
  const packed = await gzip(json);
  const payload = packed ? `z${b64urlEncode(packed)}` : `r${b64urlEncode(json)}`;
  return `${location.origin}${location.pathname}#p=${payload}`;
}

async function copyShareLink() {
  const link = await buildShareLink(activeTab());
  try {
    await navigator.clipboard.writeText(link);
    showNotice("Share link copied to the clipboard", 2500);
  } catch (e) {
    // Clipboard blocked: put the link in the URL bar so it can be copied.
    location.hash = link.slice(link.indexOf("#") + 1);
    showError("Share link is in the address bar");
  }
}

// Opens a plot from #p=... and clears the fragment, so a reload does not keep
// re-adding the same tab.
async function openSharedPlot() {
  const match = /^#p=(.+)$/.exec(location.hash);
  if (!match) return false;
  history.replaceState(null, "", location.pathname);
  try {
    const payload = match[1];
    const bytes = b64urlDecode(payload.slice(1));
    const json = payload[0] === "z" ? await gunzip(bytes) : bytes;
    const config = JSON.parse(new TextDecoder().decode(json));
    const tab = readConfig(config.name || "Shared plot", config);
    if (!tab) return false;
    addTab(tab);
    return true;
  } catch (e) {
    showError("Could not read the shared plot link");
    return false;
  }
}

/* -- import / export ------------------------------------------------------ */

const BUNDLE_FORMAT = "ip21-explorer-plots";

// Downloads the plots currently listed (i.e. matching the filter) as one file.
async function downloadPlotBundle() {
  const plots = filteredPlots();
  if (!plots.length) { showError("No plots to download"); return; }
  const entries = [];
  for (const plot of plots) {
    const config = await apiGetPlot(plot.name);
    if (config) entries.push({ name: plot.name, config });
  }
  const bundle = { format: BUNDLE_FORMAT, version: 1, plots: entries };
  const suffix = labelFilter ? `-${labelFilter}` : "";
  downloadText(`ip21-plots${suffix}.ip21plots.json`,
    JSON.stringify(bundle, null, 2), "application/json");
}

// A free name: "Plot", "Plot (2)", "Plot (3)"...
function freePlotName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; i < 500; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} ${Date.now()}`;
}

// Accepts both a single plot config and a bundle of them.
async function importPlotFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    showError(`${file.name} is not valid JSON`);
    return;
  }
  const entries = parsed && parsed.format === BUNDLE_FORMAT
    ? (Array.isArray(parsed.plots) ? parsed.plots : [])
    : [{ name: parsed.name || file.name.replace(/\.(ip21plot\.)?json$/i, ""), config: parsed }];

  const taken = new Set((await apiListPlots()).map((p) => p.name));
  let saved = 0, skipped = 0;
  for (const entry of entries) {
    const config = entry && entry.config;
    if (!config || !Array.isArray(config.tags)) { skipped++; continue; }
    const name = freePlotName(String(entry.name || "Imported plot").slice(0, 60), taken);
    if (await apiSavePlot(name, { ...config, name })) {
      taken.add(name);
      saved++;
    } else {
      skipped++;
    }
  }
  if (skipped) showError(`Imported ${saved} plot(s), skipped ${skipped}`);
  openPlotDialog();
}

/* -------------------------------------------------------------------- init */

function renderAll() {
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
