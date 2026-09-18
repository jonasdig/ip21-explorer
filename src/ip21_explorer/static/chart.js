/* The uPlot chart: options, rendering, cursor readout and drag-zoom. */

import {
  drawStackedGrid, drawStackedLabels, stackedGutter,
} from "./axis-gutter.js";
import { MAX_SPAN_S, MIN_SPAN_S } from "./constants.js";
import { loadData } from "./data.js";
import { showContextMenu } from "./menu.js";
import {
  addScooterAt, forgetScooterEls, mountScooters, positionScooters,
} from "./scooters.js";
import { activeTab, byUid, reqName, rt } from "./state.js";
import { tagDisplay } from "./tags.js";
import { setAbsoluteRange } from "./timerange.js";
import { $, el, fmtTime, fmtVal, nearestValue, pad2 } from "./util.js";
import {
  hideXyLegend, isXyMode, renderXyLegend, xyModeLabel, xyOpts, xyPairTags,
  xyPairs,
} from "./xy-chart.js";

const EMPTY_HINT = "Search for tags above, or type a tag name in the table below.";

export let chart = null;           // uPlot instance for the active tab

export function chartSize() {
  const wrap = $("chart-wrap");
  return { width: Math.max(200, wrap.clientWidth - 8), height: Math.max(150, wrap.clientHeight - 8) };
}

// Shared with the XY plot, where both axes are value axes and the same
// per-tag Min/Max cells decide their range.
export function scaleRangeFn(tag) {
  return (u, min, max) => {
    if (tag.min != null && tag.max != null) return [tag.min, tag.max];
    if (min == null || max == null) return [0, 100];
    const pad = (max - min) * 0.07 || Math.abs(max || 1) * 0.05 || 1;
    return [tag.min != null ? tag.min : min - pad, tag.max != null ? tag.max : max + pad];
  };
}

// 24h clock tick labels; a tick where the local date changes (and the first
// tick) carries the date on a second line.
//
// The year is spelled out only when the window needs it, which is exactly when
// its two ends fall in different calendar years: anything wider than a year
// always does, and eleven months inside one year never does.
function xAxisValues(u, splits, axisIdx, foundSpace, foundIncr) {
  let prevDay = null;
  const withYear = new Date(u.scales.x.min * 1000).getFullYear()
    !== new Date(u.scales.x.max * 1000).getFullYear();
  return splits.map((t) => {
    const d = new Date(t * 1000);
    const dayLabel = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}` +
      (withYear ? `.${pad2(d.getFullYear() % 100)}` : "");
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
  hideXyLegend();
  target.innerHTML = "";
  $("hover-box").classList.add("hidden");

  if (!tab.tags.length) {
    showHint(EMPTY_HINT);
    return;
  }
  $("empty-hint").classList.add("hidden");

  // Gate on raw rather than on the joined table: a window where every tag
  // came back empty leaves r.data null, and asking again on every render was
  // a fetch loop with no way out. The error box already says what happened.
  if (!r.raw) { loadData(tab); return; }
  if (!r.data) return;

  if (isXyMode(tab)) {
    // No scooters and no stacked gutter here: both of them are about time.
    const pair = xyPairTags(tab, r);
    const pairs = pair && xyPairs(tab, r, pair);
    if (!pairs) { showHint("XY needs two tags with data in this window."); return; }
    chart = new uPlot(xyOpts(tab, r, pair, pairs), pairs.data, target);
    renderXyLegend(r);
    // The pair can be settled by fallback, and only now is it known.
    $("xy-mode").textContent = xyModeLabel(tab);
    return;
  }

  chart = new uPlot(makeOpts(tab, r), r.data, target);
  mountScooters();
}

function showHint(text) {
  $("empty-hint").textContent = text;
  $("empty-hint").classList.remove("hidden");
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
  // In XY mode the x scale holds process values, not seconds, so the loaded
  // window is the only honest answer - and the right one for a CSV export.
  if (chart && !isXyMode(tab) && chart.scales.x.min != null) {
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

// Instant feedback while a window is dragged or zoomed, before the answer
// lands. Guarded in one place because the XY plot's x scale is a value scale:
// setting it to epoch seconds there would blank the plot.
export function previewXRange(min, max) {
  if (chart && !isXyMode(activeTab())) chart.setScale("x", { min, max });
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
