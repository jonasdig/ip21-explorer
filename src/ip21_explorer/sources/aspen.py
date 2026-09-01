"""Aspen ProcessData REST source, wrapping tagreader-python.

Kept as a thin mapping onto the same DataSource protocol the simulator
implements, so everything above it (API, frontend) is exercised by the
simulator during development.

Requires the optional dependency: pip install ip21-explorer[aspen]
"""
from __future__ import annotations

import logging
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Dict, List, Optional

import numpy as np

from .base import MapInfo, SampleType, Series, TagInfo, matches_terms, query_terms

logger = logging.getLogger(__name__)

# A search must never enumerate the whole historian: IP21 answers a bare "*"
# with every tag it has, and one description lookup per tag after that.
MIN_QUERY_LEN = 2
# Descriptions cost one request each, so a search that already matched by name
# only fills in the first few, for display.
MAX_DESCRIPTIONS = 15
DESCRIPTION_WORKERS = 8
# How many of the name-matched candidates get a description lookup, when a
# multi-term query needs descriptions. One request per uncached tag, so this is
# the number that has to stay small. Overridden from IP21_DESC_SCAN_MAX.
DESC_SCAN_MAX = 100
# Names-only Browse cap for the candidate set: one request, no description
# lookups, so it can be generous - it is what lets the note report a true total.
CANDIDATE_BROWSE_MAX = 2000


def _pattern(term: str) -> str:
    """Browse pattern for one term; wildcards are passed through as typed."""
    return term if "*" in term else f"*{term}*"


def _no_match_note(terms: List[str]) -> str:
    """Why a search came up empty, and what would make it work."""
    if len(terms) < 2:
        return (
            f"No tag name matches \"{' '.join(terms)}\". Descriptions are searched "
            "only alongside part of a tag name, e.g. \"TIC-24 temperature\"."
        )
    return (
        "No tag name matches any part of the search, so there was nothing to "
        "check descriptions against."
    )


def _epoch_seconds(index) -> "np.ndarray | None":
    """Epoch seconds from a pandas DatetimeIndex of any resolution.

    pandas may hand back datetime64[ms] (or [us]) rather than [ns] depending on
    its version, so the integer view has to be normalised before scaling -
    otherwise millisecond counts get read as nanoseconds and every timestamp
    lands in 1970.
    """
    import pandas as pd

    if not isinstance(index, pd.DatetimeIndex):
        return None
    if index.tz is not None:
        index = index.tz_convert("UTC").tz_localize(None)
    return index.to_numpy(dtype="datetime64[ns]").astype("int64") / 1e9


class AspenSource:
    def __init__(
        self,
        url: str,
        datasource: str,
        verify_ssl: bool = True,
        timezone_name: str = "Europe/Oslo",
        desc_scan_max: int = DESC_SCAN_MAX,
    ):
        try:
            from tagreader import IMSClient, ReaderType
        except ImportError as exc:  # pragma: no cover
            raise RuntimeError(
                "tagreader is not installed; run: pip install ip21-explorer[aspen]"
            ) from exc

        if not datasource:
            raise ValueError("IP21_ASPEN_DATASOURCE must be set for the aspen source")

        self._reader_types = {
            SampleType.INT: ReaderType.INT,
            SampleType.AVG: ReaderType.AVG,
            SampleType.MIN: ReaderType.MIN,
            SampleType.MAX: ReaderType.MAX,
        }
        self._client = IMSClient(
            datasource=datasource,
            imstype="aspenone",
            url=url or None,
            tz=timezone_name,
            verify_ssl=verify_ssl,
            cache=None,  # our auto-interval varies per zoom; a disk cache mostly misses
        )
        self._client.connect()
        self._unit_cache: Dict[str, str] = {}
        self._desc_cache: Dict[str, str] = {}
        self._desc_scan_max = max(0, desc_scan_max)
        # Set by search_tags when the answer it gave is incomplete; the API
        # passes it on so the dropdown can say so.
        self.search_note: Optional[str] = None

    # -- tag search ---------------------------------------------------------

    def search_tags(self, query: str, limit: int = 50) -> List[TagInfo]:
        """Search tag names, and descriptions where a tag fragment narrows it.

        Terms are ANDed and each may match the name or the description, but the
        two are nowhere near equally cheap: Browse matches names server-side in
        one request, while a description costs one request per tag. So names
        decide the candidates and descriptions are only ever consulted among
        them. A query that matches no tag name is answered with nothing - never
        by scanning the historian, which is one request per tag in the database.

        Wildcards are allowed; a bare term is wrapped in *.
        """
        self.search_note = None
        query = query.strip()
        if len(query) < MIN_QUERY_LEN:
            return []
        terms = query_terms(query)

        names = self._browse_terms(terms, limit)
        hits = [n for n in names if matches_terms(terms, n)][:limit]
        if hits:
            return self._tag_infos(hits, self._descriptions(hits[:MAX_DESCRIPTIONS]))
        # A single term is already settled by the Browse above: every candidate
        # it returned matches that term by name, so descriptions cannot add any
        # hit. With no candidates at all there is nothing to check either.
        if len(terms) < 2 or not names:
            self.search_note = _no_match_note(terms)
            return []
        return self._search_descriptions(terms, names, limit)

    def _browse_terms(self, terms: List[str], limit: int) -> List[str]:
        """Tag names matching any term, in term order, without duplicates.

        One term is one Browse capped at the result limit, as before. Several
        terms cost one Browse each, capped wider so the union can serve as the
        candidate set for the description stage - names only, one request each.
        """
        if len(terms) == 1:
            return self._browse(_pattern(terms[0]), limit)
        names: List[str] = []
        seen = set()
        for term in terms:
            for name in self._browse(_pattern(term), CANDIDATE_BROWSE_MAX):
                if name not in seen:
                    seen.add(name)
                    names.append(name)
        return names

    def _search_descriptions(
        self, terms: List[str], candidates: List[str], limit: int
    ) -> List[TagInfo]:
        """Match descriptions among the tags that matched some term by name.

        Never a scan of the historian: `candidates` always comes from a name
        Browse. The budget stops a wide tag fragment from becoming hundreds of
        requests, and because the candidates are fixed by the tag term, typing
        out the other word is answered from the cache.
        """
        # The budget caps the candidates looked at, not the requests made, so
        # the same query always gives the same answer and a repeat of it is
        # free. Candidates past the cap are still matched when their
        # description happens to be cached already - that costs nothing.
        scanned = candidates[: self._desc_scan_max]
        scanned += [n for n in candidates[self._desc_scan_max :] if n in self._desc_cache]
        if len(candidates) > len(scanned):
            self.search_note = (
                f"Checked the descriptions of {len(scanned)} of "
                f"{len(candidates)} matching tags - narrow the tag name to see more."
            )
        descriptions = self._descriptions(scanned)
        hits = [
            n
            for n in candidates
            if n in descriptions and matches_terms(terms, n, descriptions[n])
        ][:limit]
        return self._tag_infos(hits, descriptions)

    def _tag_infos(self, names: List[str], descriptions: Dict[str, str]) -> List[TagInfo]:
        """Search hits as TagInfo.

        Units and maps cost one request per tag, so they are left empty and
        fetched on demand by get_maps()/get_unit() once a tag is actually used.
        """
        return [
            TagInfo(name=n, description=descriptions.get(n, ""), unit="", maps=())
            for n in names
        ]

    def _browse(self, pattern: str, limit: int) -> List[str]:
        """One Browse request, capped server-side at `limit` tags."""
        handler = self._client.handler
        try:
            params = handler.generate_search_query(
                tag=pattern, desc=None, datasource=handler.datasource, max=limit
            )
            # Built by hand: urljoin drops both the "?" and a base path that
            # ends in a file name such as AtProcessDataREST.dll.
            query = urllib.parse.urlencode(
                params, safe="*", quote_via=urllib.parse.quote
            )
            url = f"{handler.base_url.rstrip('/')}/Browse?{query}"
            data = handler.fetch(url)
            return [item["t"] for item in data.get("data", {}).get("tags", [])][:limit]
        except Exception as exc:
            logger.warning("capped tag browse failed (%s); using tagreader search", exc)
            # Fall back to the public API. It cannot cap the result server-side,
            # but return_desc=False still keeps it to a single request.
            hits = self._client.search(tag=pattern, return_desc=False)
            names = [h[0] if isinstance(h, (tuple, list)) else str(h) for h in hits]
            return names[:limit]

    def _descriptions(self, names: List[str]) -> Dict[str, str]:
        """Descriptions for a handful of tags, fetched in parallel and cached."""
        missing = [n for n in names if n not in self._desc_cache]
        if missing:
            handler = self._client.handler

            def fetch_one(name: str) -> str:
                try:
                    return handler._get_tag_description(name) or ""
                except Exception:
                    return ""

            workers = min(DESCRIPTION_WORKERS, len(missing))
            with ThreadPoolExecutor(max_workers=workers) as pool:
                for name, desc in zip(missing, pool.map(fetch_one, missing)):
                    self._desc_cache[name] = desc
        return {n: self._desc_cache.get(n, "") for n in names}

    def get_maps(self, tag: str) -> List[MapInfo]:
        """List the record maps of a tag, default map first.

        Units are left empty on purpose: a tag can have 30+ maps and each unit
        is a separate request, so they are resolved one at a time by get_unit()
        when a map is selected.
        """
        base = tag.split(";")[0].strip()
        handler = self._client.handler
        try:
            found = handler._get_maps(base)  # {map name: is default}
        except Exception:
            return []
        if not found:
            return []
        names = sorted(found, key=lambda n: (not found[n], n.lower()))
        return [MapInfo(name=n, unit="") for n in names]

    def get_unit(self, tag: str) -> str:
        """Unit of one "TAG;MAP", cached per map."""
        return self._unit_of(tag.strip())

    def get_description(self, tag: str) -> str:
        """Description of one tag, from the same cache the search fills.

        A description belongs to the tag, not the map, so "TAG;MAP" is reduced
        to its base first. Free for any tag a search has already turned up.
        """
        base = tag.split(";")[0].strip()
        return self._descriptions([base]).get(base, "")

    def _unit_of(self, tag: str) -> str:
        if tag not in self._unit_cache:
            try:
                unit = self._client.get_units(tag).get(tag) or ""
            except Exception:
                unit = ""
            self._unit_cache[tag] = unit
        return self._unit_cache[tag]

    # -- reads --------------------------------------------------------------

    def read(
        self,
        tags: List[str],
        start: float,
        end: float,
        sample_type: SampleType,
        interval_s: float,
    ) -> Dict[str, Series]:
        interval_s = max(1.0, interval_s)
        frame = self._read_frame(
            tags, start, end, self._reader_types[sample_type], interval_s
        )
        return {tag: series for tag, series in frame.items()}

    def _read_frame(
        self, tags: List[str], start: float, end: float, reader_type, interval_s: float
    ) -> Dict[str, Series]:
        df = self._client.read(
            tags,
            start_time=datetime.fromtimestamp(start, tz=timezone.utc),
            end_time=datetime.fromtimestamp(end, tz=timezone.utc),
            ts=int(interval_s),
            read_type=reader_type,
        )
        result: Dict[str, Series] = {}
        for tag in tags:
            # tagreader names each column after the tag string it was given,
            # "TAG;MAP" included.
            if tag not in df.columns:
                continue
            col = df[tag].dropna()
            times = _epoch_seconds(col.index)
            if times is None:
                logger.warning("%s: unexpected index %r, skipping", tag, col.index.dtype)
                continue
            result[tag] = (times, col.to_numpy(dtype=np.float64))
        return result
