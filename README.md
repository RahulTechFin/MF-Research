# ARMSTRONG MF RESEARCH CENTRE

> 🔒 **INTERNAL USE ONLY** — For research purposes only. Not for client distribution.

Institutional-grade mutual fund research platform built on a self-updating SQLite NAV database,
a locked Python calculation engine, and a React dashboard deployed on Netlify via GitHub Actions.

---

## Architecture

```
AMFI NAVOpen.txt → fetch_daily.py → mf_research.db → run_engine / build_json → /site/data/*.json → React dashboard
Yahoo Finance     ─────────────────────────────────────────────────────────────────────────────────────────────────▲
```

- **Database:** `data/mf_research.db` — SQLite, all Regular-Growth NAVs from 2010, daily auto-updated
- **Engine:** `engine/calculation_engine.py` — single source of truth for ALL math (LOCKED)
- **Automation:** GitHub Actions (`.github/workflows/`) — runs daily at 23:45 IST + 08:15 IST catch-up
- **Frontend:** `site/` — React + TypeScript + Tailwind + ECharts, deployed on Netlify

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
