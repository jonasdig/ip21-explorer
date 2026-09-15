/* The tag settings table docked under the chart. */

import { favoriteMaps, orderedMaps, saveFavorites } from "./api.js";
import {
  autoScale, ensureMaps, moveTag, removeTag, renderTags, setAxisOwner,
  setTagField, tagDisplay,
} from "./app.js";
import { INTERVALS, SAMPLES } from "./constants.js";
import { openSwatchMenu } from "./menu.js";
import { activeTab, byUid, saveState, state } from "./state.js";
import { renderToolbar } from "./toolbar.js";
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
const TAG_TABLE_MIN_H = 96;

// Never so tall that the chart it is docked under has nothing left.
export function clampTableHeight(h) {
  const max = Math.max(TAG_TABLE_MIN_H, window.innerHeight - 240);
  return Math.min(max, Math.max(TAG_TABLE_MIN_H, Number(h) || TAG_TABLE_DEFAULT_H));
}

// Rows are kept and patched rather than rebuilt, so an edit in progress keeps
// its caret, its selection and its undo history. tagRowEls maps uid -> row.
let tagRowEls = new Map();
let tagRowsTabId = null;

export function renderTagTable() {
  const panel = $("tag-table");
  const tab = activeTab();
  panel.classList.toggle("hidden", !tab.tagTable);
  // Closed is the common case and every setting change renders, so cost
  // nothing while it is shut.
  if (!tab.tagTable) {
    tagRowEls.clear();
    tagRowsTabId = null;
    return;
  }
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

  body.classList.toggle("empty", !tab.tags.length);
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

  const sample = el("select");
  sample.title = "Sampling type";
  for (const s of SAMPLES) {
    const opt = el("option", null, s.label);
    opt.value = s.value;
    sample.appendChild(opt);
  }
  sample.addEventListener("change", () =>
    setTagField(activeTab(), tagOf(), "sample", sample.value));
  cellOf(row, "sample").appendChild(mark(sample, "sample"));

  const interval = el("select");
  interval.title = "Aggregate interval";
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

  const name = cellOf(row, "name");
  name.textContent = tagDisplay(tab, tag);
  name.title = tag.description ? `${tag.name} - ${tag.description}` : tag.name;
  cellOf(row, "unit").textContent = tag.unit || "";
  const desc = cellOf(row, "desc");
  desc.textContent = tag.description || "";
  desc.title = tag.description || "";

  updateMapCell(tab, tag, cellOf(row, "map"), row.dataset.uid);
}

// The map list arrives late (one request per tag) and the favourite order can
// change under it, so the options are rebuilt only when they would differ.
function updateMapCell(tab, tag, cell, uid) {
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

// The gear on a pill is now a way into the table rather than a popover of its
// own: open it if it is shut, put the row in view, and start the caret on the
// first setting that is actually worth changing.
export function openTagTable(tag) {
  const tab = activeTab();
  if (!tab.tagTable) {
    tab.tagTable = true;
    renderToolbar();
    renderTagTable();
    saveState();
  }
  const row = tagRowEls.get(tag.uid);
  if (row) {
    row.scrollIntoView({ block: "nearest" });
    row.classList.remove("flash");
    void row.offsetWidth; // restart the animation on a repeat click
    row.classList.add("flash");
  }
  focusTagCell(tag.uid, "color");
}

export function toggleTagTable() {
  const tab = activeTab();
  tab.tagTable = !tab.tagTable;
  renderToolbar();
  renderTagTable();
  saveState();
}
