/* DOM shortcuts, number and time formatting, and the error/notice box. */

export function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export function $(id) { return document.getElementById(id); }

export function pad2(n) { return String(n).padStart(2, "0"); }

export function fmtTime(t, withSeconds) {
  const d = new Date(t * 1000);
  const date = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}` +
    (withSeconds ? `:${pad2(d.getSeconds())}` : "");
  return `${date} ${time}`;
}

export function fmtVal(v) {
  if (v == null || Number.isNaN(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

// A span as the largest unit that reads cleanly, for messages about limits.
export function fmtSpan(seconds) {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} d`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds)} s`;
}

// Reads what the time fields accept, in the same 24h dd.mm.yyyy format
// fmtTime() writes. A native datetime-local was formatted by the browser's
// locale - AM/PM and all - which the page cannot override, so the fields are
// plain text and this is what turns them back into a timestamp.
//
// Deliberately forgiving, since these are typed by hand: the date may drop its
// year, and either half may be left out entirely.
//   01.09.2026 14:30:00   01.09.2026 14:30   01.09.2026
//   01.09 14:30           14:30              14:30:05
//   2026-09-01T14:30:00   2026-09-01 14:30
// Returns epoch seconds, or null when it cannot be read.
export function parseTimeInput(text, now) {
  const value = String(text == null ? "" : text).trim();
  if (!value) return null;
  const today = new Date((now == null ? Date.now() / 1000 : now) * 1000);

  const iso = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (iso) {
    const [, y, mo, d, h, mi, sec] = iso;
    return mk(+y, +mo, +d, +(h || 0), +(mi || 0), +(sec || 0));
  }

  const parts = value.split(/\s+/);
  const datePart = parts.length > 1 || parts[0].includes(".") ? parts[0] : null;
  const timePart = parts.length > 1 ? parts[1] : (datePart ? null : parts[0]);

  let y = today.getFullYear(), mo = today.getMonth() + 1, d = today.getDate();
  if (datePart) {
    const m = datePart.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\.?$/);
    if (!m) return null;
    d = +m[1];
    mo = +m[2];
    if (m[3]) y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  }

  let h = 0, mi = 0, sec = 0;
  if (timePart) {
    const m = timePart.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    h = +m[1];
    mi = +m[2];
    sec = +(m[3] || 0);
  }
  return mk(y, mo, d, h, mi, sec);

  function mk(year, month, day, hour, minute, second) {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const dt = new Date(year, month - 1, day, hour, minute, second, 0);
    // Rejects the likes of 31.02: the Date constructor rolls those over.
    if (dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
    return dt.getTime() / 1000;
  }
}

// Which part of "dd.mm.yyyy HH:MM:SS" the caret sits in, so the arrow keys can
// step that unit. Positions are fixed, the format has no variable-width parts.
const TIME_SEGMENTS = [
  { from: 0, to: 2, unit: "day" },
  { from: 3, to: 5, unit: "month" },
  { from: 6, to: 10, unit: "year" },
  { from: 11, to: 13, unit: "hour" },
  { from: 14, to: 16, unit: "minute" },
  { from: 17, to: 19, unit: "second" },
];

export function segmentAt(caret) {
  const seg = TIME_SEGMENTS.find((s) => caret >= s.from && caret <= s.to);
  return seg || TIME_SEGMENTS[TIME_SEGMENTS.length - 1];
}

// One step of `unit` on a timestamp. Months and years go through Date so that
// the 31st of a short month lands on a real date.
export function stepTime(t, unit, delta) {
  const d = new Date(t * 1000);
  if (unit === "year") d.setFullYear(d.getFullYear() + delta);
  else if (unit === "month") d.setMonth(d.getMonth() + delta);
  else if (unit === "day") d.setDate(d.getDate() + delta);
  else if (unit === "hour") d.setHours(d.getHours() + delta);
  else if (unit === "minute") d.setMinutes(d.getMinutes() + delta);
  else d.setSeconds(d.getSeconds() + delta);
  return d.getTime() / 1000;
}

export function nearestValue(ts, vs, t) {
  // Binary search for the sample nearest to time t.
  if (!ts || !ts.length) return null;
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < t) lo = mid; else hi = mid;
  }
  const i = Math.abs(ts[lo] - t) <= Math.abs(ts[hi] - t) ? lo : hi;
  return { t: ts[i], v: vs[i] };
}

// A successful fetch clears this box, so a message that is not about a failed
// request needs protecting from that - hence showNotice() below.
let errorHoldUntil = 0;

export function showError(msg, holdMs) {
  const box = $("error-box");
  if (msg) {
    box.textContent = msg;
    box.classList.remove("hidden");
    errorHoldUntil = holdMs ? Date.now() + holdMs : 0;
  } else if (Date.now() >= errorHoldUntil) {
    box.classList.add("hidden");
    errorHoldUntil = 0;
  }
}

// Something worth saying that is not an error: stays put for a few seconds
// even if a fetch finishes in the meantime, then clears itself.
export function showNotice(msg, ms = 4000) {
  showError(msg, ms);
  setTimeout(() => showError(null), ms);
}
