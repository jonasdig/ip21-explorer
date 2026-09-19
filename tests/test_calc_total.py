"""total(expression, period): quantities and hours per calendar period."""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pytest

from ip21_explorer.calc import compute
from ip21_explorer.calc.engine import sum_periods, total_window, Window
from ip21_explorer.sources.base import SampleType

OSLO = ZoneInfo("Europe/Oslo")


def local(*parts):
    return datetime(*parts, tzinfo=OSLO).timestamp()


class Synthetic:
    """AVG buckets of a function of time, like the historian would give."""

    def __init__(self, signal):
        self.signal = signal
        self.reads = []

    def read(self, tags, start, end, sample_type, interval_s):
        self.reads.append((sample_type, interval_s, start, end))
        n = int(round((end - start) / interval_s))
        t = start + np.arange(n) * interval_s
        # The mean of a few points across each bucket, standing in for the
        # historian's time-weighted average.
        sub = (np.arange(12) + 0.5) / 12 * interval_s
        values = self.signal((t[:, None] + sub[None, :]).ravel()).reshape(n, 12).mean(axis=1)
        return {tag: (t, values) for tag in tags}


def run(source, expr, start, end, now=None):
    item = {"id": "f", "expr": expr,
            "refs": {"FI-1": {"tag": "FI-1", "sample": "INT", "interval": "auto"}}}
    return compute(source, [item], start, end, timezone="Europe/Oslo",
                   now=now if now is not None else end + 86400 * 400)["f"]


def by_start(result):
    return dict(zip(result.t[:-1].tolist(), result.v[:-1].tolist()))


def test_a_constant_rate_totals_to_rate_times_hours_per_day():
    source = Synthetic(lambda t: np.full(len(t), 10.0))
    result = run(source, "=total([FI-1], day)", local(2026, 9, 1, 6), local(2026, 9, 3, 18))
    assert result.step and result.error is None
    days = by_start(result)
    assert list(days) == [local(2026, 9, 1), local(2026, 9, 2), local(2026, 9, 3)]
    assert list(days.values()) == pytest.approx([240.0, 240.0, 240.0])
    # Read as time-weighted averages, over whole days.
    sample, interval, start, end = source.reads[0]
    assert sample == SampleType.AVG and interval == 60
    assert (start, end) == (local(2026, 9, 1), local(2026, 9, 4))


def test_the_days_summer_time_starts_and_ends_have_23_and_25_hours():
    source = Synthetic(lambda t: np.full(len(t), 10.0))
    spring = by_start(run(source, "=total([FI-1], day)", local(2026, 3, 29, 1), local(2026, 3, 29, 23)))
    assert spring[local(2026, 3, 29)] == pytest.approx(230.0)
    autumn = by_start(run(source, "=total([FI-1], day)", local(2026, 10, 25, 1), local(2026, 10, 25, 23)))
    assert autumn[local(2026, 10, 25)] == pytest.approx(250.0)


def test_hours_above_a_limit_from_a_comparison():
    # On for the first 6 hours of every local day (00-06), off otherwise.
    def pump(t):
        hour = np.array([datetime.fromtimestamp(x, OSLO).hour for x in t])
        return np.where(hour < 6, 50.0, 0.0)

    result = run(Synthetic(pump), "=total([FI-1] > 5, day)", local(2026, 9, 1), local(2026, 9, 4))
    assert list(by_start(result).values()) == pytest.approx([6.0, 6.0, 6.0])


def test_months_and_years():
    source = Synthetic(lambda t: np.full(len(t), 1.0))
    months = by_start(run(source, "=total([FI-1], month)", local(2026, 1, 15), local(2026, 3, 2)))
    assert list(months.values()) == pytest.approx([31 * 24, 28 * 24, 31 * 24 - 1])  # March loses an hour
    years = run(source, "=total([FI-1], year)", local(2025, 6, 1), local(2026, 6, 1))
    assert list(by_start(years).values()) == pytest.approx([8760.0, 8760.0])
    # Two whole years at a minute would be a million points: the interval
    # coarsens to the finest that stays under 50 000.
    assert source.reads[-1][1] == 1800


def test_the_current_period_stops_at_now():
    source = Synthetic(lambda t: np.full(len(t), 10.0))
    now = local(2026, 9, 2, 12)
    result = run(source, "=total([FI-1], day)", local(2026, 9, 1), now, now=now)
    assert list(by_start(result).values()) == pytest.approx([240.0, 120.0])
    assert result.t[-1] == now


def test_a_period_without_data_is_a_hole():
    t = np.array([0.0, 60.0])
    edges, sums = sum_periods(t, np.array([1.0, np.nan]), 60.0, [0.0, 3600.0, 7200.0])
    assert sums[0] == pytest.approx(1 / 60) and np.isnan(sums[1])
    assert edges.tolist() == [0.0, 3600.0, 7200.0]


def test_totals_combine_with_arithmetic_and_formulas():
    source = Synthetic(lambda t: np.full(len(t), 10.0))
    result = run(source, "=total([FI-1], day) / 1000", local(2026, 9, 1), local(2026, 9, 2))
    assert by_start(result)[local(2026, 9, 1)] == pytest.approx(0.24)
    assert result.step


def test_total_window_interval_choice():
    window = Window(local(2026, 1, 1), local(2026, 1, 20))
    inner, bounds = total_window(window, "day", OSLO, now=local(2027, 1, 1))
    # 19 days, ending on a midnight: 20 boundaries.
    assert inner.interval_s == 60 and inner.sample == "AVG" and len(bounds) == 20


def test_resolution_is_the_formulas_choice():
    # On for the first 30 minutes of every hour.
    def half_hours(t):
        minute = (t % 3600) / 60
        return np.where(minute < 30, 50.0, 0.0)

    fine = Synthetic(half_hours)
    by_minute = run(fine, "=total([FI-1] > 5, day, 1min)", local(2026, 9, 1), local(2026, 9, 2))
    assert by_start(by_minute)[local(2026, 9, 1)] == pytest.approx(12.0)
    assert fine.reads[0][1] == 60

    coarse = Synthetic(half_hours)
    by_hour = run(coarse, "=total([FI-1] > 5, day, 1h)", local(2026, 9, 1), local(2026, 9, 2))
    # Hourly averages are 25: every hour counts as a whole one above 5.
    assert by_start(by_hour)[local(2026, 9, 1)] == pytest.approx(24.0)
    assert coarse.reads[0][1] == 3600

    # For a quantity the resolution makes no difference.
    flow = run(Synthetic(half_hours), "=total([FI-1], day, 1h)", local(2026, 9, 1), local(2026, 9, 2))
    assert by_start(flow)[local(2026, 9, 1)] == pytest.approx(600.0)


def test_a_resolution_too_fine_for_the_window_is_coarsened():
    window = Window(local(2021, 1, 1), local(2026, 1, 1))
    inner, _ = total_window(window, "day", OSLO, now=local(2027, 1, 1), resolution="1min")
    assert inner.interval_s == 3600
    inner, _ = total_window(Window(local(2026, 1, 1), local(2026, 1, 3)), "day", OSLO,
                            now=local(2027, 1, 1), resolution="15min")
    assert inner.interval_s == 900
