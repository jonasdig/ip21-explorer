"""Calendar periods in local time, for total(expression, period).

A day is midnight to midnight where the plant is, so the day summer time
starts has 23 hours and the day it ends has 25. Hours are stepped in UTC,
which is the same thing for any zone whose offset is a whole number of hours;
days, weeks (Monday first), months and years on the local calendar.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import List

from zoneinfo import ZoneInfo

HOUR_S = 3600.0


def _local(t: float, zone: ZoneInfo) -> datetime:
    return datetime.fromtimestamp(t, zone)


def period_floor(t: float, period: str, zone: ZoneInfo) -> float:
    """The start of the period t falls in, as epoch seconds."""
    if period == "hour":
        local = _local(t, zone)
        return local.replace(minute=0, second=0, microsecond=0).timestamp()
    day = _local(t, zone).date()
    if period == "week":
        day = day - timedelta(days=day.weekday())
    elif period == "month":
        day = day.replace(day=1)
    elif period == "year":
        day = day.replace(month=1, day=1)
    return datetime(day.year, day.month, day.day, tzinfo=zone).timestamp()


def period_next(start: float, period: str, zone: ZoneInfo) -> float:
    """The start of the period after the one starting at `start`."""
    if period == "hour":
        return start + HOUR_S
    day = _local(start, zone).date()
    if period == "day":
        day = day + timedelta(days=1)
    elif period == "week":
        day = day + timedelta(days=7)
    elif period == "month":
        day = (day.replace(day=28) + timedelta(days=4)).replace(day=1)
    elif period == "year":
        day = day.replace(year=day.year + 1, month=1, day=1)
    else:
        raise ValueError(f"unknown period: {period}")
    return datetime(day.year, day.month, day.day, tzinfo=zone).timestamp()


def period_bounds(start: float, end: float, period: str, zone: ZoneInfo) -> List[float]:
    """Boundaries of the whole periods covering [start, end]: the first at or
    before start, the last at or after end."""
    bounds = [period_floor(start, period, zone)]
    while bounds[-1] < end:
        bounds.append(period_next(bounds[-1], period, zone))
    if len(bounds) == 1:
        bounds.append(period_next(bounds[0], period, zone))
    return bounds
