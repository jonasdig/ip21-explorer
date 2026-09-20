"""The indsl function catalog: what it offers, and that it runs.

The catalog is read out of indsl itself (toolbox names, the __cognite__
lists, signatures and docstrings), so these tests are what notices when a new
version of indsl changes what we offer or how it behaves.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from ip21_explorer.calc.catalog import (
    CHOICE, DURATION, FLAG, NUMBER, TEXT, catalog, find, groups,
)
from ip21_explorer.calc.parser import FormulaError, parse_formula
from ip21_explorer.calc.indsl_catalog import SKIP
from ip21_explorer.calc.run_function import (
    RunError, even_grid, run_function, takes_a_number,
)

KINDS = {NUMBER, DURATION, CHOICE, FLAG, TEXT}
DAY = 24 * 60


def a_day(shape="sine", minutes=DAY):
    """One-minute samples: epoch seconds and values."""
    t = 1_789_689_600 + np.arange(minutes) * 60.0
    x = np.arange(minutes) / minutes
    v = 50 + 10 * np.sin(2 * np.pi * x) + np.sin(37 * np.pi * x)
    if shape == "gap":
        v[minutes // 3:minutes // 2] = np.nan
    return t, v


def test_the_catalog_has_the_toolboxes_grouped():
    names = groups()
    assert names[0] == "Basic"
    assert {"Smooth", "Detect", "Resample", "Statistics", "Operators"} <= set(names)
    assert len(catalog()) > 60


def test_every_spec_is_something_the_editor_can_show():
    for spec in catalog().values():
        assert spec.group and spec.short, spec.name
        assert spec.inputs >= 1, spec.name
        for param in spec.params:
            assert param.kind in KINDS, (spec.name, param.name)
            if param.kind == CHOICE:
                assert param.choices, (spec.name, param.name)
                if param.default is not None:
                    assert param.default in param.choices, (spec.name, param.name)


def test_inputs_are_named_so_a_block_can_tell_them_apart():
    reynolds = find("fluid_dynamics.Re")
    assert reynolds.inputs == 4
    assert [p.name for p in reynolds.input_params] == [
        "velocity", "density", "d_viscosity", "length_scale"]
    assert reynolds.input_params[0].label == "Fluid velocity [m/s]"


def test_labels_are_short_enough_for_a_block():
    """indsl writes a short label on an argument's first line and the
    explanation under it; the label is what the block has room for."""
    for spec in catalog().values():
        for param in tuple(spec.params) + tuple(spec.input_params):
            assert len(param.label) <= 45, (spec.name, param.name, param.label)
            # Sphinx roles and maths are markup, not something to read.
            assert ":math:" not in param.label and "\\" not in param.label, \
                (spec.name, param.name, param.label)
        assert ":math:" not in " ".join((spec.short,) + spec.long), spec.name


def test_known_specs_are_read_out_of_indsl():
    sg = find("smooth.sg")
    assert sg.group == "Smooth" and sg.inputs == 1 and sg.call is not None
    assert [p.name for p in sg.params] == ["window_length", "polyorder"]

    drift = find("detect.drift")
    assert drift.step and drift.inputs == 1
    assert [(p.name, p.kind, p.default) for p in drift.params] == [
        ("long_interval", DURATION, "3d"),
        ("short_interval", DURATION, "4h"),
        ("std_threshold", NUMBER, 3.0),
        ("detect", CHOICE, "both"),
    ]
    assert drift.params[3].choices == ("decrease", "increase", "both")


# -- running them ------------------------------------------------------------

def test_smoothing_keeps_the_shape_but_loses_the_ripple():
    # A slow swing of +/-10 with a five-minute ripple of +/-1 on top.
    t = 1_789_689_600 + np.arange(DAY) * 60.0
    x = np.arange(DAY) / DAY
    swing = 50 + 10 * np.sin(2 * np.pi * x)
    v = swing + np.sin(2 * np.pi * 288 * x)
    out_t, out_v = run_function(find("smooth.sg"), [(t, v)], t, {"window_length": 61})
    assert np.array_equal(out_t, t)
    # The swing survives; the ripple is gone.
    assert np.allclose(out_v[100:-100], swing[100:-100], atol=0.3)


def test_integration_of_a_constant_rate():
    t = 1_789_689_600 + np.arange(25) * 3600.0
    out_t, out_v = run_function(find("ts_utils.trapezoidal_integration"),
                                [(t, np.full(25, 10.0))], t, {"time_unit": 3600.0})
    assert out_v[-1] == pytest.approx(240.0)


def test_a_two_input_function_takes_both_series():
    t, v = a_day()
    spec = find("ts_utils.threshold")
    assert spec.inputs == 1
    both = find("filter.status_flag_filter")
    assert both.inputs == 2
    flag = np.where(np.arange(DAY) < 600, 1.0, 0.0)
    out_t, out_v = run_function(both, [(t, v), (t, flag)], t, {})
    assert len(out_t) and not np.isnan(out_v).all()


def test_an_uneven_grid_is_evened_out_first():
    t = np.array([0.0, 60.0, 120.0, 200.0, 240.0])
    assert len(even_grid(t)) == 5 and even_grid(t)[-1] == 240.0
    assert even_grid(np.array([0.0, 60.0, 120.0])) is not None


def test_indsls_complaint_becomes_the_formulas_error():
    t, v = a_day()
    with pytest.raises(RunError) as info:
        run_function(find("smooth.sg"), [(t, v)], t, {"window_length": 3, "polyorder": 9})
    assert "smooth.sg" in str(info.value)


def test_too_many_points_is_refused_rather_than_run():
    t = np.arange(300_000, dtype=float)
    with pytest.raises(RunError, match="more than it can be asked for"):
        run_function(find("smooth.sg"), [(t, t)], t, {})


# Functions that need data that means something - a status flag, a vessel's
# dimensions, a well's pressures - and say so politely over a plain trend.
# Everything else in the catalog has to work on any series.
DATA_DEPENDENT = {
    "equipment.filled_volume_spherical_head_vessel": "needs a vessel's real dimensions",
    "equipment.filled_volume_torispherical_head_vessel": "needs a vessel's real dimensions",
    "filter.status_flag_filter": "needs a status flag to filter by",
    "oil_and_gas.calculate_shutin_interval": "needs a well that has been shut in",
    "oil_and_gas.calculate_shutin_variable": "needs a shut-in flag",
    "oil_and_gas.calculate_gas_density": "needs pressure, temperature and gravity",
}


def defaults_for(spec):
    """Every setting the function has no default for, filled with something
    harmless, so the call is one a user could have written."""
    filled = {}
    for param in spec.params:
        if not param.required:
            continue
        # 2 rather than 1: a period or an order of 1 is refused by some.
        filled[param.name] = {"number": 2.0, "duration": 3600.0,
                              "flag": False, "text": "linear"}.get(
            param.kind, param.choices[0] if param.choices else 2.0)
    return filled


@pytest.mark.parametrize("name", sorted(n for n, s in catalog().items() if s.call))
@pytest.mark.parametrize("shape", ["sine", "gap"])
def test_every_catalog_function_works_on_a_plain_trend(name, shape):
    """The safety net: with its own defaults over a plain day of data, a
    function in the catalog has to answer with a series. A function that can
    only fail is not one to offer - put it in indsl_catalog.SKIP, or, when it
    needs data that means something, in DATA_DEPENDENT here, with a reason.

    This is the test that would have caught the zone on the timestamps, the
    choices that are not one word, and the settings with no default."""
    spec = find(name)
    # Six hours: enough for every function's own defaults (the longest looks
    # three days back and simply finds nothing), short enough to run the
    # whole catalog in seconds.
    t, v = a_day(shape, minutes=360)
    inputs = [(t, v)] * spec.inputs
    try:
        out_t, out_v = run_function(spec, inputs, t, defaults_for(spec))
    except RunError as exc:
        assert name in DATA_DEPENDENT, f"{name} cannot be run at all: {exc}"
        assert DATA_DEPENDENT[name]
        return
    assert len(out_t) == len(out_v)


# -- a number where a series would do ----------------------------------------

def test_a_number_goes_in_as_a_number_where_the_function_takes_one():
    """Many inputs are written Union[pd.Series, float]: a threshold or the
    value to show when a condition does not hold is a number, not a trend."""
    t, v = a_day(minutes=120)
    check = find("ts_utils.logical_check")
    assert [takes_a_number(check, i) for i in range(4)] == [True] * 4
    out_t, out_v = run_function(check, [(t, v), (t, v + 5), 1.0, 0.0], t,
                                {"operation": "smaller_than"})
    # v is always smaller than v + 5, so every point is the true value.
    assert len(out_t) == len(t) and np.allclose(out_v, 1.0)


def test_a_number_becomes_a_flat_series_for_an_input_that_only_takes_series():
    t, v = a_day(minutes=120)
    flag_filter = find("filter.status_flag_filter")
    assert not takes_a_number(flag_filter, 1)
    out_t, out_v = run_function(flag_filter, [(t, v), 0.0], t, {})
    assert len(out_t) == len(t) and out_v[0] == pytest.approx(v[0])


def test_a_formula_may_wire_a_number_into_a_function():
    from ip21_explorer.calc import compute
    from ip21_explorer.sources.simulator import SimulatorSource

    refs = {name: {"tag": name, "sample": "INT", "interval": "60"}
            for name in ("TI-101", "PI-103")}
    items = [
        {"id": "check", "refs": refs,
         "expr": "=ts_utils.logical_check([TI-101], [PI-103], 1, 0, greater_than)"},
        {"id": "head", "refs": refs,
         "expr": "=equipment.total_head([TI-101], [PI-103], 1000)"},
        {"id": "numbers", "refs": refs,
         "expr": "=ts_utils.logical_check(1, 2, 3, 4) + [TI-101] * 0"},
    ]
    out = compute(SimulatorSource(), items, 1_789_689_600, 1_789_689_600 + 3600)
    assert out["check"].error is None and len(out["check"].t) == 61
    assert set(np.unique(out["check"].v)) <= {0.0, 1.0}
    assert out["head"].error is None and len(out["head"].t) == 61
    # Nothing to draw against when every input is a number.
    assert out["numbers"].error == (
        "ts_utils.logical_check needs at least one input with data", True)


@pytest.mark.parametrize("name", sorted(
    n for n, s in catalog().items()
    if s.call and any(takes_a_number(s, i) for i in range(s.inputs))))
def test_number_accepting_inputs_work_as_numbers(name):
    """Every input a function will take a number for, given a number."""
    spec = find(name)
    t, v = a_day(minutes=360)
    inputs = [2.0 if takes_a_number(spec, i) else (t, v) for i in range(spec.inputs)]
    if all(not isinstance(given, tuple) for given in inputs):
        inputs[0] = (t, v)          # one input has to carry the time axis
    try:
        out_t, out_v = run_function(spec, inputs, t, defaults_for(spec))
    except RunError as exc:
        assert name in DATA_DEPENDENT, f"{name} cannot take a number: {exc}"
        return
    assert len(out_t) == len(out_v)


def test_skipped_functions_say_why():
    assert all(reason for reason in SKIP.values())


# -- the three faults that made functions unusable ---------------------------

def test_a_choice_with_spaces_is_written_as_one_word():
    operation = find("ts_utils.logical_check").params[0]
    assert "greater_than" in operation.choices
    assert operation.value_of("greater_than") == "Greater than"
    assert operation.default == "equality"
    from ip21_explorer.calc.catalog import as_json
    shown = next(f for g in as_json()["groups"] for f in g["functions"]
                 if f["name"] == "ts_utils.logical_check")
    assert shown["params"][0]["choiceLabels"]["greater_than"] == "Greater than"


def test_logical_check_runs_with_a_word_choice():
    t, v = a_day(minutes=360)
    high = (t, v + 5)
    out_t, out_v = run_function(find("ts_utils.logical_check"),
                                [(t, v), high, (t, np.ones(len(t))), (t, np.zeros(len(t)))],
                                t, {"operation": "greater_than"})
    # v is never greater than v + 5, so the answer is the false value.
    assert len(out_t) == len(t) and np.allclose(out_v, 0.0)


def test_a_setting_without_a_default_is_required():
    roughness = find("fluid_dynamics.Haaland").params[0]
    assert roughness.required
    with pytest.raises(FormulaError, match="fluid_dynamics.Haaland needs roughness"):
        parse_formula("=fluid_dynamics.Haaland([A])")
    assert parse_formula("=fluid_dynamics.Haaland([A], 0.0001)").node["params"] == {
        "roughness": 0.0001}


def test_timestamps_reach_the_library_without_a_zone():
    """Several indsl functions turn the index into numpy, which a zone-aware
    index cannot become."""
    from ip21_explorer.calc.run_function import to_pandas

    series = to_pandas(np.array([1_789_689_600.0, 1_789_689_660.0]), np.array([1.0, 2.0]))
    assert series.index.tz is None
    assert str(series.index[0]) == "2026-09-18 00:00:00"


# -- through a formula -------------------------------------------------------

def test_a_formula_calls_the_library_and_can_be_built_on():
    from ip21_explorer.calc import compute
    from ip21_explorer.sources.simulator import SimulatorSource

    tag = {"tag": "TI-101", "sample": "INT", "interval": "60"}
    items = [
        {"id": "raw", "expr": "=[TI-101] * 1", "refs": {"TI-101": tag}},
        {"id": "smooth", "expr": "=smooth.sg([TI-101], 61, 2)", "refs": {"TI-101": tag}},
        {"id": "off", "expr": "=[TI-101] - [s]",
         "refs": {"TI-101": tag, "s": {"formula": "smooth"}}},
        {"id": "flag", "expr": "=detect.drift([TI-101], 3d, 4h)", "refs": {"TI-101": tag}},
    ]
    out = compute(SimulatorSource(), items, 1_789_689_600, 1_789_689_600 + 6 * 3600)
    assert all(result.error is None for result in out.values()), \
        {k: r.error for k, r in out.items() if r.error}
    assert np.array_equal(out["smooth"].t, out["raw"].t)
    # Smoothing moves the trace but keeps its level.
    assert not np.allclose(out["smooth"].v, out["raw"].v)
    assert abs(np.nanmean(out["off"].v)) < 0.5
    # A detector answers with a flag, drawn as steps.
    assert out["flag"].step
    assert set(np.unique(out["flag"].v[~np.isnan(out["flag"].v)])) <= {0.0, 1.0}


def test_a_bad_setting_only_marks_its_own_row():
    from ip21_explorer.calc import compute
    from ip21_explorer.sources.simulator import SimulatorSource

    tag = {"tag": "TI-101", "sample": "INT", "interval": "60"}
    items = [
        {"id": "good", "expr": "=smooth.sma([TI-101], 10min)", "refs": {"TI-101": tag}},
        {"id": "bad", "expr": "=smooth.sg([TI-101], 3, 9)", "refs": {"TI-101": tag}},
    ]
    out = compute(SimulatorSource(), items, 1_789_689_600, 1_789_689_600 + 3600)
    assert out["good"].error is None
    text, hard = out["bad"].error
    assert hard and text.startswith("smooth.sg:")
