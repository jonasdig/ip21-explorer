/* Fixed lists and limits shared across the app. */

export const PALETTE = [
  "#4FC3F7", "#FFB74D", "#81C784", "#E57373", "#BA68C8", "#FFD54F",
  "#4DD0E1", "#F06292", "#AED581", "#90A4AE", "#FF8A65", "#7986CB",
];

// How a tag's trace is drawn, chosen in the colour menu. Widths are CSS px;
// dashes are canvas dash patterns, scaled by the line width where drawn.
export const LINE_WIDTHS = { thin: 1, normal: 1.6, thick: 3 };
export const LINE_DASHES = { solid: [], dash: [7, 4], dot: [1, 3.5], none: [] };
// XY point symbols, in the order a series with "auto" is given them, so two
// pumps plotted side by side never look alike before anyone has chosen.
export const XY_SYMBOLS = ["circle", "square", "triangle", "diamond", "cross", "plus"];

export const PRESETS = [
  { label: "1h", s: 3600 },
  { label: "8h", s: 8 * 3600 },
  { label: "24h", s: 24 * 3600 },
  { label: "3d", s: 3 * 24 * 3600 },
  { label: "7d", s: 7 * 24 * 3600 },
  { label: "30d", s: 30 * 24 * 3600 },
];

export const SAMPLES = [
  { label: "Interpolated", value: "INT" },
  { label: "Average", value: "AVG" },
  { label: "Minimum", value: "MIN" },
  { label: "Maximum", value: "MAX" },
];

// The 4 s floor matches the server's NICE_INTERVALS: IP21 stores no sample
// finer than that, so asking for less only costs bandwidth.
export const INTERVALS = [
  { label: "Auto", value: "auto" },
  { label: "4 s", value: "4" },
  { label: "8 s", value: "8" },
  { label: "30 s", value: "30" },
  { label: "1 min", value: "60" },
  { label: "5 min", value: "300" },
  { label: "10 min", value: "600" },
  { label: "30 min", value: "1800" },
  { label: "1 h", value: "3600" },
  { label: "6 h", value: "21600" },
  { label: "1 d", value: "86400" },
];

export const STORAGE_KEY = "ip21explorer.v1";
// Each search is real work for the IP21 server: keep them specific and rare.
export const MIN_QUERY_LEN = 2;
export const SEARCH_DEBOUNCE_MS = 350;
// Finest sample IP21 holds; the server's NICE_INTERVALS floor matches it.
const MIN_INTERVAL_S = 4;
// One minute is 15 samples at the 4 s floor; anything tighter is a flat line.
export const MIN_SPAN_S = 60;
export const MAX_SPAN_S = 5 * 366 * 24 * 3600;
export const HISTORY_MAX = 50;
export const LIVE_INTERVAL_MS = 10_000;
// Above this, "Open all" asks first: each listed plot becomes its own tab.
export const OPEN_ALL_CONFIRM = 8;

// What the readout boxes name a tag by, and the cycle order.
export const LABEL_MODES = {
  tag: { label: "Labels: tag", next: "desc" },
  desc: { label: "Labels: description", next: "both" },
  both: { label: "Labels: both", next: "tag" },
};
// Live refuses a refresh that would ask for more points than /api/data will
// ever serve in one go. Span is not the measure - liveTick already refreshes
// once per bucket, so a wide window is the cheapest one - request size is.
export const LIVE_MAX_POINTS = 20000;
// The server refuses more than this per tag in one request (see MAX_POINTS in
// sources/simulator.py); a pinned interval over a wide window is the only way
// to reach it.
export const DATA_MAX_POINTS = 200000;
