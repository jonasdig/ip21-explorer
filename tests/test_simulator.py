import numpy as np
import pytest

from ip21_explorer.sources.base import SampleType
from ip21_explorer.sources.simulator import SimulatorSource

START = 1_756_000_000.0  # arbitrary fixed epoch
END = START + 24 * 3600


@pytest.fixture
def sim():
    return SimulatorSource()


def first_tag(sim):
    return sim.search_tags("", limit=1)[0].name


def test_search_returns_catalog(sim):
    tags = sim.search_tags("", limit=500)
    assert len(tags) == 50
    assert all(t.name and t.description and t.unit for t in tags)


def test_search_filters_by_terms(sim):
    hits = sim.search_tags("reactor temperature")
    assert hits
    for tag in hits:
        text = f"{tag.name} {tag.description}".lower()
        assert "reactor" in text and "temperature" in text


def test_search_matches_wildcard_terms(sim):
    hits = sim.search_tags("TIC-1* temperature")
    assert hits
    assert all(t.name.startswith("TIC-1") for t in hits)
    assert all("temperature" in t.description.lower() for t in hits)


def test_search_matches_tag_name(sim):
    name = first_tag(sim)
    hits = sim.search_tags(name.lower())
    assert any(t.name == name for t in hits)


def test_read_is_deterministic(sim):
    tag = first_tag(sim)
    a = sim.read([tag], START, END, SampleType.INT, 60)
    b = sim.read([tag], START, END, SampleType.INT, 60)
    np.testing.assert_array_equal(a[tag][0], b[tag][0])
    np.testing.assert_array_equal(a[tag][1], b[tag][1])


def test_interpolated_shape_and_range(sim):
    tag = first_tag(sim)
    t, v = sim.read([tag], START, END, SampleType.INT, 60)[tag]
    assert len(t) == len(v) == 24 * 60 + 1
    assert np.all(np.diff(t) == 60)
    lo, hi = sim._range(tag)
    assert v.min() >= lo and v.max() <= hi


def test_aggregates_are_consistent(sim):
    tag = first_tag(sim)
    interval = 600
    avg = sim.read([tag], START, END, SampleType.AVG, interval)[tag][1]
    vmin = sim.read([tag], START, END, SampleType.MIN, interval)[tag][1]
    vmax = sim.read([tag], START, END, SampleType.MAX, interval)[tag][1]
    assert len(avg) == len(vmin) == len(vmax) == 144
    assert np.all(vmin <= avg + 1e-9)
    assert np.all(avg <= vmax + 1e-9)


def test_multiple_tags_differ(sim):
    tags = [t.name for t in sim.search_tags("", limit=3)]
    data = sim.read(tags, START, END, SampleType.INT, 300)
    assert set(data) == set(tags)
    v0, v1 = data[tags[0]][1], data[tags[1]][1]
    assert not np.allclose(v0, v1)


def test_unknown_tag_raises(sim):
    with pytest.raises(KeyError):
        sim.read(["NOPE-1"], START, END, SampleType.INT, 60)


def test_controller_tags_have_maps(sim):
    tic = sim.tag_info("TIC-102")
    # The trended maps come first; the default map is the one addressed by the
    # bare tag name, so its position matters.
    assert [m.name for m in tic.maps][:3] == ["CA_I PV", "CA_I SP", "CA_I OUTPUT"]
    assert tic.maps[2].unit == "%"
    # Real tags carry many more maps than are ever plotted.
    assert len(tic.maps) > 10
    ti = sim.tag_info("TI-101")
    assert [m.name for m in ti.maps][0] == "IP_AnalogMap"
    assert len(ti.maps) > 1


def test_default_map_equals_explicit(sim):
    bare = sim.read(["TIC-102"], START, END, SampleType.INT, 300)["TIC-102"]
    explicit = sim.read(["TIC-102;CA_I PV"], START, END, SampleType.INT, 300)[
        "TIC-102;CA_I PV"
    ]
    np.testing.assert_array_equal(bare[1], explicit[1])


def test_maps_give_distinct_signals(sim):
    data = sim.read(
        ["TIC-102;CA_I PV", "TIC-102;CA_I OUTPUT"], START, END, SampleType.INT, 300
    )
    pv = data["TIC-102;CA_I PV"][1]
    out = data["TIC-102;CA_I OUTPUT"][1]
    assert not np.allclose(pv, out)
    assert out.min() >= 0.0 and out.max() <= 100.0


def test_setpoint_map_is_stepwise(sim):
    sp = sim.read(["TIC-102;CA_I SP"], START, END, SampleType.INT, 60)["TIC-102;CA_I SP"]
    # Values are held in 2 h blocks, so a day of 1-min samples has few levels.
    assert len(np.unique(sp[1])) <= 13


def test_unknown_map_raises(sim):
    with pytest.raises(KeyError):
        sim.read(["TIC-102;NO_SUCH_MAP"], START, END, SampleType.INT, 60)
    with pytest.raises(KeyError):
        sim.read(["TI-101;CA_I OUTPUT"], START, END, SampleType.INT, 60)


def test_too_many_points_raises(sim):
    tag = first_tag(sim)
    with pytest.raises(ValueError):
        sim.read([tag], START, START + 400 * 24 * 3600, SampleType.INT, 0.1)


def test_get_description(sim):
    assert sim.get_description("TIC-102") == "Reactor A temperature controller"
    # The map part is ignored: a description belongs to the tag.
    assert sim.get_description("TIC-102;CA_I OUTPUT") == sim.get_description("TIC-102")
