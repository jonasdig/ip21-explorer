"""Tests for the Aspen source.

The live server is unreachable from development machines, so these tests pin
the tagreader API surface we depend on and exercise AspenSource against a fake
client. The API-surface test is what catches renames like Client -> IMSClient.
"""
import fnmatch
import sys
import types
import urllib.parse
from datetime import datetime, timezone

import numpy as np
import pytest

from ip21_explorer.sources.base import SampleType

tagreader = pytest.importorskip("tagreader")


def test_tagreader_api_surface():
    """Everything AspenSource reaches for must exist in the installed tagreader."""
    from tagreader import IMSClient, ReaderType

    for name in ("INT", "AVG", "MIN", "MAX"):
        assert hasattr(ReaderType, name)
    for name in ("connect", "read", "search", "get_units"):
        assert hasattr(IMSClient, name)
    assert hasattr(tagreader, "list_sources")

    import inspect

    init = inspect.signature(IMSClient.__init__).parameters
    for name in ("datasource", "imstype", "url", "tz", "verify_ssl", "cache"):
        assert name in init, f"IMSClient.__init__ lost parameter {name}"
    read = inspect.signature(IMSClient.read).parameters
    for name in ("tags", "start_time", "end_time", "ts", "read_type"):
        assert name in read, f"IMSClient.read lost parameter {name}"

    from tagreader.web_handlers import AspenHandlerWeb

    # Used to keep searches bounded: one capped Browse plus a few descriptions.
    for name in ("_get_maps", "_get_tag_description", "generate_search_query", "fetch"):
        assert hasattr(AspenHandlerWeb, name)
    query = inspect.signature(AspenHandlerWeb.generate_search_query).parameters
    for name in ("tag", "desc", "datasource", "max"):
        assert name in query


class FakeHandler:
    """Mimics AspenHandlerWeb, counting the requests it is asked to make."""

    def __init__(self):
        self.maps = {"CA_I PV": True, "CA_I OUTPUT": False, "CA_I SP": False}
        self.base_url = "https://server/ProcessData/"
        self.datasource = "MY_IP21"
        self.browse_calls = []
        self.description_calls = []
        # Pretend the historian holds many tags matching a loose pattern.
        self.all_tags = [f"TIC-24-{i:04d}" for i in range(500)]
        # Every tenth tag measures something the others do not, so a hit found
        # by description can be told apart from one found by name.
        self.descriptions = {
            t: "reactor temperature" if i % 10 == 5 else f"description of {t}"
            for i, t in enumerate(self.all_tags)
        }

    def _get_maps(self, tagname):
        return dict(self.maps)

    @staticmethod
    def generate_search_query(tag, desc, datasource, max):
        return {"datasource": datasource, "tag": tag, "max": max, "getTrendable": 0}

    def fetch(self, url, params=None, timeout=None):
        self.browse_calls.append(url)
        limit = int(url.split("max=")[1].split("&")[0])
        # Browse matches tag names only, case-insensitively, as IP21 does.
        pattern = urllib.parse.unquote(url.split("tag=")[1].split("&")[0]).lower()
        hits = [t for t in self.all_tags if fnmatch.fnmatchcase(t.lower(), pattern)]
        return {"data": {"tags": [{"t": t} for t in hits[:limit]]}}

    def _get_tag_description(self, tag):
        self.description_calls.append(tag)
        return self.descriptions[tag]


class FakeClient:
    """Stands in for tagreader.IMSClient, recording what it was asked for."""

    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.handler = FakeHandler()
        self.connected = False
        self.read_calls = []
        FakeClient.instances.append(self)

    def connect(self):
        self.connected = True

    def get_units(self, tag):
        self.unit_calls = getattr(self, "unit_calls", [])
        self.unit_calls.append(tag)
        unit = "%" if "OUTPUT" in tag else "degC"
        return {tag: unit}

    def search(self, tag=None, desc=None, timeout=None, return_desc=True):
        self.search_calls = getattr(self, "search_calls", [])
        self.search_calls.append({"tag": tag, "desc": desc, "return_desc": return_desc})
        return list(self.handler.all_tags)

    # Resolution pandas hands back for the index; newer versions keep the
    # millisecond unit the Aspen handler parses with instead of upcasting.
    index_unit = "ns"

    def read(self, tags, start_time, end_time, ts, read_type):
        import numpy as np
        import pandas as pd

        self.read_calls.append(
            {"tags": tags, "start": start_time, "end": end_time, "ts": ts,
             "read_type": read_type}
        )
        from tagreader import ReaderType

        start_ms = int(pd.Timestamp(start_time).timestamp() * 1000)
        stamps = np.array(
            [start_ms + i * 60_000 for i in range(3)], dtype="datetime64[ms]"
        ).astype(f"datetime64[{self.index_unit}]")
        index = pd.DatetimeIndex(stamps).tz_localize("UTC").tz_convert("Europe/Oslo")
        offset = 10.0 if read_type == ReaderType.MAX else 0.0
        return pd.DataFrame(
            {tag: [1.0 + offset, 2.0 + offset, 3.0 + offset] for tag in tags},
            index=index,
        )


@pytest.fixture
def make_source(monkeypatch):
    from tagreader import ReaderType

    fake_module = types.ModuleType("tagreader")
    fake_module.IMSClient = FakeClient
    fake_module.ReaderType = ReaderType
    monkeypatch.setitem(sys.modules, "tagreader", fake_module)

    from ip21_explorer.sources.aspen import AspenSource

    FakeClient.instances.clear()

    def build(**kwargs):
        return AspenSource(
            url="https://server/ProcessData", datasource="MY_IP21", **kwargs
        )

    return build


@pytest.fixture
def source(make_source):
    return make_source()


def test_client_configured_and_connected(source):
    client = FakeClient.instances[-1]
    assert client.kwargs["datasource"] == "MY_IP21"
    assert client.kwargs["imstype"] == "aspenone"
    assert client.kwargs["url"] == "https://server/ProcessData"
    assert client.connected


def test_datasource_is_required():
    from ip21_explorer.sources.aspen import AspenSource

    with pytest.raises(ValueError):
        AspenSource(url="https://server", datasource="")


def test_short_query_makes_no_requests(source):
    """A bare or 1-character query would match the whole historian."""
    handler = FakeClient.instances[-1].handler
    for query in ("", " ", "T", "*"):
        assert source.search_tags(query) == []
    assert handler.browse_calls == []
    assert handler.description_calls == []


def test_browse_url_is_well_formed(source):
    """urljoin ate both the "?" and a base path ending in a file name."""
    handler = FakeClient.instances[-1].handler
    handler.base_url = "http://server/ProcessData/AtProcessDataREST.dll"
    source.search_tags("TIC-24", limit=5)
    url = handler.browse_calls[-1]
    assert url.startswith(
        "http://server/ProcessData/AtProcessDataREST.dll/Browse?datasource="
    )
    assert url.count("?") == 1


def test_search_is_one_browse_plus_capped_descriptions(source):
    from ip21_explorer.sources.aspen import MAX_DESCRIPTIONS

    handler = FakeClient.instances[-1].handler
    hits = source.search_tags("TIC-24", limit=40)

    assert len(hits) == 40                        # server-side cap honoured
    assert len(handler.browse_calls) == 1         # exactly one browse request
    assert "max=40" in handler.browse_calls[0]
    assert len(handler.description_calls) == MAX_DESCRIPTIONS
    assert hits[0].description == "description of TIC-24-0000"
    assert hits[MAX_DESCRIPTIONS].description == ""  # beyond the cap: no request


def test_descriptions_are_cached_across_searches(source):
    handler = FakeClient.instances[-1].handler
    source.search_tags("TIC-24")
    first = len(handler.description_calls)
    source.search_tags("TIC-24")
    assert len(handler.description_calls) == first  # no repeat lookups


def test_query_wildcards_are_passed_through(source):
    handler = FakeClient.instances[-1].handler
    source.search_tags("TIC-24-00*")
    assert "tag=*TIC-24*" not in handler.browse_calls[0]
    assert "TIC-24-00*" in handler.browse_calls[0]


def test_two_terms_match_name_and_description(source):
    """"TIC-24 reactor": part of the tag plus part of the description."""
    handler = FakeClient.instances[-1].handler
    hits = source.search_tags("TIC-24 reactor", limit=40)

    assert hits
    assert all(h.name.startswith("TIC-24-") for h in hits)
    assert all(h.description == "reactor temperature" for h in hits)
    # One Browse per term, then descriptions for the candidates it found.
    assert len(handler.browse_calls) == 2
    assert len(handler.description_calls) <= source._desc_scan_max


def test_no_query_ever_browses_the_whole_historian(source):
    """The guard on the bug this has now shipped twice.

    Reading every description in the database is one request per tag, so no
    search may ever browse "*" - however little the query matches by name.
    """
    handler = FakeClient.instances[-1].handler
    for query in ("*si", "si", "reactor", "TIC-24 reactor", "a b c", "zz*", "*"):
        source.search_tags(query, limit=40)
    for url in handler.browse_calls:
        assert "tag=*&" not in url and not url.endswith("tag=*"), url
    assert len(handler.description_calls) <= source._desc_scan_max


def test_description_only_query_finds_nothing_and_costs_nothing(source):
    """"reactor" matches no tag name, so there is nothing to check against."""
    handler = FakeClient.instances[-1].handler

    assert source.search_tags("reactor", limit=40) == []
    assert handler.description_calls == []  # not one lookup
    assert "alongside part of a tag name" in source.search_note


def test_unmatched_wildcard_query_costs_nothing(source):
    """The query from the field report: one Browse, no description requests."""
    handler = FakeClient.instances[-1].handler

    assert source.search_tags("*si", limit=40) == []
    assert len(handler.browse_calls) == 1
    assert handler.description_calls == []
    assert source.search_note


def test_description_matching_stays_inside_the_budget(make_source):
    source = make_source(desc_scan_max=10)
    handler = FakeClient.instances[-1].handler

    hits = source.search_tags("TIC-24 reactor", limit=40)

    assert len(handler.description_calls) == 10  # budget honoured
    assert [h.name for h in hits] == [
        t for t in handler.all_tags[:10]
        if handler.descriptions[t] == "reactor temperature"
    ]
    assert "10 of 500" in source.search_note  # partial, and says so


def test_description_matching_reuses_the_cache(make_source):
    """Typing out the second word must not re-ask for the same descriptions."""
    source = make_source(desc_scan_max=100)
    handler = FakeClient.instances[-1].handler

    source.search_tags("TIC-24 reactor", limit=40)
    first = len(handler.description_calls)
    assert first == 100
    source.search_tags("TIC-24 reactor temperature", limit=40)
    assert len(handler.description_calls) == first  # cached, no new requests


def test_name_hits_never_trigger_a_description_scan(source):
    """The common case must keep costing one Browse plus 15 descriptions."""
    from ip21_explorer.sources.aspen import MAX_DESCRIPTIONS

    handler = FakeClient.instances[-1].handler
    source.search_tags("TIC-24", limit=40)
    assert len(handler.description_calls) == MAX_DESCRIPTIONS


def test_get_description_reuses_the_search_cache(source):
    handler = FakeClient.instances[-1].handler
    source.search_tags("TIC-24", limit=40)          # caches the first 15
    before = len(handler.description_calls)

    assert source.get_description("TIC-24-0000") == "description of TIC-24-0000"
    assert len(handler.description_calls) == before  # already cached, free
    # A description belongs to the tag, so the map is stripped first.
    assert source.get_description("TIC-24-0000;CA_I PV") == "description of TIC-24-0000"


def test_get_description_survives_a_failed_lookup(source, monkeypatch):
    client = FakeClient.instances[-1]

    def boom(tag):
        raise RuntimeError("no such tag")

    monkeypatch.setattr(client.handler, "_get_tag_description", boom)
    assert source.get_description("TIC-24-0499") == ""


def test_browse_falls_back_to_public_search(source, monkeypatch):
    client = FakeClient.instances[-1]

    def boom(*args, **kwargs):
        raise RuntimeError("unexpected handler shape")

    monkeypatch.setattr(client.handler, "generate_search_query", boom)
    hits = source.search_tags("TIC-24", limit=10)
    assert [t.name for t in hits] == client.handler.all_tags[:10]
    assert client.search_calls[-1]["return_desc"] is False  # still one request


def test_get_maps_puts_default_first(source):
    maps = source.get_maps("TIC-102;CA_I OUTPUT")
    assert [m.name for m in maps] == ["CA_I PV", "CA_I OUTPUT", "CA_I SP"]


def test_get_maps_looks_up_no_units(source):
    """A tag can have 30+ maps; a unit each would be 30+ requests."""
    client = FakeClient.instances[-1]
    source.get_maps("TIC-102")
    assert getattr(client, "unit_calls", []) == []
    assert all(m.unit == "" for m in source.get_maps("TIC-102"))


def test_get_unit_resolves_one_map_and_caches_it(source):
    client = FakeClient.instances[-1]
    assert source.get_unit("TIC-102;CA_I OUTPUT") == "%"
    assert client.unit_calls == ["TIC-102;CA_I OUTPUT"]
    # Asking again is free.
    assert source.get_unit("TIC-102;CA_I OUTPUT") == "%"
    assert client.unit_calls == ["TIC-102;CA_I OUTPUT"]


def test_read_passes_through_tag_map_and_reader_type(source):
    from tagreader import ReaderType

    start = datetime(2026, 8, 25, 10, tzinfo=timezone.utc).timestamp()
    result = source.read(
        ["TIC-102;CA_I OUTPUT"], start, start + 600, SampleType.INT, 60
    )
    call = FakeClient.instances[-1].read_calls[-1]
    assert call["tags"] == ["TIC-102;CA_I OUTPUT"]
    assert call["read_type"] == ReaderType.INT
    assert call["ts"] == 60

    t, v = result["TIC-102;CA_I OUTPUT"]
    assert len(t) == len(v) == 3
    assert t[0] == pytest.approx(start)          # epoch seconds, timezone correct
    assert np.allclose(v, [1.0, 2.0, 3.0])


def test_tags_of_one_request_are_read_side_by_side(make_source, monkeypatch):
    """tagreader reads the tags of one call one after another; five of them
    must not cost five round trips in a row."""
    import time

    original = FakeClient.read

    def slow_read(self, tags, **kwargs):
        time.sleep(0.2 * len(tags))       # like tagreader: one trip per tag
        return original(self, tags, **kwargs)

    monkeypatch.setattr(FakeClient, "read", slow_read)
    tags = ["TI-101", "TI-201", "PI-103", "FI-104;CA_I OUTPUT", "LI-106"]
    start = 1_787_000_000.0

    serial = make_source(read_workers=1)
    began = time.monotonic()
    one_call = serial.read(tags, start, start + 600, SampleType.INT, 60)
    serial_s = time.monotonic() - began
    assert [c["tags"] for c in FakeClient.instances[-1].read_calls] == [tags]

    parallel = make_source(read_workers=5)
    began = time.monotonic()
    side_by_side = parallel.read(tags, start, start + 600, SampleType.INT, 60)
    parallel_s = time.monotonic() - began
    calls = FakeClient.instances[-1].read_calls
    assert sorted(c["tags"][0] for c in calls) == sorted(tags)
    assert all(len(c["tags"]) == 1 for c in calls)

    assert serial_s >= 0.9 and parallel_s < 0.5
    # Same answer, same order, whichever way it was fetched.
    assert list(side_by_side) == list(one_call) == tags
    for tag in tags:
        assert np.array_equal(side_by_side[tag][0], one_call[tag][0])
        assert np.array_equal(side_by_side[tag][1], one_call[tag][1])


def test_read_workers_default(source):
    from ip21_explorer.sources.aspen import READ_WORKERS

    assert source._read_workers == READ_WORKERS == 4


@pytest.mark.parametrize(
    "sample,expected",
    [("INT", "INT"), ("AVG", "AVG"), ("MIN", "MIN"), ("MAX", "MAX")],
)
def test_sample_types_map_to_reader_types(source, sample, expected):
    from tagreader import ReaderType

    start = 1_787_000_000.0
    source.read(["TI-101"], start, start + 600, SampleType(sample), 60)
    assert FakeClient.instances[-1].read_calls[-1]["read_type"] == getattr(
        ReaderType, expected
    )


@pytest.mark.parametrize("unit", ["ns", "ms", "us"])
def test_timestamps_survive_any_pandas_resolution(source, unit):
    """A ms-resolution index read as nanoseconds puts every point in 1970."""
    FakeClient.index_unit = unit
    try:
        start = datetime(2026, 8, 26, 11, 41, 28, tzinfo=timezone.utc).timestamp()
        t, _ = source.read(["TI-101"], start, start + 600, SampleType.INT, 60)["TI-101"]
    finally:
        FakeClient.index_unit = "ns"
    assert t[0] == pytest.approx(start, abs=1e-3)
    assert np.allclose(np.diff(t), 60.0)


def test_non_datetime_index_is_skipped_not_mangled(source, monkeypatch):
    """Better an empty series than every point silently landing in 1970."""
    import pandas as pd

    client = FakeClient.instances[-1]
    monkeypatch.setattr(
        client, "read",
        lambda *a, **k: pd.DataFrame({"TI-101": [1.0, 2.0]}),  # RangeIndex
    )
    assert source.read(["TI-101"], 1_787_000_000.0, 1_787_000_600.0,
                       SampleType.INT, 60) == {}
