"""Runtime configuration, from an env file, environment variables and/or CLI."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import List


@dataclass
class Settings:
    source: str = "sim"  # "sim" or "aspen"
    sim_latency_s: float = 0.0
    aspen_url: str = ""  # e.g. https://aspenserver/ProcessData/AtProcessDataREST.dll
    aspen_datasource: str = ""  # IP21 datasource name on the server
    verify_ssl: bool = True  # set false if a corporate proxy breaks TLS verification
    timezone: str = "Europe/Oslo"  # timezone the IP21 server reports timestamps in
    plots_dir: Path = field(default_factory=lambda: Path("plots"))
    # Record maps listed first in the map dropdown, in this order. Real tags
    # have 30+ maps but only a few are used.
    favorite_maps: List[str] = field(default_factory=list)
    # How many of the tags matched by name get a description lookup, when a
    # query pairs part of a tag name with a description word. Each uncached
    # description is one IP21 request (8 in parallel), then it stays cached.
    desc_scan_max: int = 100
    # How many tags of one data request are read from IP21 at the same time.
    # tagreader would otherwise read them one after another; 1 restores that.
    read_workers: int = 4
    # Rows IP21 returns at most for one aggregate (AVG/MIN/MAX) read; longer
    # reads are split into windows of this many rows.
    agg_max_rows: int = 10_000
    # Where favourites are written back to; set by cli() to the file in use.
    config_file: Path = field(default_factory=lambda: Path("ip21.env"))

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            source=os.environ.get("IP21_SOURCE", "sim"),
            sim_latency_s=float(os.environ.get("IP21_SIM_LATENCY", "0")),
            aspen_url=os.environ.get("IP21_ASPEN_URL", ""),
            aspen_datasource=os.environ.get("IP21_ASPEN_DATASOURCE", ""),
            verify_ssl=os.environ.get("IP21_VERIFY_SSL", "1").lower()
            not in ("0", "false", "no"),
            timezone=os.environ.get("IP21_TZ", "Europe/Oslo"),
            plots_dir=Path(os.environ.get("IP21_PLOTS_DIR", "plots")),
            favorite_maps=parse_list(os.environ.get("IP21_FAVORITE_MAPS", "")),
            desc_scan_max=int(os.environ.get("IP21_DESC_SCAN_MAX", "100")),
            read_workers=int(os.environ.get("IP21_READ_WORKERS", "4")),
            agg_max_rows=int(os.environ.get("IP21_AGG_MAX_ROWS", "10000")),
        )


def parse_list(value: str) -> List[str]:
    """Comma-separated setting to a list, blanks dropped."""
    return [item.strip() for item in value.split(",") if item.strip()]


def load_env_file(path: Path) -> None:
    """Read KEY=VALUE lines into the environment (real env vars win).

    A minimal .env reader so a single `ip21.env` file can hold the whole
    server configuration without adding a dependency. Lines starting with
    `#` and blank lines are ignored; surrounding quotes on values are
    stripped.
    """
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            os.environ.setdefault(key, value)


def write_env_setting(path: Path, key: str, value: str, comment: str = "") -> None:
    """Set KEY=value in an env file, leaving every other line untouched.

    load_env_file only reads, and drops comments and formatting on the way, so
    it cannot be reused to write the file back.
    """
    lines = path.read_text().splitlines() if path.exists() else []
    for i, raw in enumerate(lines):
        stripped = raw.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        if stripped.partition("=")[0].strip() == key:
            lines[i] = f"{key}={value}"
            break
    else:
        if lines and lines[-1].strip():
            lines.append("")
        if comment:
            lines.append(f"# {comment}")
        lines.append(f"{key}={value}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n")
