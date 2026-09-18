/* CSV export and averages between scooters. */

import { activeTab, rt } from "./state.js";
import { tagDisplay, tagLabel } from "./tags.js";
import { $, el, fmtTime, fmtVal, pad2, showError } from "./util.js";

// CSV dialect: semicolon separator + decimal comma, so the file opens
// directly in Norwegian Excel. Values keep full precision (no fmtVal).
const CSV_SEP = ";";

// Number.prototype.toString is locale-independent (always "."), so a plain
// replace is safe for the decimal comma.
function csvNum(v) {
  return String(v).replace(".", ",");
}

// RFC 4180 quoting. Mandatory for headers: tag keys are "TAG;MAP", which
// contains the separator.
function csvField(s) {
  if (/[";\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Local wall-clock time, unambiguous in Excel and matching the UI's display.
function fmtCsvTime(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// Visible tags that have data, in plot order (same filter as appendValueRows).
export function exportTags(tab, r) {
  return tab.tags.filter(
    (tag) => tag.visible !== false && r.raw && r.raw[tag.uid]
  );
}

// The two outermost scooters by time (creation order is arbitrary), or null
// when fewer than two exist.
export function outermostScooters(tab) {
  if (tab.scooters.length < 2) return null;
  const ts = tab.scooters.map((s) => s.t);
  return { t0: Math.min(...ts), t1: Math.max(...ts) };
}

export function downloadText(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// One aligned grid over the visible tags' raw tables (they may have different
// time bases), rows limited to [t0, t1] inclusive. Missing samples become
// empty cells.
function buildCsv(tab, r, t0, t1) {
  const tags = exportTags(tab, r);
  if (!tags.length) return null;
  const tables = tags.map((tag) => {
    const raw = r.raw[tag.uid];
    return [raw.t, raw.v];
  });
  const joined = tables.length === 1 ? tables[0] : uPlot.join(tables);
  const header = ["Time", ...tags.map((tag) => {
    const unit = tag.unit ? ` (${tag.unit})` : "";
    return csvField(`${tagLabel(tab, tag)}${unit}`);
  })];
  const lines = [header.join(CSV_SEP)];
  for (let i = 0; i < joined[0].length; i++) {
    const t = joined[0][i];
    if (t < t0 || t > t1) continue;
    const row = [fmtCsvTime(t)];
    for (let s = 1; s < joined.length; s++) {
      const v = joined[s][i];
      row.push(v == null ? "" : csvNum(v));
    }
    lines.push(row.join(CSV_SEP));
  }
  return lines.join("\r\n");
}

// Exports whatever is loaded: during the wheel-zoom debounce the visible
// range can be slightly ahead of the fetched data, which is acceptable.
export function exportCsvRange(t0, t1) {
  const tab = activeTab();
  const r = rt(tab);
  const csv = buildCsv(tab, r, t0, t1);
  if (csv == null) { showError("No visible tags to export"); return; }
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  downloadText(`ip21-export_${stamp}.csv`, csv, "text/csv;charset=utf-8");
}

// Per-tag stats between two times, from each tag's own raw arrays (the joined
// grid would inject nulls for foreign timestamps and skew the counts).
function statsBetween(tab, r, t0, t1) {
  return exportTags(tab, r).map((tag) => {
    const { t: ts, v: vs } = r.raw[tag.uid];
    let sum = 0, min = Infinity, max = -Infinity, n = 0;
    for (let i = 0; i < ts.length; i++) {
      if (ts[i] < t0 || ts[i] > t1) continue;
      const v = vs[i];
      if (v == null || Number.isNaN(v)) continue;
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
      n++;
    }
    return n
      ? { tag, avg: sum / n, min, max, n }
      : { tag, avg: null, min: null, max: null, n: 0 };
  });
}

export function showAverageDialog(t0, t1) {
  const tab = activeTab();
  const r = rt(tab);
  const dialog = $("avg-dialog");
  $("avg-range").textContent = `${fmtTime(t0, true)}  \u2192  ${fmtTime(t1, true)}`;
  const rows = $("avg-rows");
  rows.innerHTML = "";

  const head = el("div", "row head");
  head.appendChild(el("span", "dot"));
  head.appendChild(el("span", "name", ""));
  for (const label of ["Avg", "Min", "Max", "n"]) {
    head.appendChild(el("span", "val", label));
  }
  rows.appendChild(head);

  for (const s of statsBetween(tab, r, t0, t1)) {
    const row = el("div", "row");
    const dot = el("span", "dot");
    dot.style.background = s.tag.color;
    row.appendChild(dot);
    row.appendChild(el("span", "name", tagDisplay(tab, s.tag)));
    const unit = s.tag.unit ? ` ${s.tag.unit}` : "";
    row.appendChild(el("span", "val", s.n ? `${fmtVal(s.avg)}${unit}` : "\u2013"));
    row.appendChild(el("span", "val", s.n ? fmtVal(s.min) : "\u2013"));
    row.appendChild(el("span", "val", s.n ? fmtVal(s.max) : "\u2013"));
    row.appendChild(el("span", "val", String(s.n)));
    rows.appendChild(row);
  }
  dialog.showModal();
}
