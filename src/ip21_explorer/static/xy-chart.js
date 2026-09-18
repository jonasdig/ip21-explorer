/* The XY plot: one tag against another, every point coloured by when it is.

   A trend answers "what happened"; this answers "how do these two move
   together, and has that changed". The colour is the whole point - without it
   a scatter of three days is a shapeless cloud - so the ramp runs over the
   loaded window rather than over the points, and a colour means the same
   moment wherever it appears. */

import { chartSize, renderChart, scaleRangeFn } from "./chart.js";
import { showContextMenu } from "./menu.js";
import { alignOnto, unionTimes } from "./resample.js";
import { activeTab, rt, saveState } from "./state.js";
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

// Which two tags are plotted, or why none are. The tick box in the table is
// the choice: it already means "this one is on the plot", and a plot of one
// tag against another can only mean two of them. Row order settles which is
// which, and xUid only says whether they have been swapped round.
export function xyPairTags(tab) {
  const shown = tab.tags.filter((t) => t.visible !== false);
  if (shown.length < 2) {
    return { hint: "XY: tick two tags in the table to plot them against each other." };
  }
  if (shown.length > 2) {
    return { hint: `XY: ${shown.length} tags are ticked - untick all but two.` };
  }
  const x = shown.find((t) => t.uid === tab.xUid) || shown[0];
  return { x, y: shown.find((t) => t !== x) };
}

// One point per timestamp either tag has, dropped where either side has
// nothing: a scatter has no line to break, so a hole is simply not a point.
export function xyPairs(tab, r, pair) {
  const rx = r.raw[pair.x.uid], ry = r.raw[pair.y.uid];
  if (!rx || !ry) return null;
  const inputs = [
    { t: rx.t, v: rx.v, step: !!pair.x.step },
    { t: ry.t, v: ry.v, step: !!pair.y.step },
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
  // uPlot's mode 2: every series carries its own x, so nothing is joined. The
  // timestamps ride along as a third column that uPlot never looks at.
  return xs.length ? { data: [null, [xs, ys, stamps]], colors } : null;
}

function axisLabel(tab, tag) {
  return tag.unit ? `${tagLabel(tab, tag)} [${tag.unit}]` : tagLabel(tab, tag);
}

// uPlot draws nothing itself here (the series' paths return null): one colour
// per series is the one thing it cannot do, and that is the whole feature.
// Canvas coordinates are device pixels - uPlot puts no transform on its
// context - so every size is multiplied by the ratio, as axis-gutter.js does.
function drawXyPoints(pairs) {
  return (u) => {
    const [xs, ys] = u.data[1];
    const { ctx, bbox } = u;
    const dpr = window.devicePixelRatio || 1;
    const px = new Array(xs.length), py = new Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      px[i] = u.valToPos(xs[i], "x", true);
      py[i] = u.valToPos(ys[i], "y", true);
    }
    u._xyPx = { px, py };   // the cursor hit test measures against these

    ctx.save();
    ctx.beginPath();
    ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
    ctx.clip();
    // The trail first, under the dots: a cloud of points says where the
    // process has been, the line says which way it was going.
    ctx.lineWidth = dpr;
    ctx.globalAlpha = 0.3;
    for (let i = 1; i < px.length; i++) {
      ctx.beginPath();
      ctx.moveTo(px[i - 1], py[i - 1]);
      ctx.lineTo(px[i], py[i]);
      ctx.strokeStyle = pairs.colors[i];
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const rad = XY_DOT_R * dpr;
    for (let i = 0; i < px.length; i++) {
      ctx.beginPath();
      ctx.arc(px[i], py[i], rad, 0, TAU);
      ctx.fillStyle = pairs.colors[i];
      ctx.fill();
    }
    ctx.restore();
  };
}

// uPlot's own nearest-point search is one-dimensional; a scatter needs both.
// Measured against the pixels the dots were actually drawn at, so what
// lights up is what the pointer is over.
function xyNearestIdx(u, seriesIdx) {
  if (seriesIdx !== 1 || !u._xyPx) return null;
  const dpr = window.devicePixelRatio || 1;
  const cx = (u.cursor.left + u.bbox.left / dpr) * dpr;
  const cy = (u.cursor.top + u.bbox.top / dpr) * dpr;
  if (u.cursor.left < 0 || u.cursor.top < 0) return null;
  const { px, py } = u._xyPx;
  const limit = (XY_HOVER_PX * dpr) ** 2;
  let best = null, bestDist = limit;
  for (let i = 0; i < px.length; i++) {
    const dx = px[i] - cx, dy = py[i] - cy;
    const dist = dx * dx + dy * dy;
    if (dist <= bestDist) { bestDist = dist; best = i; }
  }
  return best;
}

function onXyCursor(u) {
  const box = $("hover-box");
  const idx = u.cursor.idxs ? u.cursor.idxs[1] : null;
  if (idx == null) { box.classList.add("hidden"); return; }
  const tab = activeTab();
  const r = rt(tab);
  const pair = xyPairTags(tab);
  if (!pair.x) { box.classList.add("hidden"); return; }
  const [xs, ys, ts] = u.data[1];

  box.innerHTML = "";
  const head = el("div", "time");
  const when = el("span", "dot");
  when.style.background = xyColor((ts[idx] - r.start) / ((r.end - r.start) || 1));
  head.appendChild(when);
  head.appendChild(el("span", null, fmtTime(ts[idx], true)));
  box.appendChild(head);
  for (const [tag, value] of [[pair.x, xs[idx]], [pair.y, ys[idx]]]) {
    const row = el("div", "row");
    const dot = el("span", "dot");
    dot.style.background = tag.color;
    row.appendChild(dot);
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

export function xyOpts(tab, r, pair, pairs) {
  const size = chartSize();
  const grid = { stroke: "#232834", width: 1 };
  const ticks = { stroke: "#2e3442" };
  return {
    mode: 2,
    width: size.width,
    height: size.height,
    // time: false matters: the x scale would otherwise print dates on an axis
    // of process values, because mode 2 takes its x key from the facet.
    scales: {
      x: { time: false, range: scaleRangeFn(pair.x) },
      y: { time: false, range: scaleRangeFn(pair.y) },
    },
    series: [
      {},
      {
        facets: [{ scale: "x", auto: true }, { scale: "y", auto: true }],
        stroke: pair.y.color,
        paths: () => null,
      },
    ],
    axes: [
      { scale: "x", stroke: pair.x.color, grid, ticks, label: axisLabel(tab, pair.x), labelSize: 24 },
      { scale: "y", stroke: pair.y.color, grid, ticks, label: axisLabel(tab, pair.y), labelSize: 24 },
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
      draw: [drawXyPoints(pairs)],
      setCursor: [onXyCursor],
      ready: [onXyReady],
    },
  };
}

// The colour bar: what a colour means, in the same stops the dots are drawn
// from, so the two cannot drift apart.
export function renderXyLegend(r) {
  const bar = $("color-bar");
  bar.innerHTML = "";
  const strip = el("div", "strip");
  strip.style.background = xyGradient();
  bar.appendChild(strip);
  const labels = el("div", "labels");
  labels.appendChild(el("span", null, fmtTime(r.end, false)));
  labels.appendChild(el("span", null, fmtTime(r.start + (r.end - r.start) / 2, false)));
  labels.appendChild(el("span", null, fmtTime(r.start, false)));
  bar.appendChild(labels);
  bar.classList.remove("hidden");
}

export function hideXyLegend() { $("color-bar").classList.add("hidden"); }

export function toggleXyMode() {
  const tab = activeTab();
  tab.plotMode = isXyMode(tab) ? "time" : "xy";
  renderToolbar();
  renderChart();
  saveState();
}

// Nothing but row order distinguishes the two ticked rows, so remembering
// which one is on the x axis is the whole of "swap the axes".
export function swapXyAxes() {
  const tab = activeTab();
  const pair = xyPairTags(tab);
  if (!pair.x) return;
  tab.xUid = pair.y.uid;
  renderToolbar();
  renderChart();
  saveState();
}

// The button names the pair, so which two rows are plotted - and which way
// round - can be read without counting tick boxes.
export function xyModeLabel(tab) {
  if (!isXyMode(tab)) return "XY: off";
  const pair = xyPairTags(tab);
  return pair.x ? `XY: ${tagLabel(tab, pair.x)} \u2192 ${tagLabel(tab, pair.y)}` : "XY: on";
}
