/* Thin wrappers over the server's JSON API, including favourite maps. */

import { showError } from "./util.js";

// Returns the whole body: besides the hits it may carry a note explaining an
// incomplete answer, e.g. a description scan that ran out of budget.
export async function apiSearchTags(q, signal) {
  const resp = await fetch(
    `/api/tags?${new URLSearchParams({ q, limit: "40" })}`, { signal }
  );
  if (!resp.ok) throw new Error(`tag search failed (${resp.status})`);
  return await resp.json();
}

// Every function a formula may call, by group: the palette, the help behind
// each block, and the rules the browser's own parser checks against.
export async function apiFunctions() {
  const resp = await fetch("/api/functions");
  if (!resp.ok) throw new Error(`function list failed (${resp.status})`);
  return await resp.json();
}

// Formula rows, computed on the server: {start, end, points, items} ->
// {series: {id: {t, v, step}}, errors: {id: {text, hard}}}.
export async function apiCompute(body, signal) {
  const resp = await fetch("/api/compute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) {
    const detail = (await resp.json().catch(() => ({}))).detail;
    throw new Error(typeof detail === "string" ? detail : `compute failed (${resp.status})`);
  }
  return await resp.json();
}

// Favourite record maps, shared across tags and stored server-side in the env
// file. Real tags have 30+ maps but only a few are ever used.
export let favoriteMaps = [];
let favoritesPromise = null;

export function ensureFavorites() {
  if (!favoritesPromise) {
    favoritesPromise = fetch("/api/favorites")
      .then((r) => (r.ok ? r.json() : { favorites: [] }))
      .then((data) => { favoriteMaps = data.favorites || []; })
      .catch(() => {});
  }
  return favoritesPromise;
}

export async function saveFavorites(names) {
  const resp = await fetch("/api/favorites", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorites: names }),
  });
  if (!resp.ok) {
    const detail = (await resp.json().catch(() => ({}))).detail;
    showError(detail || "could not save favourite maps");
    return false;
  }
  favoriteMaps = (await resp.json()).favorites || [];
  return true;
}

// Favourites first (in favourite order), then the rest as the server sent
// them. Never used to rewrite tag.maps: maps[0] is the default map there, and
// reordering it would silently change which map counts as the default.
export function orderedMaps(maps) {
  if (!favoriteMaps.length) return maps;
  const favored = [];
  for (const name of favoriteMaps) {
    const found = maps.find((m) => m.name === name);
    if (found) favored.push(found);
  }
  if (!favored.length) return maps;
  return [...favored, ...maps.filter((m) => !favored.includes(m))];
}

export async function apiGetUnit(name) {
  const resp = await fetch(`/api/unit?${new URLSearchParams({ tag: name })}`);
  if (!resp.ok) throw new Error(`unit lookup failed (${resp.status})`);
  return (await resp.json()).unit;
}

export async function apiGetDescription(name) {
  const resp = await fetch(`/api/description?${new URLSearchParams({ tag: name })}`);
  if (!resp.ok) throw new Error(`description lookup failed (${resp.status})`);
  return (await resp.json()).description;
}

export async function apiGetMaps(tagName) {
  const resp = await fetch(`/api/maps?${new URLSearchParams({ tag: tagName })}`);
  if (!resp.ok) throw new Error(`map lookup failed (${resp.status})`);
  return (await resp.json()).maps;
}

export async function apiListPlots() {
  const resp = await fetch("/api/plots");
  return resp.ok ? (await resp.json()).plots : [];
}

export async function apiGetPlot(name) {
  const resp = await fetch(`/api/plots/${encodeURIComponent(name)}`);
  return resp.ok ? resp.json() : null;
}

export async function apiSavePlot(name, config) {
  const resp = await fetch(`/api/plots/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (resp.ok) return true;
  const detail = (await resp.json().catch(() => ({}))).detail;
  showError(detail || `could not save "${name}"`);
  return false;
}

export async function apiDeletePlot(name) {
  await fetch(`/api/plots/${encodeURIComponent(name)}`, { method: "DELETE" });
}
