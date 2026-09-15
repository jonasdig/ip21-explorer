/* IP21 Explorer frontend entry point: wires the modules together and starts
   the app. Modules are always strict, so there is no "use strict" here. */

import { apiSearchTags, ensureFavorites } from "./api.js";
import { chart, chartSize, renderChart } from "./chart.js";
import { loadData } from "./data.js";
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
  ensureFavorites();
  renderAll();
  // A #p=... link adds its plot as a new tab on top of the restored state.
  openSharedPlot();

  const resizeObserver = new ResizeObserver(() => {
    if (chart) {
      chart.setSize(chartSize());
      positionScooters();
    }
    renderNavigator(); // the canvas is sized from its own box, so redraw it
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
};
