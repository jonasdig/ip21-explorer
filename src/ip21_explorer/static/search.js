/* Tag search with a result list that stays open for picking many. */

import { apiSearchTags } from "./api.js";
import { insertTags, removeTags } from "./app.js";
import { MIN_QUERY_LEN, SEARCH_DEBOUNCE_MS } from "./constants.js";
import { activeTab, makeTag, normalizeTagName } from "./state.js";
import { $, el } from "./util.js";

let searchTimer = null;
let searchSelection = -1;
let searchItems = [];
let searchAbort = null;

function renderSearchHint(text) {
  const results = $("search-results");
  if (document.activeElement !== $("tag-search")) return;
  results.innerHTML = "";
  results.appendChild(el("div", "none", text));
  searchItems = [];
  searchSelection = -1;
  results.classList.remove("hidden");
}

export function initSearch() {
  const input = $("tag-search");
  const results = $("search-results");

  // The answer to the last query, so refocusing the field (or retyping the
  // same text) reopens the dropdown without asking the server again.
  let lastQuery = null;
  let lastAnswer = null;

  const doSearch = async () => {
    const q = input.value.trim();
    // A short query matches most of the historian, and every search costs the
    // IP21 server real work, so wait until it is specific enough.
    if (q.length < MIN_QUERY_LEN) {
      renderSearchHint(`Type at least ${MIN_QUERY_LEN} characters to search`);
      return;
    }
    if (q === lastQuery && lastAnswer) {
      renderSearchResults(lastAnswer);
      return;
    }
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    try {
      const answer = await apiSearchTags(q, searchAbort.signal);
      lastQuery = q;
      lastAnswer = answer;
      renderSearchResults(answer);
    } catch (e) { /* aborted or transient search error */ }
  };

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener("focus", doSearch);
  input.addEventListener("keydown", (e) => {
    if (results.classList.contains("hidden")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      searchSelection = Math.max(0, Math.min(searchItems.length - 1, searchSelection + dir));
      renderSearchSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        addAllSearchResults();
        return;
      }
      const at = searchSelection >= 0 ? searchSelection : 0;
      if (!searchItems[at]) return;
      // Enter adds and walks on, so holding it down the list seeds a whole
      // plot from one search - which is the reason the list stays open at all.
      // It never removes: walking past a tag already plotted must not quietly
      // take it off again. That is what clicking the tick is for.
      addSearchResult(searchItems[at]);
      searchSelection = Math.min(searchItems.length - 1, at + 1);
      renderSearchSelection();
    } else if (e.key === "Escape") {
      clearTimeout(searchTimer);
      results.classList.add("hidden");
      input.blur();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest("#search-box")) results.classList.add("hidden");
  });
}

function renderSearchResults(answer) {
  const tags = answer.tags || [];
  const results = $("search-results");
  // A late response must not reopen the dropdown after the field lost focus.
  if (document.activeElement !== $("tag-search")) return;
  results.innerHTML = "";
  searchItems = tags;
  searchSelection = tags.length ? 0 : -1;
  if (!tags.length) {
    results.appendChild(el("div", "none", "No matching tags"));
  }
  tags.forEach((tag) => {
    const item = el("div", "item");
    item.dataset.tag = normalizeTagName(tag.name);
    item.appendChild(el("span", "name", tag.name));
    item.appendChild(el("span", "mark"));
    item.appendChild(el("span", "desc", tag.description));
    item.appendChild(el("span", "unit", tag.unit));
    // Keeping focus in the field is what keeps the list open: a late answer
    // refuses to render once the field has lost it.
    item.addEventListener("pointerdown", (e) => e.preventDefault());
    item.addEventListener("click", () => toggleSearchResult(tag));
    results.appendChild(item);
  });
  // The historian cannot always answer in full; say so rather than pretending
  // the list is complete.
  if (answer.note) results.appendChild(el("div", "none", answer.note));
  if (tags.length > 1) {
    const foot = el("div", "foot");
    const all = el("button");
    all.addEventListener("pointerdown", (e) => e.preventDefault());
    all.addEventListener("click", () => addAllSearchResults());
    foot.appendChild(all);
    results.appendChild(foot);
  }
  refreshSearchMarks();
  renderSearchSelection();
  results.classList.remove("hidden");
}

// Only the markers change as tags are picked. Rebuilding the list instead
// would throw away both the keyboard selection and the scroll position, in the
// middle of picking - which is the whole point of keeping it open.
function refreshSearchMarks() {
  const results = $("search-results");
  const plotted = new Set(activeTab().tags.map((t) => normalizeTagName(t.name)));
  for (const item of results.querySelectorAll(".item")) {
    const on = plotted.has(item.dataset.tag);
    item.classList.toggle("on", on);
    item.querySelector(".mark").textContent = on ? "✓" : "";
    item.title = on ? "Click to remove from the plot" : "Click to add to the plot";
  }
  const button = results.querySelector(".foot button");
  if (button) {
    const left = searchItems.filter((t) => !plotted.has(normalizeTagName(t.name))).length;
    button.textContent = left ? `Add all ${left}` : "All added";
    button.disabled = !left;
  }
}

// Everything listed that is not plotted yet. No name repeats within one answer
// and the ones already plotted are filtered out, so no tag here can collide
// with an existing trace - assignFreeMap never runs from this path.
function addAllSearchResults() {
  const tab = activeTab();
  const plotted = new Set(tab.tags.map((t) => normalizeTagName(t.name)));
  const wanted = searchItems.filter((t) => !plotted.has(normalizeTagName(t.name)));
  if (!wanted.length) return;
  insertTags(tab, wanted.map(makeTag)).then(refreshSearchMarks);
  $("tag-search").focus();
}

function renderSearchSelection() {
  const nodes = $("search-results").querySelectorAll(".item");
  nodes.forEach((n, i) => n.classList.toggle("selected", i === searchSelection));
  // Enter walks the selection down on its own, so it has to stay in view.
  if (nodes[searchSelection]) nodes[searchSelection].scrollIntoView({ block: "nearest" });
}

// A dropdown row is a bare tag name with no map, so the tick can only mean
// "this name is plotted somewhere" - and clicking it takes every copy off
// again, whichever maps they sit on. That is what makes the tick a real toggle.
async function toggleSearchResult(hit) {
  const tab = activeTab();
  const plotted = plottedCopies(tab, hit);
  if (plotted.length) removeTags(tab, plotted.map((t) => t.uid));
  else await insertTags(tab, [makeTag(hit)]);
  refreshSearchMarks();
  $("tag-search").focus();
}

// Adds, or does nothing if the tag is already on the plot.
async function addSearchResult(hit) {
  const tab = activeTab();
  if (!plottedCopies(tab, hit).length) await insertTags(tab, [makeTag(hit)]);
  refreshSearchMarks();
  $("tag-search").focus();
}

function plottedCopies(tab, hit) {
  const name = normalizeTagName(hit.name);
  return tab.tags.filter((t) => normalizeTagName(t.name) === name);
}
