"""Computing formulas: reading the tags they need and evaluating them.

The browser decides what a reference in a formula means, because that depends
on its table (a row's map, a formula row's short name). It sends each formula
as an item:

    {"id": "t12", "expr": "=[TI-101] - [x]", "name": "Net",
     "refs": {"TI-101": {"tag": "TI-101;IP_AnalogMap", "sample": "INT",
                         "interval": "auto", "step": false},
              "x": {"formula": "t7"}}}

where a {"formula": id} names another item of the same request, and name
(optional) is what messages call the formula. Everything else wrong with a
formula - one that does not parse, one that loops back on itself through
others - is found here. Nothing here knows about HTTP, so a service without
a browser - one watching for a condition to raise an alarm - can compute
the same items the same way.
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

import numpy as np

from ..sources.base import DataSource, SampleType
from .align import align_onto, union_times
from .evaluate import evaluate
from .catalog import RESOLUTION_S, find
from .parser import FormulaError, Node, Parsed, parse_formula, resolve_hint
from .periods import period_bounds
from .run_function import RunError, run_function

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

# What a time function reads its tags with: time-weighted averages, whose sum
# times the bucket length is exactly the quantity that passed, at the interval
# the formula asks for - or, by default or when that would be more than
# TOTAL_MAX_POINTS over the window, the finest of these that is not. Every
# one divides an hour, so buckets never straddle a period boundary.
TOTAL_SAMPLE = "AVG"
TOTAL_INTERVALS = [60, 300, 600, 900, 1800, 3600]
TOTAL_MAX_POINTS = 50_000


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
    """Where and how a tag is read: the plot's own window and each tag's own
    sampling, or a time function's window with the sampling it needs."""
    start: float
    end: float
    sample: Optional[str] = None      # overrides a reference's own when set
    interval_s: Optional[float] = None


def total_window(window: Window, period: str, zone: ZoneInfo, now: float,
                 resolution: Optional[str] = None) -> Tuple[Window, List[float]]:
    """The window a total() reads over - stretched to whole periods, but not
    past now, where there is nothing to read - and its period boundaries."""
    bounds = period_bounds(window.start, window.end, period, zone)
    end = min(bounds[-1], max(window.end, now))
    bounds = [b for b in bounds if b < end] + [end]
    span = end - bounds[0]
    wanted = RESOLUTION_S.get(resolution or "auto") or 0.0
    # Asked for, but so fine over so long a window that the historian should
    # not be asked it: the finest that is not too many points instead.
    candidates = [i for i in TOTAL_INTERVALS if i >= wanted]
    interval_s = next((float(i) for i in candidates if span / i <= TOTAL_MAX_POINTS),
                      float(TOTAL_INTERVALS[-1]))
    return Window(bounds[0], end, TOTAL_SAMPLE, interval_s), bounds


def sum_periods(t: np.ndarray, v: np.ndarray, bucket_s: float,
                bounds: List[float]) -> Tuple[np.ndarray, np.ndarray]:
    """Sum of value x hours per period, from samples that each stand for the
    time up to the next one (at most one bucket). A period with no samples is
    a hole. The answer has a point at every period start, and one more at the
    end of the last, so a stepped line covers the whole of the last period."""
    edges = np.asarray(bounds, dtype=float)
    sums = np.full(len(edges) - 1, np.nan)
    if len(t):
        until = np.append(t[1:], np.inf)
        weight_h = (np.minimum(until, np.minimum(t + bucket_s, edges[-1])) - t) / 3600.0
        live = ~np.isnan(v) & (weight_h > 0) & (t >= edges[0]) & (t < edges[-1])
        index = np.searchsorted(edges, t[live], side="right") - 1
        totals = np.bincount(index, weights=v[live] * weight_h[live], minlength=len(sums))
        counts = np.bincount(index, minlength=len(sums))
        sums[counts > 0] = totals[counts > 0]
    return edges, np.append(sums, sums[-1] if len(sums) else np.nan)


# One read from the historian: (tag, sample, interval_s, start, end).
ReadKey = Tuple[str, str, float, float, float]


class RefError(Exception):
    def __init__(self, text: str, hard: bool):
        super().__init__(text)
        self.text = text
        self.hard = hard


class _Computation:
    def __init__(self, source: DataSource, items: Sequence[Dict[str, Any]],
                 start: float, end: float, points: int, zone: ZoneInfo, now: float):
        self.source = source
        self.zone = zone
        self.now = now
        self.items = {str(item["id"]): item for item in items}
        self.points = points
        self.window = Window(start, end)
        self.parsed: Dict[str, Parsed] = {}
        self.parse_errors: Dict[str, str] = {}
        self.data: Dict[ReadKey, Tuple[np.ndarray, np.ndarray]] = {}
        self.failed: Dict[ReadKey, str] = {}
        self.done: Dict[Tuple[str, Window], Result] = {}
        for item_id, item in self.items.items():
            try:
                self.parsed[item_id] = parse_formula(item.get("expr", ""))
            except FormulaError as exc:
                self.parse_errors[item_id] = str(exc)
        self.cyclic = self._find_cycles()

    def name(self, item_id: str) -> str:
        """What a formula is called in a message: the name the item was sent
        with, which for a row is its short description."""
        return str(self.items.get(item_id, {}).get("name") or item_id)

    # -- formulas built on formulas ----------------------------------------------

    def _formula_refs(self, item_id: str) -> List[str]:
        """The other items a formula reads, among the references it uses."""
        parsed = self.parsed.get(item_id)
        if parsed is None:
            return []
        refs = self.items[item_id].get("refs") or {}
        specs = (refs.get(ref) or {} for ref in parsed.refs)
        return [str(spec["formula"]) for spec in specs if "formula" in spec]

    def _find_cycles(self) -> Dict[str, str]:
        """Every formula that is part of a loop, and the loop by name.

        Each member is marked, not only the one a walk happens to come back
        to: two rows that point at each other are both at fault, and neither
        must sit there looking merely unlucky.
        """
        cyclic: Dict[str, str] = {}
        state: Dict[str, int] = {}      # 1: on the path walked now, 2: done
        path: List[str] = []

        def walk(item_id: str) -> None:
            if item_id not in self.items or state.get(item_id) == 2:
                return
            if state.get(item_id) == 1:
                loop = [self.name(member) for member in path[path.index(item_id):]]
                if len(loop) == 1:
                    cyclic.setdefault(item_id, f"{loop[0]} refers to itself")
                    return
                # Told from each member's own row, so each starts with itself.
                for at, member in enumerate(path[path.index(item_id):]):
                    turn = loop[at:] + loop[:at]
                    cyclic.setdefault(member, "circular formula: " + " → ".join(turn + turn[:1]))
                return
            state[item_id] = 1
            path.append(item_id)
            for other in self._formula_refs(item_id):
                walk(other)
            path.pop()
            state[item_id] = 2

        for item_id in self.items:
            walk(item_id)
        return cyclic

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
        elif kind == "fn" and node["name"] == "total":
            inner, _ = total_window(window, _period(node), self.zone, self.now,
                                    node.get("params", {}).get("resolution"))
            yield from self._needs_node(node["args"][0], refs, inner, seen)
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
        if item_id in self.cyclic:
            return Result(_empty(), _empty(), error=(self.cyclic[item_id], True))
        try:
            out = self._evaluate(item_id, window)
        except RefError as exc:
            out = Result(_empty(), _empty(), error=(exc.text, exc.hard))
        self.done[memo] = out
        return out

    def _evaluate(self, item_id: str, window: Window) -> Result:
        parsed = self.parsed[item_id]
        refs = self.items[item_id].get("refs") or {}
        t, v, step = self._series(parsed.node, refs, parsed, window)
        error = None if np.any(~np.isnan(v)) else ("no result in this window", False)
        return Result(t, v, step, error)

    def _series(self, node: Node, refs: Dict[str, Any], parsed: Parsed,
                window: Window) -> Tuple[np.ndarray, np.ndarray, bool]:
        """An expression over a window: its leaves - references, and totals
        computed over their own periods - read onto one grid, then evaluated."""
        leaves: Dict[Any, Tuple[np.ndarray, np.ndarray, bool]] = {}
        for leaf in _leaves(node):
            if leaf["k"] == "ref":
                ref = leaf["ref"]
                if ref not in leaves:
                    leaves[ref] = self._ref_series(ref, refs.get(ref), parsed, window)
            elif leaf["name"] == "total":
                leaves[id(leaf)] = self._total(leaf, refs, parsed, window)
            else:
                leaves[id(leaf)] = self._function(leaf, refs, parsed, window)

        if not leaves:
            # Numbers alone (=80): a constant, sampled over the window as a tag
            # would be, so it draws across the plot and total(1, day) is 24.
            grid = _constant_grid(window, self.points)
            return grid, np.array(evaluate(node, lambda leaf: None, len(grid)), dtype=float), False

        grid = union_times([t for t, _, _ in leaves.values()])
        columns = dict(zip(leaves, align_onto(list(leaves.values()), grid)))

        def column(leaf: Node) -> np.ndarray:
            return columns[leaf["ref"] if leaf["k"] == "ref" else id(leaf)]

        values = evaluate(node, column, len(grid))
        step = bool(leaves) and all(s for _, _, s in leaves.values())
        return (np.array(grid, dtype=float, copy=True),
                np.array(values, dtype=float, copy=True), step)

    def _total(self, node: Node, refs: Dict[str, Any], parsed: Parsed,
               window: Window) -> Tuple[np.ndarray, np.ndarray, bool]:
        inner, bounds = total_window(window, _period(node), self.zone, self.now,
                                     node.get("params", {}).get("resolution"))
        t, v, _ = self._series(node["args"][0], refs, parsed, inner)
        edges, sums = sum_periods(t, v, inner.interval_s, bounds)
        return edges, sums, True

    def _function(self, node: Node, refs: Dict[str, Any], parsed: Parsed,
                  window: Window) -> Tuple[np.ndarray, np.ndarray, bool]:
        """A library function (indsl): its inputs on one grid, then the call."""
        spec = find(node["name"])
        if spec is None or spec.call is None:
            raise RefError(f'{node["name"]} is not available here', True)
        # An input that is only numbers - a threshold, a density - has no
        # time of its own; it goes in as the number it is.
        parts, constants = [], {}
        for position, arg in enumerate(node["args"]):
            if _leaf_count(arg):
                parts.append((position, self._series(arg, refs, parsed, window)))
            else:
                constants[position] = float(evaluate(arg, lambda leaf: None, 1)[0])
        if not parts:
            raise RefError(f'{node["name"]} needs at least one input with data', True)

        grid = union_times([t for _, (t, _, _) in parts])
        columns = align_onto([(t, v, step) for _, (t, v, step) in parts], grid)
        inputs: List[Any] = [None] * len(node["args"])
        for (position, _), column in zip(parts, columns):
            inputs[position] = (grid, column)
        for position, value in constants.items():
            inputs[position] = value
        try:
            t, v = run_function(spec, inputs, grid, node.get("params", {}))
        except RunError as exc:
            raise RefError(str(exc), True) from None
        return t, v, spec.step

    def _ref_series(self, ref: str, spec: Optional[Dict[str, Any]], parsed: Parsed,
                    window: Window) -> Tuple[np.ndarray, np.ndarray, bool]:
        hint = resolve_hint(ref, ref in parsed.bare)
        if not spec:
            raise RefError(f"{ref} is not known here{hint}", True)
        if "formula" in spec:
            other_id = str(spec["formula"])
            if other_id not in self.items:
                raise RefError(f"{ref} is not known here{hint}", True)
            other = self.result(other_id, window)
            if other.error and other.error[1]:
                # Built on a formula that is wrong: this one cannot be right,
                # and should say where the fault lies.
                raise RefError(f"{ref} cannot be computed: {other.error[0]}", True)
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


def is_series_function(node: Node) -> bool:
    """A function over a whole series rather than value by value: total, and
    everything from the library. Its inputs are read over its own window."""
    if node["k"] != "fn":
        return False
    if node["name"] == "total":
        return True
    spec = find(node["name"])
    return bool(spec and spec.call)


def _leaf_count(node: Node) -> int:
    """How many series an expression rests on; none means it is all numbers."""
    return sum(1 for _ in _leaves(node))


def _period(node: Node) -> str:
    return node.get("params", {}).get("period", "day")


def _leaves(node: Node) -> Iterator[Node]:
    """References and series functions; what is inside a series function is
    read over that function's own window, not this one."""
    kind = node["k"]
    if kind == "ref" or is_series_function(node):
        yield node
    elif kind == "neg":
        yield from _leaves(node["a"])
    elif kind == "bin":
        yield from _leaves(node["a"])
        yield from _leaves(node["b"])
    elif kind == "fn":
        for arg in node["args"]:
            yield from _leaves(arg)


def _empty() -> np.ndarray:
    return np.array([], dtype=float)


def _constant_grid(window: Window, points: int) -> np.ndarray:
    """Evenly spaced times over a window, both ends included, at the interval
    the window reads tags at - or the one auto would pick for it."""
    step = window.interval_s or auto_interval(window.end - window.start, points)
    return np.arange(window.start, window.end + step / 2, step, dtype=float)


def _message(exc: Exception) -> str:
    # KeyError's str() is the repr of its argument, quotes and all.
    if isinstance(exc, KeyError) and exc.args:
        return str(exc.args[0])
    return str(exc) or "unknown tag"


def compute(source: DataSource, items: Sequence[Dict[str, Any]], start: float,
            end: float, points: int = 1500, timezone: str = "Europe/Oslo",
            now: Optional[float] = None) -> Dict[str, Result]:
    """Every item's series over [start, end], or its error. Calendar periods
    (for total) are in `timezone`."""
    run = _Computation(source, items, start, end, points, ZoneInfo(timezone),
                       time.time() if now is None else now)
    keys: List[ReadKey] = []
    for item_id in run.items:
        keys.extend(run.needs(item_id, run.window))
    run.fetch(keys)
    return {item_id: run.result(item_id, run.window) for item_id in run.items}
