/* Time windows: presets, zoom history, live mode and linked tabs. */

import { chart, loadData } from "./app.js";
import {
  DATA_MAX_POINTS, HISTORY_MAX, LIVE_MAX_POINTS, MIN_SPAN_S, PRESETS,
} from "./constants.js";
import { renderNavigator } from "./navigator.js";
import { activeTab, rt, runtime, saveState, state } from "./state.js";
import { renderToolbar } from "./toolbar.js";
import { fmtSpan, showNotice } from "./util.js";

let zoomTimer = null;

export function resolveRange(tab) {
  if (tab.range.preset) {
    const preset = PRESETS.find((p) => p.label === tab.range.preset);
    const end = Date.now() / 1000;
    return { start: end - (preset ? preset.s : 86400), end };
  }
  return { start: tab.range.start, end: tab.range.end };
}

export function pushHistory(tab) {
  tab.history = tab.history || [];
  tab.history.push(JSON.parse(JSON.stringify(tab.range)));
  if (tab.history.length > HISTORY_MAX) tab.history.shift();
}

export function popHistory() {
  const tab = activeTab();
  if (!tab.history || !tab.history.length) return;
  tab.live = false;
  tab.range = tab.history.pop();
  propagateRange(tab);
  loadData(tab);
  renderToolbar();
  saveState();
}

export function resetZoom() {
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

export function setPreset(label) {
  const tab = activeTab();
  pushHistory(tab);
  tab.range = { preset: label };
  propagateRange(tab);
  loadData(tab);
  renderToolbar();
  saveState();
}

export function setAbsoluteRange(tab, start, end, debounced, keepLive) {
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

export function jumpToNow() {
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

export function toggleLive() {
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

export function liveDisabledReason(tab) {
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
export function enforceLiveGuard(tab) {
  if (!tab.live || !liveDisabledReason(tab)) return false;
  tab.live = false;
  return true;
}

// One global ticker; only the active tab follows now. Skipped while the page
// is hidden - the next visible tick catches up because the window is
// recomputed from the wall clock.
export function liveTick() {
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
