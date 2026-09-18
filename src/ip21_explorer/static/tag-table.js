/* The tag settings table docked under the chart. */

import { favoriteMaps, orderedMaps, saveFavorites } from "./api.js";
import { isComputed } from "./computed.js";
import { INTERVALS, SAMPLES } from "./constants.js";
import { openSwatchMenu, showTagMenu } from "./menu.js";
import { activeTab, byUid, makeTag, normalizeTagName, saveState, state } from "./state.js";
import {
  autoScale, ensureMaps, insertTags, moveTag, removeTag, renderTags,
  setAxisOwner, setTagField,
} from "./tags.js";
import { $, el } from "./util.js";

// A row is a grid of its own rather than one grid for the whole table, so a
// row can carry hover, a border and a drag ghost. The columns still line up
// because every row uses this same template.
const TAG_COLUMNS = [
  { key: "grip", label: "", width: "20px" },
  { key: "visible", label: "", width: "22px" },
  { key: "axis", label: "Grid", width: "32px" },
  { key: "color", label: "", width: "24px" },
  { key: "name", label: "Tag", width: "minmax(110px, 1fr)" },
  { key: "map", label: "Map", width: "142px" },
  { key: "sample", label: "Type", width: "72px" },
  { key: "interval", label: "Period", width: "80px" },
  { key: "step", label: "Step", width: "36px" },
  { key: "min", label: "Min", width: "68px" },
  { key: "max", label: "Max", width: "68px" },
  { key: "auto", label: "", width: "38px" },
  { key: "unit", label: "Unit", width: "56px" },
  { key: "desc", label: "Description", width: "minmax(120px, 2fr)" },
  { key: "remove", label: "", width: "24px" },
];

export const TAG_TABLE_DEFAULT_H = 200;
// The resize strip plus the header row: dragged all the way down, the table
// keeps only its column headings - enough to say it is there, and to drag it
// back up - while the chart gets everything else.
const TAG_TABLE_MIN_H = 28;

// Never so tall that the chart it is docked under has nothing left.
export function clampTableHeight(h) {
  const max = Math.max(TAG_TABLE_MIN_H, window.innerHeight - 240);
  return Math.min(max, Math.max(TAG_TABLE_MIN_H, Number(h) || TAG_TABLE_DEFAULT_H));
}

// Rows are kept and patched rather than rebuilt, so an edit in progress keeps
// its caret, its selection and its undo history. tagRowEls maps uid -> row.
let tagRowEls = new Map();
let tagRowsTabId = null;
let newRowEl = null;

export function renderTagTable() {
  const panel = $("tag-table");
  const tab = activeTab();
  panel.style.height = `${clampTableHeight(state.tagTableHeight)}px`;

  const head = panel.querySelector(".head");
  if (!head.childElementCount) {
    head.style.gridTemplateColumns = TAG_COLUMNS.map((c) => c.width).join(" ");
    for (const col of TAG_COLUMNS) head.appendChild(el("span", null, col.label));
  }

  const body = panel.querySelector(".body");
  // uids are unique per tab, so a tab switch starts from a clean slate.
  if (tagRowsTabId !== tab.id) {
    body.innerHTML = "";
    tagRowEls.clear();
    tagRowsTabId = tab.id;
  }

  const live = new Set(tab.tags.map((t) => t.uid));
  for (const [uid, row] of tagRowEls) {
    if (!live.has(uid)) { row.remove(); tagRowEls.delete(uid); }
  }

  let previous = null;
  for (const tag of tab.tags) {
    let row = tagRowEls.get(tag.uid);
    if (!row) {
      row = buildTagRow(tag.uid);
      tagRowEls.set(tag.uid, row);
      body.appendChild(row);
    }
    // Moving a focused node blurs it in Chrome, so only touch the order when
    // it actually differs - which is only just after a drag.
    const expected = previous ? previous.nextSibling : body.firstChild;
    if (row !== expected) body.insertBefore(row, expected);
    previous = row;
    updateTagRow(tab, tag, row);
  }

  // Always last, and re-appended after a tab switch empties the body.
  if (!newRowEl) newRowEl = buildNewRow();
  if (newRowEl.parentNode !== body) body.appendChild(newRowEl);
}

function cellOf(row, key) {
  return row.children[TAG_COLUMNS.findIndex((c) => c.key === key)];
}

// Cells and their listeners are built exactly once per tag. Listeners close
// over the uid and look the tag up when they fire, so a row survives anything
// that reorders or replaces the tag objects.
function buildTagRow(uid) {
  const row = el("div", "row");
  row.dataset.uid = uid;
  row.style.gridTemplateColumns = TAG_COLUMNS.map((c) => c.width).join(" ");
  const tagOf = () => byUid(activeTab(), uid);

  for (const col of TAG_COLUMNS) {
    const cell = el("span", `cell ${col.key}`);
    row.appendChild(cell);
  }

  const mark = (control, key) => {
    control.dataset.uid = uid;
    control.dataset.col = key;
    return control;
  };

  row.addEventListener("contextmenu", (e) => {
    // A text field keeps the browser's own menu: that is where pasting a tag
    // name belongs, and our menu pastes whole tags instead.
    if (e.target.matches('input[type="text"]')) return;
    e.preventDefault();
    showTagMenu(e, tagOf());
  });

  const grip = el("span", "handle", "⠿");
  grip.title = "Drag to reorder (or Alt+Up / Alt+Down from any cell)";
  grip.addEventListener("pointerdown", (ev) => beginRowDrag(ev, uid));
  cellOf(row, "grip").appendChild(grip);

  const visible = el("input");
  visible.type = "checkbox";
  visible.title = "Show this tag on the plot";
  visible.addEventListener("change", () =>
    setTagField(activeTab(), tagOf(), "visible", visible.checked));
  cellOf(row, "visible").appendChild(mark(visible, "visible"));

  const axis = el("input");
  axis.type = "radio";
  axis.title = "Use this tag's scale for the gridlines";
  axis.addEventListener("change", () => {
    if (axis.checked) setAxisOwner(activeTab(), uid);
  });
  cellOf(row, "axis").appendChild(mark(axis, "axis"));

  const color = el("button", "swatch");
  color.title = "Trend colour";
  color.addEventListener("click", () =>
    openSwatchMenu(color, activeTab(), tagOf()));
  cellOf(row, "color").appendChild(mark(color, "color"));

  // Editable, because correcting a mistyped tag is the common case: LIC-2010A
  // should become LIC-2010B by typing over it, not by removing and searching
  // again. The field holds the bare name - the map has its own column, and the
  // label mode is a display setting for the plot.
  const name = el("input");
  name.type = "text";
  name.spellcheck = false;
  name.autocomplete = "off";
  name.addEventListener("change", () =>
    setTagField(activeTab(), tagOf(), "name", name.value));
  cellOf(row, "name").appendChild(mark(name, "name"));

  const sample = el("select");
  sample.title = "Sampling type (on a formula row: for the tags it fetches itself)";
  for (const s of SAMPLES) {
    const opt = el("option", null, s.label);
    opt.value = s.value;
    sample.appendChild(opt);
  }
  sample.addEventListener("change", () =>
    setTagField(activeTab(), tagOf(), "sample", sample.value));
  cellOf(row, "sample").appendChild(mark(sample, "sample"));

  const interval = el("select");
  interval.title = "Aggregate interval (on a formula row: for the tags it fetches itself)";
  for (const item of INTERVALS) {
    const opt = el("option", null, item.label);
    opt.value = item.value;
    interval.appendChild(opt);
  }
  interval.addEventListener("change", () =>
    setTagField(activeTab(), tagOf(), "interval", interval.value));
  cellOf(row, "interval").appendChild(mark(interval, "interval"));

  const step = el("input");
  step.type = "checkbox";
  step.title = "Hold the last value instead of drawing a line between samples";
  step.addEventListener("change", () =>
    setTagField(activeTab(), tagOf(), "step", step.checked));
  cellOf(row, "step").appendChild(mark(step, "step"));

  // Text rather than number: a number input steals ArrowUp/Down to step its
  // value, and those keys move between rows here.
  for (const key of ["min", "max"]) {
    const input = el("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "auto";
    input.title = `Scale ${key} - leave empty for auto`;
    input.addEventListener("change", () => commitScale(tagOf(), key, input));
    cellOf(row, key).appendChild(mark(input, key));
  }

  // Not the word "auto": it would sit right beside two fields whose own
  // placeholder is already "auto", and read as a third one.
  const auto = el("button", null, "\u21ba");
  auto.title = "Back to an automatic scale";
  auto.addEventListener("click", () => autoScale(activeTab(), tagOf()));
  cellOf(row, "auto").appendChild(mark(auto, "auto"));

  const remove = el("button", "close", "×");
  remove.title = "Remove tag";
  remove.addEventListener("click", () => removeTag(uid));
  cellOf(row, "remove").appendChild(mark(remove, "remove"));

  return row;
}

// Writing the scale has to be idempotent: a keyboard move commits before it
// leaves the cell, and the browser then fires change on the way out anyway.
function commitScale(tag, key, input) {
  if (!tag) return;
  const text = input.value.trim();
  const value = text === "" ? null : parseFloat(text);
  const next = Number.isFinite(value) ? value : null;
  if (next === tag[key]) return;
  setTagField(activeTab(), tag, key, next);
}

function updateTagRow(tab, tag, row) {
  const busy = (control) => control === document.activeElement;
  const set = (key, fn) => {
    const control = cellOf(row, key).firstElementChild;
    // Never rewrite the control under the caret: it would lose the edit.
    if (control && !busy(control)) fn(control);
  };

  row.classList.toggle("hidden-tag", tag.visible === false);
  set("visible", (c) => { c.checked = tag.visible !== false; });
  set("axis", (c) => { c.checked = tab.axisUid === tag.uid; c.name = `axis-owner-${tab.id}`; });
  set("color", (c) => { c.style.background = tag.color || "transparent"; });
  set("sample", (c) => { c.value = tag.sample; });
  set("interval", (c) => { c.value = tag.interval; });
  set("step", (c) => { c.checked = !!tag.step; });
  set("min", (c) => { c.value = tag.min == null ? "" : tag.min; });
  set("max", (c) => { c.value = tag.max == null ? "" : tag.max; });

  // A tag the last fetch had nothing for says so in its own row: the plot can
  // only show a missing trace as absence, which reads as "no data yet".
  const error = tag._error;
  row.classList.toggle("error", !!(error && error.hard));
  set("name", (c) => {
    c.value = tag.name;
    c.title = error ? error.text
      : tag.description ? `${tag.name} - ${tag.description}` : tag.name;
  });
  // A tag's unit and description come from the historian and are read-only; a
  // formula has neither until the user writes them, so there they are fields.
  // An error takes the description cell either way - it is the widest column,
  // and next to the expression that caused it.
  const computed = isComputed(tag);
  ownCell(cellOf(row, "unit"), row.dataset.uid, "unit", tag.unit || "",
    computed && !error, "unit");
  const desc = cellOf(row, "desc");
  desc.classList.toggle("problem", !!error);
  ownCell(desc, row.dataset.uid, "description",
    error ? error.text : (tag.description || ""),
    computed && !error, "name this formula");
  desc.title = error ? error.text : (tag.description || "");

  updateMapCell(tab, tag, cellOf(row, "map"), row.dataset.uid);
}

// A cell that is plain text for most rows and a field for the rows that own
// their value. The control is built once and then left alone, like every other
// editable cell here, so an edit in progress keeps its caret.
function ownCell(cell, uid, col, value, editable, placeholder) {
  if (!editable) {
    if (cell.firstElementChild) cell.innerHTML = "";
    cell.textContent = value;
    return;
  }
  let input = cell.querySelector("input");
  if (!input) {
    cell.textContent = "";
    input = el("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.dataset.uid = uid;
    input.dataset.col = col;
    input.addEventListener("change", () =>
      setTagField(activeTab(), byUid(activeTab(), uid), col, input.value));
    cell.appendChild(input);
  }
  if (input !== document.activeElement) input.value = value;
}

// The map list arrives late (one request per tag) and the favourite order can
// change under it, so the options are rebuilt only when they would differ.
function updateMapCell(tab, tag, cell, uid) {
  // A formula asks the historian for nothing of its own, so it has no map.
  if (isComputed(tag)) {
    if (cell.textContent !== "\u2013") { cell.innerHTML = ""; cell.textContent = "\u2013"; }
    return;
  }
  ensureMaps(tab, tag);

  if (!tag.maps.length) {
    // A source that cannot list maps (live Aspen): type one in.
    let input = cell.querySelector("input");
    if (!input) {
      cell.innerHTML = "";
      input = el("input");
      input.type = "text";
      input.placeholder = "default map";
      input.dataset.uid = uid;
      input.dataset.col = "map";
      input.addEventListener("change", () =>
        setTagField(activeTab(), byUid(activeTab(), uid), "map", input.value.trim()));
      cell.appendChild(input);
    }
    if (input !== document.activeElement) input.value = tag.map || "";
    return;
  }

  const selected = tag.map || tag.maps[0].name;
  const signature = `${tag.maps.map((m) => m.name).join(",")}|${favoriteMaps.join(",")}`;
  let select = cell.querySelector("select");
  if (!select || select.dataset.signature !== signature) {
    if (select === document.activeElement) return; // rebuilding would drop the menu
    cell.innerHTML = "";
    select = el("select");
    select.dataset.signature = signature;
    select.dataset.uid = uid;
    select.dataset.col = "map";
    const mkOption = (m) => {
      const opt = el("option", null, m.name);
      opt.value = m.name;
      return opt;
    };
    const favoured = tag.maps.filter((m) => favoriteMaps.includes(m.name));
    if (favoured.length && favoured.length < tag.maps.length) {
      // Favourites first, without touching tag.maps itself.
      const favGroup = document.createElement("optgroup");
      favGroup.label = "Favourites";
      for (const m of orderedMaps(favoured)) favGroup.appendChild(mkOption(m));
      select.appendChild(favGroup);
      const restGroup = document.createElement("optgroup");
      restGroup.label = "All maps";
      for (const m of tag.maps) {
        if (!favoriteMaps.includes(m.name)) restGroup.appendChild(mkOption(m));
      }
      select.appendChild(restGroup);
    } else {
      for (const m of tag.maps) select.appendChild(mkOption(m));
    }
    select.addEventListener("change", () =>
      setTagField(activeTab(), byUid(activeTab(), uid), "map", select.value));
    cell.appendChild(select);

    // Starring sorts a map first for every tag that has it, so the cell has to
    // be rebuilt afterwards - the signature above sees to that.
    const star = el("button", "star");
    star.dataset.uid = uid;
    star.dataset.col = "star";
    star.title = "Favourite maps sort first everywhere, and are stored in the server's env file";
    star.addEventListener("click", async () => {
      const current = select.value;
      const names = favoriteMaps.includes(current)
        ? favoriteMaps.filter((n) => n !== current)
        : [...favoriteMaps, current];
      if (await saveFavorites(names)) renderTags();
    });
    cell.appendChild(star);
  }
  if (select !== document.activeElement) select.value = selected;
  const star = cell.querySelector(".star");
  if (star) {
    const on = favoriteMaps.includes(selected);
    star.classList.toggle("on", on);
    star.textContent = on ? "★" : "☆";
  }
}

// The blank row at the bottom of the table. There is no search behind it, so
// the name has to be spelled right - one that is not comes back marked as a
// row the historian had nothing for.
function buildNewRow() {
  const row = el("div", "row newrow");
  row.style.gridTemplateColumns = TAG_COLUMNS.map((c) => c.width).join(" ");
  for (const col of TAG_COLUMNS) row.appendChild(el("span", `cell ${col.key}`));

  const input = el("input");
  input.type = "text";
  input.placeholder = "+ tag";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.title = "Type a tag name and press Enter; several at once, separated by spaces or commas. " +
    "A name starting with = is a formula: =[TI-101] - [TI-201]";
  input.dataset.col = "new";
  input.addEventListener("keydown", async (e) => {
    // The table's Enter and arrow navigation is for rows that exist.
    e.stopPropagation();
    if (e.key === "ArrowUp") {
      const rows = [...$("tag-table").querySelectorAll(".row:not(.newrow)")];
      const last = rows[rows.length - 1];
      if (!last) return;
      e.preventDefault();
      focusTagCell(last.dataset.uid, "name");
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    // ";" separates a tag from its map and has to survive, and a formula is
    // one row however many spaces and commas it contains.
    const text = input.value.trim();
    const names = isComputed({ name: text })
      ? [text]
      : text.split(/[,\s]+/).map((n) => n.trim()).filter(Boolean);
    if (!names.length) return;
    input.value = "";
    const tags = names.map((n) => makeTag({ name: normalizeTagName(n) }));
    await insertTags(activeTab(), tags);
    input.focus(); // ready for the next one
  });
  cellOf(row, "name").appendChild(input);
  cellOf(row, "desc").textContent = "type a tag name and press Enter";
  return row;
}

// Puts the caret back where the user was, addressed by tag and column rather
// than by any element that a re-render might have replaced.
export function focusTagCell(uid, col) {
  const control = $("tag-table").querySelector(`[data-uid="${uid}"][data-col="${col}"]`);
  if (control) control.focus();
  return control;
}

// Pointer events rather than HTML5 drag-and-drop: the app already drags
// scooters, readout boxes and the navigator window this way, and draggable
// rows full of inputs behave badly. The DOM is left alone until the drop, so
// the row reconciler and the hit test stay out of each other's way.
function beginRowDrag(e, uid) {
  const body = $("tag-table").querySelector(".body");
  const rows = [...body.querySelectorAll(".row")];
  const from = rows.findIndex((r) => r.dataset.uid === uid);
  if (from < 0) return;
  const row = rows[from];
  const height = row.getBoundingClientRect().height || 26;

  e.preventDefault();
  e.target.setPointerCapture(e.pointerId);
  row.classList.add("dragging");
  const line = el("div", "drop-line");
  body.appendChild(line);

  const startY = e.clientY;
  let to = from;

  const place = (clientY) => {
    const box = body.getBoundingClientRect();
    const offset = clientY - box.top + body.scrollTop;
    to = Math.max(0, Math.min(rows.length - 1, Math.floor(offset / height)));
    row.style.transform = `translateY(${clientY - startY}px)`;
    line.style.top = `${(to > from ? to + 1 : to) * height}px`;
    // Drag past the edge and the list follows.
    if (clientY < box.top + 24) body.scrollTop -= 8;
    else if (clientY > box.bottom - 24) body.scrollTop += 8;
  };
  place(e.clientY);

  const onMove = (ev) => place(ev.clientY);
  const onUp = () => {
    e.target.removeEventListener("pointermove", onMove);
    e.target.removeEventListener("pointerup", onUp);
    row.classList.remove("dragging");
    row.style.transform = "";
    line.remove();
    moveTag(activeTab(), from, to);
  };
  e.target.addEventListener("pointermove", onMove);
  e.target.addEventListener("pointerup", onUp);
}

// Dragging the top edge trades chart height for table height. The chart is
// flex: 1 and gives the space up on its own; its ResizeObserver does the rest.
export function beginTableResize(e) {
  const panel = $("tag-table");
  e.preventDefault();
  e.target.setPointerCapture(e.pointerId);
  const startY = e.clientY;
  const startH = panel.getBoundingClientRect().height;
  const onMove = (ev) => {
    state.tagTableHeight = clampTableHeight(startH + (startY - ev.clientY));
    panel.style.height = `${state.tagTableHeight}px`;
  };
  const onUp = () => {
    e.target.removeEventListener("pointermove", onMove);
    e.target.removeEventListener("pointerup", onUp);
    saveState();
  };
  e.target.addEventListener("pointermove", onMove);
  e.target.addEventListener("pointerup", onUp);
}

// A tag that was just added can be anywhere in a table of forty rows, so the
// eye is led to it.
export function revealTagRow(uid) {
  const row = tagRowEls.get(uid);
  if (!row) return;
  row.scrollIntoView({ block: "nearest" });
  row.classList.remove("flash");
  void row.offsetWidth; // restart the animation on a repeat
  row.classList.add("flash");
}
