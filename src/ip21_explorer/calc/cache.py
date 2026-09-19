"""A short memory in front of a data source.

The historian is the slow part of everything: at work one read can take tens
of seconds. The same window is asked for more than once in a row - the plot's
tags, then the formulas over those tags, then the block editor's preview of
each block - and none of that should reach IP21 twice.

An entry is one tag read with one (sample, interval, start, end). A few
minutes is plenty: the repeats come seconds apart, and a window that ends now
moves on by itself.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict
from typing import Dict, List, Tuple

from ..sources.base import DataSource, SampleType, Series

MAX_ENTRIES = 300
TTL_S = 120.0

Key = Tuple[str, str, float, float, float]


class CachedSource:
    """Wraps a DataSource; read() is remembered, everything else passes through."""

    def __init__(self, source: DataSource, max_entries: int = MAX_ENTRIES,
                 ttl_s: float = TTL_S):
        self._source = source
        self._max = max_entries
        self._ttl = ttl_s
        self._lock = threading.Lock()
        self._entries: "OrderedDict[Key, Tuple[float, Series]]" = OrderedDict()
        # Reads under way: a second request for the same key waits for the
        # first rather than asking the historian again.
        self._pending: Dict[Key, threading.Event] = {}

    def __getattr__(self, name):
        return getattr(self._source, name)

    @property
    def source(self) -> DataSource:
        return self._source

    def _expire(self, now: float) -> None:
        stale = [k for k, (at, _) in self._entries.items() if now - at > self._ttl]
        for key in stale:
            del self._entries[key]

    def read(self, tags: List[str], start: float, end: float,
             sample_type: SampleType, interval_s: float) -> Dict[str, Series]:
        def key(tag: str) -> Key:
            return (tag, sample_type.value, float(interval_s), float(start), float(end))

        result: Dict[str, Series] = {}
        mine: List[str] = []
        waits: List[Tuple[str, threading.Event]] = []
        with self._lock:
            self._expire(time.monotonic())
            for tag in tags:
                k = key(tag)
                if k in self._entries:
                    self._entries.move_to_end(k)
                    result[tag] = self._entries[k][1]
                elif k in self._pending:
                    waits.append((tag, self._pending[k]))
                else:
                    self._pending[k] = threading.Event()
                    mine.append(tag)

        try:
            if mine:
                fresh = self._source.read(mine, start, end, sample_type, interval_s)
                now = time.monotonic()
                with self._lock:
                    for tag, series in fresh.items():
                        self._entries[key(tag)] = (now, series)
                        self._entries.move_to_end(key(tag))
                    while len(self._entries) > self._max:
                        self._entries.popitem(last=False)
                # A tag the source left out (Aspen omits an unknown one) is
                # simply not in the answer, as without the cache.
                result.update({t: s for t, s in fresh.items() if t in mine})
        finally:
            with self._lock:
                for tag in mine:
                    event = self._pending.pop(key(tag), None)
                    if event:
                        event.set()

        for tag, event in waits:
            event.wait()
            with self._lock:
                hit = self._entries.get(key(tag))
            if hit is not None:
                result[tag] = hit[1]
            else:
                # The read it waited on failed or left this tag out: ask for
                # it alone, so its own error (if any) is the one raised.
                result.update(self._source.read([tag], start, end, sample_type, interval_s))
        return result

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
