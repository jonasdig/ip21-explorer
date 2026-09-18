/* The XY plot: tags against a shared x, every point coloured by when it is.

   A trend answers "what happened"; this answers "how do these two move
   together, and has that changed". The colour is the whole point - without it
   a scatter of three days is a shapeless cloud - so the ramp runs over the
   loaded window rather than over the points, and a colour means the same
   moment wherever it appears. */

import { chartSize, renderChart, scaleRangeFn } from "./chart.js";
import { LINE_DASHES, LINE_WIDTHS, XY_SYMBOLS } from "./constants.js";
import { showContextMenu } from "./menu.js";
import { alignOnto, unionTimes } from "./resample.js";
import { activeTab, rt, saveState, state } from "./state.js";
import { tagLabel } from "./tags.js";
import { renderToolbar } from "./toolbar.js";
import { $, el, fmtTime, fmtVal } from "./util.js";

const TAU = Math.PI * 2;
const XY_DOT_R = 2.5;      // CSS px
const XY_HOVER_PX = 14;    // how far the cursor may be from a point

// Viridis: sequential and colourblind-safe, and deliberately nothing like
// PALETTE, which is categorical - a tag's colour and a point's time must not
// be mistaken for each other.
const VIRIDIS = [
  [68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142],
  [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37],
];

export function isXyMode(tab) { return tab.plotMode === "xy"; }

// The colour for a fraction of the window, 0 = oldest.
export function xyColor(frac) {
  const x = frac <= 0 ? 0 : frac >= 1 ? 1 : frac;
  const pos = x * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(pos));
  const k = pos - i;
  const a = VIRIDIS[i], b = VIRIDIS[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},` +
    `${Math.round(a[1] + (b[1] - a[1]) * k)},` +
    `${Math.round(a[2] + (b[2] - a[2]) * k)})`;
}

function xyGradient() {
  const stops = VIRIDIS.map((c, i) =>
    `rgb(${c[0]},${c[1]},${c[2]}) ${Math.round((i / (VIRIDIS.length - 1)) * 100)}%`);
  return `linear-gradient(to top, ${stops.join(", ")})`;
}

// What is plotted, or why nothing is. The tick box in the table is the
// choice: every ticked row takes part, one of them on the shared x axis and
// each of the others as a series of its own against it - identical pumps into
// one header, say. xUid says which ticked row is x; the top one otherwise.
export function xySeriesTags(tab) {
  const shown = tab.tags.filter((t) => t.visible !== false);
  if (shown.length < 2) {
    return { hint: "XY: tick the x tag and at least one y tag in the table." };
  }
  const x = shown.find((t) => t.uid === tab.xUid) || shown[0];
  return { x, ys: shown.filter((t) => t !== x) };
}

// A series' symbol: the one chosen in its colour menu, or else one by its
// place among the y series, so two of them never look alike by default.
function symbolOf(tag, index) {
  return tag.symbol || XY_SYMBOLS[index % XY_SYMBOLS.length];
}

// The text stand-in for each symbol, for the hover box and the legend.
const SYMBOL_GLYPHS = {
  circle: "●", square: "■", triangle: "▲", diamond: "◆",
  cross: "✕", plus: "+",
};
export function symbolGlyph(symbol) { return SYMBOL_GLYPHS[symbol] || SYMBOL_GLYPHS.circle; }

// One point per timestamp either tag has, dropped where either side has
// nothing: a scatter has no line to break, so a hole is simply not a point.
function pairUp(r, x, y) {
  const rx = r.raw[x.uid], ry = r.raw[y.uid];
  if (!rx || !ry) return null;
  const inputs = [
    { t: rx.t, v: rx.v, step: !!x.step },
    { t: ry.t, v: ry.v, step: !!y.step },
  ];
  const ts = unionTimes(inputs.map((input) => input.t));
  const [xv, yv] = alignOnto(inputs, ts);
  const xs = [], ys = [], stamps = [], colors = [];
  const span = (r.end - r.start) || 1;
  for (let i = 0; i < ts.length; i++) {
    if (xv[i] == null || yv[i] == null) continue;
    xs.push(xv[i]);
    ys.push(yv[i]);
    stamps.push(ts[i]);
    colors.push(xyColor((ts[i] - r.start) / span));
  }
  return xs.length ? { cols: [xs, ys, stamps], colors } : null;
}

// Every y series against the shared x. uPlot's mode 2 lets each series carry
// its own x, so nothing is joined; the timestamps ride along as a third column
// uPlot never looks at. Series with nothing in common with x are left out.
export function xySeriesData(tab, r, set) {
  const series = [];
  set.ys.forEach((tag, i) => {
    const paired = pairUp(r, set.x, tag);
    if (paired) series.push({ tag, symbol: symbolOf(tag, i), ...paired });
  });
  return series.length
    ? { data: [null, ...series.map((one) => one.cols)], series }
    : null;
}

function axisLabel(tab, tag) {
  return tag.unit ? `${tagLabel(tab, tag)} [${tag.unit}]` : tagLabel(tab, tag);
}

// The y axis serves every series: one is named as before; several are listed,
// with their unit when they share one.
function yAxisLabel(tab, tags) {
  if (tags.length === 1) return axisLabel(tab, tags[0]);
  const units = [...new Set(tags.map((t) => t.unit).filter(Boolean))];
  let names = tags.map((t) => tagLabel(tab, t)).join(", ");
  if (names.length > 60) names = `${tags.length} series`;
  return units.length === 1 ? `${names} [${units[0]}]` : names;
}

// The y scale honours the table's Min/Max over all the series at once: the
// lowest Min anyone set and the highest Max, each left automatic otherwise.
function sharedRange(tags) {
  const mins = tags.map((t) => t.min).filter((v) => v != null);
  const maxs = tags.map((t) => t.max).filter((v) => v != null);
  return scaleRangeFn({
    min: mins.length ? Math.min(...mins) : null,
    max: maxs.length ? Math.max(...maxs) : null,
  });
}

// Canvas coordinates are device pixels - uPlot puts no transform on its
// context - so every size is scaled by the ratio, as axis-gutter.js does.
function drawSymbol(ctx, symbol, x, y, r) {
  ctx.beginPath();
  if (symbol === "square") {
    ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
  } else if (symbol === "triangle") {
    ctx.moveTo(x, y - r * 1.2);
    ctx.lineTo(x + r * 1.1, y + r * 0.8);
    ctx.lineTo(x - r * 1.1, y + r * 0.8);
    ctx.closePath();
  } else if (symbol === "diamond") {
    ctx.moveTo(x, y - r * 1.3);
    ctx.lineTo(x + r * 1.1, y);
    ctx.lineTo(x, y + r * 1.3);
    ctx.lineTo(x - r * 1.1, y);
    ctx.closePath();
  } else if (symbol === "cross" || symbol === "plus") {
    // Line symbols: stroked, in the point's own colour.
    const d = r * 1.15;
    if (symbol === "cross") {
      ctx.moveTo(x - d, y - d); ctx.lineTo(x + d, y + d);
      ctx.moveTo(x + d, y - d); ctx.lineTo(x - d, y + d);
    } else {
      ctx.moveTo(x - d * 1.2, y); ctx.lineTo(x + d * 1.2, y);
      ctx.moveTo(x, y - d * 1.2); ctx.lineTo(x, y + d * 1.2);
    }
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = Math.max(1.5, r * 0.55);
    ctx.stroke();
    return;
  } else {
    ctx.arc(x, y, r, 0, TAU);
  }
  ctx.fill();
}

// uPlot draws nothing itself here (the series' paths return null): a colour
// per point is the one thing it cannot do, and that is the whole feature.
function drawXyPoints(plot) {
  return (u) => {
    const { ctx, bbox } = u;
    const dpr = window.devicePixelRatio || 1;
    u._xyPx = [];
    ctx.save();
    ctx.beginPath();
    ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
    ctx.clip();
    plot.series.forEach((one, k) => {
      const [xs, ys] = u.data[k + 1];
      const px = new Array(xs.length), py = new Array(xs.length);
      for (let i = 0; i < xs.length; i++) {
        px[i] = u.valToPos(xs[i], "x", true);
        py[i] = u.valToPos(ys[i], "y", true);
      }
      u._xyPx.push({ px, py });   // the cursor hit test measures against these

      // The trail, under the dots, in the series' own colour and line: the
      // dots already carry the time, so the line is free to say which series.
      const tag = one.tag;
      if (tag.lineStyle !== "none" && px.length > 1) {
        const width = (LINE_WIDTHS[tag.lineWidth] || LINE_WIDTHS.normal) * dpr;
        ctx.lineWidth = width;
        ctx.setLineDash((LINE_DASHES[tag.lineStyle] || []).map((d) => d * width));
        ctx.lineCap = tag.lineStyle === "dot" ? "round" : "butt";
        ctx.lineJoin = "round";
        ctx.strokeStyle = tag.color;
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.moveTo(px[0], py[0]);
        for (let i = 1; i < px.length; i++) ctx.lineTo(px[i], py[i]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
      const rad = XY_DOT_R * dpr;
      for (let i = 0; i < px.length; i++) {
        ctx.fillStyle = one.colors[i];
        drawSymbol(ctx, one.symbol, px[i], py[i], rad);
      }
    });
    ctx.restore();
  };
}

// uPlot asks for a point per series; a scatter wants the one nearest the
// pointer over all of them, or every series would light up a ring of its
// own. So the first ask settles it for this pointer position and the rest
// read the answer: only the winning series gets an index.
function xyNearestIdx(u, seriesIdx) {
  if (!u._xyPx || u.cursor.left < 0 || u.cursor.top < 0) return null;
  if (seriesIdx === 1) {
    const dpr = window.devicePixelRatio || 1;
    const cx = u.cursor.left * dpr + u.bbox.left;
    const cy = u.cursor.top * dpr + u.bbox.top;
    let best = null, bestDist = (XY_HOVER_PX * dpr) ** 2;
    u._xyPx.forEach(({ px, py }, k) => {
      for (let i = 0; i < px.length; i++) {
        const dx = px[i] - cx, dy = py[i] - cy;
        const dist = dx * dx + dy * dy;
        if (dist <= bestDist) { bestDist = dist; best = { series: k + 1, idx: i }; }
      }
    });
    u._xyHit = best;
  }
  const hit = u._xyHit;
  return hit && hit.series === seriesIdx ? hit.idx : null;
}

function onXyCursor(u) {
  const box = $("hover-box");
  const hit = u._xyHit;
  const plot = u._xyPlot;
  if (!hit || !plot) { box.classList.add("hidden"); return; }
  const tab = activeTab();
  const r = rt(tab);
  const one = plot.series[hit.series - 1];
  const [xs, ys, ts] = u.data[hit.series];
  const idx = hit.idx;

  box.innerHTML = "";
  const head = el("div", "time");
  const when = el("span", "dot");
  when.style.background = xyColor((ts[idx] - r.start) / ((r.end - r.start) || 1));
  head.appendChild(when);
  head.appendChild(el("span", null, fmtTime(ts[idx], true)));
  box.appendChild(head);
  const rows = [[plot.x, xs[idx], null], [one.tag, ys[idx], one.symbol]];
  for (const [tag, value, symbol] of rows) {
    const row = el("div", "row");
    const mark = el("span", symbol ? "glyph" : "dot", symbol ? symbolGlyph(symbol) : null);
    if (symbol) mark.style.color = tag.color; else mark.style.background = tag.color;
    row.appendChild(mark);
    row.appendChild(el("span", "name", tagLabel(tab, tag)));
    row.appendChild(el("span", "val", `${fmtVal(value)} ${tag.unit}`));
    box.appendChild(row);
  }
  box.classList.remove("hidden");
}

// No scooter and no time under the pointer here, so the menu is opened
// without one: the chart menu leaves out what it cannot do.
function onXyReady(u) {
  u.over.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e, null);
  });
}

export function xyOpts(tab, r, set, plot) {
  const size = chartSize();
  const grid = { stroke: "#232834", width: 1 };
  const ticks = { stroke: "#2e3442" };
  const ys = plot.series.map((one) => one.tag);
  plot.x = set.x;
  return {
    mode: 2,
    width: size.width,
    height: size.height,
    // time: false matters: the x scale would otherwise print dates on an axis
    // of process values, because mode 2 takes its x key from the facet.
    scales: {
      x: { time: false, range: scaleRangeFn(set.x) },
      y: { time: false, range: sharedRange(ys) },
    },
    series: [
      {},
      ...plot.series.map((one) => ({
        facets: [{ scale: "x", auto: true }, { scale: "y", auto: true }],
        stroke: one.tag.color,
        paths: () => null,
      })),
    ],
    axes: [
      { scale: "x", stroke: set.x.color, grid, ticks, label: axisLabel(tab, set.x), labelSize: 24 },
      { scale: "y", stroke: ys.length === 1 ? ys[0].color : "#8b93a3", grid, ticks,
        label: yAxisLabel(tab, ys), labelSize: 24 },
    ],
    legend: { show: false },
    cursor: {
      // Drag zooms the two value scales; double-click puts them back. Neither
      // touches the time window, which is still the toolbar's and the
      // navigator's business.
      drag: { x: true, y: true, uni: 10, setScale: true },
      points: { size: 10, width: 2, stroke: () => "#e8eaf0", fill: () => "transparent" },
      dataIdx: xyNearestIdx,
    },
    hooks: {
      draw: [drawXyPoints(plot)],
      setCursor: [onXyCursor],
      // The hover box needs to know which series is which; nothing asks for it
      // before the first draw is done.
      ready: [(u) => { u._xyPlot = plot; onXyReady(u); }],
    },
  };
}

// The colour bar: what a colour means, in the same stops the dots are drawn
// from so the two cannot drift apart - and, under it, which symbol and line
// belong to which series.
export function renderXyLegend(r, plot) {
  const bar = $("color-bar");
  bar.innerHTML = "";
  const ramp = el("div", "ramp");
  const strip = el("div", "strip");
  strip.style.background = xyGradient();
  ramp.appendChild(strip);
  const labels = el("div", "labels");
  labels.appendChild(el("span", null, fmtTime(r.end, false)));
  labels.appendChild(el("span", null, fmtTime(r.start + (r.end - r.start) / 2, false)));
  labels.appendChild(el("span", null, fmtTime(r.start, false)));
  ramp.appendChild(labels);
  bar.appendChild(ramp);
  if (plot && plot.series.length > 1) {
    const list = el("div", "series");
    const tab = activeTab();
    for (const one of plot.series) {
      const item = el("div", "item");
      const glyph = el("span", "glyph", symbolGlyph(one.symbol));
      glyph.style.color = one.tag.color;
      item.appendChild(glyph);
      item.appendChild(el("span", "name", tagLabel(tab, one.tag)));
      list.appendChild(item);
    }
    bar.appendChild(list);
  }
  bar.classList.remove("hidden");
  placeXyLegend();
}

export function hideXyLegend() { $("color-bar").classList.add("hidden"); }

// Where the colour bar sits: wherever it was last dropped, as fractions of the
// plot area so it keeps its place when the window changes size, or the CSS
// default (bottom left) until it has been moved. Always kept inside the plot.
export function placeXyLegend() {
  const bar = $("color-bar");
  const pos = state.xyLegendPos;
  if (bar.classList.contains("hidden")) return;
  if (!pos) {
    bar.style.left = bar.style.top = bar.style.bottom = "";
    return;
  }
  const wrap = $("chart-wrap").getBoundingClientRect();
  const maxX = Math.max(0, wrap.width - bar.offsetWidth);
  const maxY = Math.max(0, wrap.height - bar.offsetHeight);
  bar.style.left = `${Math.min(maxX, Math.max(0, pos.x * wrap.width))}px`;
  bar.style.top = `${Math.min(maxY, Math.max(0, pos.y * wrap.height))}px`;
  bar.style.bottom = "auto";
}

// Dragged like the scooter boxes, because wherever it starts it will sooner
// or later sit on top of the points someone wants to look at. Double-click
// puts it back in its corner.
export function initXyLegend() {
  const bar = $("color-bar");
  bar.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const wrap = $("chart-wrap").getBoundingClientRect();
    const box = bar.getBoundingClientRect();
    const dx = e.clientX - box.left, dy = e.clientY - box.top;
    const onMove = (ev) => {
      state.xyLegendPos = {
        x: (ev.clientX - dx - wrap.left) / wrap.width,
        y: (ev.clientY - dy - wrap.top) / wrap.height,
      };
      placeXyLegend();
    };
    const onUp = () => {
      bar.removeEventListener("pointermove", onMove);
      bar.removeEventListener("pointerup", onUp);
      // Store where it actually ended up, after the clamp.
      const end = bar.getBoundingClientRect();
      state.xyLegendPos = {
        x: (end.left - wrap.left) / wrap.width,
        y: (end.top - wrap.top) / wrap.height,
      };
      saveState();
    };
    bar.addEventListener("pointermove", onMove);
    bar.addEventListener("pointerup", onUp);
  });
  bar.addEventListener("dblclick", () => {
    state.xyLegendPos = null;
    placeXyLegend();
    saveState();
  });
}

export function toggleXyMode() {
  const tab = activeTab();
  tab.plotMode = isXyMode(tab) ? "time" : "xy";
  renderToolbar();
  renderChart();
  saveState();
}

// Which ticked row the others are plotted against.
export function setXyAxis(uid) {
  const tab = activeTab();
  tab.xUid = uid;
  renderToolbar();
  renderChart();
  saveState();
}

// The button names what is on show, so it can be read without counting tick
// boxes: the pair when there is one y, the count when there are several.
export function xyModeLabel(tab) {
  if (!isXyMode(tab)) return "XY: off";
  const set = xySeriesTags(tab);
  if (!set.x) return "XY: on";
  const ys = set.ys.length === 1 ? tagLabel(tab, set.ys[0]) : `${set.ys.length} series`;
  return `XY: ${tagLabel(tab, set.x)} \u2192 ${ys}`;
}
