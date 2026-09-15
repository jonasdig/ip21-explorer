/* The tab strip: rendering, overflow, switching, closing and linking. */

import { loadData, renderAll } from "./app.js";
import { openMenu } from "./menu.js";
import { activeTab, newTab, runtime, saveState, state } from "./state.js";
import { pushHistory } from "./timerange.js";
import { renderToolbar } from "./toolbar.js";
import { $, el } from "./util.js";

export function renderTabs() {
  const container = $("tabs");
  container.innerHTML = "";
  for (const tab of state.tabs) {
    const node = el("div", "tab" + (tab.id === state.activeTabId ? " active" : ""));
    node.title = tab.name; // names ellipsize when the strip gets tight
    node.appendChild(el("span", "name", tab.name));
    const close = el("button", "close", "×");
    close.title = "Close tab";
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(tab.id); });
    node.appendChild(close);
    node.addEventListener("click", () => switchTab(tab.id));
    node.addEventListener("dblclick", () => {
      const name = prompt("Tab name:", tab.name);
      if (name) { tab.name = name.trim().slice(0, 60) || tab.name; renderTabs(); saveState(); }
    });
    container.appendChild(node);
  }
  $("link-ranges-cb").checked = !!activeTab().linked;
  // innerHTML was rebuilt, so the strip scrolled back to the start: put the
  // active tab back in view before measuring what ends up clipped.
  revealActiveTab();
}

function revealActiveTab() {
  const active = $("tabs").querySelector(".tab.active");
  if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
  updateTabOverflow();
}

// Tabs shrink to a floor (see .tab in style.css) and only then does the strip
// scroll, so past a certain count some tabs sit outside it. Measured with
// client rects because #tabs is not a positioned ancestor, which would make
// offsetLeft and scrollLeft refer to different origins.
function clippedTabs() {
  const container = $("tabs");
  const box = container.getBoundingClientRect();
  const out = [];
  state.tabs.forEach((tab, i) => {
    const node = container.children[i];
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (rect.left < box.left - 1 || rect.right > box.right + 1) out.push(tab);
  });
  return out;
}

// Keeps the edge fades and the "» N" button in sync with what is out of view.
function updateTabOverflow() {
  const container = $("tabs");
  const maxScroll = container.scrollWidth - container.clientWidth;
  container.classList.toggle("fade-left", container.scrollLeft > 1);
  container.classList.toggle("fade-right", container.scrollLeft < maxScroll - 1);
  const hidden = clippedTabs().length;
  const btn = $("tab-overflow");
  btn.textContent = `» ${hidden}`;
  btn.classList.toggle("hidden", hidden === 0);
}

// Doubles as a tab switcher: every tab is listed, the ones out of view marked.
// Nothing is disabled - the active tab can itself be scrolled out of sight,
// and picking it then has to be the way back to it.
function openTabMenu(e) {
  const clipped = new Set(clippedTabs().map((t) => t.id));
  openMenu(e, state.tabs.map((tab) => [
    tab.name,
    tab.id === state.activeTabId ? "active" : clipped.has(tab.id) ? "out of view" : null,
    () => (tab.id === state.activeTabId ? revealActiveTab() : switchTab(tab.id)),
  ]));
}

export function initTabbar() {
  const container = $("tabs");
  $("tab-overflow").addEventListener("click", openTabMenu);
  container.addEventListener("scroll", updateTabOverflow);
  new ResizeObserver(updateTabOverflow).observe(container);
  // A horizontal strip with no horizontal wheel is awkward to reach, so map
  // vertical wheel movement onto it.
  container.addEventListener("wheel", (e) => {
    if (container.scrollWidth <= container.clientWidth) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // real sideways wheel
    e.preventDefault();
    container.scrollLeft += e.deltaY;
    updateTabOverflow(); // don't wait for the scroll event to be delivered
  }, { passive: false });
}

function switchTab(id) {
  if (state.activeTabId === id) return;
  state.activeTabId = id;
  renderAll();
  saveState();
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  state.tabs.splice(idx, 1);
  runtime.delete(id);
  if (!state.tabs.length) {
    const tab = newTab("Plot 1");
    state.tabs.push(tab);
    state.activeTabId = tab.id;
  } else if (state.activeTabId === id) {
    state.activeTabId = state.tabs[Math.min(idx, state.tabs.length - 1)].id;
  }
  renderAll();
  saveState();
}

export function addTab(tab) {
  tab = tab || newTab();
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  renderAll();
  saveState();
  return tab;
}

export function setLinked(checked) {
  const tab = activeTab();
  tab.linked = checked;
  if (checked) {
    // Join the group: adopt the range of an already-linked tab.
    const other = state.tabs.find((t) => t.id !== tab.id && t.linked);
    if (other) {
      pushHistory(tab);
      tab.range = JSON.parse(JSON.stringify(other.range));
      loadData(tab);
      renderToolbar();
    }
  }
  saveState();
}
