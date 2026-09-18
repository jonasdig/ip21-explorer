/* Fetching trend data for a tab and joining it into uPlot's format. */

import { renderChart } from "./chart.js";
import { computeInto, computedPlan, isComputed } from "./computed.js";
import { ensureNavData } from "./navigator.js";
import { reqName, rt, state } from "./state.js";
import { ensureDescriptions, ensureUnits, renderTags } from "./tags.js";
import { resolveRange } from "./timerange.js";
import { $, showError } from "./util.js";

export async function loadData(tab) {
  const r = rt(tab);
  if (!tab.tags.length) { r.raw = null; r.data = null; renderChart(); return; }
  ensureUnits(tab);
  ensureDescriptions(tab);
  ensureNavData(tab);

  const { start, end } = resolveRange(tab);
  if (r.abort) r.abort.abort();
  r.abort = new AbortController();
  const seq = ++r.seq;
  // Read by the live tick, which must wait for an answer rather than replace
  // it: see liveTick() in timerange.js.
  r.inFlight = true;

  const width = $("chart-wrap").clientWidth || 1200;
  const points = Math.max(300, Math.min(4000, Math.round(width * 1.2)));

  // What actually has to be fetched: the plain rows, plus the tags a formula
  // refers to that have no row of their own. Formula rows themselves are
  // computed from the answers, further down.
  const plan = computedPlan(tab);
  const items = [
    ...tab.tags.filter((tag) => !isComputed(tag)).map((tag) => ({
      id: tag.uid, req: reqName(tag), sample: tag.sample, interval: tag.interval, tag,
    })),
    ...plan.operands,
  ];

  // Sample type and interval are individual per tag: fetch one request per
  // distinct (sample, interval) group, in parallel.
  const groups = new Map();
  for (const item of items) {
    const key = `${item.sample}|${item.interval}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  if (tab.id === state.activeTabId) $("loading").classList.remove("hidden");
  try {
    const results = await Promise.all(
      [...groups.values()].map(async (groupItems) => {
        const params = new URLSearchParams({
          tags: [...new Set(groupItems.map((item) => item.req))].join(","),
          start: String(start),
          end: String(end),
          sample: groupItems[0].sample,
          interval: groupItems[0].interval,
          points: String(points),
        });
        try {
          const resp = await fetch(`/api/data?${params}`, { signal: r.abort.signal });
          if (!resp.ok) {
            const detail = (await resp.json().catch(() => ({}))).detail;
            throw new Error(detail || `data request failed (${resp.status})`);
          }
          // Map the response back per item: several tags can share one request
          // name (same tag, same map), and each needs its own runtime slot.
          const body = await resp.json();
          const out = {};
          for (const item of groupItems) {
            const s = body.series[item.req];
            if (s) out[item.id] = s; // read-only, so twins may share one object
          }
          return { series: out, intervalS: body.interval_s, items: groupItems };
        } catch (err) {
          if (err.name === "AbortError") throw err;
          // One misspelled tag fails its whole request, but only that one:
          // the other sample/interval groups keep their data and their traces.
          return { series: {}, error: err.message, items: groupItems };
        }
      })
    );
    if (seq !== r.seq) return; // superseded by a newer request
    const { first, failures } = markTagErrors(results);

    // Keyed by tag.uid, so groups can never overwrite each other's entries.
    r.raw = Object.assign({}, ...results.map((g) => g.series));
    r.start = start;
    r.end = end;
    // Smallest aggregate interval that was served: liveTick skips refetches
    // until at least one new plot bucket can exist.
    const intervals = results.map((g) => g.intervalS).filter((i) => i > 0);
    r.intervalS = intervals.length ? Math.min(...intervals) : null;
    computeInto(tab, r, plan, failures);
    rebuildJoined(tab, r);
    showError(first);
    if (tab.id === state.activeTabId) { renderTags(); renderChart(); }
  } catch (err) {
    if (err.name === "AbortError") return;
    if (tab.id === state.activeTabId) showError(err.message);
  } finally {
    // Hide even if the active tab changed mid-fetch, so it can't get stuck.
    if (seq === r.seq) {
      $("loading").classList.add("hidden");
      r.inFlight = false;
    }
  }
}

// Why a row has no trace, written onto the tag itself: a request that failed
// (a name the historian does not know, typically) is a hard error and the row
// says so in red; a tag simply absent from an otherwise good answer has no
// data in this window, which is worth saying but is not a mistake.
//
// A failed request takes its whole group down, so the red is aimed at the tag
// the historian named in its complaint, if any: the rest of the group lost
// their data for this round without having done anything wrong.
//
// Formula rows are in no group and so are never seen here; what happens to
// them is decided in computeInto(), from the failures map this returns.
function markTagErrors(results) {
  let first = null;
  const failures = new Map();
  for (const group of results) {
    const blamed = group.error
      ? group.items.filter((item) => group.error.includes(item.req))
      : [];
    for (const item of group.items) {
      let note = null;
      if (group.error) {
        const hard = !blamed.length || blamed.includes(item);
        note = {
          text: hard ? group.error
            : `not fetched: ${blamed.map((b) => b.req).join(", ")} failed in the same request`,
          hard,
        };
        first = first || group.error;
      } else if (!group.series[item.id]) {
        note = { text: "no data in this window", hard: false };
      }
      if (item.tag) item.tag._error = note;
      else if (note) failures.set(item.id, note);
    }
  }
  return { first, failures };
}

export function rebuildJoined(tab, r) {
  r.tagOrder = tab.tags.map((t) => t.uid).filter((uid) => r.raw && r.raw[uid]);
  const tables = r.tagOrder.map((uid) => [r.raw[uid].t, r.raw[uid].v]);
  r.data = tables.length === 0 ? null
    : tables.length === 1 ? tables[0] : uPlot.join(tables);
}
