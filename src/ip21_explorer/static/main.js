/* IP21 Explorer frontend entry point: wires the modules together and starts
   the app. Modules are always strict, so there is no "use strict" here. */

import { apiFunctions, apiSearchTags, ensureFavorites } from "./api.js";
import { chart, chartSize, renderChart } from "./chart.js";
import { formulaItems } from "./computed.js";
import { loadData } from "./data.js";
import { parseFormula, setFunctionCatalog } from "./formula.js";
import { hideContextMenu } from "./menu.js";
import { initNavigator, renderNavigator } from "./navigator.js";
import { initDialogs } from "./plots.js";
import { positionScooters } from "./scooters.js";
import { initSearch } from "./search.js";
import { openSharedPlot } from "./share.js";
import {
  activeTab, byUid, loadState, makeTag, persistState, rt, saveTimer, state,
} from "./state.js";
import { initTabbar, renderTabs } from "./tabs.js";
import {
  insertTags, moveTag, removeTags, renderTags, setTagFields,
} from "./tags.js";
import { initToolbar, renderToolbar } from "./toolbar.js";
import { $ } from "./util.js";
import { initXyLegend, placeXyLegend } from "./xy-chart.js";

document.addEventListener("pointerdown", (e) => {
  const menu = $("context-menu");
  if (!menu.classList.contains("hidden") && !menu.contains(e.target)) {
    hideContextMenu();
  }
});

export function renderAll() {
  renderTabs();
  renderToolbar();
  renderTags();
  renderChart();
  renderNavigator();
}

function init() {
  loadState();
  initSearch();
  initToolbar();
  initTabbar();
  initDialogs();
  initNavigator();
  initXyLegend();
  ensureFavorites();
  // What a formula may call, from the server's own catalog: the parser reads
  // formulas with it, and the block editor builds its palette from it. Until
  // it lands, the handful of built-in functions still parse.
  apiFunctions()
    .then((answer) => { setFunctionCatalog(answer); renderTags(); })
    .catch((err) => console.warn("could not read the function list:", err.message));
  renderAll();
  // A #p=... link adds its plot as a new tab on top of the restored state.
  openSharedPlot();

  const resizeObserver = new ResizeObserver(() => {
    if (chart) {
      chart.setSize(chartSize());
      positionScooters();
    }
    renderNavigator(); // the canvas is sized from its own box, so redraw it
    placeXyLegend();   // re-clamped, so a smaller window cannot lose it
  });
  resizeObserver.observe($("chart-wrap"));

  window.addEventListener("beforeunload", () => {
    clearTimeout(saveTimer);
    persistState();
  });
}

init();

// Module code keeps its names out of window, so the browser console needs a
// way in. Getters, because state and chart are replaced rather than mutated.
window.ip21 = {
  get state() { return state; },
  get chart() { return chart; },
  activeTab, rt, byUid, makeTag, renderAll, loadData, apiSearchTags,
  insertTags, removeTags, setTagFields, moveTag,
  // The formula parser is a pure function: worth being able to try one
  // straight from the console (and to check it against
  // tests/fixtures/formula_cases.json) without a row and a fetch behind it.
  parseFormula, formulaItems, setFunctionCatalog,
};
