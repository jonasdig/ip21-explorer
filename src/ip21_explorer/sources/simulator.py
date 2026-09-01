"""Deterministic process-trend simulator used for development without IP21 access.

Every signal is a pure function of (tag name, map, time), so repeated reads of
the same range return identical data and zooming behaves like a real historian.

Tags follow the IP21 convention "TAG" or "TAG;MAP": controller tags (TIC/FIC)
expose the maps CA_I PV (default), CA_I SP and CA_I OUTPUT, other tags a single
default map (IP_AnalogMap).
"""
from __future__ import annotations

import time
import zlib
from typing import Dict, List, Tuple

import numpy as np

from .base import MapInfo, SampleType, Series, TagInfo, matches_terms, query_terms

TWO_PI = 2.0 * np.pi

# Hard limits so a bad request cannot allocate unbounded memory.
MAX_POINTS = 200_000
MAX_FINE_POINTS = 2_000_000

# Setpoints are held constant within blocks of this many seconds.
SP_HOLD_S = 2.0 * 3600.0

_CONTROLLER_PREFIXES = {"TIC", "FIC"}

_RANGES = {
    "TI": (0.0, 250.0),
    "TIC": (0.0, 250.0),
    "PI": (0.0, 12.0),
    "FI": (0.0, 400.0),
    "FIC": (0.0, 400.0),
    "LI": (0.0, 100.0),
    "AI": (0.0, 25.0),
    "SI": (0.0, 3600.0),
    "JI": (0.0, 900.0),
    "ZI": (0.0, 100.0),
}


def _hash01(x: np.ndarray) -> np.ndarray:
    """Deterministic pseudo-random values in [0, 1) (GLSL-style hash)."""
    return (np.sin(x) * 43758.5453123) % 1.0


# Real IP21 tags carry far more maps than anyone uses, which is what the
# favourite-maps feature exists for; the simulator mirrors that spread so the
# behaviour is visible without a live historian. Order matters: the first entry
# is the default map, addressed by the bare tag name.
_CONTROLLER_EXTRA_MAPS = (
    ("CA_I MODE", ""),
    ("CA_I HI_LIM", None),
    ("CA_I LO_LIM", None),
    ("CA_I DEVIATION", None),
    ("CA_I GAIN", ""),
    ("CA_I RESET", "s"),
    ("CA_I RATE", "s"),
    ("CA_I FILTER", "s"),
    ("CA_I ALARM_STATE", ""),
    ("CA_I QUALITY", ""),
    ("IP_ANALOGMAP", None),
    ("IP_TREND_TIME", ""),
)

_ANALOG_EXTRA_MAPS = (
    ("IP_ALARM_STATE", ""),
    ("IP_HI_LIM", None),
    ("IP_LO_LIM", None),
    ("IP_QUALITY", ""),
    ("IP_TREND_TIME", ""),
)


def _maps_for(prefix: str, unit: str) -> Tuple[MapInfo, ...]:
    """Record maps of a tag, default first. `None` means "same unit as the tag"."""
    if prefix in _CONTROLLER_PREFIXES:
        base = (
            MapInfo(name="CA_I PV", unit=unit),
            MapInfo(name="CA_I SP", unit=unit),
            MapInfo(name="CA_I OUTPUT", unit="%"),
        )
        extra = _CONTROLLER_EXTRA_MAPS
    else:
        base = (MapInfo(name="IP_AnalogMap", unit=unit),)
        extra = _ANALOG_EXTRA_MAPS
    return base + tuple(
        MapInfo(name=name, unit=unit if map_unit is None else map_unit)
        for name, map_unit in extra
    )


def _build_catalog() -> List[TagInfo]:
    areas = [
        (100, "Reactor A"),
        (200, "Reactor B"),
        (300, "Distillation column"),
        (400, "Compressor train"),
        (500, "Utilities"),
    ]
    # (prefix, description template, unit)
    instruments = [
        ("TI", "{area} temperature", "degC"),
        ("TIC", "{area} temperature controller", "degC"),
        ("PI", "{area} pressure", "barg"),
        ("FI", "{area} flow", "m3/h"),
        ("FIC", "{area} flow controller", "m3/h"),
        ("LI", "{area} level", "%"),
        ("AI", "{area} analyzer O2", "%"),
        ("SI", "{area} motor speed", "rpm"),
        ("JI", "{area} motor power", "kW"),
        ("ZI", "{area} valve position", "%"),
    ]
    catalog: List[TagInfo] = []
    for area_no, area_name in areas:
        for i, (prefix, desc, unit) in enumerate(instruments):
            name = f"{prefix}-{area_no + i + 1}"
            catalog.append(
                TagInfo(
                    name=name,
                    description=desc.format(area=area_name),
                    unit=unit,
                    maps=_maps_for(prefix, unit),
                )
            )
    return catalog


class SimulatorSource:
    """DataSource implementation producing deterministic synthetic trends."""

    # The catalog is in memory, so a search is never partial: see AspenSource.
    search_note = None

    def __init__(self, latency_s: float = 0.0):
        self.latency_s = latency_s
        self._catalog = _build_catalog()
        self._by_name = {t.name: t for t in self._catalog}

    # -- tag search ---------------------------------------------------------

    def search_tags(self, query: str, limit: int = 50) -> List[TagInfo]:
        self.search_note = None
        terms = query_terms(query)
        results = []
        for tag in self._catalog:
            if matches_terms(terms, tag.name, tag.description):
                results.append(tag)
                if len(results) >= limit:
                    break
        return results

    def tag_info(self, name: str) -> TagInfo:
        return self._by_name[name]

    def get_maps(self, tag: str) -> List[MapInfo]:
        """Record maps of a tag, default first."""
        base = tag.split(";")[0].strip()
        info = self._by_name.get(base)
        if info is None:
            raise KeyError(f"unknown tag: {base}")
        return list(info.maps)

    def get_unit(self, tag: str) -> str:
        """Unit of one "TAG;MAP" (bare "TAG" = default map)."""
        _, map_info = self._resolve(tag)
        return map_info.unit

    def get_description(self, tag: str) -> str:
        """Description of one tag; the map part is ignored, as IP21 does."""
        info, _ = self._resolve(tag)
        return info.description

    # -- signal model -------------------------------------------------------

    def _resolve(self, name: str) -> Tuple[TagInfo, MapInfo]:
        """Split "TAG;MAP" and validate; bare "TAG" resolves to the default map."""
        base, _, map_name = name.partition(";")
        info = self._by_name.get(base.strip())
        if info is None:
            raise KeyError(f"unknown tag: {base!r}")
        map_name = map_name.strip()
        if not map_name:
            return info, info.maps[0]
        for map_info in info.maps:
            if map_info.name.lower() == map_name.lower():
                return info, map_info
        raise KeyError(f"unknown map {map_name!r} for tag {base!r}")

    def _range(self, name: str) -> tuple:
        info, map_info = self._resolve(name)
        if "OUTPUT" in map_info.name.upper():
            return (0.0, 100.0)
        prefix = info.name.split("-")[0]
        return _RANGES.get(prefix, (0.0, 100.0))

    def _value_noise(self, seed: float, t: np.ndarray, period_s: float) -> np.ndarray:
        """Smoothly interpolated grid noise in [0, 1) - a wandering baseline."""
        g = t / period_s
        i = np.floor(g)
        f = g - i
        f = f * f * (3.0 - 2.0 * f)  # smoothstep
        a = _hash01(i * 12.9898 + seed)
        b = _hash01((i + 1.0) * 12.9898 + seed)
        return a + (b - a) * f

    def _signal(self, name: str, t: np.ndarray) -> np.ndarray:
        """Underlying continuous signal, evaluated at epoch seconds t."""
        info, map_info = self._resolve(name)
        lo, hi = self._range(name)
        span = hi - lo
        canonical = f"{info.name};{map_info.name}"
        seed = float(zlib.crc32(canonical.encode()) % 100_000) / 7.0

        is_setpoint = "SP" in map_info.name.upper()
        if is_setpoint:
            # Setpoints are operator-entered: hold values in blocks.
            t = np.floor(t / SP_HOLD_S) * SP_HOLD_S

        base = lo + span * (0.35 + 0.35 * _hash01(np.array([seed * 1.7]))[0])
        period_slow = 3600.0 * (18.0 + 30.0 * _hash01(np.array([seed * 2.3]))[0])
        phase = TWO_PI * _hash01(np.array([seed * 3.1]))[0]

        slow = 0.12 * span * np.sin(TWO_PI * t / period_slow + phase)
        wander = 0.22 * span * (self._value_noise(seed, t, 4.0 * 3600.0) - 0.5)
        ripple = 0.08 * span * (self._value_noise(seed + 51.3, t, 20.0 * 60.0) - 0.5)
        if is_setpoint:
            noise = 0.0
        else:
            noise = 0.012 * span * (_hash01(np.floor(t) * 0.061 + seed) - 0.5)

        # Occasional step changes: one candidate per 8-hour block, ~12% chance.
        block = np.floor(t / (8.0 * 3600.0))
        r = _hash01(block * 7.77 + seed)
        magnitude = 0.3 * span * (_hash01(block * 3.13 + seed + 5.0) - 0.5)
        steps = np.where(r < 0.12, magnitude, 0.0)

        return np.clip(base + slow + wander + ripple + noise + steps, lo, hi)

    # -- reads --------------------------------------------------------------

    def read(
        self,
        tags: List[str],
        start: float,
        end: float,
        sample_type: SampleType,
        interval_s: float,
    ) -> Dict[str, Series]:
        if end <= start:
            raise ValueError("end must be after start")
        if interval_s <= 0:
            raise ValueError("interval must be positive")
        n = int((end - start) // interval_s)
        if n > MAX_POINTS:
            raise ValueError(
                f"too many points requested ({n}); increase the interval"
            )
        if self.latency_s > 0:
            time.sleep(self.latency_s)

        for tag in tags:
            self._resolve(tag)  # raises KeyError for unknown tag or map

        result: Dict[str, Series] = {}
        for tag in tags:
            if sample_type == SampleType.INT:
                result[tag] = self._read_interpolated(tag, start, end, interval_s)
            else:
                result[tag] = self._read_aggregate(
                    tag, start, end, sample_type, interval_s
                )
        return result

    def _read_interpolated(
        self, tag: str, start: float, end: float, interval_s: float
    ) -> Series:
        t = np.arange(start, end + interval_s * 0.5, interval_s)
        return t, self._signal(tag, t)

    def _read_aggregate(
        self, tag: str, start: float, end: float, sample_type: SampleType, interval_s: float
    ) -> Series:
        n = max(1, int((end - start) // interval_s))
        # Sample the underlying signal finely within each bucket.
        k = int(min(20, max(2, MAX_FINE_POINTS // n)))
        dt = interval_s / k
        t_fine = start + np.arange(n * k) * dt
        v_fine = self._signal(tag, t_fine).reshape(n, k)
        t_bucket = start + np.arange(n) * interval_s

        if sample_type == SampleType.AVG:
            return t_bucket, v_fine.mean(axis=1)
        if sample_type == SampleType.MIN:
            return t_bucket, v_fine.min(axis=1)
        if sample_type == SampleType.MAX:
            return t_bucket, v_fine.max(axis=1)
        raise ValueError(f"unsupported sample type: {sample_type}")
