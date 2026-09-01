# IP21 Explorer

A fast, browser-based trend viewer for AspenTech IP21 process data — built as a
snappier alternative to Aspen Process Explorer. The whole application is a
single Python server (FastAPI) serving a static frontend, so it runs anywhere
Python runs; no Node, no build step, no external CDNs.

![Stack](https://img.shields.io/badge/stack-FastAPI%20%2B%20uPlot-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Source: [github.com/jonasdig/ip21-explorer](https://github.com/jonasdig/ip21-explorer)

## Features

- **Full-screen plot per tab** — multiple tabs, each with its own tag set;
  per-tab *Link time* membership shares a common time range between the tabs
  that opt in
- **Per-tag colour**: tags get distinct colorblind-friendly colors
  automatically; pick another from the palette — or any colour at all — in the
  tag's settings popover
- **Tag search** with autocomplete over tag names *and* descriptions, so
  half-remembered tags still turn up: pair part of the tag with a word from its
  description (`TIC-24 temperature`) and both must match, `*` wildcards
  allowed. Names always decide which tags are looked at — IP21 matches those
  server-side in one request, while a description costs one request per tag — so descriptions are checked
  only among the name matches, capped by `IP21_DESC_SCAN_MAX` and cached. A
  word on its own that matches no tag name finds nothing, rather than reading
  every description in the historian
- **Individual y-scale per tag** (auto or manual min/max); Process
  Explorer-style stacked axis gutter by default (all tags share a few
  gridlines, values stacked in tag colors), with a toggle cycling to
  single-axis and side-by-side axes modes
- **Time presets** (1h–30d), custom ranges, drag-select and mouse-wheel zoom
  with automatic re-fetch, zoom-back history (Esc), a red **Now** button, and
  a right-click menu (add scooter, delete scooters, zoom back, reset zoom)
- **Sampling types per tag**: interpolated, average, min, max with
  an aggregate interval (or Auto) — individually per tag, like Process
  Explorer's Type/Period columns. Intervals start at 4 s, the finest sample
  IP21 stores
- **IP21 record maps**: plot `TAG;MAP` (e.g. `TIC-102;OUTPUT`); the map
  is chosen in each tag's settings popover. The same tag can be plotted several
  times — adding it again moves the copy onto its next unused map, so a
  controller's PV, SP and OUT can be compared side by side
- **Favourite maps**: real tags carry 30+ record maps but only a few matter —
  star them in a tag's settings to sort them to the top everywhere and to
  decide which map a duplicated tag takes next. Stored server-side in
  `ip21.env` (`IP21_FAVORITE_MAPS`). Map units are looked up only for the map
  actually in use, so opening the dropdown costs one request, not one per map
- **Copy/paste tags**: right-click a tag for copy, duplicate, paste and remove,
  or use Ctrl+C / Ctrl+V — tags travel as JSON on the system clipboard, so they
  can be pasted between tabs, windows and machines
- **Scooters**: any number of draggable value cursors with per-tag readouts;
  double-click the chart to add one, drag the readout box vertically if it
  covers the trends
- **Live mode**: the green **Live** button follows now, ticking every 10 s but
  only refetching once the aggregate interval can hold a new point — so a wide
  window refreshes rarely (every 5 min at 3 days) and costs the historian far
  less than a narrow one. New plots start live, zooming to an absolute window
  pauses it, and a saved plot reopens with the live state it was saved with.
  Live steps aside only when a *manually* pinned interval would make one
  refresh ask for more than 20 000 points per tag
- **Step rendering per tag** (hold last value) for discrete/status signals,
  toggled in the tag's settings popover
- **CSV export** from the chart's right-click menu: the visible window or the
  span between two scooters (semicolon-separated, decimal comma, Excel-ready)
- **Average between scooters**: per-tag average/min/max/sample count over the
  scooter span, from the same right-click menu
- **24h clock** throughout, timestamps as dd.mm.yyyy
- **Save/open** named plot configurations (stored as JSON on the server), with
  free-text labels for grouping and filtering them; **Open all** opens every
  plot the dialog is listing, one tab each
- **Import/export**: download a single plot or every listed plot as one file,
  and import either back again — a saved plot restores exactly, down to
  scooters, colors, scales, maps, sampling and the time range
- **Share links**: the Share button copies a link that carries the whole plot
  in the URL fragment, so nothing is stored server-side
- **Simulator source** with deterministic, realistic trends for development
  without plant access

All chart interaction (cursor, scooters, pan/zoom preview) happens on already
loaded data with zero server round-trips; the server is only hit when the
range or sampling changes, with stale requests cancelled.

## Installation

Both ways of running it start from a clone, so that `git pull` is all an
upgrade takes:

```bash
git clone https://github.com/jonasdig/ip21-explorer.git
cd ip21-explorer
```

### Development (simulator data)

No plant access needed — the built-in simulator produces deterministic trends.

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m ip21_explorer.main --source sim --port 8021
```

Open http://localhost:8021. Add `--latency 0.5` to simulate a slow historian.

Run the tests with:

```bash
.venv/bin/pytest
```

### Live IP21 data

Requires network access to an aspenONE ProcessData REST endpoint
(the same one Aspen Process Explorer's web components use).

```bash
pip install -e ".[aspen]"
```

The `-e` matters: installed editable, the package runs straight from the clone,
so upgrading is a `git pull` and a restart.

Without cloning at all, if you only ever want to install and not follow the
repository:

```bash
pip install "ip21-explorer[aspen] @ git+https://github.com/jonasdig/ip21-explorer.git"
```

Upgrading then means running that same command again, so the clone above is the
better bet if you expect updates.

## Configuration (live IP21 data)

Copy [ip21.env.example](ip21.env.example) to `ip21.env` next to where you start
the server and fill in the endpoint and datasource; the file is picked up
automatically (or pass `--config myfile.env`). Then start with:

```bash
python -m ip21_explorer.main
```

Plain environment variables still work and override the file:

```bash
set IP21_ASPEN_URL=https://<server>/ProcessData/AtProcessDataREST.dll
set IP21_ASPEN_DATASOURCE=<your IP21 datasource name>

python -m ip21_explorer.main --source aspen --port 8021
```

If the datasource name is unknown, list what the server offers:

```bash
python -m ip21_explorer.main --source aspen --list-sources
```

Data access goes through [tagreader-python](https://github.com/equinor/tagreader-python)
(`imstype="aspenone"`), which handles authentication (NTLM/Kerberos via the
logged-in Windows user), the REST protocol, and `TAG;MAP` addressing.

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `IP21_VERIFY_SSL=0` | Skip TLS verification when a corporate proxy breaks it |
| `IP21_TZ` | Timezone the server reports timestamps in (default `Europe/Oslo`) |
| `IP21_PLOTS_DIR` | Where saved plots are stored (default `./plots`) |
| `IP21_DESC_SCAN_MAX` | How many name-matched tags get a description lookup (default `100`, `0` disables); each uncached one costs a request |
| `IP21_HOST`, `IP21_PORT` | Bind address (default `127.0.0.1:8021`) |

Saved plots are written to `./plots/*.json` (override with `IP21_PLOTS_DIR`).

## Upgrading to the latest version

From the clone:

```bash
cd ip21-explorer
git pull
pip install -e ".[aspen]"
```

Then restart the server. The reinstall picks up any dependency changes; for a
pure frontend/backend code change a plain `git pull` + restart is enough, since
the package is installed editable (`-e`). Saved plots (`plots/*.json`), your
`ip21.env`, and the per-browser state (open tabs, colors, scooters) are not
touched by an upgrade — reload the page with Ctrl+F5 if the browser serves a
stale `app.js` from cache.

To see what changed:

```bash
git log --oneline HEAD@{1}..HEAD
```

## Architecture

```
src/ip21_explorer/
  main.py              FastAPI app: /api/tags, /api/data, /api/plots + static files
  config.py            Settings from env vars / CLI
  sources/
    base.py            DataSource protocol, SampleType (INT/AVG/MIN/MAX)
    simulator.py       Deterministic synthetic trends (dev/testing)
    aspen.py           tagreader-backed live source (work machine)
  static/              Vanilla JS frontend, vendored uPlot (MIT, ~50 KB)
tests/                 Simulator and API tests (pytest)
```

The two data sources implement the same small protocol, so the entire app is
testable against the simulator; `aspen.py` is a thin mapping kept deliberately
free of logic.

## License

MIT — see [LICENSE](LICENSE).

`src/ip21_explorer/static/vendor/` bundles [uPlot](https://github.com/leeoniya/uPlot)
(MIT, see [LICENSE-uplot.txt](src/ip21_explorer/static/vendor/LICENSE-uplot.txt)).
Data access on live systems goes through
[tagreader-python](https://github.com/equinor/tagreader-python) (MIT).

This project is not affiliated with, endorsed by, or sponsored by Aspen
Technology, Inc. IP.21, InfoPlus.21, and Aspen are trademarks of Aspen
Technology, Inc.
