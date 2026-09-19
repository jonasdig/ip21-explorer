"""The Python formula engine: parser, alignment, evaluation and caching."""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from ip21_explorer.calc import CachedSource, FormulaError, compute, parse_formula
from ip21_explorer.calc.align import align_onto, median_step, sample_at
from ip21_explorer.sources.base import SampleType
from ip21_explorer.sources.simulator import SimulatorSource

FIXTURES = Path(__file__).parent / "fixtures"
CASES = json.loads((FIXTURES / "formula_cases.json").read_text(encoding="utf-8"))
JS_REFERENCE = json.loads((FIXTURES / "js_reference.json").read_text(encoding="utf-8"))


# -- parser ------------------------------------------------------------------

@pytest.mark.parametrize("case", CASES["ok"], ids=lambda c: c["text"])
def test_parser_reads_shared_cases(case):
    assert parse_formula(case["text"]).refs == case["refs"]


@pytest.mark.parametrize("case", CASES["error"], ids=lambda c: c["text"])
def test_parser_rejects_shared_cases_with_the_browsers_words(case):
    with pytest.raises(FormulaError) as info:
        parse_formula(case["text"])
    assert str(info.value) == case["error"]


def test_parser_precedence():
    # Unary minus binds tighter than ^; ^ is right-associative.
    assert parse_formula("=-[A]^2").node == {
        "k": "bin", "op": "^",
        "a": {"k": "neg", "a": {"k": "ref", "ref": "A", "bare": False}},
        "b": {"k": "num", "v": 2.0},
    }
    node = parse_formula("=2^3^2 + [A]").node
    assert node["op"] == "+" and node["a"]["b"]["op"] == "^"


def test_bare_names_are_remembered_for_the_subtraction_hint():
    assert parse_formula("=TI-101-TI-201").bare == {"TI-101-TI-201"}


# -- alignment ---------------------------------------------------------------

def test_sample_at_interpolates_holds_and_respects_holes():
    ts = np.array([0.0, 10.0, 20.0, 60.0])
    vs = np.array([0.0, 10.0, np.nan, 100.0])
    at = np.array([-1.0, 0.0, 5.0, 15.0, 30.0, 60.0, 61.0])
    got = sample_at(ts, vs, at, hold=False, max_gap=30.0)
    assert np.allclose(got, [np.nan, 0.0, 5.0, np.nan, np.nan, 100.0, np.nan], equal_nan=True)
    held = sample_at(ts, vs, np.array([5.0, 15.0]), hold=True, max_gap=30.0)
    assert np.allclose(held, [0.0, 10.0])


def test_median_step_is_the_upper_median():
    assert median_step(np.array([0.0, 1.0, 3.0, 6.0, 10.0])) == 3.0


def test_an_input_owning_the_grid_passes_through():
    ts = np.array([0.0, 1.0])
    vs = np.array([1.0, np.nan])
    assert align_onto([(ts, vs, False)], ts)[0] is vs


# -- the numbers the browser used to compute -----------------------------------

class RoundedSource:
    """The simulator as the browser saw it: values rounded like /api/data."""

    def __init__(self):
        self.sim = SimulatorSource()

    def read(self, tags, start, end, sample_type, interval_s):
        out = self.sim.read(tags, start, end, sample_type, interval_s)
        return {tag: (t, np.round(v, 6)) for tag, (t, v) in out.items()}


def _reference_items(text, step_pi):
    parsed = parse_formula(text)
    refs = {}
    for ref in parsed.refs:
        sample, interval = JS_REFERENCE["specs"][ref]
        refs[ref] = {"tag": ref, "sample": sample, "interval": interval,
                     "step": step_pi and ref == "PI-103"}
    return [{"id": "f", "expr": text, "refs": refs}]


def _times(spec):
    return [spec["from"] + i * spec["every"] for i in range(spec["count"])]


@pytest.mark.parametrize("section", ["grid", "between"])
def test_results_match_the_browsers_old_evaluator(section):
    times = _times(JS_REFERENCE[f"{section}_times"])
    source = RoundedSource()
    for text, step_pi, expected in JS_REFERENCE[section]:
        result = compute(source, _reference_items(text, step_pi),
                         JS_REFERENCE["start"], JS_REFERENCE["end"])["f"]
        at = dict(zip(result.t.tolist(), result.v.tolist()))
        for t, want in zip(times, expected):
            got = at.get(t)
            label = f"{text} step={step_pi} t={t}"
            if want is None:
                assert got is None or math.isnan(got), label
            else:
                assert got == pytest.approx(want, rel=1e-9), label


# -- engine behaviour --------------------------------------------------------

def _tag(name, **extra):
    spec = {"tag": name, "sample": "INT", "interval": "60"}
    spec.update(extra)
    return spec


def test_a_formula_can_use_another():
    sim = SimulatorSource()
    items = [
        {"id": "a", "expr": "=[TI-101] * 2", "refs": {"TI-101": _tag("TI-101")}},
        {"id": "b", "expr": "=[twice] + 1", "refs": {"twice": {"formula": "a"}}},
    ]
    out = compute(sim, items, 1_789_689_600, 1_789_693_200)
    assert np.allclose(out["b"].v, out["a"].v + 1)


def test_one_unknown_tag_only_fails_its_own_formula():
    sim = SimulatorSource()
    items = [
        {"id": "good", "expr": "=[TI-101] + 1", "refs": {"TI-101": _tag("TI-101")}},
        {"id": "bad", "expr": "=[XX-999] + 1", "refs": {"XX-999": _tag("XX-999")}},
    ]
    out = compute(sim, items, 1_789_689_600, 1_789_693_200)
    assert out["good"].error is None and len(out["good"].t) == 61
    text, hard = out["bad"].error
    assert hard and "XX-999" in text


def test_parse_errors_and_cycles_are_reported_per_item():
    sim = SimulatorSource()
    items = [
        {"id": "p", "expr": "=[A] +", "refs": {}},
        {"id": "x", "expr": "=[y] + 1", "refs": {"y": {"formula": "y"}}},
        {"id": "y", "expr": "=[x] + 1", "refs": {"x": {"formula": "x"}}},
    ]
    out = compute(sim, items, 1_789_689_600, 1_789_693_200)
    assert out["p"].error == ("the expression ends too early", True)
    assert "circular" in out["y"].error[0] or "circular" in out["x"].error[0]


def test_bare_name_hint_in_errors():
    sim = SimulatorSource()
    items = [{"id": "f", "expr": "=TI-101-TI-201",
              "refs": {"TI-101-TI-201": _tag("TI-101-TI-201")}}]
    text, _ = compute(sim, items, 1_789_689_600, 1_789_693_200)["f"].error
    assert text.endswith("to subtract, write [TI] - [101] - [TI] - [201]")


# -- cache -------------------------------------------------------------------

class CountingSource:
    def __init__(self):
        self.sim = SimulatorSource()
        self.calls = []

    def read(self, tags, start, end, sample_type, interval_s):
        self.calls.append(list(tags))
        return self.sim.read(tags, start, end, sample_type, interval_s)


def test_cache_asks_only_for_what_it_has_not_seen():
    counting = CountingSource()
    cached = CachedSource(counting)
    args = (1_789_689_600, 1_789_693_200, SampleType.INT, 60.0)
    first = cached.read(["TI-101", "PI-103"], *args)
    again = cached.read(["TI-101", "FI-104"], *args)
    assert counting.calls == [["TI-101", "PI-103"], ["FI-104"]]
    assert again["TI-101"] is first["TI-101"]


def test_cache_lets_an_unknown_tag_raise():
    cached = CachedSource(CountingSource())
    with pytest.raises(KeyError):
        cached.read(["XX-999"], 1_789_689_600, 1_789_693_200, SampleType.INT, 60.0)
