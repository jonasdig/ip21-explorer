"""Evaluating an expression tree over aligned columns, all timestamps at once.

A hole (NaN) anywhere is a hole in the answer, and so is anything that stops
being a finite number on the way - x/0, sqrt of a negative, ln(0). The
multi-argument functions skip holes, so one tag with a gap does not blank the
average of five; the single-argument ones pass a hole straight through.
Comparisons give 1 or 0, or a hole when either side is one.
"""
from __future__ import annotations

from typing import Callable, Dict

import numpy as np

from .parser import Node

Column = np.ndarray


def _finite(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    values[~np.isfinite(values)] = np.nan
    return values


def _round_half_up(values: np.ndarray) -> np.ndarray:
    # Math.round in the browser rounds .5 up; numpy rounds it to even.
    return np.floor(values + 0.5)


SINGLE: Dict[str, Callable[[np.ndarray], np.ndarray]] = {
    "abs": np.abs,
    "sqrt": np.sqrt,
    "ln": np.log,
    "log10": np.log10,
    "exp": np.exp,
    "round": _round_half_up,
}


def _multi(name: str, stack: np.ndarray) -> np.ndarray:
    live = ~np.isnan(stack)
    count = live.sum(axis=0)
    out = np.full(stack.shape[1], np.nan)
    has = count > 0
    if name == "min":
        out[has] = np.where(live, stack, np.inf).min(axis=0)[has]
    elif name == "max":
        out[has] = np.where(live, stack, -np.inf).max(axis=0)[has]
    else:  # avg
        out[has] = np.where(live, stack, 0.0).sum(axis=0)[has] / count[has]
    return out


def _is_leaf(node: Node) -> bool:
    from .engine import is_series_function   # late: engine imports this module
    return is_series_function(node)


def _compare(op: str, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    if op == ">":
        out = a > b
    elif op == "<":
        out = a < b
    elif op == ">=":
        out = a >= b
    else:
        out = a <= b
    out = out.astype(float)
    out[np.isnan(a) | np.isnan(b)] = np.nan
    return out


def evaluate(node: Node, column: Callable[[Node], Column], size: int) -> Column:
    """The expression's values on a grid of `size` timestamps. `column(node)`
    gives the values of a leaf on that grid: a tag reference, or a time
    function (total) that the engine has already computed over its periods."""
    with np.errstate(all="ignore"):
        return _eval(node, column, size)


def _eval(node: Node, column: Callable[[Node], Column], size: int) -> Column:
    kind = node["k"]
    if kind == "num":
        return np.full(size, float(node["v"]))
    if kind == "ref" or (kind == "fn" and _is_leaf(node)):
        return np.asarray(column(node), dtype=float)
    if kind == "neg":
        return -_eval(node["a"], column, size)
    if kind == "bin":
        a = _eval(node["a"], column, size)
        b = _eval(node["b"], column, size)
        op = node["op"]
        if op == "+":
            out = a + b
        elif op == "-":
            out = a - b
        elif op == "*":
            out = a * b
        elif op == "/":
            out = a / b
        elif op == "^":
            out = np.power(a, b)
        else:
            out = _compare(op, a, b)
        return _finite(out)
    if kind == "fn":
        args = [_eval(arg, column, size) for arg in node["args"]]
        name = node["name"]
        if name in SINGLE:
            return _finite(SINGLE[name](args[0]))
        return _finite(_multi(name, np.vstack(args)))
    raise ValueError(f"unknown node kind: {kind}")
