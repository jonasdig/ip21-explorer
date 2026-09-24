"""FastAPI application: JSON API for trend data plus the static frontend."""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import json
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from . import __version__
from .calc import CachedSource, auto_interval, compute
from .calc.catalog import as_json as functions_json
from .config import Settings, load_env_file, write_env_setting
from .sources.base import DataSource, SampleType
from .sources.simulator import SimulatorSource

STATIC_DIR = Path(__file__).parent / "static"

logger = logging.getLogger("ip21_explorer")


class RevalidatingStaticFiles(StaticFiles):
    """Static files the browser must check with the server before reusing.

    The frontend is a set of ES modules loaded without a build step, so a
    heuristically cached copy can mix old and new modules and break imports.
    no-cache still lets the browser keep its copy - it just asks first, and an
    unchanged file costs a 304.
    """

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


def parse_time(value: str, name: str) -> float:
    """Accept epoch seconds (numeric) or ISO 8601 timestamps."""
    try:
        return float(value)
    except ValueError:
        pass
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        raise HTTPException(422, f"invalid {name!r} timestamp: {value}")


def _jsonable(values) -> List[Optional[float]]:
    """Round to trim JSON size and convert NaN/inf to null."""
    return [
        None if (math.isnan(v) or math.isinf(v)) else round(v, 6)
        for v in values.tolist()
    ]


def create_app(source: Optional[DataSource] = None, settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or Settings.from_env()
    if source is None:
        source = make_source(settings)
    # Every read goes through a short memory, so the formulas computed right
    # after a plot's own fetch - and the block editor's previews - find the
    # tags already read instead of asking the historian again.
    source = CachedSource(source)

    app = FastAPI(title="IP21 Explorer")

    @app.get("/api/tags")
    async def search_tags(q: str = "", limit: int = Query(50, ge=1, le=500)):
        def search():
            # The note is read in the same thread as the search that set it.
            hits = source.search_tags(q, limit)
            return hits, getattr(source, "search_note", None)

        tags, note = await asyncio.to_thread(search)
        return {
            "tags": [
                {
                    "name": t.name,
                    "description": t.description,
                    "unit": t.unit,
                    "maps": [{"name": m.name, "unit": m.unit} for m in t.maps],
                }
                for t in tags
            ],
            # Set when the answer is incomplete, e.g. a truncated description
            # scan; the dropdown shows it as a footer.
            "note": note,
        }

    @app.get("/api/maps")
    async def get_maps(tag: str):
        """Record maps of one tag, looked up on demand (one server call)."""
        getter = getattr(source, "get_maps", None)
        if getter is None:
            return {"maps": []}
        try:
            maps = await asyncio.to_thread(getter, tag)
        except KeyError as exc:
            raise HTTPException(404, str(exc))
        return {"maps": [{"name": m.name, "unit": m.unit} for m in maps]}

    @app.get("/api/unit")
    async def get_unit(tag: str):
        """Unit of one "TAG;MAP", looked up only once a map has been chosen."""
        getter = getattr(source, "get_unit", None)
        if getter is None:
            return {"unit": ""}
        try:
            unit = await asyncio.to_thread(getter, tag)
        except KeyError as exc:
            raise HTTPException(404, str(exc))
        return {"unit": unit}

    @app.get("/api/description")
    async def get_description(tag: str):
        """Description of one tag, for the description label modes."""
        getter = getattr(source, "get_description", None)
        if getter is None:
            return {"description": ""}
        try:
            description = await asyncio.to_thread(getter, tag)
        except KeyError as exc:
            raise HTTPException(404, str(exc))
        return {"description": description}

    @app.get("/api/data")
    async def read_data(
        tags: str,
        start: str,
        end: str,
        sample: str = "INT",
        interval: str = "auto",
        points: int = Query(1500, ge=10, le=20000),
    ):
        # dict.fromkeys keeps order while dropping repeats: a repeated tag
        # would make tagreader return a two-column frame for it.
        tag_list = list(dict.fromkeys(t for t in tags.split(",") if t))
        if not tag_list:
            raise HTTPException(422, "no tags given")
        # Formula rows go to /api/compute; one arriving here means the frontend
        # leaked an expression, and failing plainly beats an opaque complaint
        # from the historian.
        formulas = [t for t in tag_list if t.lstrip().startswith("=")]
        if formulas:
            raise HTTPException(422, f"not a tag name: {formulas[0]}")
        start_s = parse_time(start, "start")
        end_s = parse_time(end, "end")
        if end_s <= start_s:
            raise HTTPException(422, "end must be after start")
        try:
            sample_type = SampleType(sample.upper())
        except ValueError:
            valid = ", ".join(s.value for s in SampleType)
            raise HTTPException(422, f"invalid sample type {sample!r}; use one of {valid}")

        if interval == "auto":
            interval_s = auto_interval(end_s - start_s, points)
        else:
            try:
                interval_s = float(interval)
            except ValueError:
                raise HTTPException(422, f"invalid interval: {interval}")
            if interval_s <= 0:
                raise HTTPException(422, "interval must be positive")

        began = time.monotonic()
        try:
            series = await asyncio.to_thread(
                source.read, tag_list, start_s, end_s, sample_type, interval_s
            )
        except KeyError as exc:
            # KeyError's str() is the repr of its argument, quotes and all, and
            # this message is shown to the user as it stands.
            raise HTTPException(404, exc.args[0] if exc.args else "unknown tag")
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        # One line per trend request, so a slow plot can be traced to the
        # historian (or ruled out) from the server window rather than guessed.
        logger.info(
            "read %d tag%s %s/%gs in %.1f s", len(tag_list),
            "" if len(tag_list) == 1 else "s", sample_type.value, interval_s,
            time.monotonic() - began,
        )

        return {
            "sample": sample_type.value,
            "interval_s": interval_s,
            "series": {
                tag: {"t": _jsonable(t_arr), "v": _jsonable(v_arr)}
                for tag, (t_arr, v_arr) in series.items()
            },
        }

    @app.get("/api/functions")
    async def list_functions():
        """Every function a formula may call, by group: what the block editor
        builds its palette and help from, and what the browser's parser
        checks a half-written formula against."""
        return await asyncio.to_thread(functions_json)

    @app.post("/api/compute")
    async def compute_formulas(body: Dict[str, Any] = Body(...)):
        """Formula rows: {start, end, points, items} -> a series or an error per
        item. One formula failing never takes the others down with it."""
        start_s = parse_time(str(body.get("start", "")), "start")
        end_s = parse_time(str(body.get("end", "")), "end")
        if end_s <= start_s:
            raise HTTPException(422, "end must be after start")
        items = body.get("items") or []
        if not isinstance(items, list) or not all(isinstance(i, dict) and "id" in i for i in items):
            raise HTTPException(422, "items must be a list of {id, expr, refs}")
        points = int(body.get("points") or 1500)
        points = max(10, min(20000, points))

        began = time.monotonic()
        results = await asyncio.to_thread(
            compute, source, items, start_s, end_s, points, settings.timezone)
        logger.info("computed %d formula%s in %.1f s", len(items),
                    "" if len(items) == 1 else "s", time.monotonic() - began)
        series, errors = {}, {}
        for item_id, result in results.items():
            if len(result.t):
                series[item_id] = {"t": _jsonable(result.t), "v": _jsonable(result.v),
                                   "step": result.step}
            if result.error:
                errors[item_id] = {"text": result.error[0], "hard": result.error[1]}
        return {"series": series, "errors": errors}

    # -- favourite record maps ---------------------------------------------

    @app.get("/api/favorites")
    async def get_favorites():
        return {"favorites": settings.favorite_maps}

    @app.put("/api/favorites")
    async def put_favorites(favorites: List[str] = Body(..., embed=True)):
        """Store the favourite maps, in order, in the env file in use."""
        cleaned = [str(name).strip() for name in favorites if str(name).strip()]
        try:
            write_env_setting(
                settings.config_file,
                "IP21_FAVORITE_MAPS",
                ",".join(cleaned),
                comment="Record maps listed first in the map dropdown, in order.",
            )
        except OSError as exc:
            raise HTTPException(500, f"could not write {settings.config_file}: {exc}")
        settings.favorite_maps = cleaned
        return {"favorites": cleaned}

    # -- saved plot configurations -----------------------------------------

    # Parentheses are allowed so imports can de-duplicate as "Name (2)".
    plot_name_re = re.compile(r"^[\w][\w \-.()]{0,59}$")

    def plot_path(name: str) -> Path:
        if not plot_name_re.match(name):
            raise HTTPException(422, "invalid plot name (letters, digits, space, - _ . parentheses)")
        return settings.plots_dir / f"{name}.json"

    def plot_labels(path: Path) -> List[str]:
        """Labels stored in a plot file, for grouping in the open dialog."""
        try:
            labels = json.loads(path.read_text()).get("labels")
        except (OSError, ValueError):
            return []
        return [str(l) for l in labels] if isinstance(labels, list) else []

    @app.get("/api/plots")
    async def list_plots():
        if not settings.plots_dir.is_dir():
            return {"plots": []}
        plots = sorted(
            (
                {
                    "name": p.stem,
                    "modified": p.stat().st_mtime,
                    "labels": plot_labels(p),
                }
                for p in settings.plots_dir.glob("*.json")
            ),
            key=lambda p: p["name"].lower(),
        )
        return {"plots": plots}

    @app.get("/api/plots/{name}")
    async def get_plot(name: str):
        path = plot_path(name)
        if not path.is_file():
            raise HTTPException(404, f"no saved plot named {name!r}")
        return json.loads(path.read_text())

    @app.put("/api/plots/{name}")
    async def save_plot(name: str, config: Dict[str, Any] = Body(...)):
        path = plot_path(name)
        settings.plots_dir.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(config, indent=2))
        return {"saved": name}

    @app.delete("/api/plots/{name}")
    async def delete_plot(name: str):
        path = plot_path(name)
        if not path.is_file():
            raise HTTPException(404, f"no saved plot named {name!r}")
        path.unlink()
        return {"deleted": name}

    app.mount("/", RevalidatingStaticFiles(directory=STATIC_DIR, html=True), name="static")
    return app


def make_source(settings: Settings) -> DataSource:
    if settings.source == "sim":
        return SimulatorSource(latency_s=settings.sim_latency_s)
    if settings.source == "aspen":
        from .sources.aspen import AspenSource

        return AspenSource(
            url=settings.aspen_url,
            datasource=settings.aspen_datasource,
            verify_ssl=settings.verify_ssl,
            timezone_name=settings.timezone,
            desc_scan_max=settings.desc_scan_max,
            read_workers=settings.read_workers,
            agg_max_rows=settings.agg_max_rows,
        )
    raise ValueError(f"unknown source: {settings.source}")


def cli() -> None:
    parser = argparse.ArgumentParser(description="IP21 Explorer trend viewer")
    parser.add_argument("--source", choices=["sim", "aspen"], default=None)
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument(
        "--config", type=Path, default=None,
        help="env file with IP21_* settings (default: ./ip21.env if it exists)",
    )
    parser.add_argument(
        "--latency", type=float, default=None,
        help="artificial simulator latency in seconds, to test UI responsiveness",
    )
    parser.add_argument(
        "--list-sources", action="store_true",
        help="list the IP21 datasources the Aspen server offers, then exit",
    )
    args = parser.parse_args()

    # Settings resolve as CLI > environment > env file > defaults.
    config_file = args.config or Path("ip21.env")
    if args.config or config_file.exists():
        if not config_file.exists():
            raise SystemExit(f"Config file not found: {config_file}")
        load_env_file(config_file)

    settings = Settings.from_env()
    settings.config_file = config_file
    host = args.host or os.environ.get("IP21_HOST", "127.0.0.1")
    port = args.port or int(os.environ.get("IP21_PORT", "8021"))
    if args.source:
        settings.source = args.source
    if args.latency is not None:
        settings.sim_latency_s = args.latency

    if args.list_sources:
        list_aspen_sources(settings)
        return

    try:
        source = make_source(settings)
    except Exception as exc:
        raise SystemExit(f"Could not start the {settings.source} source: {exc}\n{SETUP_HINT}")

    import uvicorn

    # uvicorn configures only its own loggers; this lets ours through at INFO,
    # in the same shape as uvicorn's lines.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:     %(message)s")
    logging.getLogger("tagreader").setLevel(logging.WARNING)
    # Which build is actually running: the version carries the commit, so an
    # upgrade that did not take hold says so here.
    logger.info("IP21 Explorer %s, %s source", __version__, settings.source)

    uvicorn.run(
        create_app(source=source, settings=settings), host=host, port=port
    )


SETUP_HINT = """
For the Aspen source, check:
  IP21_ASPEN_URL        e.g. https://<server>/ProcessData/AtProcessDataREST.dll
  IP21_ASPEN_DATASOURCE the IP21 datasource name (list them with --list-sources)
  IP21_VERIFY_SSL=0     if a corporate proxy breaks TLS verification
  IP21_TZ               server timezone, default Europe/Oslo
  IP21_HOST, IP21_PORT  bind address, default 127.0.0.1:8021

Settings can live in an env file (KEY=VALUE per line) passed with --config,
or in ./ip21.env which is picked up automatically.
"""


def list_aspen_sources(settings: Settings) -> None:
    try:
        import tagreader
    except ImportError:
        raise SystemExit("tagreader is not installed; run: pip install ip21-explorer[aspen]")
    try:
        sources = tagreader.list_sources(
            imstype="aspenone",
            url=settings.aspen_url or None,
            verify_ssl=settings.verify_ssl,
        )
    except Exception as exc:
        raise SystemExit(f"Could not list datasources: {exc}\n{SETUP_HINT}")
    print("Available IP21 datasources:")
    for name in sources:
        print(f"  {name}")


if __name__ == "__main__":
    cli()
