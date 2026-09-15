/* The toolbar's buttons and the global keyboard shortcuts. */

import {
  beginTableResize, chart, currentXRange, ensureDescriptions, isEditingContext,
  onTagTableKey, renderChart, renderTags, toggleTagTable,
} from "./app.js";
import { copyTags, pasteTags, tagsFromClipText } from "./clipboard.js";
import { LABEL_MODES, LIVE_INTERVAL_MS, PRESETS } from "./constants.js";
import { hideContextMenu } from "./menu.js";
import { addScooterAt, positionScooters } from "./scooters.js";
import { activeTab, saveState, state } from "./state.js";
import { addTab, setLinked } from "./tabs.js";
import { initTimeFields } from "./timefields.js";
import {
  jumpToNow, liveDisabledReason, liveTick, popHistory, resolveRange,
  setAbsoluteRange, setPreset, toggleLive,
} from "./timerange.js";
import { $, el, fmtTime, parseTimeInput, showError } from "./util.js";

export function renderToolbar() {
  const tab = activeTab();

  // Preset buttons
  const presets = $("presets");
  presets.innerHTML = "";
  for (const preset of PRESETS) {
    const btn = el("button", tab.range.preset === preset.label ? "active" : "", preset.label);
    btn.addEventListener("click", () => setPreset(preset.label));
    presets.appendChild(btn);
  }

  // Custom range inputs reflect the resolved range
  const { start, end } = resolveRange(tab);
  // Not while typing: rewriting the field under the caret loses the edit.
  for (const [id, t] of [["range-start", start], ["range-end", end]]) {
    if (document.activeElement !== $(id)) $(id).value = fmtTime(t, true);
  }

  const liveBlocked = liveDisabledReason(tab);
  $("live-btn").classList.toggle("active", !!tab.live);
  $("live-btn").disabled = !tab.live && !!liveBlocked;
  $("live-btn").title = liveBlocked || "Follow now, refreshing every 10 s";

  const axisModeLabels = { stacked: "Axes: stacked", single: "Axes: one", all: "Axes: all" };
  $("axis-mode").textContent = axisModeLabels[tab.axisMode] || axisModeLabels.stacked;
  $("label-mode").textContent = (LABEL_MODES[state.labelMode] || LABEL_MODES.tag).label;
  $("nav-toggle").classList.toggle("active", !!state.navigator);
  $("table-toggle").classList.toggle("active", !!tab.tagTable);
  $("link-ranges-cb").checked = !!tab.linked;
}

export function initToolbar() {
  initTimeFields();
  $("apply-range").addEventListener("click", () => {
    const start = parseTimeInput($("range-start").value);
    const end = parseTimeInput($("range-end").value);
    if (start == null || end == null || end <= start) {
      showError("Invalid custom time range");
      return;
    }
    setAbsoluteRange(activeTab(), start, end, false);
  });

  $("now-btn").addEventListener("click", jumpToNow);
  $("live-btn").addEventListener("click", toggleLive);
  setInterval(liveTick, LIVE_INTERVAL_MS);

  $("label-mode").addEventListener("click", () => {
    state.labelMode = (LABEL_MODES[state.labelMode] || LABEL_MODES.tag).next;
    ensureDescriptions(activeTab()); // nothing was fetched while in tag mode
    renderToolbar();
    renderTags();
    positionScooters();
    saveState();
  });

  $("axis-mode").addEventListener("click", () => {
    const tab = activeTab();
    const cycle = { stacked: "single", single: "all", all: "stacked" };
    tab.axisMode = cycle[tab.axisMode] || "stacked";
    renderToolbar();
    renderChart();
    saveState();
  });

  $("add-scooter").addEventListener("click", () => {
    if (!chart) return;
    const cur = currentXRange();
    addScooterAt((cur.start + cur.end) / 2);
  });

  $("table-toggle").addEventListener("click", toggleTagTable);
  $("tag-table").addEventListener("keydown", onTagTableKey);
  $("tag-table").querySelector(".resize")
    .addEventListener("pointerdown", beginTableResize);

  $("add-tab").addEventListener("click", () => addTab());
  $("link-ranges-cb").addEventListener("change", (e) => setLinked(e.target.checked));

  // A paste event carries the clipboard text without a permission prompt,
  // unlike navigator.clipboard.readText().
  document.addEventListener("paste", (e) => {
    if (isEditingContext(document.activeElement)) return;
    const tags = tagsFromClipText(e.clipboardData.getData("text") || "");
    if (tags) { e.preventDefault(); pasteTags(tags); }
  });

  document.addEventListener("keydown", (e) => {
    const typing = isEditingContext(document.activeElement);
    if ((e.ctrlKey || e.metaKey) && e.key === "c" && !typing &&
        !window.getSelection().toString()) {
      copyTags(activeTab().tags);
      return;
    }
    if (e.key !== "Escape") return;
    if (typing) return;
    if ($("open-dialog").open || $("save-dialog").open) return; // dialogs close themselves
    if (!$("context-menu").classList.contains("hidden")) { hideContextMenu(); return; }
    popHistory();
  });
}
