/* The persisted app state: tabs and tags, their migration, and localStorage. */

import { INTERVALS, LABEL_MODES, STORAGE_KEY } from "./constants.js";
import { TAG_TABLE_DEFAULT_H, clampTableHeight } from "./tag-table.js";

export let state = null;      // { tabs: [...], activeTabId }
let tabSeq = 0;
let uidSeq = 0;
export const runtime = new Map();  // tab.id -> {raw, data, tagOrder, start, end, seq, abort}

export let saveTimer = null;

export function newUid() {
  uidSeq += 1;
  // The random suffix matters: uids are persisted but uidSeq restarts at 0 on
  // every load, and a collision would make two tags share one data slot.
  return `u${Date.now().toString(36)}_${uidSeq}_${Math.random().toString(36).slice(2, 7)}`;
}

export function newTab(name) {
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
    tagTable: false,          // settings table docked under the chart
    history: [],              // previous ranges, for zoom-back (not persisted)
  };
}

export function makeTag(info) {
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
export function normalizeTagName(name) {
  return name.replace(/\.(PV|SP|OUT)$/, "");
}

// Plots saved before the 4 s floor carry intervals this list no longer offers
// (1 s, 5 s, 10 s). Left alone, the dropdown would read "Auto" while the tag
// went on requesting 1 s, so snap anything unknown to the nearest offered
// value - which also enforces the floor, since 4 s is the smallest one.
export function normalizeInterval(value) {
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
  tab.tagTable = tab.tagTable === true;
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
  state = { tabs: [], activeTabId: null, labelMode: "tag", navigator: true,
            tagTableHeight: TAG_TABLE_DEFAULT_H };
  const tab = newTab("Plot 1");
  state.tabs.push(tab);
  state.activeTabId = tab.id;
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed.tabs || !parsed.tabs.length) return defaultState();
    state = parsed;
    if (!LABEL_MODES[state.labelMode]) state.labelMode = "tag";
    if (typeof state.navigator !== "boolean") state.navigator = true;
    state.tagTableHeight = clampTableHeight(state.tagTableHeight);
    for (const tab of state.tabs) migrateTab(tab, parsed);
    delete state.linkRanges;
    if (!state.tabs.some((t) => t.id === state.activeTabId)) {
      state.activeTabId = state.tabs[0].id;
    }
  } catch (e) {
    defaultState();
  }
}

export function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistState, 300);
}

export function persistState() {
  try {
    const json = JSON.stringify(state, (key, value) =>
      key === "history" || key === "_wheeling" || key === "_mapsChecked" ||
      key === "_unitChecked" || key === "_descChecked"
        ? undefined : value
    );
    localStorage.setItem(STORAGE_KEY, json);
  } catch (e) { /* storage unavailable - ad-hoc state just won't survive reload */ }
}

export function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

export function rt(tab) {
  let r = runtime.get(tab.id);
  if (!r) {
    r = { raw: null, data: null, tagOrder: [], start: 0, end: 0, seq: 0, abort: null };
    runtime.set(tab.id, r);
  }
  return r;
}

// Full "TAG;MAP" request identifier for a tag entry (bare name = default map).
export function reqName(tag) {
  return tag.map ? `${tag.name};${tag.map}` : tag.name;
}

function byName(tab, name) {
  return tab.tags.find((t) => t.name === name);
}

export function byUid(tab, uid) {
  return tab.tags.find((t) => t.uid === uid);
}
