"""Every function a formula may call, ours and indsl's, in one table.

The parser checks calls against it, the engine runs them, and the browser
builds the block editor's palette and help from it - so a function exists in
exactly one place, whichever side is asking.

A call is written with its inputs first and its settings after:

    =smooth.sg([TI-101], 61, 3)
    =detect.drift([TI-101], 3d, 4h, 3, both)

Inputs are expressions; settings are single words - a number, a duration
(30min, 4h, 3d), a choice, or true/false - and the ones at the end may be
left out to keep their defaults.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

BASIC = "Basic"

# A setting's kind, and how its word is read.
NUMBER, DURATION, CHOICE, FLAG, TEXT = "number", "duration", "choice", "flag", "text"

DURATION_AT = re.compile(r"^(\d+(?:\.\d+)?)(ms|s|min|h|d|w)$", re.IGNORECASE)
DURATION_S = {"ms": 0.001, "s": 1.0, "min": 60.0, "h": 3600.0, "d": 86400.0, "w": 604800.0}
TRUE_WORDS = {"true", "yes", "on", "1"}
FALSE_WORDS = {"false", "no", "off", "0"}


class ArgumentError(ValueError):
    """A setting that cannot be read; the message is meant for the user."""


@dataclass(frozen=True)
class Param:
    name: str
    kind: str
    default: Any = None
    choices: Tuple[str, ...] = ()
    label: str = ""          # the docstring's own words for it
    help: str = ""


@dataclass(frozen=True)
class FunctionSpec:
    name: str                # "avg", "smooth.sg"
    group: str               # the palette's heading
    inputs: int              # how many series go in
    params: Tuple[Param, ...] = ()
    short: str = ""
    long: Tuple[str, ...] = ()
    # Set for functions whose answer holds between samples (a 0/1 flag, a
    # value per period): drawn as steps, and read as held.
    step: bool = False
    # What runs it: for indsl, the function itself; our own are built into
    # the evaluator and leave this empty.
    call: Optional[Callable[..., Any]] = None
    # A many-input function of ours (min/max/avg) takes any number.
    variadic: bool = False

    def param(self, name: str) -> Optional[Param]:
        return next((p for p in self.params if p.name == name), None)


def read_word(spec: FunctionSpec, param: Param, word: str) -> Any:
    """One setting's word to its value, or ArgumentError saying what was wrong."""
    def wrong(expected: str) -> ArgumentError:
        return ArgumentError(f"{spec.name}: {param.name} expects {expected}, got \"{word}\"")

    if param.kind == NUMBER:
        try:
            return float(word)
        except ValueError:
            raise wrong("a number") from None
    if param.kind == DURATION:
        match = DURATION_AT.match(word)
        if not match:
            raise wrong("a duration like 30min, 4h or 3d")
        return float(match.group(1)) * DURATION_S[match.group(2).lower()]
    if param.kind == FLAG:
        if word.lower() in TRUE_WORDS:
            return True
        if word.lower() in FALSE_WORDS:
            return False
        raise wrong("true or false")
    if param.kind == CHOICE:
        if word not in param.choices:
            raise ArgumentError(
                f"{spec.name}: {param.name} must be one of {', '.join(param.choices)}"
            )
        return word
    return word  # TEXT: a word is a word


# -- our own functions --------------------------------------------------------

PERIODS = ("hour", "day", "week", "month", "year")
RESOLUTIONS = ("auto", "1min", "5min", "15min", "1h")
RESOLUTION_S = {"1min": 60.0, "5min": 300.0, "15min": 900.0, "1h": 3600.0, "auto": None}

_HOLES = ("Inputs with no value at a moment are left out, so a gap in one tag does "
          "not blank the result.")

BUILTINS: Tuple[FunctionSpec, ...] = (
    FunctionSpec("abs", BASIC, 1, short="The value without its sign"),
    FunctionSpec("sqrt", BASIC, 1, short="Square root",
                 long=("Negative values have no square root and leave a gap.",)),
    FunctionSpec("ln", BASIC, 1, short="Natural logarithm",
                 long=("Zero and negative values have no logarithm and leave a gap.",)),
    FunctionSpec("log10", BASIC, 1, short="Base-10 logarithm",
                 long=("Zero and negative values have no logarithm and leave a gap.",)),
    FunctionSpec("exp", BASIC, 1, short="e to the power of the input"),
    FunctionSpec("round", BASIC, 1, short="Round to a whole number",
                 long=("Halves round up: 2.5 becomes 3, and -2.5 becomes -2.",)),
    FunctionSpec("min", BASIC, 1, short="The smallest of the inputs",
                 long=(_HOLES,), variadic=True),
    FunctionSpec("max", BASIC, 1, short="The largest of the inputs",
                 long=(_HOLES,), variadic=True),
    FunctionSpec("avg", BASIC, 1, short="The average of the inputs, at each moment",
                 long=(_HOLES,), variadic=True),
    FunctionSpec(
        "total", BASIC, 1,
        params=(
            Param("period", CHOICE, "day", PERIODS, "Period",
                  "The calendar period to sum over, in local time."),
            Param("resolution", CHOICE, "auto", RESOLUTIONS, "Resolution",
                  "How finely the input is read, as averages over this interval."),
        ),
        short="Sum per hour, day, week, month or year of a rate per hour",
        long=(
            "Reads the input as a rate per hour and adds it up over each calendar "
            "period, drawn as one step per period. A flow in m3/h becomes m3 per day; "
            "a comparison (1 or 0) becomes the hours it held. A rate per second needs "
            "x 3600 first.",
            "Periods follow the local calendar: the day summer time starts has 23 "
            "hours, the day it ends 25. Weeks start on Monday. A period that began "
            "before the plot's window is counted whole, and the current one is the "
            "total so far.",
            "Auto resolution reads 1-minute averages for windows up to about a month "
            "and coarser ones beyond. For a quantity it hardly matters; for a "
            "comparison it does - read per 1h, an hour counts whole or not at all.",
        ),
        step=True,
    ),
)


# -- the whole catalog --------------------------------------------------------

_catalog: Dict[str, FunctionSpec] = {}
_groups: List[str] = []


def _build() -> None:
    from .indsl_catalog import indsl_functions  # imported late: it is the slow part

    specs: List[FunctionSpec] = list(BUILTINS) + list(indsl_functions())
    _catalog.clear()
    _groups.clear()
    for spec in specs:
        _catalog[spec.name] = spec
        if spec.group not in _groups:
            _groups.append(spec.group)


def catalog() -> Dict[str, FunctionSpec]:
    """Every function by name, built on first use."""
    if not _catalog:
        _build()
    return _catalog


def find(name: str) -> Optional[FunctionSpec]:
    return catalog().get(name)


def groups() -> List[str]:
    """Group names in palette order: ours first, then indsl's toolboxes."""
    catalog()
    return list(_groups)


def as_json() -> Dict[str, Any]:
    """The catalog as the browser reads it: the parser's rules, the palette's
    groups, and the help behind each block."""
    by_group: Dict[str, List[Dict[str, Any]]] = {group: [] for group in groups()}
    for spec in catalog().values():
        by_group[spec.group].append({
            "name": spec.name,
            "inputs": spec.inputs,
            "variadic": spec.variadic,
            "step": spec.step,
            "short": spec.short,
            "long": list(spec.long),
            "params": [{
                "name": p.name,
                "kind": p.kind,
                "default": p.default,
                "choices": list(p.choices),
                "label": p.label,
                "help": p.help,
            } for p in spec.params],
        })
    return {"groups": [{"name": group, "functions": by_group[group]} for group in groups()]}
