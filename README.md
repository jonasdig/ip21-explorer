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
- **Tag settings table** under the plot — the one place tags live: one row per
  tag with the tag name itself, colour, record map, sampling type, interval,
  stepped, and min/max, all editable in place while the trends stay visible
  above. The tag name is a field like any other, so a mistyped or neighbouring
  tag (`LIC-2010A` → `LIC-2010B`) is fixed by typing over it, and the blank row
  at the bottom adds a tag by name without going through search. A row the
  historian had nothing for says so in red, in its own row. `Tab` moves to the
  next setting, `Enter` to the same setting on the next tag, so a whole plot
  can be set up without leaving the keyboard. Rows drag to reorder (or
  `Alt`+`↑`/`↓`), which is also the order the stacked axis gutter and the
  scooter readouts use, so related tags can be grouped. Drag its top edge to
  trade height with the plot — all the way down leaves just the column
  headings
- **Per-tag colour**: tags get distinct colorblind-friendly colors
  automatically; pick another from the palette — or any colour at all — in the
  table's colour cell
- **Tag search** with autocomplete over tag names *and* descriptions, so
  half-remembered tags still turn up: pair part of the tag with a word from its
  description (`TIC-24 temperature`) and both must match, `*` wildcards
  allowed. The result list stays open as tags are picked, so one search can
  seed a whole plot — click to add, click the ✓ to remove again, hold `Enter`
  to walk down the list adding as it goes, or take the lot with **Add all N**. Names always decide which tags are looked at — IP21 matches those
  server-side in one request, while a description costs one request per tag — so descriptions are checked
  only among the name matches, capped by `IP21_DESC_SCAN_MAX` and cached. A
  word on its own that matches no tag name finds nothing, rather than reading
  every description in the historian
- **Formula rows**: a row whose tag name starts with `=` is arithmetic over
  other tags rather than a tag of its own — `=[TI-101] - [TI-201]`,
  `=([FI-104]*2)^0.5`, `=avg([TI-101],[TI-201],[TI-301])` — with `+ - * / ^`,
  parentheses, numbers, and `abs, sqrt, min, max, avg, ln, log10, exp, round`.
  References go in brackets (`;MAP` works inside them), because every IP21 tag
  has a hyphen in it and `=TI-101-TI-201` would otherwise be one name. A
  reference with no row of its own is fetched quietly in the same request as
  the rows, so a difference between two tags costs one row, not three.
  Formulas may refer to other formulas by their description, and a cycle says
  so by name. Give the row a unit and a short name in the Unit and Description
  cells and that is what the readouts and the CSV use
- **XY plot with a time colour**: one tag against another, every point coloured
  by when it is and joined by a faint trail in time order, so drift shows up as
  the cloud moving rather than as two trends that have to be compared by eye.
  Right-click a row for *Use as X axis* / *Use as Y axis*; the colour bar says
  which colour is when, and the ramp always spans the loaded window, so a
  colour means the same moment wherever it appears. Drag to zoom the two value
  axes, double-click to undo it; the time window is still chosen with the
  presets, the time fields and the navigator
- **Individual y-scale per tag** (auto or manual min/max); Process
  Explorer-style stacked axis gutter by default (all tags share a few
  gridlines, values stacked in tag colors), with a toggle cycling to
  single-axis and side-by-side axes modes
- **Time presets** (1h–30d), custom ranges, drag-select and mouse-wheel zoom
  with automatic re-fetch, zoom-back history (Esc), a red **Now** button, and
  a right-click menu (add scooter, delete scooters, zoom back, reset zoom).
  Reset zoom returns to the window you asked for — the preset you pressed or
  the dates you typed. Axis labels carry the year once a window spans one
- **24-hour time fields** in `dd.mm.yyyy hh:mm:ss`, never AM/PM whatever the
  browser's locale, with a calendar popover (Monday first) and arrow keys that
  step whichever part the cursor sits in
- **Navigator band** under the chart: a wider span with the visible window
  drawn on it, to drag or stretch into place when a range landed slightly
  wrong. It costs one extra coarse request for a single tag, only when the
  window leaves the band's span — panning inside it is free — and the **Nav**
  button switches it off entirely
- **Sampling types per tag**: interpolated, average, min, max with
  an aggregate interval (or Auto) — individually per tag, like Process
  Explorer's Type/Period columns, in the table's own Type and Period columns.
  Intervals start at 4 s, the finest sample IP21 stores
- **IP21 record maps**: plot `TAG;MAP` (e.g. `TIC-102;OUTPUT`); the map
  is chosen in each tag's row in the table. The same tag can be plotted several
  times — adding it again moves the copy onto its next unused map, so a
  controller's PV, SP and OUT can be compared side by side
- **Favourite maps**: real tags carry 30+ record maps but only a few matter —
  star them beside the map dropdown to sort them to the top everywhere and to
  decide which map a duplicated tag takes next. Stored server-side in
  `ip21.env` (`IP21_FAVORITE_MAPS`). Map units are looked up only for the map
  actually in use, so opening the dropdown costs one request, not one per map
- **Copy/paste tags**: right-click a tag's row for copy, duplicate, paste and remove,
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
  toggled in the tag's row
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

## Upgrading

```bash
git pull && .venv/bin/pip install -e ".[aspen]"
```

Then restart the server. Saved plots (`plots/*.json`), your `ip21.env` and the
per-browser state (open tabs, colors, scooters) are untouched. The server tells
the browser to check for a newer frontend on every load, so a normal reload
picks it up — except the first time after upgrading from a build older than
that, when one Ctrl+F5 clears the copy the browser cached on its own.

## Architecture

```
src/ip21_explorer/
  main.py              FastAPI app: /api/tags, /api/data, /api/plots + static files
  config.py            Settings from env vars / CLI
  sources/
    base.py            DataSource protocol, SampleType (INT/AVG/MIN/MAX)
    simulator.py       Deterministic synthetic trends (dev/testing)
    aspen.py           tagreader-backed live source (work machine)
  static/              Vanilla JS frontend as ES modules, vendored uPlot (MIT, ~50 KB)
    main.js            Entry point: wires the modules together and starts the app
    state.js           Tabs and tags, their migration, localStorage
    api.js, data.js    Server API wrappers; fetching and joining trend data
    chart.js           uPlot chart; axis-gutter.js draws the stacked axis
    tags.js            Adding/removing tags, units, the tag setter
    formula.js         "=" expressions: parser and evaluator (imports nothing)
    resample.js        Reading a series at a time it has no sample of
    computed.js        Formula rows: references, order, evaluation
    xy-chart.js        XY plot, time colour ramp and its legend
    tag-table.js       Settings table (tag-table-keys.js: its keyboard handling)
    search.js          Tag search         timerange.js   Presets, zoom, live
    scooters.js        Value cursors      navigator.js   Navigator band
    tabs.js            Tab strip          toolbar.js     Buttons, shortcuts
    plots.js           Save/open/import   share.js       Share links
    menu.js            Context menus      clipboard.js   Copy/paste tags
    analysis.js        CSV, averages      timefields.js  Time fields, calendar
    constants.js, util.js
tests/                 Simulator, API and frontend module tests (pytest)
```

The two data sources implement the same small protocol, so the entire app is
testable against the simulator; `aspen.py` is a thin mapping kept deliberately
free of logic.

The frontend has no build step, so nothing checks its imports before a browser
runs them - and a browser only reports a missing import when the code needing
it runs. `tests/test_static_modules.py` scans the modules as text instead and
fails on an import that does not resolve, a name used from another module
without importing it, an unused import, or a module nothing loads.

## License

MIT — see [LICENSE](LICENSE).

`src/ip21_explorer/static/vendor/` bundles [uPlot](https://github.com/leeoniya/uPlot)
(MIT, see [LICENSE-uplot.txt](src/ip21_explorer/static/vendor/LICENSE-uplot.txt)).
Data access on live systems goes through
[tagreader-python](https://github.com/equinor/tagreader-python) (MIT).

This project is not affiliated with, endorsed by, or sponsored by Aspen
Technology, Inc. IP.21, InfoPlus.21, and Aspen are trademarks of Aspen
Technology, Inc.
