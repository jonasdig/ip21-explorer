/* The context menu, the tag menu and the colour menu. */

import {
  exportCsvRange, exportTags, outermostScooters, showAverageDialog,
} from "./analysis.js";
import { currentXRange } from "./chart.js";
import { copyTags, pasteFromClipboard } from "./clipboard.js";
import { PALETTE, XY_SYMBOLS } from "./constants.js";
import { addScooterAt, mountScooters } from "./scooters.js";
import { activeTab, byUid, rt, saveState } from "./state.js";
import { focusTagCell } from "./tag-table.js";
import { duplicateTag, removeTag, setTagField, tagLabel } from "./tags.js";
import { popHistory, resetZoom } from "./timerange.js";
import { $, el } from "./util.js";
import {
  isXyMode, setXyAxis, symbolGlyph, xyGradient, xySeriesTags,
} from "./xy-chart.js";

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
  menu.appendChild(el("div", "sep"));

  // How the trace is drawn. Unlike a colour, these are things to try out, so
  // a click redraws the plot and the menu and leaves the menu open.
  const choose = (key, value) => {
    setTagField(tab, tag, key, value);
    openSwatchMenu(anchor, tab, byUid(tab, tag.uid) || tag);
  };
  const optionRow = (label, options, key, current) => {
    const row = el("div", "opts");
    row.appendChild(el("span", "label", label));
    for (const [value, make, title] of options) {
      const btn = el("button", value === current ? "on" : "");
      btn.title = title;
      btn.appendChild(make());
      btn.addEventListener("click", () => choose(key, value));
      row.appendChild(btn);
    }
    menu.appendChild(row);
  };
  const stroke = (style, width) => () => {
    const line = el("span", "stroke");
    line.style.borderTopStyle = style;
    line.style.borderTopWidth = `${width}px`;
    return line;
  };
  optionRow("Line", [
    ["solid", stroke("solid", 2), "Solid"],
    ["dash", stroke("dashed", 2), "Dashed"],
    ["dot", stroke("dotted", 2), "Dotted"],
    ["none", () => el("span", null, "\u2205"), "No line - the samples are drawn as dots"],
  ], "lineStyle", tag.lineStyle || "solid");
  optionRow("Width", [
    ["thin", stroke("solid", 1), "Thin"],
    ["normal", stroke("solid", 2), "Normal"],
    ["thick", stroke("solid", 3), "Thick"],
  ], "lineWidth", tag.lineWidth || "normal");

  const points = el("label", "opts check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = tag.points === true;
  box.addEventListener("change", () => choose("points", box.checked));
  points.appendChild(box);
  points.appendChild(el("span", null, "Dots on the samples (trend)"));
  menu.appendChild(points);

  const symbols = XY_SYMBOLS.map((symbol) =>
    [symbol, () => el("span", null, symbolGlyph(symbol)), symbol]);
  optionRow("XY symbol", [
    [null, () => el("span", null, "auto"), "One per series, by its place among them"],
  ].concat(symbols), "symbol", tag.symbol || null);
  // Whether this series' XY points say when (the ramp) or which (its colour).
  const swatchOf = (background) => () => {
    const chip = el("span", "chip");
    chip.style.background = background;
    return chip;
  };
  optionRow("XY colour", [
    ["time", swatchOf(xyGradient("to right")), "Colour each point by its time"],
    ["fixed", swatchOf(tag.color || PALETTE[0]), "Every point in this row's colour"],
  ], "pointColor", tag.pointColor === "fixed" ? "fixed" : "time");

  const rect = anchor.getBoundingClientRect();
  placeMenu(menu, rect.left, rect.bottom + 4);
}

export function showContextMenu(e, tAtCursor) {
  const tab = activeTab();
  const items = [];
  const mkItem = (label, key, action, disabled) =>
    items.push([label, key, action, disabled]);

  // In XY, which ticked row the others are plotted against - one line each,
  // the current one ticked off.
  const set = isXyMode(tab) ? xySeriesTags(tab) : {};
  if (set.x) {
    for (const t of [set.x, ...set.ys]) {
      const current = t === set.x;
      mkItem(`X axis: ${tagLabel(tab, t)}${current ? " \u2713" : ""}`, null,
        () => setXyAxis(t.uid), current);
    }
    items.push(null);
  }
  // tAtCursor is null in the XY plot: there is no time under the pointer
  // there, and a scooter would have nothing to stand on.
  if (tAtCursor != null) {
    mkItem("Add scooter here", "dbl-click", () => addScooterAt(tAtCursor));
    mkItem("Delete all scooters", null, () => {
      tab.scooters = [];
      mountScooters();
      saveState();
    }, !tab.scooters.length);
    items.push(null);
  }
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

export function showTagMenu(e, tag) {
  const tab = activeTab();
  openMenu(e, [
    ["Copy tag", "Ctrl+C", () => copyTags([tag])],
    ["Copy all tags", null, () => copyTags(tab.tags), !tab.tags.length],
    ["Duplicate tag", null, () => duplicateTag(tag.uid)],
    ["Paste tags", "Ctrl+V", pasteFromClipboard],
    null,
    ["Use as X axis", null, () => setXyAxis(tag.uid),
      !isXyMode(tab) || tag.visible === false || xySeriesTags(tab).x === tag],
    null,
    ["Remove tag", null, () => removeTag(tag.uid)],
  ]);
}

export function hideContextMenu() { $("context-menu").classList.add("hidden"); }
