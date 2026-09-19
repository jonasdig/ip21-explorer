"""Reading a series at times it has no sample of.

Two tags rarely share a time base: sample type and interval are per tag, so
the historian buckets them differently. A formula is evaluated on every
timestamp any of its inputs has, and every input is read at all of them -
interpolated, or held from the left for a stepped tag, and never across a
hole wider than three of its own steps. The same rules as static/resample.js,
which the XY plot still uses in the browser.

Holes are NaN throughout.
"""
from __future__ import annotations

from typing import List, Sequence, Tuple

import numpy as np

# How much wider than a series' own cadence a hole may be before nothing is
# drawn across it. Three buckets of silence is an outage, not a slope.
MAX_HOLE_FACTOR = 3

# (timestamps, values, stepped)
Input = Tuple[np.ndarray, np.ndarray, bool]


def median_step(ts: np.ndarray) -> float:
    """The typical distance between samples (the upper median, as in the browser)."""
    if len(ts) < 2:
        return 0.0
    steps = np.sort(np.diff(ts))
    return float(steps[len(steps) >> 1])


def sample_at(ts: np.ndarray, vs: np.ndarray, at: np.ndarray, hold: bool,
              max_gap: float) -> np.ndarray:
    """The values of (ts, vs) at the times `at`: NaN outside the series, next
    to a hole, or across a gap wider than max_gap."""
    out = np.full(len(at), np.nan)
    if not len(ts):
        return out
    i = np.searchsorted(ts, at, side="right") - 1
    inside = i >= 0
    exact = inside & (ts[np.clip(i, 0, None)] == at)
    out[exact] = vs[i[exact]]

    between = inside & ~exact & (i + 1 < len(ts))
    k = i[between]
    a = vs[k]
    b = vs[k + 1]
    span = ts[k + 1] - ts[k]
    ok = ~np.isnan(a)
    if max_gap > 0:
        ok &= span <= max_gap
    if hold:
        values = a
    else:
        ok &= ~np.isnan(b)
        with np.errstate(invalid="ignore"):
            values = a + (b - a) * (at[between] - ts[k]) / span
    out[np.flatnonzero(between)[ok]] = values[ok]
    return out


def union_times(tables: Sequence[np.ndarray]) -> np.ndarray:
    """Every timestamp any of the series has, once, ascending."""
    live = [ts for ts in tables if ts is not None and len(ts)]
    if not live:
        return np.array([], dtype=float)
    if len(live) == 1:
        return live[0]
    return np.unique(np.concatenate(live))


def align_onto(inputs: Sequence[Input], grid: np.ndarray) -> List[np.ndarray]:
    """One value column per input, all on the grid. An input that already owns
    the grid passes straight through, holes and all."""
    columns = []
    for ts, vs, step in inputs:
        if ts is grid or (len(ts) == len(grid) and np.array_equal(ts, grid)):
            columns.append(vs)
            continue
        gap = MAX_HOLE_FACTOR * median_step(ts)
        columns.append(sample_at(ts, vs, grid, step, gap))
    return columns
