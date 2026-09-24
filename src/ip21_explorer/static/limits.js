/* Alarm limits on a row - "HH 90, H 80, L 20, LL 10" - read, written back,
   and shown on the plot: the trend drawn bolder where it is beyond one, and
   a tick at the plot's right edge for each. Nothing is drawn across the
   plot, so a dozen tags with limits of their own stay readable. */

// Highest first: the order a limits field is written back in.
const KINDS = ["HH", "H", "L", "LL"];
const HIGH = new Set(["HH", "H"]);
const OUTER = new Set(["HH", "LL"]);
// How much wider than the trend a stretch beyond a limit is drawn, in CSS
// px: one more beyond HH or LL, so the worse breach reads as the worse.
const WIDEN = { H: 2, L: 2, HH: 3, LL: 3 };
// The ticks sit in the plot's 12 px right margin, clear of the data.
const TICK_GAP = 2;
const TICK_LEN = 8;

// One entry: the kind, then the value, with a space or "=" between or
// nothing at all - "H 80", "H=80", "h80".
const ENTRY_AT = /^(hh|h|ll|l)\s*=?\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)$/i;

export const LIMITS_HELP =
  "Alarm limits: H 80, HH 90, L 20, LL 10. The trend is drawn bolder beyond " +
  "a limit, and each limit has a tick at the plot's right edge.";

// What a limits field says, as [{kind, value}] highest first - or {error},
// saying what to write instead.
export function parseLimits(text) {
  const limits = [];
  for (const part of String(text || "").split(/[,;]/)) {
    const entry = part.trim();
    if (!entry) continue;
    const match = ENTRY_AT.exec(entry);
    // A comma separates limits, so "H 80,5" arrives as "H 80" and "5": the
    // decimal comma is the likelier mistake than a limit with no kind.
    if (!match && limits.length && /^\d+$/.test(entry)) {
      return { error: "a comma separates limits - write decimals with a point, as in H 80.5" };
    }
    if (!match) return { error: `"${entry}" is not a limit: write H 80, HH 90, L 20 or LL 10` };
    const kind = match[1].toUpperCase();
    if (limits.some((limit) => limit.kind === kind)) return { error: `${kind} is given twice` };
    limits.push({ kind, value: Number(match[2]) });
  }
  return { limits: sortLimits(limits) };
}

export function formatLimits(limits) {
  return (limits || []).map((limit) => `${limit.kind} ${limit.value}`).join(", ");
}

// Limits as stored - in a saved plot, a share link, the browser's own state -
// kept only where they still make sense.
export function normalizeLimits(limits) {
  if (!Array.isArray(limits)) return [];
  return sortLimits(limits
    .filter((limit) => limit && KINDS.includes(limit.kind) && Number.isFinite(limit.value))
    .map((limit) => ({ kind: limit.kind, value: limit.value })));
}

function sortLimits(limits) {
  return limits.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

// Marks every visible row's limits on its own scale, in its own colour.
// Called from the draw hook, once the trends are on the canvas.
export function drawLimitMarks(u, tab, r) {
  const { ctx, bbox } = u;
  const dpr = window.devicePixelRatio || 1;
  const bottom = bbox.top + bbox.height;
  r.tagOrder.forEach((uid, i) => {
    const tag = tab.tags.find((t) => t.uid === uid);
    if (!tag || tag.visible === false || !(tag.limits || []).length) return;
    const scale = u.scales[uid];
    if (!scale || scale.min == null) return;
    // The line uPlot has just drawn - absent for a row drawn as dots only.
    const series = u.series[i + 1];
    const path = series && series._paths && series._paths.stroke;
    // H and L first, so a breach of HH or LL is drawn over theirs.
    const limits = [...tag.limits].sort((a, b) => OUTER.has(a.kind) - OUTER.has(b.kind));
    for (const { kind, value } of limits) {
      const y = u.valToPos(value, uid, true);
      // Beyond the limit: from it to the top of the plot, or to the bottom.
      const from = HIGH.has(kind) ? bbox.top : Math.max(bbox.top, y);
      const to = HIGH.has(kind) ? Math.min(bottom, y) : bottom;
      if (path && to > from) {
        strokeBeyond(ctx, path, bbox, from, to, tag.color, (series.width + WIDEN[kind]) * dpr, dpr);
      }
      if (y >= bbox.top && y <= bottom) {
        drawTick(ctx, bbox, y, tag.color, (OUTER.has(kind) ? 3 : 1.5) * dpr, dpr);
      }
    }
  });
}

// The trend's own line again, clipped to the band beyond a limit, so only
// the stretches that are in alarm show: wider in the tag's colour, with a
// pale core, and solid even where the line itself is dashed.
function strokeBeyond(ctx, path, bbox, from, to, color, width, dpr) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, from, bbox.width, to - from);
  ctx.clip();
  ctx.setLineDash([]);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke(path);
  ctx.strokeStyle = "#fff";
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = dpr;
  ctx.stroke(path);
  ctx.restore();
}

function drawTick(ctx, bbox, y, color, width, dpr) {
  const x = bbox.left + bbox.width + TICK_GAP * dpr;
  ctx.save();
  ctx.setLineDash([]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, Math.round(y));
  ctx.lineTo(x + TICK_LEN * dpr, Math.round(y));
  ctx.stroke();
  ctx.restore();
}
