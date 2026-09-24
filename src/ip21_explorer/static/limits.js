/* Alarm limits on a row - "HH 90, H 80, L 20, LL 10" - read, written back,
   and shaded on the plot beyond each of them. */

// Highest first: the order a limits field is written back in.
const KINDS = ["HH", "H", "L", "LL"];
const HIGH = new Set(["HH", "H"]);
// Faint enough to leave the trends readable. Where H and HH overlap it
// doubles, and that is what sets the HH band apart without a colour of its own.
const SHADE_ALPHA = 0.08;

// One entry: the kind, then the value, with a space or "=" between or
// nothing at all - "H 80", "H=80", "h80".
const ENTRY_AT = /^(hh|h|ll|l)\s*=?\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)$/i;

export const LIMITS_HELP =
  "Alarm limits, shaded beyond each one: H 80, HH 90, L 20, LL 10";

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

// Shades the plot beyond every visible row's limits, each on the row's own
// scale and in its own colour. Called from drawClear, so the trends are drawn
// over it. A limit above the scale shades nothing; a trend that lies wholly
// in the alarm band has the whole plot shaded, which is what it is.
export function drawLimitShading(u, tab, r) {
  const { ctx, bbox } = u;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height);
  ctx.clip();
  ctx.globalAlpha = SHADE_ALPHA;
  for (const uid of r.tagOrder) {
    const tag = tab.tags.find((t) => t.uid === uid);
    if (!tag || tag.visible === false || !(tag.limits || []).length) continue;
    const scale = u.scales[uid];
    if (!scale || scale.min == null) continue;
    ctx.fillStyle = tag.color;
    for (const { kind, value } of tag.limits) {
      const y = u.valToPos(value, uid, true);
      if (HIGH.has(kind)) ctx.fillRect(bbox.left, bbox.top, bbox.width, y - bbox.top);
      else ctx.fillRect(bbox.left, y, bbox.width, bbox.top + bbox.height - y);
    }
  }
  ctx.restore();
}
