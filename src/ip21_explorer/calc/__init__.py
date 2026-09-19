"""Formula computation, independent of the web app.

The web app calls it for formula rows; a service without a browser (one that
watches a condition and raises an alarm) can call it the same way.
"""
from .cache import CachedSource
from .engine import Result, auto_interval, compute
from .parser import FormulaError, is_formula, parse_formula

__all__ = [
    "CachedSource", "FormulaError", "Result", "auto_interval", "compute",
    "is_formula", "parse_formula",
]
