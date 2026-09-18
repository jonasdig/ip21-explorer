/* Share links that carry a whole plot in the URL fragment. */

import { isFormula } from "./formula.js";
import { readConfig, tabToConfig } from "./plots.js";
import { activeTab } from "./state.js";
import { addTab } from "./tabs.js";
import { showError, showNotice } from "./util.js";

// Everything the plot needs travels in the URL fragment: there is no shared
// server to store links on, and a fragment is never sent to the server.
function b64urlEncode(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function gzip(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Cached catalog data (maps, descriptions) is dropped: it is re-fetched on
// demand and would otherwise dominate the link length. A description someone
// wrote is not catalog data, though - a corrected one, or a formula's name,
// which other formulas may refer to - so those travel with the link.
function shareConfig(tab) {
  const config = tabToConfig(tab);
  config.tags = config.tags.map(({ maps, description, ...rest }) =>
    rest.descEdited || isFormula(rest.name) ? { ...rest, description } : rest);
  return config;
}

async function buildShareLink(tab) {
  const json = new TextEncoder().encode(JSON.stringify(shareConfig(tab)));
  const packed = await gzip(json);
  const payload = packed ? `z${b64urlEncode(packed)}` : `r${b64urlEncode(json)}`;
  return `${location.origin}${location.pathname}#p=${payload}`;
}

export async function copyShareLink() {
  const link = await buildShareLink(activeTab());
  try {
    await navigator.clipboard.writeText(link);
    showNotice("Share link copied to the clipboard", 2500);
  } catch (e) {
    // Clipboard blocked: put the link in the URL bar so it can be copied.
    location.hash = link.slice(link.indexOf("#") + 1);
    showError("Share link is in the address bar");
  }
}

// Opens a plot from #p=... and clears the fragment, so a reload does not keep
// re-adding the same tab.
export async function openSharedPlot() {
  const match = /^#p=(.+)$/.exec(location.hash);
  if (!match) return false;
  history.replaceState(null, "", location.pathname);
  try {
    const payload = match[1];
    const bytes = b64urlDecode(payload.slice(1));
    const json = payload[0] === "z" ? await gunzip(bytes) : bytes;
    const config = JSON.parse(new TextDecoder().decode(json));
    const tab = readConfig(config.name || "Shared plot", config);
    if (!tab) return false;
    addTab(tab);
    return true;
  } catch (e) {
    showError("Could not read the shared plot link");
    return false;
  }
}
