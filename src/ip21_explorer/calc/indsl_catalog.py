"""indsl's toolboxes, read into our own function catalog.

indsl carries what a user interface needs: every toolbox module names itself
in TOOLBOX_NAME and lists the functions meant for one in __cognite__, and each
function is an ordinary typed call over pandas Series with a Google-style
docstring. So the palette is built by reading the library rather than by
keeping a list of our own that would drift out of date.

Functions whose settings cannot be written as a single word - a list, a
timestamp, something of indsl's own - are left out, as are the ones in SKIP.
"""
from __future__ import annotations

import enum
import importlib
import inspect
import math
import logging
import re
import typing
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from .catalog import CHOICE, DURATION, FLAG, NUMBER, TEXT, FunctionSpec, Param

logger = logging.getLogger("ip21_explorer")

# Toolboxes we do not offer:
# - not_listed_operations: Cognite Charts' own aliases of what the other
#   toolboxes already have, untyped and upper-case (ROUND, SG_SMOOTHER).
# - signals: generators of synthetic series, which need dates rather than a
#   tag and have nothing to do with what is on the plot.
SKIP_MODULES = {"not_listed_operations", "signals", "exceptions"}

# Functions that take the right shapes but cannot be run over a plain trend;
# the smoke test in tests/test_indsl.py is what puts names here.
SKIP: Dict[str, str] = {
    "ts_utils.set_timestamps": "writes one series' values as another's timestamps",
    "ts_utils.get_timestamps": "answers with timestamps, not a measurement",
    "ts_utils.union": "joins two series' samples rather than computing anything",
    "resample.reindex_scatter": "for scatter plots, not a trend",
    "resample.reindex_scatter_x": "for scatter plots, not a trend",
}

# Groups whose answer is a flag or a state that holds until the next sample.
STEP_GROUPS = {"Detect", "Data quality"}


def _kind(annotation: Any) -> Optional[str]:
    """What kind of setting an annotation is, or None when it is an input
    series - and False-y "unsupported" as None with series=False."""
    origin, args = typing.get_origin(annotation), typing.get_args(annotation)
    if origin is typing.Literal:
        return CHOICE if all(isinstance(a, str) for a in args) else None
    if origin is typing.Union or str(origin) == "<class 'types.UnionType'>":
        inner = [a for a in args if a is not type(None)]
        if pd.Series in inner:
            return "series"
        if len(inner) == 1:
            return _kind(inner[0])
        return None
    if annotation is pd.Series:
        return "series"
    if annotation is pd.Timedelta:
        return DURATION
    if annotation is bool:
        return FLAG
    if annotation in (int, float):
        return NUMBER
    if annotation is str:
        return TEXT
    if inspect.isclass(annotation) and issubclass(annotation, enum.Enum):
        return CHOICE
    return None


def _choices(annotation: Any) -> Tuple[str, ...]:
    origin, args = typing.get_origin(annotation), typing.get_args(annotation)
    if origin is typing.Literal:
        return tuple(str(a) for a in args)
    if origin is typing.Union or str(origin) == "<class 'types.UnionType'>":
        for inner in args:
            if inner is not type(None):
                found = _choices(inner)
                if found:
                    return found
        return ()
    if inspect.isclass(annotation) and issubclass(annotation, enum.Enum):
        return tuple(str(member.value) for member in annotation)
    return ()


def _default(value: Any, kind: str) -> Any:
    """A default as it would be written in a formula."""
    if value is inspect.Parameter.empty or value is None:
        return None
    if kind == DURATION and isinstance(value, pd.Timedelta):
        return _duration_word(value.total_seconds())
    if isinstance(value, enum.Enum):
        return str(value.value)
    if kind == FLAG:
        return bool(value)
    if kind == NUMBER:
        number = float(value)
        # An infinite default ("no limit") cannot be written in a formula;
        # leaving the setting out means the same thing.
        return number if math.isfinite(number) else None
    return str(value)


def _duration_word(seconds: float) -> str:
    for unit, size in (("d", 86400), ("h", 3600), ("min", 60), ("s", 1)):
        if seconds >= size and seconds % size == 0:
            return f"{int(seconds // size)}{unit}"
    return f"{seconds:g}s"


# "    name: Label. Rest of the sentence." in a Google-style Args section.
ARG_AT = re.compile(r"^\s{4}(\w+)\s*(?:\([^)]*\))?:\s*(.*)$")


def _docs(func: Any) -> Tuple[str, List[str], Dict[str, Tuple[str, str]]]:
    """A function's summary, its remaining prose, and one (label, text) per
    documented argument."""
    doc = inspect.getdoc(func) or ""
    lines = doc.splitlines()
    summary = lines[0].strip().rstrip(".") if lines else ""
    prose: List[str] = []
    args: Dict[str, Tuple[str, str]] = {}
    section, current, buffer = "prose", None, []

    def flush_arg() -> None:
        if current:
            text = " ".join(buffer).strip()
            label, _, rest = text.partition(".")
            args[current] = (label.strip(), rest.strip() or label.strip())

    paragraph: List[str] = []
    for line in lines[1:]:
        stripped = line.strip()
        if stripped in ("Args:", "Returns:", "Raises:", "Examples:", "Note:"):
            flush_arg()
            current, buffer = None, []
            if paragraph:
                prose.append(" ".join(paragraph))
                paragraph = []
            section = "args" if stripped == "Args:" else "other"
            continue
        if section == "prose":
            if stripped:
                paragraph.append(stripped)
            elif paragraph:
                prose.append(" ".join(paragraph))
                paragraph = []
        elif section == "args":
            match = ARG_AT.match(line)
            if match:
                flush_arg()
                current, buffer = match.group(1), [match.group(2)]
            elif stripped and current:
                buffer.append(stripped)
    flush_arg()
    if paragraph:
        prose.append(" ".join(paragraph))
    return summary, prose, args


def _spec(group: str, module_name: str, func_name: str, func: Any) -> Optional[FunctionSpec]:
    try:
        signature = inspect.signature(func)
    except (TypeError, ValueError):
        return None
    inputs, params = 0, []
    summary, prose, documented = _docs(func)
    for parameter in signature.parameters.values():
        if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            return None
        kind = _kind(parameter.annotation)
        if kind is None:
            return None
        if kind == "series":
            if params:  # a series after a setting: we write inputs first
                return None
            inputs += 1
            continue
        label, help_text = documented.get(parameter.name, ("", ""))
        params.append(Param(
            name=parameter.name,
            kind=kind,
            default=_default(parameter.default, kind),
            choices=_choices(parameter.annotation),
            label=label,
            help=help_text,
        ))
    if not inputs:
        return None
    name = f"{module_name}.{func_name}"
    return FunctionSpec(
        name=name,
        group=group,
        inputs=inputs,
        params=tuple(params),
        short=summary,
        long=tuple(prose),
        step=group in STEP_GROUPS,
        call=func,
    )


def indsl_functions() -> List[FunctionSpec]:
    """Every indsl function we can offer, in toolbox order."""
    try:
        import indsl
    except ImportError as exc:  # pragma: no cover - indsl is a dependency
        raise RuntimeError("indsl is not installed; run: pip install -e .") from exc

    specs: List[FunctionSpec] = []
    left_out: List[str] = []
    for module_name in indsl.__all__:
        if module_name in SKIP_MODULES:
            continue
        try:
            module = importlib.import_module(f"indsl.{module_name}")
        except Exception as exc:  # a toolbox whose optional dependency is missing
            logger.warning("indsl.%s is unavailable: %s", module_name, exc)
            continue
        group = getattr(module, "TOOLBOX_NAME", module_name.replace("_", " ").title())
        for func_name in getattr(module, "__cognite__", []) or []:
            func = getattr(module, func_name, None)
            if func is None:
                continue
            name = f"{module_name}.{func_name}"
            if name in SKIP:
                continue
            spec = _spec(group, module_name, func_name, func)
            if spec is None:
                left_out.append(name)
            else:
                specs.append(spec)
    if left_out:
        logger.info("%d indsl functions left out (settings we cannot write): %s",
                    len(left_out), ", ".join(sorted(left_out)))
    return specs
