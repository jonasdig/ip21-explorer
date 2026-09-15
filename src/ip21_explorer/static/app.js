/* IP21 Explorer frontend: tabs, tag search, uPlot chart, scooters, save/open. */
"use strict";

import {
  apiGetDescription, apiGetMaps, apiGetUnit, apiSearchTags, ensureFavorites,
  favoriteMaps, orderedMaps, saveFavorites,
} from "./api.js";
import { copyTags, pasteTags, tagsFromClipText } from "./clipboard.js";
import {
  DATA_MAX_POINTS, HISTORY_MAX, INTERVALS, LABEL_MODES, LIVE_INTERVAL_MS,
  LIVE_MAX_POINTS, MAX_SPAN_S, MIN_SPAN_S, PALETTE, PRESETS, SAMPLES,
} from "./constants.js";
import {
  hideContextMenu, openMenu, openSwatchMenu, showContextMenu, showPillMenu,
} from "./menu.js";
import { ensureNavData, initNavigator, renderNavigator } from "./navigator.js";
import { initDialogs } from "./plots.js";
import { initSearch } from "./search.js";
import { openSharedPlot } from "./share.js";
import {
  activeTab, byUid, loadState, makeTag, newTab, newUid, normalizeInterval,
  persistState, reqName, rt, runtime, saveState, saveTimer, state,
} from "./state.js";
import { initTimeFields } from "./timefields.js";
import {
  $, el, fmtSpan, fmtTime, fmtVal, intervalLabel, nearestValue, pad2,
  parseTimeInput, showError, showNotice,
} from "./util.js";

export let chart = null;           // uPlot instance for the active tab

let scooterEls = [];        // [{line, box}] for the active tab

let zoomTimer = null;

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

export function resolveRange(tab) {
  if (tab.range.preset) {
    const preset = PRESETS.find((p) => p.label === tab.range.preset);
    const end = Date.now() / 1000;
    return { start: end - (preset ? preset.s : 86400), end };
  }
  return { start: tab.range.start, end: tab.range.end };
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

function pushHistory(tab) {
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

function setPreset(label) {
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

export function renderTabs() {
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

export function addTab(tab) {
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
function renderTags() {
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
function isEditingContext(node) {
  if (!node) return false;
  return ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName) || !!node.closest("#tag-table");
}

// Tab and Shift+Tab are left to the browser: its own order already runs left
// to right along a row and on into the next, skips the read-only spans, and
// lets focus out of the panel at either end. Enter and the arrows are what
// move between rows.
function onTagTableKey(e) {
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
function beginTableResize(e) {
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

function toggleTagTable() {
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

export function addScooterAt(t) {
  const tab = activeTab();
  tab.scooters.push({ t });
  mountScooters();
  saveState();
}

// Scooter elements live in the chart's overlay and go when the chart is
// destroyed, so this only drops the references to them.
function forgetScooterEls() {
  scooterEls = [];
}

export function mountScooters() {
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

export function renderToolbar() {
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
  $("table-toggle").classList.toggle("active", !!tab.tagTable);
  $("link-ranges-cb").checked = !!tab.linked;
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

  $("table-toggle").addEventListener("click", toggleTagTable);
  $("tag-table").addEventListener("keydown", onTagTableKey);
  $("tag-table").querySelector(".resize")
    .addEventListener("pointerdown", beginTableResize);

  $("add-tab").addEventListener("click", () => addTab());
  $("link-ranges-cb").addEventListener("change", (e) => setLinked(e.target.checked));

  // A paste event carries the clipboard text without a permission prompt,
  // unlike navigator.clipboard.readText().
  document.addEventListener("paste", (e) => {
    if (isEditingContext(document.activeElement)) return;
    const tags = tagsFromClipText(e.clipboardData.getData("text") || "");
    if (tags) { e.preventDefault(); pasteTags(tags); }
  });

  document.addEventListener("keydown", (e) => {
    const typing = isEditingContext(document.activeElement);
    if ((e.ctrlKey || e.metaKey) && e.key === "c" && !typing &&
        !window.getSelection().toString()) {
      copyTags(activeTab().tags);
      return;
    }
    if (e.key !== "Escape") return;
    if (typing) return;
    if ($("open-dialog").open || $("save-dialog").open) return; // dialogs close themselves
    if (!$("context-menu").classList.contains("hidden")) { hideContextMenu(); return; }
    popHistory();
  });
}

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
