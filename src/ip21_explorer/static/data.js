/* Fetching trend data for a tab and joining it into uPlot's format. */

import { ensureDescriptions, ensureUnits } from "./app.js";
import { renderChart } from "./chart.js";
import { ensureNavData } from "./navigator.js";
import { reqName, rt, state } from "./state.js";
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

  const width = $("chart-wrap").clientWidth || 1200;
  const points = Math.max(300, Math.min(4000, Math.round(width * 1.2)));

  // Sample type and interval are individual per tag: fetch one request per
  // distinct (sample, interval) group, in parallel.
  const groups = new Map();
  for (const tag of tab.tags) {
    const key = `${tag.sample}|${tag.interval}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tag);
  }

  if (tab.id === state.activeTabId) $("loading").classList.remove("hidden");
  try {
    const results = await Promise.all(
      [...groups.values()].map(async (groupTags) => {
        const params = new URLSearchParams({
          tags: [...new Set(groupTags.map(reqName))].join(","),
          start: String(start),
          end: String(end),
          sample: groupTags[0].sample,
          interval: groupTags[0].interval,
          points: String(points),
        });
        const resp = await fetch(`/api/data?${params}`, { signal: r.abort.signal });
        if (!resp.ok) {
          const detail = (await resp.json().catch(() => ({}))).detail;
          throw new Error(detail || `data request failed (${resp.status})`);
        }
        // Map the response back per tag: several tags can share one reqName
        // (same tag, same map), and each needs its own runtime slot.
        const body = await resp.json();
        const out = {};
        for (const tag of groupTags) {
          const s = body.series[reqName(tag)];
          if (s) out[tag.uid] = s; // read-only, so twins may share one object
        }
        return { series: out, intervalS: body.interval_s };
      })
    );
    if (seq !== r.seq) return; // superseded by a newer request

    // Keyed by tag.uid, so groups can never overwrite each other's entries.
    r.raw = Object.assign({}, ...results.map((g) => g.series));
    r.start = start;
    r.end = end;
    // Smallest aggregate interval that was served: liveTick skips refetches
    // until at least one new plot bucket can exist.
    const intervals = results.map((g) => g.intervalS).filter((i) => i > 0);
    r.intervalS = intervals.length ? Math.min(...intervals) : null;
    rebuildJoined(tab, r);
    showError(null);
    if (tab.id === state.activeTabId) renderChart();
  } catch (err) {
    if (err.name === "AbortError") return;
    if (tab.id === state.activeTabId) showError(err.message);
  } finally {
    // Hide even if the active tab changed mid-fetch, so it can't get stuck.
    if (seq === r.seq) $("loading").classList.add("hidden");
  }
}

export function rebuildJoined(tab, r) {
  r.tagOrder = tab.tags.map((t) => t.uid).filter((uid) => r.raw && r.raw[uid]);
  const tables = r.tagOrder.map((uid) => [r.raw[uid].t, r.raw[uid].v]);
  r.data = tables.length === 0 ? null
    : tables.length === 1 ? tables[0] : uPlot.join(tables);
}
