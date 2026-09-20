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
from ip21_explorer.calc.indsl_catalog import SKIP
from ip21_explorer.calc.run_function import RunError, even_grid, run_function

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
    out_t, out_v = run_function(find("smooth.sg"), [(t, v)], {"window_length": 61})
    assert np.array_equal(out_t, t)
    # The swing survives; the ripple is gone.
    assert np.allclose(out_v[100:-100], swing[100:-100], atol=0.3)


def test_integration_of_a_constant_rate():
    t = 1_789_689_600 + np.arange(25) * 3600.0
    out_t, out_v = run_function(find("ts_utils.trapezoidal_integration"),
                                [(t, np.full(25, 10.0))], {"time_unit": 3600.0})
    assert out_v[-1] == pytest.approx(240.0)


def test_a_two_input_function_takes_both_series():
    t, v = a_day()
    spec = find("ts_utils.threshold")
    assert spec.inputs == 1
    both = find("filter.status_flag_filter")
    assert both.inputs == 2
    flag = np.where(np.arange(DAY) < 600, 1.0, 0.0)
    out_t, out_v = run_function(both, [(t, v), (t, flag)], {})
    assert len(out_t) and not np.isnan(out_v).all()


def test_an_uneven_grid_is_evened_out_first():
    t = np.array([0.0, 60.0, 120.0, 200.0, 240.0])
    assert len(even_grid(t)) == 5 and even_grid(t)[-1] == 240.0
    assert even_grid(np.array([0.0, 60.0, 120.0])) is not None


def test_indsls_complaint_becomes_the_formulas_error():
    t, v = a_day()
    with pytest.raises(RunError) as info:
        run_function(find("smooth.sg"), [(t, v)], {"window_length": 3, "polyorder": 9})
    assert "smooth.sg" in str(info.value)


def test_too_many_points_is_refused_rather_than_run():
    t = np.arange(300_000, dtype=float)
    with pytest.raises(RunError, match="more than it can be asked for"):
        run_function(find("smooth.sg"), [(t, t)], {})


@pytest.mark.parametrize("name", sorted(n for n, s in catalog().items() if s.call))
@pytest.mark.parametrize("shape", ["sine", "gap"])
def test_every_catalog_function_runs_or_complains_politely(name, shape):
    """The safety net: with its own defaults over a plain day of data, a
    function must answer with a series or say what is wrong. Anything else
    (a crash, an answer of the wrong type) means it does not belong in the
    catalog - put it in indsl_catalog.SKIP with a reason."""
    spec = find(name)
    # Six hours: enough for every function's own defaults (the longest looks
    # three days back and simply finds nothing), short enough to run the
    # whole catalog in seconds.
    t, v = a_day(shape, minutes=360)
    inputs = [(t, v)] * spec.inputs
    try:
        out_t, out_v = run_function(spec, inputs, {})
    except RunError as exc:
        assert name in str(exc) or "failed" in str(exc)
        return
    assert len(out_t) == len(out_v)


def test_skipped_functions_say_why():
    assert all(reason for reason in SKIP.values())


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
