/* Formula rows: what "=[TI-101] - [TI-201]" refers to, and asking the server
   to compute it.

   A row whose name starts with "=" is never asked of the historian as a tag.
   Its references are resolved here, against the other rows, because what a
   name means depends on this table; the server (calc/ in Python) reads the
   tags and does the arithmetic. A reference that is not a row is read there
   quietly and never gets a row of its own, so a difference between two tags
   costs one row, not three. */

import { apiCompute } from "./api.js";
import { isFormula, parseFormula } from "./formula.js";
import { reqName } from "./state.js";

export function isComputed(tag) { return isFormula(tag.name); }

// What a formula row is called when it is spoken about rather than read: the
// short description if the user gave it one, else the expression itself.
function formulaName(tag) {
  return (tag.description || "").trim() || tag.name;
}

// A reference names a row by its "TAG;MAP", by its bare tag name, or - for a
// formula row - by the short description, which is the only handle a formula
// has that is worth typing.
function findRow(tab, ref) {
  const want = ref.trim().toLowerCase();
  if (!want) return null;
  const plain = tab.tags.filter((t) => !isComputed(t));
  return plain.find((t) => reqName(t).toLowerCase() === want)
    || plain.find((t) => t.name.toLowerCase() === want)
    || tab.tags.find((t) => isComputed(t) &&
        (t.description || "").trim().toLowerCase() === want)
    || null;
}

// What a reference means to the server: a row's tag with the row's own
// sampling, another formula row by id, or - not on the plot - the bare tag,
// read with the owning formula's Type and Period, which is what those two
// cells mean on a formula row.
function refSpec(tab, ref, owner) {
  const row = findRow(tab, ref);
  if (row && isComputed(row)) return { spec: { formula: row.uid }, row };
  if (row) {
    return { spec: { tag: reqName(row), sample: row.sample, interval: row.interval,
                     step: !!row.step }, row };
  }
  const sample = owner ? owner.sample : "INT";
  const interval = owner ? owner.interval : "auto";
  return { spec: { tag: ref, sample, interval, step: false }, row: null };
}

// One formula as the server takes it, its references resolved against this
// table - the one thing only the browser knows. Everything else wrong with a
// formula, from a typo to a loop through other rows, the server finds and
// says in the same words. Also returns the rows it refers to.
function formulaItem(tab, id, text, name, owner) {
  const refs = {}, rows = [];
  let names = [];
  try { names = parseFormula(text).refs; } catch (err) { /* the server says why */ }
  for (const ref of names) {
    const found = refSpec(tab, ref, owner);
    refs[ref] = found.spec;
    if (found.row) rows.push(found.row);
  }
  return { item: { id, expr: text, name, refs }, rows };
}

// Every formula row on the tab, as the items the server computes.
export function formulaItems(tab) {
  return tab.tags.filter(isComputed).map((tag) =>
    formulaItem(tab, tag.uid, tag.name, formulaName(tag), tag).item);
}

// Asks the server for the tab's formula rows over [start, end]. Nothing is
// changed here: applyComputed does that with what comes back.
export async function fetchComputed(tab, start, end, points, signal) {
  const items = formulaItems(tab);
  const answer = items.length
    ? await apiCompute({ start, end, points, items }, signal)
    : { series: {}, errors: {} };
  return { items, answer };
}

// Writes r.raw[uid] for every formula row the server could compute, and its
// error on every one it could not. Only the rows that were asked about: one
// added while the answer was on its way waits for the next. Everything
// downstream - chart, hover box, scooters, CSV, the value gutter - then sees
// a formula exactly as it sees a tag.
export function applyComputed(tab, r, { items, answer }) {
  for (const { id } of items) {
    const tag = tab.tags.find((t) => t.uid === id);
    if (!tag) continue;
    const series = answer.series[id];
    const error = answer.errors[id];
    if (series) r.raw[id] = series;
    else delete r.raw[id];
    // A formula that comes right again has to lose its red: nothing else
    // clears an error a formula set on itself.
    tag._error = error ? { text: error.text, hard: !!error.hard } : null;
  }
}

// -- preview, for the block editor ------------------------------------------

// Series for several expressions at once - the block editor's preview and
// every block under it - over the window the tab has loaded, so the tags it
// has read come out of the server's cache. owner is the formula row being
// edited, if any: its Type and Period, and it may not use itself.
// Returns a Map of text -> {t, v, step} or {error}.
export async function previewFormulas(tab, owner, texts, start, end, points, signal) {
  const out = new Map();
  const items = [];
  texts.forEach((text, i) => {
    const { item, rows } = formulaItem(tab, `p${i}`, text, null, owner);
    // An edit to a row cannot be built on the row's own old value, which is
    // all the server would have of it.
    if (owner && rows.includes(owner)) out.set(text, { error: "a formula cannot use itself" });
    else items.push(item);
  });
  if (!items.length) return out;
  // Formula rows the previewed text refers to are computed alongside it.
  const answer = await apiCompute(
    { start, end, points, items: formulaItems(tab).concat(items) }, signal);
  for (const item of items) {
    const error = answer.errors[item.id];
    const series = answer.series[item.id];
    out.set(item.expr, series && !(error && error.hard) ? series : { error: error ? error.text : "no data" });
  }
  return out;
}
