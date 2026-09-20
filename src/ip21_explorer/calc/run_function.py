"""Running one catalog function over series we have read.

Our series are (timestamps, values) arrays; indsl works in pandas, over a
Series with a DatetimeIndex, and most of its functions assume the samples are
evenly spaced - which a formula's own grid, the union of several tags', need
not be. So the values are put on an even grid first, handed over as pandas,
and the answer brought back.
"""
from __future__ import annotations

import enum
import inspect
import logging
import time
import typing
from typing import Any, Dict, List, Sequence, Tuple

import numpy as np
import pandas as pd

from .align import median_step, sample_at
from .catalog import DURATION, FunctionSpec

logger = logging.getLogger("ip21_explorer")

# Beyond this, a function would take longer than anyone waits, and some are
# O(n^2). The formula says so instead of hanging.
MAX_POINTS = 200_000
# How far apart the steps may be before the grid counts as uneven.
EVEN_ENOUGH = 0.01


class RunError(Exception):
    """A function that could not be run; the message is for the user."""


def even_grid(times: np.ndarray) -> np.ndarray:
    """The times themselves when they are evenly spaced, else an even grid of
    the same span with the typical step."""
    if len(times) < 3:
        return times
    steps = np.diff(times)
    step = median_step(times)
    if step <= 0:
        return times
    if float(np.max(np.abs(steps - step))) <= EVEN_ENOUGH * step:
        return times
    count = int(round((times[-1] - times[0]) / step)) + 1
    return times[0] + np.arange(count) * step


def to_pandas(times: np.ndarray, values: np.ndarray) -> pd.Series:
    # UTC, but without the zone on the index: several indsl functions turn
    # the index into numpy, which a zone-aware one cannot become. The
    # timestamps are the same either way, and from_pandas reads a bare index
    # back as UTC.
    index = pd.to_datetime(np.asarray(times) * 1e9, utc=True).tz_localize(None)
    return pd.Series(np.asarray(values, dtype=float), index=index)


def from_pandas(series: pd.Series) -> Tuple[np.ndarray, np.ndarray]:
    index = pd.DatetimeIndex(series.index)
    if index.tz is None:
        index = index.tz_localize("UTC")
    times = np.asarray(index.astype("int64"), dtype=float) / 1e9
    values = pd.to_numeric(series, errors="coerce").to_numpy(dtype=float)
    return times, values


def python_value(annotation: Any, kind: str, value: Any, param=None) -> Any:
    """A setting from the formula in the shape the function's signature wants:
    indsl checks its types, so an int parameter may not be handed a float."""
    origin, args = typing.get_origin(annotation), typing.get_args(annotation)
    if origin is typing.Union or str(origin) == "<class 'types.UnionType'>":
        inner = [a for a in args if a is not type(None)]
        if inner:
            return python_value(inner[0], kind, value)
    if param is not None and param.choice_values:
        value = param.value_of(value)
    if kind == DURATION:
        return pd.Timedelta(seconds=float(value))
    if annotation is int:
        return int(round(float(value)))
    if annotation is float:
        return float(value)
    if inspect.isclass(annotation) and issubclass(annotation, enum.Enum):
        return annotation(value)
    return value


def call_arguments(spec: FunctionSpec, params: Dict[str, Any]) -> Dict[str, Any]:
    """The settings as keyword arguments; anything left out keeps the
    function's own default."""
    signature = inspect.signature(spec.call)
    out: Dict[str, Any] = {}
    for param in spec.params:
        if param.name not in params:
            continue
        annotation = signature.parameters[param.name].annotation
        out[param.name] = python_value(annotation, param.kind, params[param.name], param)
    return out


def run_function(spec: FunctionSpec, inputs: Sequence[Tuple[np.ndarray, np.ndarray]],
                 params: Dict[str, Any]) -> Tuple[np.ndarray, np.ndarray]:
    """One catalog function over inputs already on a common grid."""
    times = inputs[0][0]
    if not len(times):
        return times, np.array([], dtype=float)
    if len(times) > MAX_POINTS:
        raise RunError(
            f"{spec.name}: {len(times)} points is more than it can be asked for "
            f"({MAX_POINTS}); a shorter window or a coarser Period"
        )
    grid = even_grid(times)
    series: List[pd.Series] = []
    for t, v in inputs:
        if grid is times:
            series.append(to_pandas(t, v))
        else:
            gap = 3 * median_step(t)
            series.append(to_pandas(grid, sample_at(t, v, grid, False, gap)))

    began = time.monotonic()
    try:
        answer = spec.call(*series, **call_arguments(spec, params))
    except Exception as exc:
        raise RunError(_message(spec, exc)) from None
    took = time.monotonic() - began
    if took > 1:
        logger.info("%s over %d points took %.1f s", spec.name, len(grid), took)

    if isinstance(answer, (int, float, np.floating)):
        return grid, np.full(len(grid), float(answer))
    if not isinstance(answer, pd.Series):
        raise RunError(f"{spec.name}: answered with {type(answer).__name__}, not a series")
    if not len(answer):
        return np.array([], dtype=float), np.array([], dtype=float)
    return from_pandas(answer)


def _message(spec: FunctionSpec, exc: Exception) -> str:
    """indsl's own words where it has any - its UserValueError and friends are
    written for the person who asked - and something plain otherwise."""
    text = str(exc).strip().replace("\n", " ")
    kind = type(exc).__name__
    if kind.startswith("User") or isinstance(exc, (ValueError, TypeError)):
        return f"{spec.name}: {text}" if text else f"{spec.name}: {kind}"
    return f"{spec.name} failed: {text or kind}"
