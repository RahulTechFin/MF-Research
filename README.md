# ARMSTRONG MF RESEARCH CENTRE

> 🔒 **INTERNAL USE ONLY** — For research purposes only. Not for client distribution.

Institutional-grade mutual fund research platform built on a live NAV API,
a locked Python calculation engine, and a React dashboard deployed on Netlify via GitHub Actions.

**No database is stored.** NAVs are pulled fresh from `api.mfapi.in` on every run,
computed in a temporary database inside the CI runner, and that database is deleted
when the run finishes. The only durable artifacts are the committed scheme catalogue
and the JSON the dashboard reads.

---

## Architecture

```
api.mfapi.in ──► temp SQLite ──► calculation_engine ──► site/public/data/*.json ──► React dashboard
Yahoo Finance ──►  (deleted)          (LOCKED)
                       ▲
        data/scheme_catalogue.json (committed — defines the 3,622-fund universe)
```

- **NAV source:** `api.mfapi.in` — full history per scheme, keyed by AMFI `scheme_code`
- **Catalogue:** `data/scheme_catalogue.json` — the fund universe, categories and
  benchmarks. Committed, ~780 KB. The API cannot supply this (see the header of
  `scripts/export_catalogue.py` for why).
- **Database:** none persisted. `scripts/build_db_from_api.py` builds a disposable
  one per run so the engine keeps receiving an ordinary `sqlite3.Connection`.
- **Engine:** `engine/calculation_engine.py` — single source of truth for ALL math (LOCKED, unchanged)
- **Indices:** still Yahoo Finance — `api.mfapi.in` carries no index data
- **Automation:** GitHub Actions (`.github/workflows/daily_update.yml`) — 23:45 IST + 08:15 IST catch-up
- **Frontend:** `site/` — React + TypeScript + Tailwind + ECharts, deployed on Netlify

### Daily pipeline

```bash
python scripts/daily_run.py          # API -> engine -> JSON, deletes the temp DB
```

It aborts *before* touching any published JSON if the pull fails, the data is thin,
or the newest NAV is more than `--max-staleness` days old — so a bad upstream day
leaves yesterday's working dashboard live.

### Admin vs team builds

The same repo produces two sites. This is a build-time split, not a runtime
one — hiding a tab in React would be cosmetic, because every file under
`site/public/data` is served as a static asset and could simply be fetched by
URL.

```bash
npm run build        # admin — all 9 sections, all 2,626 data files
npm run build:team   # team  — Market Pulse + Quartile Ranking only
```

The team build is stripped twice over:

| | admin | team |
|---|---|---|
| App bundle | 99.8 kB | **53.2 kB** |
| Data shipped | 2,626 files / 109 MB | **72 files / 3.5 MB** |
| `risk_*.json`, `nav/`, `category_*`, `rolling_*` | shipped | **not deployed** |
| Strings `Sortino`, `Risk Lab`, `Fund Screener` … | in bundle | **absent** |

`src/config/profile.ts` decides which sections compile in; Rollup folds the
disabled branches away, so even the tab labels are gone. `scripts/prune_data.mjs`
then deletes the restricted JSON from `dist/` and **fails the build** if any
survives — a leftover file would be deployed and served, so that is treated as
a leak rather than a warning.

**Netlify setup —** two sites from this one repo:

| | build command | env |
|---|---|---|
| admin site | `npm run build` | — |
| team site | `npm run build:team` | `VITE_PROFILE=team` |

Both use base `site`, publish `dist`. Password-protect each separately.

To change what the team sees, edit `SECTIONS` in `src/config/profile.ts` **and**
the `ALLOW` list in `site/scripts/prune_data.mjs` — they must agree.

### Adding newly launched funds

The catalogue defines which funds exist, so a new NFO will not appear until it
is refreshed. This merges AMFI's live list in — additive only, nothing is ever
dropped, and no database is involved:

```bash
python scripts/export_catalogue.py --refresh
```

AMFI's `NAVOpen.txt` is a daily snapshot (~2,750 schemes) rather than the full
universe (~3,640), so funds that have stopped reporting are absent from it but
still hold history the dashboard shows — which is why the refresh only ever
adds and updates. Run it monthly, or whenever a fund is missing.

### Published payload

Only NAVs are stored. Everything derivable from them is calculated — in the
engine for cross-fund aggregates, in the browser for single-fund views.

| what | where | size |
|---|---|---|
| Aggregates (screener, quartiles, risk, rolling, movers, glance, indices) | precomputed daily in CI — they compare all 3,622 funds, so the browser cannot | 12 MB |
| `nav/{code}.json` | committed; the raw NAV series per fund | 85 MB |
| Drawdown curves | **not stored** — derived in the browser by `site/src/utils/drawdown.ts` | 0 |

Dropping the pre-built drawdown files took the payload from 400 MB to 97 MB.
They were a pure function of the NAV series that sat beside them, and were
regenerated and committed every single day.

### History baseline

`HISTORY_START = "2010-01-01"` in `scripts/build_db_from_api.py`. The API reaches
back to 2006, but including those years pulls the 2008 crash into the drawdown
window and changes every Risk Lab figure (measured: max drawdown −0.45 → −0.69).
Pass `--from-date 2006-01-01` to deliberately extend it.

---

## Quick Start

### 1. Python setup (data pipeline)
```bash
pip install -r requirements.txt
```

### 2. Initialise the database
```bash
$env:PYTHONIOENCODING="utf-8"; python scripts/init_db.py
```

### 3. Run Gate 2 unit tests (verify engine)
```bash
python -m pytest tests/ -v
```

### 4. Historical backfill (one-time, slow — ~2 hours)
```bash
# Run locally or trigger via GitHub Actions → backfill.yml workflow_dispatch
$env:PYTHONIOENCODING="utf-8"; python scripts/backfill_amfi.py --from 2010-01-01
$env:PYTHONIOENCODING="utf-8"; python scripts/backfill_indices.py
```

### 5. Gap repair (after backfill, if any batches failed)
```bash
$env:PYTHONIOENCODING="utf-8"; python scripts/backfill_amfi.py --repair
```

### 6. Build JSON outputs
```bash
$env:PYTHONIOENCODING="utf-8"; python scripts/build_json.py
```

### 7. Frontend (requires Node.js 22+)
```bash
cd site
npm install
npm run dev       # development server
npm run build     # production build (for Netlify)
```

---

## Build Order (P9 — follow exactly)

1. ✅ **DB schema** — `python scripts/init_db.py`
2. ⏳ **AMFI backfill** — `python scripts/backfill_amfi.py`
3. ⏳ **Index backfill** — `python scripts/backfill_indices.py`
4. ✅ **Engine tests** — `pytest tests/` (25/25 PASS)
5. ⏳ **Daily automation** — push to GitHub, connect Netlify
6. ⏳ **JSON build** — `python scripts/build_json.py`
7. ⏳ **Frontend** — `cd site && npm install && npm run dev`

---

## Acceptance Gates

| Gate | Status | Command |
|---|---|---|
| Gate 1 — Data | ⏳ Pending backfill | `python scripts/backfill_amfi.py --repair` |
| Gate 2 — Engine | ✅ **25/25 PASSED** | `pytest tests/ -v` |
| Gate 3 — Automation | ⏳ Push to GitHub | GitHub Actions → daily_update.yml |
| Gate 4 — Frontend | ⏳ Needs Node.js | `cd site && npm run dev` |

---

## GitHub Actions Setup

No secrets needed — uses the built-in `GITHUB_TOKEN`.

1. Push this repo to GitHub
2. Connect Netlify to the repo (site/ directory, `npm run build`, dist/)
3. Trigger `backfill.yml` once via workflow_dispatch
4. `daily_update.yml` runs automatically every night

---

## Design System (P8)

- **Dark canvas:** `#0B1120` background
- **Typography:** Space Grotesk (headings) + Inter (UI)
- **Identity colors:** Equity blue · Hybrid violet · Debt teal · Other amber
- **Heat maps:** gain green / loss red at 8–26% opacity
- **Quartile pills:** Q1 green · Q2 yellow · Q3 orange · Q4 red

---

## Dashboard Sections

| # | Section | Heading |
|---|---|---|
| 1 | Index strip | Market Pulse |
| 2 | Category table | Category Snapshot |
| 3 | Category chart | Category Trends |
| 4 | Fund returns | Fund Screener |
| 4b | Top 10 | Leaders & Laggards |
| 5 | Comparison chart | Trend Finder |
| 6 | Quartile grid | Quartile Ranking |
| 6b | Boxes | Most Consistent / Most Volatile |
| 7 | Rolling/P2P | Rolling & Point-to-Point Returns |
| 8 | Risk metrics | Risk Lab 🔒 |
| 9 | Blend builder | Blend Studio |
