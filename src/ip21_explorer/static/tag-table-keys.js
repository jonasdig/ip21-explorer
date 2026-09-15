/* Keyboard movement inside the tag settings table. */

import { moveTag } from "./app.js";
import { activeTab } from "./state.js";
import { focusTagCell } from "./tag-table.js";
import { $ } from "./util.js";

// The global shortcuts must stand aside for an edit in progress. Form controls
// were always exempt; the table adds buttons - colour, star, auto, remove -
// where Ctrl+C would otherwise copy every tag instead of the selection.
export function isEditingContext(node) {
  if (!node) return false;
  return ["INPUT", "SELECT", "TEXTAREA"].includes(node.tagName) || !!node.closest("#tag-table");
}

// Tab and Shift+Tab are left to the browser: its own order already runs left
// to right along a row and on into the next, skips the read-only spans, and
// lets focus out of the panel at either end. Enter and the arrows are what
// move between rows.
export function onTagTableKey(e) {
  const cell = e.target.closest("[data-col]");
  if (!cell) return;

  if (e.key === "Escape") {
    // Without this it reaches the global handler, which reads Escape as
    // "zoom back" and would move the chart out from under the edit.
    if (!$("context-menu").classList.contains("hidden")) return;
    e.stopPropagation();
    cell.blur();
    return;
  }

  const vertical = e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp";
  if (!vertical) return;

  const rows = [...$("tag-table").querySelectorAll(".row")];
  const index = rows.indexOf(cell.closest(".row"));
  if (index < 0) return;

  if (e.altKey && e.key !== "Enter") {
    // Alt+Arrow moves the row itself - the keyboard equivalent of dragging.
    e.preventDefault();
    e.stopPropagation();
    moveTag(activeTab(), index, index + (e.key === "ArrowDown" ? 1 : -1));
    focusTagCell(cell.dataset.uid, cell.dataset.col);
    return;
  }

  e.preventDefault();
  e.stopPropagation();
  // keydown runs before change, so an edit in progress has to be banked before
  // the caret leaves - otherwise the move would discard it.
  if (cell.tagName === "INPUT" && cell.type === "text") {
    cell.dispatchEvent(new Event("change"));
  }
  const down = e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey) ? -1 : 1;
  const target = rows[Math.max(0, Math.min(rows.length - 1, index + down))];
  if (!target || target === rows[index]) return;
  const next = focusTagCell(target.dataset.uid, cell.dataset.col);
  if (next && next.select) next.select();
}
