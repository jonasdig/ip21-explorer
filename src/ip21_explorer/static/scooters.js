/* Scooters: draggable value cursors and their readout boxes. */

import { appendValueRows, chart, currentXRange } from "./app.js";
import { activeTab, rt, saveState } from "./state.js";
import { el, fmtTime } from "./util.js";

let scooterEls = [];        // [{line, box}] for the active tab

export function addScooterAt(t) {
  const tab = activeTab();
  tab.scooters.push({ t });
  mountScooters();
  saveState();
}

// Scooter elements live in the chart's overlay and go when the chart is
// destroyed, so this only drops the references to them.
export function forgetScooterEls() {
  scooterEls = [];
}

export function mountScooters() {
  if (!chart) return;
  for (const s of scooterEls) { s.line.remove(); s.box.remove(); }
  scooterEls = [];
  const tab = activeTab();
  tab.scooters.forEach((scooter, i) => {
    const line = el("div", "scooter-line");
    const box = el("div", "scooter-box");
    chart.over.appendChild(line);
    chart.over.appendChild(box);
    scooterEls.push({ line, box });
    line.addEventListener("pointerdown", (e) => beginScooterDrag(e, scooter, i));
    box.addEventListener("pointerdown", (e) => beginBoxDrag(e, scooter, i));
    // Keep uPlot's drag-select from starting when grabbing a scooter.
    line.addEventListener("mousedown", (e) => e.stopPropagation());
    box.addEventListener("mousedown", (e) => e.stopPropagation());
  });
  positionScooters();
}

function beginScooterDrag(e, scooter, index) {
  if (e.target.closest(".close")) return;
  e.preventDefault();
  e.stopPropagation();
  const els = scooterEls[index];
  els.line.classList.add("dragging");
  els.line.setPointerCapture(e.pointerId);
  const overRect = chart.over.getBoundingClientRect();
  const cur = currentXRange();

  const onMove = (ev) => {
    let t = chart.posToVal(ev.clientX - overRect.left, "x");
    t = Math.max(cur.start, Math.min(cur.end, t));
    scooter.t = t;
    positionScooter(index);
  };
  const onUp = (ev) => {
    els.line.classList.remove("dragging");
    els.line.releasePointerCapture(ev.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    saveState();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

// Dragging the readout box moves it vertically, so it can be pulled out of
// the way of the trends. The offset is persisted per scooter.
function beginBoxDrag(e, scooter, index) {
  if (e.target.closest(".close")) return;
  e.preventDefault();
  e.stopPropagation();
  const els = scooterEls[index];
  els.box.classList.add("dragging");
  els.box.setPointerCapture(e.pointerId);
  const startY = e.clientY;
  const startDy = scooter.dy || 0;

  const onMove = (ev) => {
    scooter.dy = startDy + (ev.clientY - startY);
    positionScooter(index);
  };
  const onUp = (ev) => {
    els.box.classList.remove("dragging");
    els.box.releasePointerCapture(ev.pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    saveState();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

export function positionScooters() {
  const tab = activeTab();
  if (!chart || !tab) return;
  tab.scooters.forEach((_, i) => positionScooter(i));
}

function positionScooter(index) {
  const tab = activeTab();
  const scooter = tab.scooters[index];
  const els = scooterEls[index];
  if (!scooter || !els || !chart) return;
  const r = rt(tab);
  const plotWidth = chart.over.clientWidth;
  const x = chart.valToPos(scooter.t, "x");

  if (x < 0 || x > plotWidth) {
    els.line.style.display = "none";
    els.box.style.display = "none";
    return;
  }
  els.line.style.display = "";
  els.box.style.display = "";
  els.line.style.left = `${x}px`;

  // Readout content
  els.box.innerHTML = "";
  const head = el("div", "head");
  head.appendChild(el("span", "time", fmtTime(scooter.t, true)));
  const close = el("button", "close", "×");
  close.title = "Remove scooter";
  close.addEventListener("pointerdown", (e) => e.stopPropagation());
  close.addEventListener("click", (e) => {
    e.stopPropagation();
    tab.scooters.splice(index, 1);
    mountScooters();
    saveState();
  });
  head.appendChild(close);
  els.box.appendChild(head);
  appendValueRows(els.box, tab, r, scooter.t);

  // Place the box beside the line, flipping side near the right edge.
  const boxWidth = els.box.offsetWidth || 180;
  const left = x + 10 + boxWidth > plotWidth ? x - boxWidth - 10 : x + 10;
  els.box.style.left = `${Math.max(0, left)}px`;
  const maxTop = Math.max(0, chart.over.clientHeight - (els.box.offsetHeight || 60));
  const top = 8 + index * 26 + (scooter.dy || 0);
  els.box.style.top = `${Math.min(maxTop, Math.max(0, top))}px`;
}
