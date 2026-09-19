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

function setError(tag, text, hard) { tag._error = { text, hard }; }

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

// Formulas may feed formulas, so they are computed in dependency order. A
// cycle marks every row in it, not just the one the walk happened to re-enter:
// two rows pointing at each other must not sit there looking merely unlucky.
function orderRows(rows, plan) {
  const seen = new Map();   // uid -> 1 walking, 2 done
  const stack = [];
  const out = [];

  const walk = (tag) => {
    const mark = seen.get(tag.uid);
    if (mark === 2) return true;
    if (mark === 1) {
      const loop = stack.slice(stack.indexOf(tag)).concat(tag);
      const chain = loop.map(formulaName).join(" → ");
      for (const member of loop) {
        setError(member, `circular formula: ${chain}`, true);
        seen.set(member.uid, 2);
        plan.entries.get(member.uid).error = plan.entries.get(member.uid).error || "circular";
      }
      return false;
    }
    const entry = plan.entries.get(tag.uid);
    if (!entry || entry.error) return false;
    seen.set(tag.uid, 1);
    stack.push(tag);
    let ok = true;
    for (const source of entry.sources.values()) {
      if (source.tag && isComputed(source.tag) && !walk(source.tag)) ok = false;
    }
    stack.pop();
    seen.set(tag.uid, 2);
    if (ok) out.push(tag);
    return ok;
  };

  for (const tag of rows) walk(tag);
  return out;
}

// What a reference means to the server: a row's tag with the row's own
// sampling, another formula row by id, or - not on the plot - the bare tag,
// read with the owning formula's Type and Period, which is what those two
// cells mean on a formula row.
function refSpec(tab, ref, owner) {
  const row = findRow(tab, ref);
  if (row && owner && row === owner) return { error: "a formula cannot use itself" };
  if (row && isComputed(row)) return { spec: { formula: row.uid }, row };
  if (row) {
    return { spec: { tag: reqName(row), sample: row.sample, interval: row.interval,
                     step: !!row.step }, row };
  }
  const sample = owner ? owner.sample : "INT";
  const interval = owner ? owner.interval : "auto";
  return { spec: { tag: ref, sample, interval, step: false } };
}

// Everything one computation needs: every formula row parsed, where each of
// its references comes from, and the items to send - in dependency order,
// without the rows that cannot be computed (a typo, a cycle).
export function computedPlan(tab) {
  const plan = { entries: new Map(), order: [], items: [] };
  const rows = tab.tags.filter(isComputed);
  if (!rows.length) return plan;

  for (const tag of rows) {
    const entry = { tag, parsed: null, error: null, sources: new Map(), refs: {} };
    plan.entries.set(tag.uid, entry);
    try {
      entry.parsed = parseFormula(tag.name);
    } catch (err) {
      entry.error = err.message;
      continue;
    }
    for (const ref of entry.parsed.refs) {
      const found = refSpec(tab, ref, tag);
      if (found.error) { entry.error = found.error; break; }
      entry.refs[ref] = found.spec;
      entry.sources.set(ref, { tag: found.row || null });
    }
  }
  plan.order = orderRows(rows, plan);
  plan.items = plan.order.map((tag) => ({
    id: tag.uid, expr: tag.name, refs: plan.entries.get(tag.uid).refs,
  }));
  return plan;
}

// Writes r.raw[uid] for every formula row the server could compute, and an
// error on every one that it, or the plan, could not. Everything downstream -
// chart, hover box, scooters, CSV, the stacked gutter - then sees a formula
// exactly as it sees a tag.
export function applyComputed(tab, r, plan, answer) {
  for (const entry of plan.entries.values()) {
    if (entry.error && entry.error !== "circular") setError(entry.tag, entry.error, true);
    if (entry.error) delete r.raw[entry.tag.uid];
  }
  for (const tag of plan.order) {
    const series = answer.series[tag.uid];
    const error = answer.errors[tag.uid];
    if (series) r.raw[tag.uid] = series;
    else delete r.raw[tag.uid];
    // A formula that comes right again has to lose its red: nothing else
    // clears an error a formula set on itself.
    tag._error = error ? { text: error.text, hard: !!error.hard } : null;
  }
}

// Asks the server for the tab's formula rows over [start, end]. Returns the
// plan and the answer, for applyComputed; nothing is changed here.
export async function fetchComputed(tab, start, end, points, signal) {
  const plan = computedPlan(tab);
  if (!plan.items.length) return { plan, answer: { series: {}, errors: {} } };
  const answer = await apiCompute({ start, end, points, items: plan.items }, signal);
  return { plan, answer };
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
    let parsed;
    try { parsed = parseFormula(text); } catch (err) { out.set(text, { error: err.message }); return; }
    const refs = {};
    for (const ref of parsed.refs) {
      const found = refSpec(tab, ref, owner);
      if (found.error) { out.set(text, { error: found.error }); return; }
      refs[ref] = found.spec;
    }
    items.push({ id: `p${i}`, expr: text, refs });
  });
  if (!items.length) return out;
  // Formula rows the previewed text refers to are computed alongside it.
  const plan = computedPlan(tab);
  const answer = await apiCompute(
    { start, end, points, items: plan.items.concat(items) }, signal);
  for (const item of items) {
    const error = answer.errors[item.id];
    const series = answer.series[item.id];
    out.set(item.expr, series && !(error && error.hard) ? series : { error: error ? error.text : "no data" });
  }
  return out;
}
