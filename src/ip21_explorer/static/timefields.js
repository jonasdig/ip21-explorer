/* The 24-hour time fields and their calendar. */

import {
  $, el, fmtTime, pad2, parseTimeInput, segmentAt, stepTime,
} from "./util.js";

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
// Monday first, as the rest of Europe reads a calendar.
const WEEKDAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

let calendarField = null;   // the input the open calendar belongs to
let calendarMonth = null;   // first of the month on show

// Arrow keys step the unit under the caret, so the field keeps the one thing
// the native picker was actually good at.
function onTimeFieldKey(e) {
  const field = e.target;
  if (e.key === "Enter") { $("apply-range").click(); return; }
  if (e.key === "Escape") { hideCalendar(); field.blur(); return; }
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  const t = parseTimeInput(field.value);
  if (t == null) return;
  e.preventDefault();
  const caret = field.selectionStart || 0;
  const seg = segmentAt(caret);
  const stepped = stepTime(t, seg.unit, e.key === "ArrowUp" ? 1 : -1);
  field.value = fmtTime(stepped, true);
  field.setSelectionRange(seg.from, seg.to);
  if (calendarField === field) showCalendar(field); // keep the grid in step
}

function hideCalendar() {
  $("calendar-popover").classList.add("hidden");
  calendarField = null;
}

// Writes back to the text field only - Apply stays the one thing that asks the
// historian for data, so a half-finished pick never triggers a fetch.
function showCalendar(field) {
  const pop = $("calendar-popover");
  const selected = parseTimeInput(field.value) ?? Date.now() / 1000;
  const sel = new Date(selected * 1000);
  if (calendarField !== field || !calendarMonth) {
    calendarMonth = new Date(sel.getFullYear(), sel.getMonth(), 1);
  }
  calendarField = field;
  pop.innerHTML = "";

  const setDate = (year, month, day) => {
    const cur = parseTimeInput(field.value) ?? Date.now() / 1000;
    const c = new Date(cur * 1000);
    const next = new Date(year, month, day, c.getHours(), c.getMinutes(), c.getSeconds());
    field.value = fmtTime(next.getTime() / 1000, true);
    showCalendar(field);
  };

  // Month header with the two steppers
  const head = el("div", "cal-head");
  const prev = el("button", "cal-nav", "\u2039");
  prev.title = "Previous month";
  prev.addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
    showCalendar(field);
  });
  const next = el("button", "cal-nav", "\u203a");
  next.title = "Next month";
  next.addEventListener("click", () => {
    calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
    showCalendar(field);
  });
  head.appendChild(prev);
  head.appendChild(el("span", "cal-title",
    `${MONTH_NAMES[calendarMonth.getMonth()]} ${calendarMonth.getFullYear()}`));
  head.appendChild(next);
  pop.appendChild(head);

  // Day grid, six rows so the popover never changes height month to month
  const grid = el("div", "cal-grid");
  for (const name of WEEKDAY_NAMES) grid.appendChild(el("span", "cal-dow", name));
  const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const lead = (firstOfMonth.getDay() + 6) % 7; // getDay() is Sunday-first
  const today = new Date();
  const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  for (let i = 0; i < 42; i++) {
    const day = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1 + i - lead);
    const outside = day.getMonth() !== calendarMonth.getMonth();
    const cell = el("button",
      "cal-day" + (outside ? " outside" : "") +
      (isSameDay(day, today) ? " today" : "") +
      (isSameDay(day, sel) ? " on" : ""), String(day.getDate()));
    cell.addEventListener("click", () =>
      setDate(day.getFullYear(), day.getMonth(), day.getDate()));
    grid.appendChild(cell);
  }
  pop.appendChild(grid);

  // 24h clock, one box per unit
  const timeRow = el("div", "cal-time");
  const units = [
    ["hour", sel.getHours(), 23],
    ["minute", sel.getMinutes(), 59],
    ["second", sel.getSeconds(), 59],
  ];
  units.forEach(([unit, value, max], i) => {
    if (i) timeRow.appendChild(el("span", "dim", ":"));
    const box = el("input");
    box.type = "number";
    box.min = "0";
    box.max = String(max);
    box.value = pad2(value);
    box.addEventListener("change", () => {
      const n = Math.max(0, Math.min(max, parseInt(box.value, 10) || 0));
      const cur = parseTimeInput(field.value) ?? Date.now() / 1000;
      const c = new Date(cur * 1000);
      if (unit === "hour") c.setHours(n);
      else if (unit === "minute") c.setMinutes(n);
      else c.setSeconds(n);
      field.value = fmtTime(c.getTime() / 1000, true);
      showCalendar(field);
    });
    timeRow.appendChild(box);
  });
  pop.appendChild(timeRow);

  const nowBtn = el("button", null, "Now");
  nowBtn.addEventListener("click", () => {
    field.value = fmtTime(Date.now() / 1000, true);
    calendarMonth = null;
    showCalendar(field);
  });
  pop.appendChild(nowBtn);

  // Anchored under the field, kept inside the window like the context menu.
  const rect = field.getBoundingClientRect();
  pop.classList.remove("hidden");
  pop.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 250))}px`;
  pop.style.top = `${rect.bottom + 6}px`;
}

export function initTimeFields() {
  for (const id of ["range-start", "range-end"]) {
    const field = $(id);
    field.addEventListener("keydown", onTimeFieldKey);
    field.addEventListener("focus", () => showCalendar(field));
    field.addEventListener("click", () => showCalendar(field));
    // Normalise whatever was typed once the field is left, so the format the
    // fields show is always the one they document.
    field.addEventListener("blur", () => {
      const t = parseTimeInput(field.value);
      if (t != null) field.value = fmtTime(t, true);
    });
  }
  document.addEventListener("pointerdown", (e) => {
    const pop = $("calendar-popover");
    if (pop.classList.contains("hidden")) return;
    if (!pop.contains(e.target) && !e.target.closest(".timefield")) hideCalendar();
  });
}
