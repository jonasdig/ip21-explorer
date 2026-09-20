/* The value gutter (Process Explorer style):
   All tags share a few horizontal gridlines; at each gridline the value of
   every visible tag is printed in a single narrow gutter, stacked vertically
   in the tag's color. Values are each tag's linear interpolation at that
   height, so they are not round numbers - exactly like Process Explorer. */

import { activeTab, byUid, rt } from "./state.js";

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
export function stackedGutter(tab, r) {
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

export function drawStackedGrid(u) {
  const tab = activeTab();
  if (!tab) return;
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

export function drawStackedLabels(u) {
  const tab = activeTab();
  if (!tab) return;
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
