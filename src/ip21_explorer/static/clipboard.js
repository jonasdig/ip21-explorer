/* Copying and pasting tags as JSON on the system clipboard. */

import { activeTab, makeTag } from "./state.js";
import { insertTags } from "./tags.js";
import { showError } from "./util.js";

// Fallback for when the system clipboard is unavailable or unreadable.
let tagClipboard = null;

const CLIP_KEY = "ip21ExplorerTags";

// Tags travel as plain JSON text, so they can be pasted between tabs, windows
// and even machines. uid and color are dropped: copies always get fresh ones.
function tagsToClipText(tags) {
  const strip = ({ uid, color, _mapsChecked, ...rest }) => rest;
  return JSON.stringify({ [CLIP_KEY]: tags.map(strip) }, null, 2);
}

export function tagsFromClipText(text) {
  try {
    const parsed = JSON.parse(text);
    const tags = parsed && parsed[CLIP_KEY];
    return Array.isArray(tags) && tags.every((t) => t && t.name) ? tags : null;
  } catch (e) {
    return null;
  }
}

export function copyTags(tags) {
  if (!tags.length) return;
  const text = tagsToClipText(tags);
  tagClipboard = text;
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

// Pasted tags keep their settings but get fresh identity, and move onto a free
// map when they would otherwise land on one that is already plotted.
export async function pasteTags(tags) {
  if (!tags || !tags.length) return;
  const tab = activeTab();
  const built = [];
  for (const src of tags) {
    const tag = makeTag(src);
    tag.map = src.map ?? null;
    tag.min = src.min ?? null;
    tag.max = src.max ?? null;
    tag.visible = src.visible !== false;
    tag.step = src.step === true;
    tag.sample = src.sample || "INT";
    tag.interval = src.interval || "auto";
    built.push(tag);
  }
  await insertTags(tab, built);
}

export async function pasteFromClipboard() {
  let text = null;
  if (navigator.clipboard && navigator.clipboard.readText) {
    text = await navigator.clipboard.readText().catch(() => null);
  }
  const tags = tagsFromClipText(text || "") || tagsFromClipText(tagClipboard || "");
  if (!tags) { showError("No copied tags on the clipboard"); return; }
  pasteTags(tags);
}
