# IP21 Explorer

A fast, browser-based trend viewer for AspenTech IP21 process data — built as a
snappier alternative to Aspen Process Explorer. The whole application is a
single Python server (FastAPI) serving a static frontend, so it runs anywhere
Python runs; no Node, no build step, no external CDNs.

![Stack](https://img.shields.io/badge/stack-FastAPI%20%2B%20uPlot-blue)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Source: [github.com/jonasdig/ip21-explorer](https://github.com/jonasdig/ip21-explorer)

## Features

### The plot

- **A full-screen plot per tab**, each with its own tags and time range; tabs
  that tick *Link time* share one range
- **Process Explorer-style value gutter**: all tags share a few gridlines, with
  every tag's value at each one printed in its own colour. Each tag has its own
  y-scale, automatic or a typed min/max
- **Line style per tag**: solid, dashed, dotted or dots only, thin to thick
- **Scooters**: draggable value cursors with per-tag readouts. Double-click the
  chart to add one
- **Time presets** (1h–30d), typed ranges, drag-select and wheel zoom with
  automatic re-fetch, `Esc` to zoom back, a **Now** button and **Live** mode
  that follows now and refreshes itself
- **Navigator band** under the chart: a wider span with the visible window
  drawn on it, to drag or stretch into place
- **XY plot**: tags against a shared x tag, each point coloured by when it is,
  so drift shows as the cloud moving rather than as trends compared by eye
- **CSV export** and **average between scooters** from the chart's right-click
  menu — the visible window or the span between two scooters
- 24-hour clock throughout, dates as `dd.mm.yyyy`

### Tags

- **Settings table** under the plot: one row per tag, everything editable in
  place while the trends stay visible — tag name, colour, record map, sampling
  type and interval, step, min/max, unit and description. `Tab` and `Enter`
  move between cells, the blank bottom row adds a tag by name, and rows drag to
  reorder. Drag a heading to move its column or its edge to size it; drag the
  table's top edge to trade height with the plot
- **Search** over tag names *and* descriptions, with `*` wildcards: pair part
  of a tag with a word from its description (`TIC-24 temperature`) and both
  must match. The list stays open while tags are picked, so one search can seed
  a whole plot
- **Sampling per tag**: interpolated, average, min or max over an interval (or
  Auto), like Process Explorer's Type and Period columns
- **Record maps**: plot `TAG;MAP` (e.g. `TIC-102;OUTPUT`), chosen per row. The
  same tag can be plotted several times, each on its own map. Star the maps you
  use to sort them to the top everywhere
- **Copy/paste** rows with the right-click menu or `Ctrl+C` / `Ctrl+V`; tags
  travel as JSON, so they can be pasted between tabs, windows and machines

### Formulas

- **A row whose tag name starts with `=`** is arithmetic over other tags:
  `=[TI-101] - [TI-201]`, `=([FI-104]*2)^0.5`, `=avg([TI-101],[TI-201])`, with
  `+ - * / ^`, parentheses and comparisons (`>` `<` `>=` `<=`, giving 1 or 0).
  References go in brackets, since every IP21 tag has a hyphen in it. A
  reference needs no row of its own, and formulas can refer to other formulas
  by their description
- **Totals per calendar period**: `=total([FI-104], day)` turns m3/h into m3
  per day, `=total([FI-104] > 5, day)` counts the hours a pump ran
- **A function library**: the basics (`abs`, `sqrt`, `min`, `max`, `avg`, …)
  plus [indsl](https://github.com/cognitedata/indsl) — filtering, smoothing,
  resampling, drift and outlier detection, data quality, forecasting,
  statistics and fluid-dynamics calculations, grouped by toolbox
- **Block editor**: the same formulas built by dragging blocks onto a canvas
  and wiring them together, with a live preview of the result or of any single
  block. Open it with the *ƒ* after a row's tag name. Every block explains
  itself on hover, and a *?* opens a fuller description where one helps. The
  text stays the truth: *Apply* writes the expression into the Tag field, and
  typing there rebuilds the blocks

### Keeping a plot

- **Save and open** named plot configurations on the server, with free-text
  labels for grouping them; **Open all** opens every listed plot in its own tab
- **Import/export** a single plot or a whole set as one file — a saved plot
  restores exactly, down to scooters, colours, scales, maps and sampling
- **Share links** carry the whole plot in the URL fragment, so nothing is
  stored server-side

## Installation

Python 3.11 or newer (the function library needs it); tested on 3.13.

```bash
git clone https://github.com/jonasdig/ip21-explorer.git
cd ip21-explorer
python3 -m venv .venv
.venv/bin/pip install -e ".[aspen]"   # ".[dev]" for the simulator and tests
```

Then start it, against the simulator or against live IP21:

```bash
.venv/bin/python -m ip21_explorer.main --source sim --port 8021   # simulator
.venv/bin/python -m ip21_explorer.main                            # live IP21
```

Open http://localhost:8021. The simulator needs no plant access and produces
deterministic trends; add `--latency 0.5` to imitate a slow historian. Live
IP21 needs network access to an aspenONE ProcessData REST endpoint (the same
one Aspen Process Explorer's web components use) — see Configuration below.

Run the tests with `.venv/bin/pytest`.

To install without a clone, into a virtual environment of your own:

```bash
pip install "ip21-explorer[aspen] @ git+https://github.com/jonasdig/ip21-explorer.git"
```

The server then starts as `ip21-explorer` (same options as above).

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
| `IP21_DESC_SCAN_MAX` | How many name-matched tags get a description lookup (default `100`, `0` disables) |
| `IP21_READ_WORKERS` | Tags of one request read from IP21 side by side (default `4`) |
| `IP21_AGG_MAX_ROWS` | Most rows IP21 returns for one Average/Minimum/Maximum read (default `10000`); longer reads are split |
| `IP21_HOST`, `IP21_PORT` | Bind address (default `127.0.0.1:8021`) |

Saved plots are written to `./plots/*.json` (override with `IP21_PLOTS_DIR`).

## Upgrading

From a clone:

```bash
git pull && .venv/bin/pip install -e ".[aspen]"
```

Installed straight from GitHub:

```bash
pip install --upgrade "ip21-explorer[aspen] @ git+https://github.com/jonasdig/ip21-explorer.git"
```

The version number comes from the git history, so every commit is a version
of its own and `--upgrade` sees it. A build from before that was true reports
`0.1.0` whatever it holds, and pip skips it as already installed; such an
install needs one

```bash
pip install --force-reinstall --no-deps "ip21-explorer @ git+https://github.com/jonasdig/ip21-explorer.git"
```

to get across, and upgrades normally afterwards. The version the server is
running is the first line it logs at startup.

Then restart the server. Saved plots (`plots/*.json`), your `ip21.env` and the
per-browser state (open tabs, colors, scooters) are untouched. The server tells
the browser to check for a newer frontend on every load, so a normal reload
picks it up — except the first time after upgrading from a build older than
that, when one Ctrl+F5 clears the copy the browser cached on its own.

## Architecture

```
src/ip21_explorer/
  main.py              FastAPI app: /api/tags, /api/data, /api/compute, /api/functions, /api/plots + static files
  config.py            Settings from env vars / CLI
  calc/                Formulas, independent of the web app (so an alarm service can use it)
    catalog.py         Every function a formula may call, ours and indsl's
    indsl_catalog.py   indsl's toolboxes, read from its signatures and docstrings
    run_function.py    Calling one of them over a series, through pandas
    parser.py          "=" expressions, the same grammar as static/formula.js
    align.py           Reading a series at a time it has no sample of
    evaluate.py        An expression over aligned columns
    periods.py         Local calendar hours, days, weeks, months, years
    engine.py          compute(): reads the tags, evaluates, total()
    cache.py           CachedSource: recent reads kept for a couple of minutes
  sources/
    base.py            DataSource protocol, SampleType (INT/AVG/MIN/MAX)
    simulator.py       Deterministic synthetic trends (dev/testing)
    aspen.py           tagreader-backed live source (work machine)
  static/              Vanilla JS frontend as ES modules, vendored uPlot (MIT, ~50 KB)
    main.js            Entry point: wires the modules together and starts the app
    state.js           Tabs and tags, their migration, localStorage
    api.js, data.js    Server API wrappers; fetching and joining trend data
    chart.js           uPlot chart; axis-gutter.js draws the value gutter
    tags.js            Adding/removing tags, units, the tag setter
    formula.js         "=" expressions: the parser, driven by /api/functions
    resample.js        Reading a series at a time it has no sample of (XY, previews)
    computed.js        Formula rows: references, order, asking the server
    formula-graph.js   Formulas as blocks and wires, and back to text
    formula-editor.js  The block editor window
    xy-chart.js        XY plot, time colour ramp and its legend
    tag-table.js       Settings table (tag-table-keys.js: its keyboard handling)
    search.js          Tag search         timerange.js   Presets, zoom, live
    scooters.js        Value cursors      navigator.js   Navigator band
    tabs.js            Tab strip          toolbar.js     Buttons, shortcuts
    plots.js           Save/open/import   share.js       Share links
    menu.js            Context menus      clipboard.js   Copy/paste tags
    analysis.js        CSV, averages      timefields.js  Time fields, calendar
    constants.js, util.js
tests/                 Simulator, API, formula and frontend module tests (pytest);
                       fixtures/formula_cases.json holds both parsers to the same answers
```

The two data sources implement the same small protocol, so the entire app is
testable against the simulator; `aspen.py` is a thin mapping kept deliberately
free of logic.

The frontend has no build step, so nothing checks its imports before a browser
runs them. `tests/test_static_modules.py` scans the modules as text instead and
fails on an import that does not resolve, a name used from another module
without importing it, an unused import, or a module nothing loads.

## License

MIT — see [LICENSE](LICENSE).

`src/ip21_explorer/static/vendor/` bundles [uPlot](https://github.com/leeoniya/uPlot)
(MIT, see [LICENSE-uplot.txt](src/ip21_explorer/static/vendor/LICENSE-uplot.txt)).
Formula functions come from [indsl](https://github.com/cognitedata/indsl)
(Apache 2.0, see [NOTICE](NOTICE)), and data access on live systems goes
through [tagreader-python](https://github.com/equinor/tagreader-python) (MIT).

This project is not affiliated with, endorsed by, or sponsored by Aspen
Technology, Inc. IP.21, InfoPlus.21, and Aspen are trademarks of Aspen
Technology, Inc.
