/* The context menu, the pill menu and the colour menu. */

import {
  exportCsvRange, exportTags, outermostScooters, showAverageDialog,
} from "./analysis.js";
import {
  addScooterAt, currentXRange, duplicateTag, focusTagCell, mountScooters,
  popHistory, removeTag, resetZoom, setTagField,
} from "./app.js";
import { copyTags, pasteFromClipboard } from "./clipboard.js";
import { PALETTE } from "./constants.js";
import { activeTab, rt, saveState } from "./state.js";
import { $, el } from "./util.js";

// Opens #context-menu at the event position with the given items, where an
// item is [label, shortcut, action, disabled] and null is a separator.
export function openMenu(e, items) {
  const menu = $("context-menu");
  menu.innerHTML = "";
  for (const spec of items) {
    if (!spec) { menu.appendChild(el("div", "sep")); continue; }
    const [label, key, action, disabled] = spec;
    const item = el("div", "menu-item" + (disabled ? " disabled" : ""));
    item.appendChild(el("span", null, label));
    if (key) item.appendChild(el("span", "key", key));
    item.addEventListener("click", () => { hideContextMenu(); action(); });
    menu.appendChild(item);
  }
  placeMenu(menu, e.clientX, e.clientY);
}

// Kept apart from openMenu so a menu opened from a cell can be placed under
// the control that opened it, where there is no pointer position to use.
function placeMenu(menu, x, y) {
  // Measure the menu while invisible so the clamp tracks its real size.
  menu.style.visibility = "hidden";
  menu.classList.remove("hidden");
  const left = Math.min(x, window.innerWidth - menu.offsetWidth - 8);
  const top = Math.min(y, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = `${Math.max(0, left)}px`;
  menu.style.top = `${Math.max(0, top)}px`;
  menu.style.visibility = "";
}

// The palette, as a menu hung under a cell. A select cannot show colours, so
// this is the one table cell that needs a menu of its own.
export function openSwatchMenu(anchor, tab, tag) {
  const menu = $("context-menu");
  menu.innerHTML = "";
  const grid = el("div", "swatches");
  const taken = new Set(tab.tags.filter((t) => t !== tag).map((t) => t.color));
  for (const color of PALETTE) {
    const swatch = el("button", "swatch" + (color === tag.color ? " on" : "") +
      (taken.has(color) ? " taken" : ""));
    swatch.style.background = color;
    swatch.title = taken.has(color) ? `${color} (used by another tag)` : color;
    swatch.addEventListener("click", () => {
      hideContextMenu();
      setTagField(tab, tag, "color", color);
      focusTagCell(tag.uid, "color");
    });
    grid.appendChild(swatch);
  }
  menu.appendChild(grid);

  const custom = el("div", "menu-item");
  custom.appendChild(el("span", null, "Custom"));
  const picker = el("input");
  picker.type = "color";
  picker.value = tag.color || PALETTE[0];
  picker.addEventListener("change", () => {
    hideContextMenu();
    setTagField(tab, tag, "color", picker.value);
    focusTagCell(tag.uid, "color");
  });
  custom.appendChild(picker);
  menu.appendChild(custom);

  const rect = anchor.getBoundingClientRect();
  placeMenu(menu, rect.left, rect.bottom + 4);
}

export function showContextMenu(e, tAtCursor) {
  const tab = activeTab();
  const items = [];
  const mkItem = (label, key, action, disabled) =>
    items.push([label, key, action, disabled]);

  mkItem("Add scooter here", "dbl-click", () => addScooterAt(tAtCursor));
  mkItem("Delete all scooters", null, () => {
    tab.scooters = [];
    mountScooters();
    saveState();
  }, !tab.scooters.length);
  items.push(null);
  mkItem("Zoom back", "Esc", popHistory, !(tab.history && tab.history.length));
  mkItem("Reset zoom", null, resetZoom);
  items.push(null);

  const r = rt(tab);
  const noData = !r.raw || !exportTags(tab, r).length;
  const pair = outermostScooters(tab);
  mkItem("Export CSV (visible window)", null, () => {
    const cur = currentXRange();
    exportCsvRange(cur.start, cur.end);
  }, noData);
  mkItem("Export CSV (between scooters)", null, () => {
    exportCsvRange(pair.t0, pair.t1);
  }, noData || !pair);
  mkItem("Average between scooters", null, () => {
    showAverageDialog(pair.t0, pair.t1);
  }, noData || !pair);

  openMenu(e, items);
}

export function showPillMenu(e, tag) {
  const tab = activeTab();
  openMenu(e, [
    ["Copy tag", "Ctrl+C", () => copyTags([tag])],
    ["Copy all tags", null, () => copyTags(tab.tags), !tab.tags.length],
    ["Duplicate tag", null, () => duplicateTag(tag.uid)],
    ["Paste tags", "Ctrl+V", pasteFromClipboard],
    null,
    ["Remove tag", null, () => removeTag(tag.uid)],
  ]);
}

export function hideContextMenu() { $("context-menu").classList.add("hidden"); }
