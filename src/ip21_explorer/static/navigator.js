/* The navigator band under the chart. */

import { chart } from "./chart.js";
import { MIN_SPAN_S } from "./constants.js";
import { activeTab, byUid, reqName, rt, saveState, state } from "./state.js";
import { tagLabel } from "./tags.js";
import { resolveRange, setAbsoluteRange } from "./timerange.js";
import { renderToolbar } from "./toolbar.js";
import { $, fmtTime } from "./util.js";

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
export async function ensureNavData(tab) {
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
export function renderNavigator(preview) {
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

export function initNavigator() {
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
