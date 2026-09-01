"""Data source abstraction shared by the simulator and the Aspen backend."""
from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Tuple

import numpy as np

try:  # Protocol is 3.8+, but keep import explicit
    from typing import Protocol
except ImportError:  # pragma: no cover
    from typing_extensions import Protocol  # type: ignore


class SampleType(str, Enum):
    """Sampling/aggregation types, named to mirror tagreader's ReaderType."""

    INT = "INT"  # interpolated at fixed interval
    AVG = "AVG"
    MIN = "MIN"
    MAX = "MAX"


@dataclass(frozen=True)
class MapInfo:
    """An IP21 record map: a named data field on a tag, with its unit."""

    name: str
    unit: str


@dataclass(frozen=True)
class TagInfo:
    name: str
    description: str
    unit: str
    # Available maps, first entry is the default. Data is requested with the
    # full "TAG;MAP" string as identifier; bare "TAG" means the default map.
    maps: Tuple["MapInfo", ...] = ()


# A series is (timestamps as epoch seconds, values), both float64 arrays.
Series = Tuple[np.ndarray, np.ndarray]


def query_terms(query: str) -> List[str]:
    """Split a search query into terms, keeping the case the user typed.

    Case is preserved because the terms are also used to build IP21 Browse
    patterns; matching lowercases them again.
    """
    return query.split()


def matches_terms(terms: List[str], name: str, description: str = "") -> bool:
    """True when every term matches the tag name or its description.

    A term containing "*" is a glob, anything else a plain substring. Both
    sources share this so the simulator behaves like the historian.
    """
    haystack = f"{name} {description}".lower()
    return all(
        fnmatch.fnmatchcase(haystack, f"*{t}*") if "*" in t else t in haystack
        for t in (term.lower() for term in terms)
    )


class DataSource(Protocol):
    def search_tags(self, query: str, limit: int = 50) -> List[TagInfo]:
        """Search tags by name/description terms (see matches_terms).

        A source may set `search_note` to a string explaining a limitation of
        the answer it just gave; the API passes it on to the dropdown.
        """
        ...

    def get_maps(self, tag: str) -> List[MapInfo]:
        """Record maps of one tag, default first. Optional per source.

        Units may be empty here: resolving one costs a request per map on a
        live historian, so they are looked up per map with get_unit() once a
        map has actually been chosen.
        """
        ...

    def get_unit(self, tag: str) -> str:
        """Unit of one "TAG;MAP" (bare "TAG" = default map). Optional per source."""
        ...

    def get_description(self, tag: str) -> str:
        """Description of one tag, looked up on demand. Optional per source.

        Search results carry a description only where it was cheap to include
        one, so the label modes ask for the rest here.
        """
        ...

    def read(
        self,
        tags: List[str],
        start: float,
        end: float,
        sample_type: SampleType,
        interval_s: float,
    ) -> Dict[str, Series]:
        """Read data for tags between start and end (epoch seconds)."""
        ...
