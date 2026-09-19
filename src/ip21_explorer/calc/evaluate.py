"""Evaluating an expression tree over aligned columns, all timestamps at once.

A hole (NaN) anywhere is a hole in the answer, and so is anything that stops
being a finite number on the way - x/0, sqrt of a negative, ln(0). The
multi-argument functions skip holes, so one tag with a gap does not blank the
average of five; the single-argument ones pass a hole straight through.
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


def evaluate(node: Node, column: Callable[[Node], Column], size: int) -> Column:
    """The expression's values on a grid of `size` timestamps. `column(node)`
    gives the values of a leaf - a tag reference - on that grid."""
    with np.errstate(all="ignore"):
        return _eval(node, column, size)


def _eval(node: Node, column: Callable[[Node], Column], size: int) -> Column:
    kind = node["k"]
    if kind == "num":
        return np.full(size, float(node["v"]))
    if kind == "ref":
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
        else:
            out = np.power(a, b)
        return _finite(out)
    if kind == "fn":
        args = [_eval(arg, column, size) for arg in node["args"]]
        name = node["name"]
        if name in SINGLE:
            return _finite(SINGLE[name](args[0]))
        return _finite(_multi(name, np.vstack(args)))
    raise ValueError(f"unknown node kind: {kind}")
