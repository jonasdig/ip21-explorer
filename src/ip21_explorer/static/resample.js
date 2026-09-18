/* Reading a series at a time it has no sample of.

   Two tags rarely share a time base: sample type and interval are per tag, so
   the server buckets them differently and a request for one is not a request
   for the other. Both formulas (which combine tags) and the XY plot (which
   pairs them) therefore need the same thing - the value of a series at an
   arbitrary time - and that lives here. Pure: it imports nothing. */

// How much wider than a series' own cadence a hole may be before nothing is
// drawn across it. Three buckets of silence is an outage, not a slope.
const MAX_HOLE_FACTOR = 3;

// Index of the last sample at or before t, or -1 when t precedes the series.
function lastBefore(ts, t) {
  if (!ts.length || t < ts[0]) return -1;
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid; else hi = mid;
  }
  return ts[hi] <= t ? hi : lo;
}

// The typical distance between samples. Median rather than mean, so one long
// outage cannot widen the tolerance that is meant to catch it, and rather than
// ts[1] - ts[0] because a historian's first bucket is not always a full one.
export function medianStep(ts) {
  if (ts.length < 2) return 0;
  const steps = [];
  for (let i = 1; i < ts.length; i++) steps.push(ts[i] - ts[i - 1]);
  steps.sort((a, b) => a - b);
  return steps[steps.length >> 1];
}

// The value of (ts, vs) at time t, or null when there is nothing honest to say:
// outside the series, next to a hole, or across a gap wider than maxGap.
// Between two samples the value is interpolated, or held from the left one for
// a stepped tag, where a straight line between two states would be a fiction.
export function sampleAt(ts, vs, t, hold, maxGap) {
  const i = lastBefore(ts, t);
  if (i < 0) return null;                      // before the series starts
  if (ts[i] === t) return vs[i];               // exact hit: no arithmetic
  if (i + 1 >= ts.length) return null;         // after the series ends
  const a = vs[i], b = vs[i + 1];
  if (a == null) return null;
  const span = ts[i + 1] - ts[i];
  if (maxGap > 0 && span > maxGap) return null;
  if (hold) return a;
  if (b == null) return null;
  return a + ((b - a) * (t - ts[i])) / span;
}

// Every timestamp any of the series has, once, ascending: the grid a
// combination of them is evaluated on. Keeping every real sample means no tag
// loses its own resolution, and only the borrowed values are interpolated.
export function unionTimes(tables) {
  const live = tables.filter((ts) => ts && ts.length);
  if (!live.length) return [];
  if (live.length === 1) return live[0];
  const all = new Set();
  for (const ts of live) for (const t of ts) all.add(t);
  return [...all].sort((x, y) => x - y);
}

// One value column per input, all on the same grid. An input that already owns
// the grid is passed straight through: no interpolation error, no allocation,
// and its own holes stay exactly where they are.
// Each input is {t, v, step}.
export function alignOnto(inputs, ts) {
  return inputs.map((input) => {
    if (input.t === ts) return input.v;
    const maxGap = MAX_HOLE_FACTOR * medianStep(input.t);
    const out = new Array(ts.length);
    for (let i = 0; i < ts.length; i++) {
      out[i] = sampleAt(input.t, input.v, ts[i], input.step, maxGap);
    }
    return out;
  });
}
