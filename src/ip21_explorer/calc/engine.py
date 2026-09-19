"""Computing formulas: reading the tags they need and evaluating them.

The browser decides what a reference in a formula means, because that depends
on its table (a row's map, a formula row's short name). It sends each formula
as an item:

    {"id": "t12", "expr": "=[TI-101] - [x]",
     "refs": {"TI-101": {"tag": "TI-101;IP_AnalogMap", "sample": "INT",
                         "interval": "auto", "step": false},
              "x": {"formula": "t7"}}}

where a {"formula": id} names another item of the same request. Nothing here
knows about HTTP, so a service without a browser - one watching for a
condition to raise an alarm - can compute the same items the same way.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple

import numpy as np

from ..sources.base import DataSource, SampleType
from .align import align_onto, union_times
from .evaluate import evaluate
from .parser import FormulaError, Node, Parsed, parse_formula, resolve_hint

logger = logging.getLogger("ip21_explorer")

# Candidate aggregate intervals for interval=auto, in seconds. The floor is
# 4 s because IP21 stores no sample finer than that.
NICE_INTERVALS = [
    4, 8, 15, 30,
    60, 120, 300, 600, 900, 1800,
    3600, 7200, 14400, 21600, 43200, 86400,
]

# Sample/interval groups read from the historian at the same time.
READ_GROUPS_AT_ONCE = 4


def auto_interval(span_s: float, points: int) -> float:
    """Pick a nice interval giving roughly `points` samples over the span."""
    target = span_s / max(1, points)
    for candidate in NICE_INTERVALS:
        if candidate >= target:
            return float(candidate)
    return float(NICE_INTERVALS[-1])


@dataclass
class Result:
    t: np.ndarray
    v: np.ndarray
    step: bool = False
    # (message, hard): hard is a fault in the formula or a tag that does not
    # exist; soft is a window with nothing in it, which may pass.
    error: Optional[Tuple[str, bool]] = None


@dataclass(frozen=True)
class Window:
    """Where and how a tag is read: the plot's own window and sampling, or
    (later) a coarser one of a time function's own."""
    start: float
    end: float
    sample: Optional[str] = None      # overrides a reference's own when set
    interval_s: Optional[float] = None


# One read from the historian: (tag, sample, interval_s, start, end).
ReadKey = Tuple[str, str, float, float, float]


class RefError(Exception):
    def __init__(self, text: str, hard: bool):
        super().__init__(text)
        self.text = text
        self.hard = hard


class _Computation:
    def __init__(self, source: DataSource, items: Sequence[Dict[str, Any]],
                 start: float, end: float, points: int):
        self.source = source
        self.items = {str(item["id"]): item for item in items}
        self.points = points
        self.window = Window(start, end)
        self.parsed: Dict[str, Parsed] = {}
        self.parse_errors: Dict[str, str] = {}
        self.data: Dict[ReadKey, Tuple[np.ndarray, np.ndarray]] = {}
        self.failed: Dict[ReadKey, str] = {}
        self.done: Dict[Tuple[str, Window], Result] = {}
        self.walking: List[str] = []
        for item_id, item in self.items.items():
            try:
                self.parsed[item_id] = parse_formula(item.get("expr", ""))
            except FormulaError as exc:
                self.parse_errors[item_id] = str(exc)

    # -- what has to be read -------------------------------------------------

    def read_key(self, spec: Dict[str, Any], window: Window) -> ReadKey:
        sample = (window.sample or str(spec.get("sample") or "INT")).upper()
        if window.interval_s:
            interval_s = window.interval_s
        else:
            interval = spec.get("interval", "auto")
            if interval in (None, "", "auto"):
                interval_s = auto_interval(window.end - window.start, self.points)
            else:
                interval_s = float(interval)
        return (str(spec["tag"]), sample, float(interval_s),
                float(window.start), float(window.end))

    def needs(self, item_id: str, window: Window, seen: Tuple[str, ...] = ()) -> Iterator[ReadKey]:
        if item_id in seen or item_id not in self.parsed:
            return
        refs = self.items[item_id].get("refs") or {}
        yield from self._needs_node(self.parsed[item_id].node, refs, window, seen + (item_id,))

    def _needs_node(self, node: Node, refs: Dict[str, Any], window: Window,
                    seen: Tuple[str, ...]) -> Iterator[ReadKey]:
        kind = node["k"]
        if kind == "ref":
            spec = refs.get(node["ref"])
            if not spec:
                return
            if "formula" in spec:
                yield from self.needs(str(spec["formula"]), window, seen)
            elif spec.get("tag"):
                yield self.read_key(spec, window)
        elif kind == "neg":
            yield from self._needs_node(node["a"], refs, window, seen)
        elif kind == "bin":
            yield from self._needs_node(node["a"], refs, window, seen)
            yield from self._needs_node(node["b"], refs, window, seen)
        elif kind == "fn":
            for arg in node["args"]:
                yield from self._needs_node(arg, refs, window, seen)

    def fetch(self, keys: Sequence[ReadKey]) -> None:
        """Reads everything at once, one request per sampling group, the
        groups side by side - as the browser did when it read them itself."""
        groups: Dict[Tuple[str, float, float, float], List[str]] = {}
        for tag, sample, interval_s, start, end in dict.fromkeys(keys):
            groups.setdefault((sample, interval_s, start, end), []).append(tag)

        def read(group):
            (sample, interval_s, start, end), tags = group
            try:
                series = self.source.read(tags, start, end, SampleType(sample), interval_s)
            except (KeyError, ValueError) as exc:
                if len(tags) == 1:
                    return {}, {tags[0]: _message(exc)}
                # One bad name fails a whole request on some sources: ask for
                # each alone, so only the formulas that use it are marked.
                series, errors = {}, {}
                for tag in tags:
                    try:
                        series.update(self.source.read([tag], start, end, SampleType(sample), interval_s))
                    except (KeyError, ValueError) as one:
                        errors[tag] = _message(one)
                return series, errors
            return series, {}

        if not groups:
            return
        with ThreadPoolExecutor(max_workers=min(READ_GROUPS_AT_ONCE, len(groups))) as pool:
            answers = list(pool.map(read, groups.items()))
        for (group, tags), (series, errors) in zip(groups.items(), answers):
            sample, interval_s, start, end = group
            for tag in tags:
                key = (tag, sample, interval_s, start, end)
                if tag in errors:
                    self.failed[key] = errors[tag]
                elif tag in series:
                    t, v = series[tag]
                    self.data[key] = (np.asarray(t, dtype=float), np.asarray(v, dtype=float))

    # -- evaluation --------------------------------------------------------------

    def result(self, item_id: str, window: Window) -> Result:
        memo = (item_id, window)
        if memo in self.done:
            return self.done[memo]
        if item_id in self.parse_errors:
            return Result(_empty(), _empty(), error=(self.parse_errors[item_id], True))
        if item_id in self.walking:
            chain = self.walking[self.walking.index(item_id):] + [item_id]
            raise RefError("circular formula: " + " → ".join(chain), True)
        self.walking.append(item_id)
        try:
            out = self._evaluate(item_id, window)
        except RefError as exc:
            out = Result(_empty(), _empty(), error=(exc.text, exc.hard))
        finally:
            self.walking.pop()
        self.done[memo] = out
        return out

    def _evaluate(self, item_id: str, window: Window) -> Result:
        parsed = self.parsed[item_id]
        refs = self.items[item_id].get("refs") or {}
        leaves: Dict[str, Tuple[np.ndarray, np.ndarray, bool]] = {}
        for ref in parsed.refs:
            leaves[ref] = self._ref_series(ref, refs.get(ref), parsed, window)

        grid = union_times([t for t, _, _ in leaves.values()])
        columns = dict(zip(leaves, align_onto(list(leaves.values()), grid)))
        values = evaluate(parsed.node, lambda node: columns[node["ref"]], len(grid))
        values = np.array(values, dtype=float, copy=True)
        step = all(s for _, _, s in leaves.values())
        error = None if np.any(~np.isnan(values)) else ("no result in this window", False)
        return Result(np.array(grid, dtype=float, copy=True), values, step, error)

    def _ref_series(self, ref: str, spec: Optional[Dict[str, Any]], parsed: Parsed,
                    window: Window) -> Tuple[np.ndarray, np.ndarray, bool]:
        hint = resolve_hint(ref, ref in parsed.bare)
        if not spec:
            raise RefError(f"{ref} is not known here{hint}", True)
        if "formula" in spec:
            other = self.result(str(spec["formula"]), window)
            if other.error and not len(other.t):
                raise RefError(f"{ref} has no data in this window{hint}", False)
            return other.t, other.v, other.step
        key = self.read_key(spec, window)
        if key in self.failed:
            said = self.failed[key]
            said = said if ref in said else f"{ref}: {said}"
            raise RefError(said + hint, True)
        series = self.data.get(key)
        if series is None or not len(series[0]):
            raise RefError(f"{ref} has no data in this window{hint}", False)
        return series[0], series[1], bool(spec.get("step"))


def _empty() -> np.ndarray:
    return np.array([], dtype=float)


def _message(exc: Exception) -> str:
    # KeyError's str() is the repr of its argument, quotes and all.
    if isinstance(exc, KeyError) and exc.args:
        return str(exc.args[0])
    return str(exc) or "unknown tag"


def compute(source: DataSource, items: Sequence[Dict[str, Any]], start: float,
            end: float, points: int = 1500) -> Dict[str, Result]:
    """Every item's series over [start, end], or its error."""
    run = _Computation(source, items, start, end, points)
    keys: List[ReadKey] = []
    for item_id in run.items:
        keys.extend(run.needs(item_id, run.window))
    run.fetch(keys)
    out: Dict[str, Result] = {}
    for item_id in run.items:
        try:
            out[item_id] = run.result(item_id, run.window)
        except RefError as exc:
            out[item_id] = Result(_empty(), _empty(), error=(exc.text, exc.hard))
    return out
