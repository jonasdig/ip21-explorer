/* The block editor: a formula built by dragging blocks in and wiring them up.

   It edits a graph (formula-graph.js) and hands back text: Apply writes the
   expression into the row's Tag field exactly as if it had been typed, so
   everything after that - fetching, computing, saving - is the formula path
   that already exists. The graph itself is kept on the row only so that the
   blocks come back where they were left. */

import { apiSearchTags } from "./api.js";
import { xAxisValues } from "./chart.js";
import { isComputed, previewFormulas } from "./computed.js";
import { MIN_QUERY_LEN, SEARCH_DEBOUNCE_MS } from "./constants.js";
import { FUNCTION_NAMES, PERIODS, RESOLUTIONS } from "./formula.js";
import { BLOCK_HELP, helpKey } from "./formula-help.js";
import {
  emptyGraph, graphFromText, inputPorts, isVariadic, layoutGraph,
  newNode, nodeLabel, textFromGraph,
} from "./formula-graph.js";
import { medianStep, sampleAt } from "./resample.js";
import { makeTag, reqName, rt, saveState } from "./state.js";
import { insertTags, setTagFields, tagLabel } from "./tags.js";
import { resolveRange } from "./timerange.js";
import { $, el, fmtTime, fmtVal } from "./util.js";

// The one editor there is. tab and tag say what Apply writes to (tag null =
// a new row); graph is what is on the canvas.
let session = null;
let shell = null;       // the dialog's parts, built on first use

// -- opening -------------------------------------------------------------------

// Opens on an existing formula row, on a blank sheet (tag null), or seeded
// with one plain tag as the first block ("New formula from this tag").
export function openFormulaEditor(tab, tag, seed) {
  if (!shell) shell = buildShell();
  let graph = null;
  let problem = "";
  if (tag && isComputed(tag)) {
    const kept = tag.graphLayout;
    if (kept && kept.text === tag.name && kept.graph) {
      graph = JSON.parse(JSON.stringify(kept.graph));
    } else {
      try { graph = graphFromText(tag.name); } catch (err) { problem = err.message; }
    }
  }
  if (!graph) {
    graph = emptyGraph();
    if (seed) {
      const node = newNode(graph, { type: "tag", ref: reqName(seed) });
      graph.wires.push({ from: node.id, to: "out", port: 0 });
    }
    layoutGraph(graph);
    // A blank sheet: Result over on the right, where the blocks will flow to.
    if (!seed) Object.assign(graph.nodes[0], { x: 560, y: 160 });
  }
  session = { tab, tag: tag && isComputed(tag) ? tag : null, graph, pan: { x: 0, y: 0 },
    selected: null, preview: null, previewId: "out", helpFor: null,
    // The preview's request to the server, replaced by each newer one.
    abort: null, previewSeq: 0 };
  shell.title.textContent = session.tag
    ? `Formula: ${tagLabel(tab, session.tag)}` : "New formula";
  fillRows();
  shell.search.value = "";
  shell.results.innerHTML = "";
  // Open first: the wires are drawn between ports measured on screen, and a
  // closed dialog has nothing on screen to measure.
  shell.dialog.showModal();
  render();
  if (problem) showErrors([`the formula text could not be read: ${problem}`]);
}

// -- the window ----------------------------------------------------------------

function buildShell() {
  const dialog = $("formula-editor");
  dialog.innerHTML = "";
  const title = el("h3", "fe-title");
  const body = el("div", "fe-body");

  const palette = el("aside", "fe-palette");
  const search = el("input", "fe-search");
  search.type = "text";
  search.placeholder = "Search tag or description…";
  search.spellcheck = false;
  search.autocomplete = "off";
  const results = el("div", "fe-list");
  const rows = el("div", "fe-list");
  const blocks = el("div", "fe-blocks");
  palette.append(
    search, results,
    el("h4", null, "On this plot"), rows,
    el("h4", null, "Blocks"), blocks,
  );

  const canvas = el("div", "fe-canvas");
  canvas.tabIndex = -1;
  const world = el("div", "fe-world");
  const wires = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  wires.classList.add("fe-wires");
  const nodes = el("div", "fe-nodes");
  world.append(wires, nodes);
  canvas.appendChild(world);
  body.append(palette, canvas);

  const foot = el("div", "fe-foot");
  const text = el("input", "fe-text");
  text.type = "text";
  text.spellcheck = false;
  text.title = "The formula the blocks make. Type here and press Enter to rebuild the blocks from it.";
  const errors = el("div", "fe-errors");
  const preview = el("div", "fe-preview");
  const buttons = el("div", "dialog-buttons");
  const tidy = el("button", null, "Tidy");
  tidy.title = "Lay the blocks out afresh";
  const cancel = el("button", null, "Cancel");
  const apply = el("button", "primary", "Apply");
  buttons.append(tidy, el("span", "spacer"), cancel, apply);
  foot.append(text, errors, preview, buttons);

  dialog.append(title, body, foot);

  for (const [label, fields] of paletteBlocks()) {
    blocks.appendChild(paletteItem(label, fields, "fe-block"));
  }

  // Background drag pans; a click on nothing clears the selection.
  canvas.addEventListener("pointerdown", (e) => {
    if (e.target !== canvas && e.target !== world && e.target !== nodes &&
        e.target !== wires) return;
    selectItem(null);
    const start = { x: e.clientX - session.pan.x, y: e.clientY - session.pan.y };
    canvas.setPointerCapture(e.pointerId);
    const move = (ev) => {
      session.pan = { x: ev.clientX - start.x, y: ev.clientY - start.y };
      world.style.transform = `translate(${session.pan.x}px, ${session.pan.y}px)`;
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
  });

  dialog.addEventListener("keydown", (e) => {
    // Escape is Cancel. Handled here rather than left to the browser, which
    // may hold a dialog's own Escape back when it was opened from script.
    if (e.key === "Escape") {
      e.preventDefault();
      // An open help box goes first; the next Escape closes the editor.
      if (session.helpFor) { session.helpFor = null; render(); return; }
      dialog.close();
      return;
    }
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName);
    if ((e.key === "Delete" || e.key === "Backspace") && !typing && session.selected) {
      e.preventDefault();
      removeSelected();
    }
  });
  // A click anywhere but in the help box, or on the "?" that opened it,
  // puts the help away.
  dialog.addEventListener("pointerdown", (e) => {
    if (!session || !session.helpFor) return;
    if (e.target.closest(".fe-help") || e.target.closest(".head .help")) return;
    session.helpFor = null;
    const open = shell.nodes.querySelector(".fe-help");
    if (open) open.remove();
    shell.nodes.querySelectorAll(".fe-node.helping").forEach((b) => b.classList.remove("helping"));
  }, true);
  dialog.addEventListener("close", () => {
    // The event is queued, and can arrive after the editor was opened again:
    // it must not tear down the new session's preview.
    if (dialog.open) return;
    if (session && session.preview) { session.preview.destroy(); session.preview = null; }
    if (session && session.abort) session.abort.abort();
  });

  text.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const typed = text.value.trim();
    try {
      session.graph = graphFromText(typed.startsWith("=") ? typed : `=${typed}`);
      // Fresh blocks reuse ids, so a preview left on one would jump to another.
      session.previewId = "out";
      render();
    } catch (err) {
      showErrors([err.message]);
    }
  });

  tidy.addEventListener("click", () => { layoutGraph(session.graph); render(); });
  cancel.addEventListener("click", () => dialog.close());
  apply.addEventListener("click", applyEditor);

  let timer = null, abort = null;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    const q = search.value.trim();
    if (q.length < MIN_QUERY_LEN) { results.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      if (abort) abort.abort();
      abort = new AbortController();
      try {
        const answer = await apiSearchTags(q, abort.signal);
        results.innerHTML = "";
        if (!answer.tags.length) results.appendChild(el("div", "fe-none", "No tags found"));
        for (const hit of answer.tags) {
          const item = paletteItem(hit.name, { type: "tag", ref: hit.name }, "fe-tag");
          if (hit.description) item.title = hit.description;
          results.appendChild(item);
        }
      } catch (err) {
        if (err.name !== "AbortError") results.textContent = err.message;
      }
    }, SEARCH_DEBOUNCE_MS);
  });

  return { dialog, title, canvas, world, wires, nodes, search, results, rows,
    text, errors, preview, apply };
}

// Every block the parser knows, grouped as a toolbox reads.
function paletteBlocks() {
  return [
    ["Number", { type: "num", value: 1 }],
    ["+", { type: "op", op: "+" }],
    ["−", { type: "op", op: "-" }],
    ["×", { type: "op", op: "*" }],
    ["÷", { type: "op", op: "/" }],
    ["^", { type: "op", op: "^" }],
    ["−x", { type: "neg" }],
    [">", { type: "op", op: ">" }],
    ["<", { type: "op", op: "<" }],
    ["≥", { type: "op", op: ">=" }],
    ["≤", { type: "op", op: "<=" }],
  ].concat(FUNCTION_NAMES.map((name) => [name,
    name === "total" ? { type: "fn", name, period: "day" } : { type: "fn", name }]));
}

// The rows on the tab, for quick access: their bare request name is what a
// formula refers to them by. Other formulas go by their short description.
function fillRows() {
  shell.rows.innerHTML = "";
  for (const tag of session.tab.tags) {
    if (session.tag && tag === session.tag) continue;
    const ref = isComputed(tag) ? (tag.description || "").trim() : reqName(tag);
    if (!ref) continue;
    const item = paletteItem(tagLabel(session.tab, tag), { type: "tag", ref }, "fe-tag");
    item.style.borderLeftColor = tag.color || "transparent";
    shell.rows.appendChild(item);
  }
}

// A palette entry: click to drop the block mid-canvas, or drag it to a spot.
function paletteItem(label, fields, cls) {
  const item = el("div", `fe-item ${cls}`, label);
  const help = BLOCK_HELP[helpKey(fields)];
  if (help) item.title = help.short + (help.long ? " - its ? on the canvas says more" : "");
  item.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const ghost = el("div", "fe-ghost", label);
    document.body.appendChild(ghost);
    const place = (ev) => {
      ghost.style.left = `${ev.clientX + 8}px`;
      ghost.style.top = `${ev.clientY + 8}px`;
    };
    place(e);
    let moved = false;
    const move = (ev) => { moved = true; place(ev); };
    const up = (ev) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      ghost.remove();
      const box = shell.canvas.getBoundingClientRect();
      const inside = ev.clientX >= box.left && ev.clientX <= box.right &&
        ev.clientY >= box.top && ev.clientY <= box.bottom;
      if (moved && !inside) return;       // dragged somewhere else: nothing
      const at = moved
        ? { x: ev.clientX - box.left - session.pan.x - 40, y: ev.clientY - box.top - session.pan.y - 16 }
        : spareSpot(box);
      const node = newNode(session.graph, { ...fields, ...at });
      render();
      selectItem({ node: node.id });
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
  return item;
}

// A clicked block lands near the middle of what is on show, stepping aside
// from the last one so a row of clicks does not stack them on one spot.
function spareSpot(box) {
  const count = session.graph.nodes.length;
  return {
    x: box.width / 2 - session.pan.x - 60 + (count % 5) * 14,
    y: box.height / 2 - session.pan.y - 30 + (count % 5) * 14,
  };
}

// -- drawing -------------------------------------------------------------------

function render() {
  const { graph } = session;
  shell.world.style.transform = `translate(${session.pan.x}px, ${session.pan.y}px)`;
  shell.nodes.innerHTML = "";
  for (const node of graph.nodes) shell.nodes.appendChild(buildNode(node));
  placeHelp();
  renderWires();
  // A change on the canvas wins over whatever sits in the text field, even
  // if it still has the focus from the last time it was typed in.
  refreshText(true);
}

function buildNode(node) {
  const selected = session.selected && session.selected.node === node.id;
  const helping = session.helpFor === node.id;
  const box = el("div", `fe-node ${node.type}` + (selected ? " selected" : "")
    + (session.previewId === node.id ? " previewing" : "") + (helping ? " helping" : ""));
  box.dataset.id = node.id;
  box.style.left = `${node.x}px`;
  box.style.top = `${node.y}px`;

  const head = el("div", "head");
  head.appendChild(el("span", "label", node.type === "tag" ? "Tag"
    : node.type === "num" ? "Number" : nodeLabel(node)));
  // A "?" only where a line of tooltip is not enough.
  const help = BLOCK_HELP[helpKey(node)];
  if (help && help.long) {
    const ask = el("button", "help", "?");
    ask.title = "What this block does";
    ask.addEventListener("pointerdown", (e) => e.stopPropagation());
    ask.addEventListener("click", (e) => {
      e.stopPropagation();
      session.helpFor = helping ? null : node.id;
      render();
    });
    head.appendChild(ask);
  }
  const eye = el("button", "eye", "◉");
  eye.title = node.type === "out" ? "Preview the result"
    : session.previewId === node.id ? "Back to previewing the result" : "Preview this block";
  eye.addEventListener("pointerdown", (e) => e.stopPropagation());
  eye.addEventListener("click", (e) => {
    e.stopPropagation();
    session.previewId = session.previewId === node.id ? "out" : node.id;
    render();
  });
  head.appendChild(eye);
  if (node.type !== "out") {
    const close = el("button", "x", "×");
    close.title = "Remove block";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      session.selected = { node: node.id };
      removeSelected();
    });
    head.appendChild(close);
  }
  box.appendChild(head);

  const main = el("div", "main");
  const ins = el("div", "ins");
  const count = inputPorts(session.graph, node);
  for (let port = 0; port < count; port++) {
    const dot = el("span", "port in");
    dot.dataset.port = String(port);
    const wired = session.graph.wires.some((w) => w.to === node.id && w.port === port);
    dot.classList.toggle("wired", wired);
    dot.title = isVariadic(node) && !wired ? "Wire another input here" : "Input";
    dot.addEventListener("pointerdown", (e) => pickUpWire(e, node, port));
    ins.appendChild(dot);
  }
  main.appendChild(ins);

  const content = el("div", "content");
  if (node.type === "tag" || node.type === "num") {
    const field = el("input");
    field.type = "text";
    field.spellcheck = false;
    field.value = node.type === "tag" ? (node.ref || "") : String(node.value);
    field.placeholder = node.type === "tag" ? "TAG or TAG;MAP" : "0";
    field.addEventListener("pointerdown", (e) => e.stopPropagation());
    field.addEventListener("input", () => {
      if (node.type === "tag") node.ref = field.value;
      else node.value = field.value;
      refreshText();
    });
    content.appendChild(field);
  } else if (node.type === "out") {
    content.appendChild(el("span", "big", "="));
  } else {
    content.appendChild(el("span", "big", nodeLabel(node)));
    // A total sums over calendar periods: which one is the block's own choice.
    if (node.type === "fn" && node.name === "total") {
      const period = el("select", "period");
      for (const name of PERIODS) {
        const opt = el("option", null, `per ${name}`);
        opt.value = name;
        period.appendChild(opt);
      }
      period.value = node.period || "day";
      period.title = "Sum per calendar period, of the input read as a rate per hour";
      period.addEventListener("pointerdown", (e) => e.stopPropagation());
      period.addEventListener("change", () => { node.period = period.value; refreshText(); });
      content.appendChild(period);
      // How finely what goes in is read. Matters most for a comparison: at
      // 1 h, an hour is counted whole or not at all.
      const resolution = el("select", "period");
      for (const name of RESOLUTIONS) {
        const opt = el("option", null, name === "auto" ? "auto resolution" : `read per ${name}`);
        opt.value = name;
        resolution.appendChild(opt);
      }
      resolution.value = node.resolution || "auto";
      resolution.title = "How finely the input is read, as averages over this interval";
      resolution.addEventListener("pointerdown", (e) => e.stopPropagation());
      resolution.addEventListener("change", () => {
        if (resolution.value === "auto") delete node.resolution;
        else node.resolution = resolution.value;
        refreshText();
      });
      content.appendChild(resolution);
    }
  }
  content.appendChild(el("span", "val"));
  main.appendChild(content);

  if (node.type !== "out") {
    const out = el("span", "port out");
    out.title = "Drag to an input";
    out.addEventListener("pointerdown", (e) => beginWire(e, node.id));
    main.appendChild(out);
  }
  box.appendChild(main);

  if (helping && help && help.long) {
    const card = el("div", "fe-help");
    card.appendChild(el("div", "title", help.short));
    for (const text of help.long) card.appendChild(el("p", null, text));
    card.addEventListener("pointerdown", (e) => e.stopPropagation());
    box.appendChild(card);
  }

  box.addEventListener("pointerdown", (e) => beginMove(e, node, box));
  return box;
}

// A help box hangs under its block, or over it when the canvas has more room
// there; whatever still does not fit scrolls inside the box.
function placeHelp() {
  const card = shell.nodes.querySelector(".fe-help");
  if (!card) return;
  const area = shell.canvas.getBoundingClientRect();
  const block = card.parentElement.getBoundingClientRect();
  const below = area.bottom - block.bottom - 12;
  const above = block.top - area.top - 12;
  const up = below < card.offsetHeight && above > below;
  card.classList.toggle("above", up);
  card.style.maxHeight = `${Math.max(120, up ? above : below)}px`;
}

// Where a port sits in world coordinates - the space the SVG draws in.
function portPoint(nodeId, kind, port) {
  const box = shell.nodes.querySelector(`.fe-node[data-id="${nodeId}"]`);
  if (!box) return null;
  const dot = kind === "out"
    ? box.querySelector(".port.out")
    : box.querySelector(`.port.in[data-port="${port}"]`);
  if (!dot) return null;
  const world = shell.world.getBoundingClientRect();
  const r = dot.getBoundingClientRect();
  return { x: r.left + r.width / 2 - world.left, y: r.top + r.height / 2 - world.top };
}

function curve(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function renderWires(extra) {
  const svg = shell.wires;
  svg.innerHTML = "";
  session.graph.wires.forEach((wire, i) => {
    const a = portPoint(wire.from, "out"), b = portPoint(wire.to, "in", wire.port);
    if (!a || !b) return;
    const d = curve(a, b);
    // A wide invisible twin makes a thin wire possible to click.
    const hit = document.createElementNS(SVG_NS, "path");
    hit.setAttribute("d", d);
    hit.setAttribute("class", "hit");
    hit.addEventListener("pointerdown", (e) => { e.stopPropagation(); selectItem({ wire: i }); });
    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("d", d);
    const on = session.selected && session.selected.wire === i;
    line.setAttribute("class", on ? "wire selected" : "wire");
    svg.append(line, hit);
  });
  if (extra) {
    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("d", curve(extra.a, extra.b));
    line.setAttribute("class", "wire pending");
    svg.appendChild(line);
  }
}

function selectItem(what) {
  // Choosing a block or a wire is leaving the text fields: the canvas takes
  // the focus, so Delete goes to the selection rather than to the field
  // typed in last - and stays inside the dialog, where it is listened for.
  shell.canvas.focus({ preventScroll: true });
  session.selected = what;
  for (const box of shell.nodes.querySelectorAll(".fe-node")) {
    box.classList.toggle("selected", !!what && what.node === box.dataset.id);
  }
  renderWires();
}

// -- editing -------------------------------------------------------------------

function beginMove(e, node, box) {
  if (e.target.closest(".port") || e.target.closest("input") || e.target.closest("button")) return;
  e.preventDefault();
  selectItem({ node: node.id });
  box.setPointerCapture(e.pointerId);
  const start = { x: e.clientX - node.x, y: e.clientY - node.y };
  const move = (ev) => {
    node.x = ev.clientX - start.x;
    node.y = ev.clientY - start.y;
    box.style.left = `${node.x}px`;
    box.style.top = `${node.y}px`;
    renderWires();
  };
  const up = () => {
    box.removeEventListener("pointermove", move);
    box.removeEventListener("pointerup", up);
  };
  box.addEventListener("pointermove", move);
  box.addEventListener("pointerup", up);
}

// Dragging from an output draws a wire that follows the pointer; letting go
// over an input connects it, replacing whatever that input had.
function beginWire(e, fromId) {
  e.preventDefault();
  e.stopPropagation();
  const a = portPoint(fromId, "out");
  const world = () => shell.world.getBoundingClientRect();
  const move = (ev) => {
    const w = world();
    renderWires({ a, b: { x: ev.clientX - w.left, y: ev.clientY - w.top } });
  };
  const up = (ev) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const dot = target && target.closest(".port.in");
    if (dot) {
      const toId = dot.closest(".fe-node").dataset.id;
      const port = Number(dot.dataset.port);
      if (toId !== fromId) {
        session.graph.wires = session.graph.wires.filter(
          (w) => !(w.to === toId && w.port === port));
        session.graph.wires.push({ from: fromId, to: toId, port });
      }
    }
    render();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

// Grabbing a wired input picks its wire up again, to move it or drop it; an
// empty one starts a wire the other way, to be dropped on an output.
function pickUpWire(e, node, port) {
  const wire = session.graph.wires.find((w) => w.to === node.id && w.port === port);
  if (!wire) { beginWireFromInput(e, node, port); return; }
  session.graph.wires = session.graph.wires.filter((w) => w !== wire);
  compactPorts(node);
  render();
  beginWire(e, wire.from);
}

function beginWireFromInput(e, node, port) {
  e.preventDefault();
  e.stopPropagation();
  const b = portPoint(node.id, "in", port);
  const world = () => shell.world.getBoundingClientRect();
  const move = (ev) => {
    const w = world();
    renderWires({ a: { x: ev.clientX - w.left, y: ev.clientY - w.top }, b });
  };
  const up = (ev) => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    const dot = target && target.closest(".port.out");
    const fromId = dot && dot.closest(".fe-node").dataset.id;
    if (fromId && fromId !== node.id) {
      session.graph.wires = session.graph.wires.filter(
        (w) => !(w.to === node.id && w.port === port));
      session.graph.wires.push({ from: fromId, to: node.id, port });
    }
    render();
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

// A variadic block keeps its inputs packed, so taking one out of the middle
// does not leave a hole the formula would read as an empty argument.
function compactPorts(node) {
  if (!isVariadic(node)) return;
  session.graph.wires
    .filter((w) => w.to === node.id)
    .sort((a, b) => a.port - b.port)
    .forEach((w, i) => { w.port = i; });
}

function removeSelected() {
  const { graph } = session;
  const sel = session.selected;
  if (!sel) return;
  if (sel.wire != null) {
    const wire = graph.wires[sel.wire];
    graph.wires.splice(sel.wire, 1);
    const target = wire && graph.nodes.find((n) => n.id === wire.to);
    if (target) compactPorts(target);
  } else if (sel.node && sel.node !== "out") {
    const touched = graph.wires.filter((w) => w.from === sel.node).map((w) => w.to);
    graph.nodes = graph.nodes.filter((n) => n.id !== sel.node);
    graph.wires = graph.wires.filter((w) => w.from !== sel.node && w.to !== sel.node);
    for (const id of touched) {
      const target = graph.nodes.find((n) => n.id === id);
      if (target) compactPorts(target);
    }
  }
  session.selected = null;
  if (!graph.nodes.some((n) => n.id === session.previewId)) session.previewId = "out";
  render();
}

// -- text, errors and the preview ---------------------------------------------

function showErrors(list) {
  shell.errors.innerHTML = "";
  for (const message of list) shell.errors.appendChild(el("div", null, message));
  shell.errors.classList.toggle("hidden", !list.length);
}

let previewTimer = null;

function refreshText(force) {
  const { text, errors } = textFromGraph(session.graph);
  if (force || document.activeElement !== shell.text) shell.text.value = text;
  showErrors(errors);
  shell.apply.disabled = !!errors.length;
  // The preview is a small chart rebuilt from scratch, so typing in a block
  // waits for a pause before it is redrawn.
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 150);
}

// The label over the preview, e.g. "Preview: Result" or "Preview: ÷".
function previewName() {
  const node = session.graph.nodes.find((n) => n.id === session.previewId);
  if (!node || node.type === "out") return "Result";
  if (node.type === "tag") return node.ref || "Tag";
  if (node.type === "num") return String(node.value);
  return nodeLabel(node);
}

// The window the preview covers: what the tab has loaded, so the server finds
// its tags cached, or the tab's range when nothing is loaded yet.
function previewWindow(tab) {
  const r = rt(tab);
  if (r.raw && r.start != null) return { start: r.start, end: r.end, points: r.points || 1500 };
  const { start, end } = resolveRange(tab);
  const width = $("chart-wrap").clientWidth || 1200;
  return { start, end, points: Math.max(300, Math.min(4000, Math.round(width * 1.2))) };
}

// Asks the server for the previewed block and for every block that is wired
// up, in one request: the first draws the trend, the rest give each block its
// value under the cursor. The old chart stays until the answer is in.
async function renderPreview() {
  const current = session;
  const seq = ++current.previewSeq;
  if (current.abort) current.abort.abort();
  current.abort = new AbortController();

  const name = previewName();
  const { text, errors } = textFromGraph(current.graph, current.previewId);
  const blocks = new Map();   // node id -> its text
  for (const node of current.graph.nodes) {
    if (node.type === "num") continue;
    const own = textFromGraph(current.graph, node.id);
    if (!own.errors.length) blocks.set(node.id, own.text);
  }
  let results = new Map();
  let failure = null;
  if (!errors.length) {
    const { start, end, points } = previewWindow(current.tab);
    const texts = [...new Set([text, ...blocks.values()])];
    try {
      results = await previewFormulas(current.tab, current.tag, texts, start, end, points,
        current.abort.signal);
    } catch (err) {
      if (err.name === "AbortError") return;
      failure = err.message;
    }
  }
  if (session !== current || seq !== current.previewSeq || !shell.dialog.open) return;
  drawPreview(name, errors.length ? null : text, results, blocks, failure);
}

function drawPreview(name, text, results, blocks, failure) {
  const box = shell.preview;
  if (session.preview) { session.preview.destroy(); session.preview = null; }
  box.innerHTML = "";
  const head = el("div", "fe-preview-head", `Preview: ${name}`);
  box.appendChild(head);
  const note = (message) => box.appendChild(el("div", "fe-none", message));
  if (!text) { note(`No preview until ${name} is complete.`); return; }
  if (failure) { note(failure); return; }
  const result = results.get(text);
  if (!result || result.error) { note(result ? result.error : "no data"); return; }

  const readout = el("span", "fe-readout");
  head.appendChild(readout);
  // Each block read at the cursor the way the server reads a series: along
  // its own samples, held when stepped, nothing across a hole.
  const readers = new Map();
  for (const [id, own] of blocks) {
    const series = results.get(own);
    if (!series || series.error || !series.t.length) continue;
    const gap = 3 * medianStep(series.t);
    readers.set(id, (t) => sampleAt(series.t, series.v, t, !!series.step, gap));
  }
  const width = Math.max(200, box.clientWidth - 8);
  session.preview = new uPlot({
    width,
    height: 110,
    legend: { show: false },
    scales: { x: { time: true } },
    axes: [
      // The main chart's 24-hour labels, not uPlot's own am/pm ones.
      { stroke: "#8b93a3", grid: { stroke: "#232834" }, ticks: { stroke: "#2e3442" },
        size: 34, values: xAxisValues },
      // A short chart: closer ticks than uPlot's default, or it shows just one.
      { stroke: "#8b93a3", grid: { stroke: "#232834" }, ticks: { stroke: "#2e3442" }, size: 48,
        space: 22 },
    ],
    series: [{}, { stroke: "#4fc3f7", width: 1.4, spanGaps: true, points: { show: false },
      paths: result.step ? uPlot.paths.stepped({ align: 1 }) : undefined }],
    cursor: { drag: { x: false, y: false }, points: { size: 6 } },
    hooks: {
      // Under the cursor, every block shows what it amounts to at that moment:
      // where a long formula goes wrong is where the numbers stop making sense.
      setCursor: [(u) => {
        const idx = u.cursor.idx;
        const t = idx == null ? null : u.data[0][idx];
        readout.textContent = t == null ? "" : `${fmtTime(t, true)}   ${fmtVal(u.data[1][idx])}`;
        for (const box of shell.nodes.querySelectorAll(".fe-node")) {
          const node = session.graph.nodes.find((n) => n.id === box.dataset.id);
          let v;
          if (t == null || !node) v = undefined;
          else if (node.type === "num") v = Number(node.value);
          else if (readers.has(node.id)) v = readers.get(node.id)(t);
          box.querySelector(".val").textContent = v === undefined ? "" : fmtVal(v);
        }
      }],
    },
  }, [result.t, result.v], box);
}

// -- applying ------------------------------------------------------------------

function applyEditor() {
  const { text, errors } = textFromGraph(session.graph);
  if (errors.length) return;
  const { tab, tag } = session;
  // The blocks are kept only while the text is still theirs: a later edit in
  // the Tag field lays them out afresh from the new text.
  const layout = { text, graph: JSON.parse(JSON.stringify(session.graph)) };
  if (tag) {
    tag.graphLayout = layout;
    if (tag.name === text) saveState();
    else setTagFields(tab, tag, { name: text });
  } else {
    insertTags(tab, [makeTag({ name: text, graphLayout: layout })]);
  }
  shell.dialog.close();
}
