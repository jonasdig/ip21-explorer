/* Formula rows: turning "=[TI-101] - [TI-201]" into a series.

   A row whose name starts with "=" is never asked of the historian. Its
   references are resolved against the other rows; a reference that is not a
   row is fetched quietly alongside them and never gets a row of its own, so a
   difference between two tags costs one row, not three. */

import { evalNode, isFormula, parseFormula, resolveHint } from "./formula.js";
import { alignOnto, medianStep, sampleAt, unionTimes } from "./resample.js";
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

// Everything one load needs to know about the tab's formulas: the parsed
// expressions, where each reference comes from, the order to compute them in,
// and the references that have to be fetched because they are not rows.
export function computedPlan(tab) {
  const plan = { entries: new Map(), order: [], operands: [] };
  const rows = tab.tags.filter(isComputed);
  if (!rows.length) return plan;

  const operands = new Map();
  for (const tag of rows) {
    const entry = { tag, parsed: null, error: null, sources: new Map() };
    plan.entries.set(tag.uid, entry);
    try {
      entry.parsed = parseFormula(tag.name);
    } catch (err) {
      entry.error = err.message;
      continue;
    }
    for (const ref of entry.parsed.refs) {
      const row = findRow(tab, ref);
      if (row && row !== tag) { entry.sources.set(ref, { id: row.uid, tag: row }); continue; }
      if (row === tag) { entry.error = "a formula cannot use itself"; break; }
      // Not on the plot: fetched with this row's own Type and Period, which is
      // what those two cells mean on a formula row.
      const id = `#op:${ref}|${tag.sample}|${tag.interval}`;
      if (!operands.has(id)) {
        operands.set(id, { id, req: ref, sample: tag.sample, interval: tag.interval });
      }
      entry.sources.set(ref, { id, ref });
    }
  }
  plan.operands = [...operands.values()];
  plan.order = orderRows(rows, plan);
  return plan;
}

// Recomputes from data already in hand, when nothing new has to be fetched.
// Editing a formula over tags that are already loaded is arithmetic, not a
// reason to make the historian repeat itself. False means a fetch is needed.
export function recompute(tab, r) {
  if (!r || !r.raw) return false;
  const plan = computedPlan(tab);
  if (plan.operands.some((op) => !r.raw[op.id])) return false;
  computeInto(tab, r, plan, null);
  return true;
}

// Writes r.raw[uid] for every formula row that can be computed, and an error
// on every one that cannot. Runs after the fetch has filled r.raw and before
// rebuildJoined, so everything downstream - chart, hover box, scooters, CSV,
// the stacked gutter - sees a formula exactly as it sees a tag.
// failures maps a fetch id to the message that came back for it.
export function computeInto(tab, r, plan, failures) {
  for (const entry of plan.entries.values()) {
    if (entry.error && entry.error !== "circular") {
      setError(entry.tag, entry.error, true);
    }
    if (entry.error) delete r.raw[entry.tag.uid];
  }

  for (const tag of plan.order) {
    const entry = plan.entries.get(tag.uid);
    const inputs = [];
    let stop = null;
    for (const ref of entry.parsed.refs) {
      const source = entry.sources.get(ref);
      const hint = resolveHint(ref, entry.parsed.bare.has(ref));
      const failed = failures && failures.get(source.id);
      if (failed) {
        // The historian's own words usually name the tag already.
        const said = failed.text.includes(ref) ? failed.text : `${ref}: ${failed.text}`;
        stop = { text: said + hint, hard: failed.hard };
        break;
      }
      const raw = r.raw[source.id];
      if (!raw || !raw.t.length) {
        stop = { text: `${ref} has no data in this window${hint}`, hard: false };
        break;
      }
      inputs.push({ t: raw.t, v: raw.v, step: !!(source.tag && source.tag.step) });
    }
    if (stop) {
      setError(tag, stop.text, stop.hard);
      delete r.raw[tag.uid];
      continue;
    }

    const ts = unionTimes(inputs.map((input) => input.t));
    const cols = alignOnto(inputs, ts);
    const row = new Array(cols.length);
    const index = new Map(entry.parsed.refs.map((ref, i) => [ref, i]));
    const at = (ref) => row[index.get(ref)];
    const vs = new Array(ts.length);
    for (let i = 0; i < ts.length; i++) {
      for (let k = 0; k < cols.length; k++) row[k] = cols[k][i];
      vs[i] = evalNode(entry.parsed.node, at);
    }
    r.raw[tag.uid] = { t: ts, v: vs };
    // A formula that comes right again has to lose its red: nothing else
    // clears an error a formula set on itself.
    tag._error = vs.some((v) => v != null)
      ? null : { text: "no result in this window", hard: false };
  }
}

// -- preview, for the block editor ------------------------------------------

// A reference's series among what is already loaded: a row's own, or one a
// formula fetched quietly. Nothing is fetched for a preview - that is what
// Apply is for.
function loadedSeries(tab, r, ref) {
  if (!r || !r.raw) return null;
  const row = findRow(tab, ref);
  if (row) return r.raw[row.uid] ? { raw: r.raw[row.uid], step: !!row.step } : null;
  const key = Object.keys(r.raw).find((k) => k.startsWith(`#op:${ref}|`));
  return key ? { raw: r.raw[key], step: false } : null;
}

// Reads any reference at any time from loaded data, the same way the formula
// itself is computed: interpolated, held for a stepped tag, nothing across a
// hole. For the per-block values under the preview cursor.
export function refSampler(tab, r) {
  const cache = new Map();
  return (ref, t) => {
    if (!cache.has(ref)) {
      const found = loadedSeries(tab, r, ref);
      cache.set(ref, found && { ...found, gap: 3 * medianStep(found.raw.t) });
    }
    const s = cache.get(ref);
    return s ? sampleAt(s.raw.t, s.raw.v, t, s.step, s.gap) : null;
  };
}

// The series a formula would produce, from what is loaded now: {t, v}, or
// {missing} naming the references that are not loaded yet, or {error}.
export function previewFormula(tab, r, text) {
  let parsed;
  try { parsed = parseFormula(text); } catch (err) { return { error: err.message }; }
  const inputs = [], missing = [];
  for (const ref of parsed.refs) {
    const found = loadedSeries(tab, r, ref);
    if (!found || !found.raw.t.length) missing.push(ref);
    else inputs.push({ t: found.raw.t, v: found.raw.v, step: found.step });
  }
  if (missing.length) return { missing };
  const ts = unionTimes(inputs.map((input) => input.t));
  const cols = alignOnto(inputs, ts);
  const index = new Map(parsed.refs.map((ref, i) => [ref, i]));
  const row = new Array(cols.length);
  const at = (ref) => row[index.get(ref)];
  const vs = new Array(ts.length);
  for (let i = 0; i < ts.length; i++) {
    for (let k = 0; k < cols.length; k++) row[k] = cols[k][i];
    vs[i] = evalNode(parsed.node, at);
  }
  return { t: ts, v: vs };
}
