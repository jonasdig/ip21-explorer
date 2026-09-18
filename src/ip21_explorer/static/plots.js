/* Saved plots: config conversion, the save and open dialogs, import/export. */

import { downloadText } from "./analysis.js";
import { apiDeletePlot, apiGetPlot, apiListPlots, apiSavePlot } from "./api.js";
import { OPEN_ALL_CONFIRM } from "./constants.js";
import { renderAll } from "./main.js";
import { copyShareLink } from "./share.js";
import {
  activeTab, byUid, makeTag, newTab, normalizeInterval, normalizeTagName,
  saveState, state,
} from "./state.js";
import { addTab, renderTabs } from "./tabs.js";
import { nextColor } from "./tags.js";
import { $, el, fmtTime, showError } from "./util.js";

const CONFIG_VERSION = 6;

// A complete snapshot of a plot: everything needed to recreate it exactly,
// minus runtime-only identity (uid) and caches (_mapsChecked).
export function tabToConfig(tab, name) {
  const strip = ({ uid, _mapsChecked, ...rest }) => rest;
  return {
    version: CONFIG_VERSION,
    name: name || tab.name,
    labels: (tab.labels || []).slice(),
    tags: tab.tags.map(strip),
    axisMode: tab.axisMode,
    axisTag: (byUid(tab, tab.axisUid) || {}).name || null,
    // Index disambiguates which copy of a repeated tag holds the grid.
    axisIndex: tab.tags.findIndex((t) => t.uid === tab.axisUid),
    linked: !!tab.linked,
    plotMode: tab.plotMode === "xy" ? "xy" : "time",
    // Indices, like axisIndex: a repeated tag name cannot be told apart by
    // name, and a formula's "name" is an expression.
    xIndex: tab.tags.findIndex((t) => t.uid === tab.xUid),
    yIndex: tab.tags.findIndex((t) => t.uid === tab.yUid),
    live: !!tab.live,
    scooters: (tab.scooters || []).map((sc) => ({ t: sc.t, dy: sc.dy || 0 })),
    range: tab.range.preset
      ? { preset: tab.range.preset }
      : { start: tab.range.start, end: tab.range.end },
    // What "Reset zoom" goes back to: the plot was saved zoomed in, but the
    // window it was zoomed in from is part of how it was meant to be read.
    baseRange: tab.baseRange || null,
  };
}

function configToTab(name, config) {
  const tab = newTab(name);
  tab.tags = (config.tags || []).map((t) => {
    const tag = makeTag({
      name: normalizeTagName(t.name),
      description: t.description,
      unit: t.unit,
      maps: t.maps,
    });
    tag.map = t.map ?? null;
    tag.color = t.color || null;
    tag.min = t.min ?? null;
    tag.max = t.max ?? null;
    tag.visible = t.visible !== false;
    tag.step = t.step === true;
    tag.sample = t.sample || config.sample || "INT";
    tag.interval = normalizeInterval(t.interval || config.interval || "auto");
    return tag;
  });
  for (const tag of tab.tags) {
    if (!tag.color) tag.color = nextColor(tab);
  }
  tab.axisMode = !config.axisMode || config.axisMode === "multi"
    ? "stacked" : config.axisMode;
  // v3 stores the index, which survives repeated tag names; older files only
  // carry the name.
  const axisTag = config.axisIndex >= 0 && tab.tags[config.axisIndex]
    ? tab.tags[config.axisIndex]
    : tab.tags.find((t) => t.name === normalizeTagName(config.axisTag || ""));
  tab.axisUid = (axisTag || tab.tags[0] || {}).uid || null;
  tab.range = config.range && (config.range.preset || config.range.start != null)
    ? config.range : { preset: "24h" };
  tab.baseRange = config.baseRange || (config.range && config.range.fromPreset
    ? { preset: config.range.fromPreset } : { ...tab.range });
  delete tab.range.fromPreset;
  tab.labels = Array.isArray(config.labels) ? config.labels.slice() : [];
  tab.linked = config.linked === true;
  tab.plotMode = config.plotMode === "xy" ? "xy" : "time";
  tab.xUid = (tab.tags[config.xIndex] || {}).uid || null;
  tab.yUid = (tab.tags[config.yIndex] || {}).uid || null;
  tab.live = config.live === true;
  tab.scooters = Array.isArray(config.scooters)
    ? config.scooters.filter((sc) => sc && typeof sc.t === "number")
        .map((sc) => ({ t: sc.t, dy: sc.dy || 0 }))
    : [];
  return tab;
}

// Reads a plot config from any source (file, link, server) and warns when it
// comes from a newer build, whose extra fields we would silently drop.
export function readConfig(name, config) {
  if (!config || typeof config !== "object" || !Array.isArray(config.tags)) {
    showError("Not a valid plot file");
    return null;
  }
  if (config.version > CONFIG_VERSION) {
    showError(`Plot "${name}" comes from a newer version; some settings may be lost`);
  }
  return configToTab(name, config);
}

export function initDialogs() {
  $("save-plot").addEventListener("click", () => {
    $("save-name").value = activeTab().name;
    $("save-labels").value = (activeTab().labels || []).join(", ");
    $("save-dialog").showModal();
    $("save-name").select();
  });
  $("save-cancel").addEventListener("click", () => $("save-dialog").close());
  $("save-confirm").addEventListener("click", saveCurrentPlot);
  $("save-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveCurrentPlot(); }
  });

  $("save-labels").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveCurrentPlot(); }
  });

  $("open-plot").addEventListener("click", openPlotDialog);
  $("open-cancel").addEventListener("click", () => $("open-dialog").close());
  $("plot-search").addEventListener("input", renderPlotList);
  $("plot-open-all").addEventListener("click", openAllListedPlots);
  $("plot-download-all").addEventListener("click", downloadPlotBundle);
  $("plot-import").addEventListener("click", () => $("plot-file").click());
  $("plot-file").addEventListener("change", async (e) => {
    for (const file of e.target.files) await importPlotFile(file);
    e.target.value = "";
  });
  $("share-plot").addEventListener("click", copyShareLink);
  $("avg-close").addEventListener("click", () => $("avg-dialog").close());
}

function parseLabels(text) {
  return text.split(",").map((l) => l.trim()).filter(Boolean);
}

async function saveCurrentPlot() {
  const name = $("save-name").value.trim();
  if (!name) return;
  const tab = activeTab();
  tab.labels = parseLabels($("save-labels").value);
  // The name in the config must be the one it is saved under, not the old
  // tab name, or an exported file disagrees with itself.
  if (!(await apiSavePlot(name, tabToConfig(tab, name)))) return;
  tab.name = name;
  $("save-dialog").close();
  renderTabs();
  saveState();
}

let plotList = [];        // last listing from the server
let labelFilter = null;   // active label chip, null = show all

async function openPlotDialog() {
  if (!$("open-dialog").open) $("open-dialog").showModal();
  plotList = await apiListPlots();
  renderPlotList();
}

function filteredPlots() {
  const q = $("plot-search").value.trim().toLowerCase();
  return plotList.filter((p) =>
    (!labelFilter || (p.labels || []).includes(labelFilter)) &&
    (!q || p.name.toLowerCase().includes(q))
  );
}

function renderPlotList() {
  // Label chips, from every label in use
  const chips = $("plot-labels");
  chips.innerHTML = "";
  const all = [...new Set(plotList.flatMap((p) => p.labels || []))].sort();
  if (labelFilter && !all.includes(labelFilter)) labelFilter = null;
  for (const label of ["All", ...all]) {
    const value = label === "All" ? null : label;
    const chip = el("button", "chip" + (labelFilter === value ? " active" : ""), label);
    chip.addEventListener("click", () => { labelFilter = value; renderPlotList(); });
    chips.appendChild(chip);
  }

  const listNode = $("plot-list");
  listNode.innerHTML = "";
  const plots = filteredPlots();
  $("plot-open-all").textContent = plots.length ? `Open all (${plots.length})` : "Open all";
  $("plot-open-all").disabled = !plots.length;
  if (!plots.length) {
    listNode.appendChild(el("div", "none",
      plotList.length ? "No plots match the filter." : "No saved plots yet."));
    return;
  }
  for (const plot of plots) {
    const item = el("div", "plot-item");
    item.appendChild(el("span", "name", plot.name));
    for (const label of plot.labels || []) {
      item.appendChild(el("span", "tag-label", label));
    }
    item.appendChild(el("span", "date", fmtTime(plot.modified, false)));

    const dl = el("button", "del", "\u2b07");
    dl.title = "Download this plot";
    dl.addEventListener("click", async (e) => {
      e.stopPropagation();
      const config = await apiGetPlot(plot.name);
      if (config) {
        downloadText(`${plot.name}.ip21plot.json`,
          JSON.stringify(config, null, 2), "application/json");
      }
    });
    item.appendChild(dl);

    const del = el("button", "del", "\ud83d\uddd1");
    del.title = "Delete saved plot";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete saved plot "${plot.name}"?`)) return;
      await apiDeletePlot(plot.name);
      openPlotDialog();
    });
    item.appendChild(del);

    item.addEventListener("click", async () => {
      const tab = await loadSavedPlot(plot.name);
      if (!tab) return;
      $("open-dialog").close();
      addTab(tab);
    });
    listNode.appendChild(item);
  }
}

// A saved plot as a ready-to-add tab, or null if it cannot be read.
async function loadSavedPlot(name) {
  const config = await apiGetPlot(name);
  if (!config) return null;
  return readConfig(name, config);
}

// Opens every plot the dialog is currently listing - i.e. matching the label
// chip and the name filter - one tab each, the same set "Download all" acts on.
async function openAllListedPlots() {
  const plots = filteredPlots();
  if (!plots.length) { showError("No plots to open"); return; }
  if (plots.length > OPEN_ALL_CONFIRM &&
      !confirm(`Open ${plots.length} plots, one tab each?`)) return;
  const tabs = [];
  let skipped = 0;
  for (const plot of plots) {
    const tab = await loadSavedPlot(plot.name);
    if (tab) tabs.push(tab); else skipped++;
  }
  if (!tabs.length) { showError("Could not read any of the listed plots"); return; }
  $("open-dialog").close();
  // Added in one go: addTab() re-renders and re-activates per call, which
  // would leave only the last plot showing after a whole list.
  state.tabs.push(...tabs);
  state.activeTabId = tabs[0].id;
  renderAll();
  saveState();
  if (skipped) showError(`Opened ${tabs.length} plot(s), skipped ${skipped}`);
}

const BUNDLE_FORMAT = "ip21-explorer-plots";

// Downloads the plots currently listed (i.e. matching the filter) as one file.
async function downloadPlotBundle() {
  const plots = filteredPlots();
  if (!plots.length) { showError("No plots to download"); return; }
  const entries = [];
  for (const plot of plots) {
    const config = await apiGetPlot(plot.name);
    if (config) entries.push({ name: plot.name, config });
  }
  const bundle = { format: BUNDLE_FORMAT, version: 1, plots: entries };
  const suffix = labelFilter ? `-${labelFilter}` : "";
  downloadText(`ip21-plots${suffix}.ip21plots.json`,
    JSON.stringify(bundle, null, 2), "application/json");
}

// A free name: "Plot", "Plot (2)", "Plot (3)"...
function freePlotName(name, taken) {
  if (!taken.has(name)) return name;
  for (let i = 2; i < 500; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} ${Date.now()}`;
}

// Accepts both a single plot config and a bundle of them.
async function importPlotFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (e) {
    showError(`${file.name} is not valid JSON`);
    return;
  }
  const entries = parsed && parsed.format === BUNDLE_FORMAT
    ? (Array.isArray(parsed.plots) ? parsed.plots : [])
    : [{ name: parsed.name || file.name.replace(/\.(ip21plot\.)?json$/i, ""), config: parsed }];

  const taken = new Set((await apiListPlots()).map((p) => p.name));
  let saved = 0, skipped = 0;
  for (const entry of entries) {
    const config = entry && entry.config;
    if (!config || !Array.isArray(config.tags)) { skipped++; continue; }
    const name = freePlotName(String(entry.name || "Imported plot").slice(0, 60), taken);
    if (await apiSavePlot(name, { ...config, name })) {
      taken.add(name);
      saved++;
    } else {
      skipped++;
    }
  }
  if (skipped) showError(`Imported ${saved} plot(s), skipped ${skipped}`);
  openPlotDialog();
}
