import pytest
from fastapi.testclient import TestClient

from ip21_explorer.main import auto_interval, create_app
from ip21_explorer.sources.simulator import SimulatorSource

START = "2026-08-01T00:00:00Z"
END = "2026-08-02T00:00:00Z"


@pytest.fixture(scope="module")
def client():
    app = create_app(source=SimulatorSource())
    return TestClient(app)


def test_tag_search(client):
    r = client.get("/api/tags", params={"q": "temperature"})
    assert r.status_code == 200
    body = r.json()
    tags = body["tags"]
    assert tags
    assert {"name", "description", "unit", "maps"} <= set(tags[0])
    # The simulator answers in full, so it never explains a limitation.
    assert body["note"] is None


def test_tag_search_includes_maps(client):
    r = client.get("/api/tags", params={"q": "temperature controller"})
    tag = r.json()["tags"][0]
    assert tag["name"].startswith("TIC-")
    assert [m["name"] for m in tag["maps"]][:3] == ["CA_I PV", "CA_I SP", "CA_I OUTPUT"]
    assert tag["maps"][2]["unit"] == "%"


def test_maps_endpoint(client):
    r = client.get("/api/maps", params={"tag": "TIC-102"})
    assert r.status_code == 200
    names = [m["name"] for m in r.json()["maps"]]
    # Default map first, then the rest of the record's maps.
    assert names[:3] == ["CA_I PV", "CA_I SP", "CA_I OUTPUT"]
    assert "CA_I HI_LIM" in names


def test_maps_endpoint_accepts_tag_with_map(client):
    r = client.get("/api/maps", params={"tag": "TIC-102;CA_I OUTPUT"})
    assert r.status_code == 200
    assert len(r.json()["maps"]) == len(
        client.get("/api/maps", params={"tag": "TIC-102"}).json()["maps"]
    )


def test_maps_endpoint_unknown_tag(client):
    r = client.get("/api/maps", params={"tag": "NOPE-1"})
    assert r.status_code == 404


def test_read_tag_with_map(client):
    r = client.get(
        "/api/data",
        params={
            "tags": "TIC-102;CA_I OUTPUT",
            "start": START,
            "end": END,
            "interval": 300,
        },
    )
    assert r.status_code == 200
    assert "TIC-102;CA_I OUTPUT" in r.json()["series"]


def test_tag_search_empty_query_lists_tags(client):
    r = client.get("/api/tags")
    assert r.status_code == 200
    assert len(r.json()["tags"]) == 50


def test_read_interpolated(client):
    tag = client.get("/api/tags").json()["tags"][0]["name"]
    r = client.get(
        "/api/data",
        params={"tags": tag, "start": START, "end": END, "sample": "INT", "interval": 300},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["sample"] == "INT"
    assert body["interval_s"] == 300
    series = body["series"][tag]
    assert len(series["t"]) == len(series["v"]) == 24 * 12 + 1


def test_read_auto_interval(client):
    tags = [t["name"] for t in client.get("/api/tags").json()["tags"][:3]]
    r = client.get(
        "/api/data",
        params={
            "tags": ",".join(tags),
            "start": START,
            "end": END,
            "sample": "AVG",
            "interval": "auto",
            "points": 1000,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert set(body["series"]) == set(tags)
    # 24 h / 1000 points -> 86.4 s -> next nice interval is 120 s
    assert body["interval_s"] == 120


def test_epoch_timestamps_accepted(client):
    tag = client.get("/api/tags").json()["tags"][0]["name"]
    r = client.get(
        "/api/data",
        params={
            "tags": tag,
            "start": "1756000000",
            "end": "1756003600",
            "interval": 60,
        },
    )
    assert r.status_code == 200


def test_invalid_sample_type(client):
    r = client.get(
        "/api/data",
        params={"tags": "TI-101.PV", "start": START, "end": END, "sample": "BOGUS"},
    )
    assert r.status_code == 422


def test_unknown_tag_404(client):
    r = client.get(
        "/api/data",
        params={"tags": "NOPE-1.PV", "start": START, "end": END},
    )
    assert r.status_code == 404


def test_end_before_start(client):
    r = client.get(
        "/api/data",
        params={"tags": "TI-101.PV", "start": END, "end": START},
    )
    assert r.status_code == 422


def test_auto_interval_function():
    # IP21 stores nothing finer than a 4 s sample, so 4 s is the floor however
    # short the span or however many points are asked for.
    assert auto_interval(3600, 1500) == 4  # 2.4 s target -> 4 s
    assert auto_interval(7 * 86400, 1500) == 600
    assert auto_interval(10, 1500) == 4


# -- saved plots -------------------------------------------------------------


@pytest.fixture
def plots_client(tmp_path):
    from ip21_explorer.config import Settings

    settings = Settings(plots_dir=tmp_path / "plots")
    return TestClient(create_app(source=SimulatorSource(), settings=settings))


def _config(name="Test plot", labels=None):
    return {
        "version": 3,
        "name": name,
        "labels": labels or [],
        "tags": [{"name": "TI-101", "map": None, "color": "#4FC3F7"}],
        "axisMode": "stacked",
        "range": {"preset": "24h"},
    }


def test_plots_empty_before_any_save(plots_client):
    assert plots_client.get("/api/plots").json() == {"plots": []}


def test_plot_save_list_get_delete(plots_client):
    r = plots_client.put("/api/plots/Reactor A", json=_config("Reactor A", ["reactor"]))
    assert r.status_code == 200

    listing = plots_client.get("/api/plots").json()["plots"]
    assert [p["name"] for p in listing] == ["Reactor A"]
    assert listing[0]["labels"] == ["reactor"]
    assert listing[0]["modified"] > 0

    got = plots_client.get("/api/plots/Reactor A").json()
    assert got["tags"][0]["name"] == "TI-101"
    assert got["version"] == 3

    assert plots_client.delete("/api/plots/Reactor A").status_code == 200
    assert plots_client.get("/api/plots").json() == {"plots": []}
    assert plots_client.get("/api/plots/Reactor A").status_code == 404


def test_plot_listing_sorted_and_labels_optional(plots_client):
    plots_client.put("/api/plots/beta", json=_config("beta", ["b"]))
    plots_client.put("/api/plots/Alpha", json={"version": 2, "tags": []})
    listing = plots_client.get("/api/plots").json()["plots"]
    assert [p["name"] for p in listing] == ["Alpha", "beta"]
    assert listing[0]["labels"] == []  # a v2 file has no labels


def test_plot_name_is_validated(plots_client):
    # Reaches the route but fails the name pattern.
    assert plots_client.put("/api/plots/bad*name", json=_config()).status_code == 422
    # Parentheses are allowed, so imports can de-duplicate as "Name (2)".
    assert plots_client.put("/api/plots/Plot (2)", json=_config()).status_code == 200
    # A path separator never matches the single-segment route, and ".." is
    # normalized away before routing, so traversal cannot reach the handler.
    for path in ("/api/plots/sub/name", "/api/plots/.."):
        assert plots_client.put(path, json=_config()).status_code in (404, 405)
    assert plots_client.get("/api/plots/nope").status_code == 404


def test_repeated_tag_in_data_request_is_deduped(client):
    r = client.get(
        "/api/data",
        params={"tags": "TI-101,TI-101", "start": START, "end": END},
    )
    assert r.status_code == 200
    assert list(r.json()["series"]) == ["TI-101"]


def test_unit_endpoint(client):
    assert client.get("/api/unit", params={"tag": "TIC-102;CA_I OUTPUT"}).json() == {
        "unit": "%"
    }
    # A bare tag resolves to its default map.
    assert client.get("/api/unit", params={"tag": "TIC-102"}).json() == {"unit": "degC"}


def test_unit_endpoint_unknown(client):
    assert client.get("/api/unit", params={"tag": "NOPE-1"}).status_code == 404
    assert client.get("/api/unit", params={"tag": "TIC-102;NOPE"}).status_code == 404


def test_description_endpoint(client):
    r = client.get("/api/description", params={"tag": "TIC-102"})
    assert r.json() == {"description": "Reactor A temperature controller"}
    # A description belongs to the tag, so the map part makes no difference.
    assert client.get(
        "/api/description", params={"tag": "TIC-102;CA_I OUTPUT"}
    ).json() == {"description": "Reactor A temperature controller"}


def test_description_endpoint_unknown(client):
    assert client.get("/api/description", params={"tag": "NOPE-1"}).status_code == 404


# -- favourite maps ----------------------------------------------------------


@pytest.fixture
def favorites_client(tmp_path):
    from ip21_explorer.config import Settings

    settings = Settings(config_file=tmp_path / "ip21.env")
    client = TestClient(create_app(source=SimulatorSource(), settings=settings))
    return client, settings


def test_favorites_default_to_empty(favorites_client):
    client, _ = favorites_client
    assert client.get("/api/favorites").json() == {"favorites": []}


def test_favorites_are_stored_and_returned_in_order(favorites_client):
    client, settings = favorites_client
    r = client.put("/api/favorites", json={"favorites": ["CA_I OUTPUT", " CA_I SP ", ""]})
    assert r.status_code == 200
    assert r.json() == {"favorites": ["CA_I OUTPUT", "CA_I SP"]}
    # Served from memory without re-reading the file...
    assert client.get("/api/favorites").json()["favorites"] == ["CA_I OUTPUT", "CA_I SP"]
    # ...and written to the env file in use.
    assert "IP21_FAVORITE_MAPS=CA_I OUTPUT,CA_I SP" in settings.config_file.read_text()


def test_favorites_survive_a_reload_of_the_env_file(favorites_client, monkeypatch):
    from ip21_explorer.config import Settings, load_env_file

    client, settings = favorites_client
    client.put("/api/favorites", json={"favorites": ["CA_I SP"]})

    monkeypatch.delenv("IP21_FAVORITE_MAPS", raising=False)
    load_env_file(settings.config_file)
    assert Settings.from_env().favorite_maps == ["CA_I SP"]


@pytest.mark.parametrize("path", ["/", "/main.js", "/style.css"])
def test_static_files_are_revalidated(client, path):
    # The frontend is loaded as separate modules with no build step; a stale
    # cached module next to a fresh one would break its imports.
    r = client.get(path)
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"


def test_unchanged_static_file_is_a_304(client):
    first = client.get("/style.css")
    again = client.get("/style.css", headers={"if-none-match": first.headers["etag"]})
    assert again.status_code == 304
    assert again.headers["cache-control"] == "no-cache"


# -- formulas computed on the server ------------------------------------------

def _formula(item_id, expr, **refs):
    return {"id": item_id, "expr": expr, "refs": refs}


def test_compute_formulas(client):
    tag = {"tag": "TI-101", "sample": "INT", "interval": "300", "step": False}
    body = {"start": START, "end": END, "points": 1500, "items": [
        _formula("ok", "=[TI-101] * 2", **{"TI-101": tag}),
        _formula("bad", "=[XX-999] + 1", **{"XX-999": {**tag, "tag": "XX-999"}}),
        _formula("typo", "=[TI-101] +", **{"TI-101": tag}),
    ]}
    r = client.post("/api/compute", json=body)
    assert r.status_code == 200
    out = r.json()
    ok = out["series"]["ok"]
    assert len(ok["t"]) == 289 and ok["step"] is False
    raw = client.get("/api/data", params={"tags": "TI-101", "start": START, "end": END,
                                          "interval": "300"}).json()["series"]["TI-101"]
    assert ok["v"][:5] == pytest.approx([2 * v for v in raw["v"][:5]], abs=1e-5)
    assert "ok" not in out["errors"]
    assert out["errors"]["bad"]["hard"] and "XX-999" in out["errors"]["bad"]["text"]
    assert out["errors"]["typo"] == {"text": "the expression ends too early", "hard": True}


def test_compute_reuses_what_data_just_read():
    class Counting(SimulatorSource):
        calls = 0

        def read(self, *args, **kwargs):
            Counting.calls += 1
            return super().read(*args, **kwargs)

    local = TestClient(create_app(source=Counting()))
    params = {"tags": "PI-103", "start": START, "end": END, "interval": "600"}
    assert local.get("/api/data", params=params).status_code == 200
    body = {"start": START, "end": END, "items": [_formula(
        "f", "=[PI-103] / 10",
        **{"PI-103": {"tag": "PI-103", "sample": "INT", "interval": "600"}})]}
    assert local.post("/api/compute", json=body).status_code == 200
    assert Counting.calls == 1


def test_compute_rejects_a_bad_window(client):
    r = client.post("/api/compute", json={"start": END, "end": START, "items": []})
    assert r.status_code == 422


def test_functions_endpoint_lists_the_groups(client):
    body = client.get("/api/functions").json()
    groups = {g["name"]: g["functions"] for g in body["groups"]}
    assert list(groups)[0] == "Basic"
    assert {"Smooth", "Detect", "Resample"} <= set(groups)
    basic = {f["name"]: f for f in groups["Basic"]}
    assert basic["avg"]["variadic"] and basic["total"]["step"]
    assert [p["name"] for p in basic["total"]["params"]] == ["period", "resolution"]
    sg = next(f for f in groups["Smooth"] if f["name"] == "smooth.sg")
    assert sg["inputs"] == 1 and sg["short"] and sg["long"]
    window = sg["params"][0]
    assert window["name"] == "window_length" and window["kind"] == "number"
    assert window["default"] is None and window["choices"] == [] and not window["required"]
    assert window["label"] == "Window" and window["help"]
    # A choice the library spells with spaces is one word in a formula, and
    # the dropdown is told what to call it.
    check = next(f for g in body["groups"] for f in g["functions"]
                 if f["name"] == "ts_utils.logical_check")
    operation = check["params"][0]
    assert "greater_than" in operation["choices"]
    assert operation["choiceLabels"]["greater_than"] == "Greater than"
    # An input a block has to tell apart from the others carries its name.
    assert [i["name"] for i in check["inputNames"]] == [
        "value_1", "value_2", "value_true", "value_false"]
