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
  at the bottom adds a tag by name without going through search. Unit and
  description are fields too, for when what IP21 reports is wrong; empty one
  and the historian's value comes back. A row the
  historian had nothing for says so in red, in its own row. `Tab` moves to the
  next setting, `Enter` to the same setting on the next tag, so a whole plot
  can be set up without leaving the keyboard. Rows drag to reorder (or
  `Alt`+`↑`/`↓`), which is also the order the stacked axis gutter and the
  scooter readouts use, so related tags can be grouped. Drag its top edge to
  trade height with the plot — all the way down leaves just the column
  headings. Drag a heading to move its column, or its right edge to size it
  (double-click the edge, or *Reset columns* in the heading's menu, for the
  defaults back)
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
  Comparisons `> < >= <=` give 1 or 0. Formulas are computed on the server
  (`calc/`), which keeps the tags it has just read for a couple of minutes, so
  editing a formula does not make the historian read them again
  References go in brackets (`;MAP` works inside them), because every IP21 tag
  has a hyphen in it and `=TI-101-TI-201` would otherwise be one name. A
  reference with no row of its own is fetched quietly in the same request as
  the rows, so a difference between two tags costs one row, not three.
  Formulas may refer to other formulas by their description, and a cycle says
  so by name. Give the row a unit and a short name in the Unit and Description
  cells and that is what the readouts and the CSV use
- **Totals per calendar period**: `total(expression, period)` reads the
  expression as a rate per hour and sums it per `hour`, `day`, `week`
  (Monday first), `month` or `year` in local time (`IP21_TZ`), drawn as one
  step per period. `=total([FI-104], day)` turns m3/h into m3 per day;
  `=total([FI-104] > 5, day)` counts the hours a pump ran. The tags inside are
  read as time-weighted averages (AVG), at 1 min for windows up to about a
  month and coarser beyond (at most 50 000 points per tag), over whole
  periods — a day that started before the window counts in full, and today's
  total is so far. A rate per second needs `* 3600`
- **Formula blocks**: the same formulas, built by dragging blocks - tags,
  numbers, the arithmetic, comparisons and every function (a *total* block
  picks its period from a list) - onto a canvas and wiring them
  together, from an output to an input or the other way. Open it with the *ƒ*
  after any row's tag name (the blank row's starts from scratch), or *Edit visually* /
  *New formula from this tag* in a row's right-click menu. Tags can be
  searched for right there, including ones that are not on the plot - the
  server reads them for the preview straight away; `+`, `×`, `min`, `max` and
  `avg` take any number of inputs. A preview trend shows the result, or the
  block whose ◉ is lit, and hovering over it shows every block's value at
  that moment, so a long formula shows where it goes wrong. The text stays the truth: Apply
  writes the expression into the Tag field, it can still be edited as text,
  and the text field under the canvas rebuilds the blocks from what is typed
- **XY plot with a time colour**: tags against a shared x, every point
  coloured by when it is, so drift shows up as the cloud moving rather than as
  trends that have to be compared by eye. The table's show column decides what
  takes part: one ticked row is the x axis (right-click a row for *Use as X
  axis*, or pick it from the plot's own right-click menu) and every other
  ticked row is a series against it - identical pumps into one header, say.
  Each series gets its own point symbol and a trail in its own line colour and
  style; the legend lists them under the colour bar, which says which colour
  is when. Drag the legend out of the way, double-click it to put it back. The
  ramp always spans the loaded window, so a colour means the same moment
  wherever it appears. Drag to zoom the two value axes, double-click to undo
  it; the time window is still chosen with the presets, the time fields and
  the navigator
- **Line style per tag**, from the colour menu in the table: solid, dashed,
  dotted or no line (dots only), thin to thick, optional dots on every sample
  in the trend view, the XY point symbol, and whether that series' XY points
  are coloured by time or all drawn in the row's own colour
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
| `IP21_READ_WORKERS` | Tags of one request read from IP21 side by side (default `4`, `1` reads them one after another) |
| `IP21_AGG_MAX_ROWS` | Most rows IP21 returns for one Average/Minimum/Maximum read (default `10000`); longer reads are split into windows of this size, and the server log warns if one comes back full |
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
  main.py              FastAPI app: /api/tags, /api/data, /api/compute, /api/plots + static files
  config.py            Settings from env vars / CLI
  calc/                Formulas, independent of the web app (so an alarm service can use it)
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
    chart.js           uPlot chart; axis-gutter.js draws the stacked axis
    tags.js            Adding/removing tags, units, the tag setter
    formula.js         "=" expressions: the parser, for blocks and errors while typing
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
