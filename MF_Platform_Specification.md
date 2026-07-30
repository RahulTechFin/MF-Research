# FILE 2 of 2 — PLATFORM SPECIFICATION (`MF_Platform_Specification.md`)

> **This file covers everything EXCEPT math:** data collection, database, automation (GitHub + Netlify), dashboard structure, and design.
> **All calculations live ONLY in File 1 (`MF_Calculation_Engine.md`)** — the agent must import from `engine/calculation_engine.py` and never compute returns anywhere else.
> The two files together are the complete build instruction. Read both fully before writing any code.

---

## P0. Agent Execution Rules — READ FIRST

1. **PRIORITY #1 = DATA COLLECTION. This is the core engine of the dashboard. Zero mistakes are acceptable in the data pipeline code.** Write it carefully, test it on small date ranges first, verify counts, then run the full collection. Everything else is built on top of this data — if the data is wrong, everything is wrong.
2. Build in the order of P9. Do not start the frontend before the database is complete and verified.
3. Two-file discipline: math changes → File 1 only. Structure/design/data changes → this file only.
4. Nothing hardcoded: fund lists, categories, index mappings, dates, and periods all come from the database/config, so future additions need no code changes.
5. The system must run unattended forever: daily automation must handle holidays, AMFI delays, and re-runs without human help and without ever corrupting stored data.

---

## P1. What We Are Building

**Project / Platform Name (FINAL): `Mutual Fund Research Center`**
— displayed as the wordmark in the gradient hero header, browser title, and all branding. Tagline under the wordmark: *"Mutual Fund Intelligence · Every NAV, Every Fund, Every Day"*.

**Official Section Headings (FINAL — use these exact names in the UI):**
| # | Dashboard Section | Heading |
|---|---|---|
| 1 | Index strip | **Market Pulse** |
| 2 | Category glance table | **Category Snapshot** |
| 3 | Category comparison chart | **Category Trends** |
| 4 | Main fund returns table | **Fund Screener** |
| 4b | Top 10 winners/losers | **Leaders & Laggards** |
| 5 | Fund comparison chart | **Trend Finder** |
| 6 | Quartile section | **Quartile Ranking** |
| 6b | Two boxes | **Most Consistent** / **Most Volatile** |
| 7 | Rolling/P2P section | **Rolling & Point-to-Point Returns** |
| 8 | Risk section | **Risk Lab** 🔒 *(with INTERNAL USE ONLY badge)* |
| 9 | Blend builder panel | **Blend Studio** |

**A permanent, self-updating mutual fund NAV DATABASE first — then a professional research dashboard on top of it.**

- **Database:** every **Regular-plan Growth-option** scheme across **Equity, Hybrid, Debt, and Other (ETFs / Index / Gold)** — full daily NAV history from **01-Jan-2010 to today**, then updated automatically every trading day, forever.
- **Dashboard:** a visually striking, institutional-grade research site (Section P7–P8) with category tables, fund screeners, comparison charts, and quartile rankings — all reading pre-computed outputs of the File 1 engine.
- **Dynamic by design:** new categories, funds, indices, and analysis sections plug in without restructuring anything.

---

## P2. Data Collection — AMFI NAVs (THE CORE ENGINE)

> **COMPLETENESS GUARANTEE (non-negotiable):** the database must contain the NAV for **EVERY trading day, for EVERY Regular-Growth scheme, from its first available date (starting point 01-Jan-2010) to today — with zero missing days and zero wrong values.** Same standard for index closing prices. The backfill is not "done" until the completeness audit (Gate 1, Appendix PC) proves it. Every future daily run preserves this standard automatically.

### P2.1 Universe: Regular + Growth ONLY
Collect and store ONLY schemes that are:
- **Plan: Regular** (scheme name does NOT contain `direct`)
- **Option: Growth** (name contains `growth`; name does NOT contain any of `idcw`, `dividend`, `payout`, `reinvest`, `bonus`)
- Across these AMFI scheme-type blocks:
  - `Open Ended Schemes(Equity Scheme - …)` → all Equity categories
  - `Open Ended Schemes(Hybrid Scheme - …)` → all Hybrid categories
  - `Open Ended Schemes(Debt Scheme - …)` → all Debt categories
  - `Open Ended Schemes(Other Scheme - …)` → ETFs / Index Funds / Gold ETF / FoF Overseas. *(ETFs are single-plan: apply only the IDCW/dividend exclusion, not the `direct` test.)*
- Everything else (Direct, IDCW, close-ended, interval) is **not stored**.

### P2.2 Scheme Code = Permanent Key (IMPORTANT)
On the very first collection run, capture each scheme's **AMFI Scheme Code** — this is the permanent primary key. All future daily fetches match rows by **scheme code only** (never by name — names change, codes don't). New scheme codes appearing later are auto-added to the master with their category.

### P2.3 Historical Backfill (one-time, 2010 → today)
Endpoint modes (all return the same semicolon format, Appendix PA):
- **PRIMARY — Mode 2 (all-AMC, monthly batches):** `https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?tp=1&frmdt=01-Jan-2010&todt=31-Jan-2010` … loop monthly to today (~195 requests; 90-day cap per request). Small batches fail loudly and retry — nothing lost silently.
- **Mode 1 (per-AMC long range, cross-check only):** `...?mf=3&frmdt=01-Jan-2023&todt=31-Jan-2026`
- **Mode 3 (single-date, gap repair):** `...?frmdt=27-Jan-2025` → all funds' NAV for that one date.
- Every batch logged (row counts); failed/empty batches retried via `--repair` until **zero failures**; then a completeness audit (any scheme with >5 consecutive missing trading days → Mode 3 repair per missing date).

### P2.4 Daily Update (forever)
- Source: `https://portal.amfiindia.com/spages/NAVOpen.txt` (latest trading day, all funds).
- Parse → filter to P2.1 universe → UPSERT by (scheme_code, nav_date) → each trading day lands as **one new row per fund**. Weekends/holidays = 0 new rows = success.
- Gap detector: any scheme >3 trading days stale → Mode 3 single-date repairs, automatically.

---

## P3. Index Data — Yahoo Finance (Closing Prices Only)

Daily **closing price only** for every index we display or benchmark against, backfilled from 2010 (or listing date) and updated in the same daily run. Stored identically to NAVs (`index_history: index_id, date, close`).

| Purpose | Index | Yahoo ticker (primary) |
|---|---|---|
| Header strip + benchmark | NIFTY 50 | `^NSEI` |
| Header strip | SENSEX | `^BSESN` |
| Header strip + Large Cap benchmark | NIFTY 100 | `^CNX100` |
| Header strip | NIFTY BANK | `^NSEBANK` |
| Nifty 500 / Flexi–Multi–ELSS–Focused benchmark | NIFTY 500 | `^CRSLDX` |
| Mid Cap benchmark | NIFTY MIDCAP 150 | `NIFTYMIDCAP150.NS` |
| Small Cap benchmark | NIFTY SMALLCAP 250 | `NIFTYSMLCAP250.NS` |
| Large & Mid benchmark | NIFTY LARGEMIDCAP 250 | `NIFTY_LARGEMID250.NS` |
| Header strip (Gold) | Gold (India proxy) | `GOLDBEES.NS` |
| Sectoral examples | NIFTY IT / PHARMA / FMCG / AUTO | `^CNXIT` / `SUNPHARMA…` *(verify)* |
| Hybrid benchmarks | NIFTY 50 (aggressive) etc. | mapping table below |

**Agent instructions (mandatory):** on first run, VERIFY every ticker actually returns data from Yahoo; log any that fail; the ticker map lives in a config table (`benchmarks`) so a wrong ticker is fixed as data, not code.

### P3.1 Category → Benchmark Mapping (seed data, changeable as table rows)

**Equity:** Large Cap → NIFTY 100 · Mid Cap → NIFTY MIDCAP 150 · Small Cap → NIFTY SMALLCAP 250 · Large & Mid → NIFTY LARGEMIDCAP 250 · Flexi / Multi / ELSS / Focused / Value-Contra / Dividend Yield → NIFTY 500 · Sectoral/Thematic → NIFTY 500 (default, per-scheme override allowed).

**Hybrid — the standard, majorly-used comparisons, built as synthetic blends (engine E7.1) since composite hybrid indices aren't on Yahoo.** Debt component proxy = long-term Gilt ETF (`LTGILTBEES.NS`, verify ticker); Gold component = `GOLDBEES.NS`:

| Hybrid category | Benchmark blend (industry standard) |
|---|---|
| Aggressive Hybrid | **65% NIFTY 50 + 35% Gilt** (≈ NIFTY 50 Hybrid Composite Debt 65:35) |
| Balanced Advantage / Dynamic AA | **50% NIFTY 50 + 50% Gilt** (≈ the 50:50 composite) |
| Conservative Hybrid | **25% NIFTY 50 + 75% Gilt** (≈ 25:75 composite) |
| Equity Savings | **35% NIFTY 50 + 65% Gilt** (≈ NIFTY Equity Savings profile) |
| Multi Asset Allocation | **65% NIFTY 50 + 25% Gilt + 10% Gold** |
| Arbitrage | No benchmark for now (proper arbitrage index unavailable on Yahoo) — owner maps later |

**Debt categories:** no benchmark in Phase 1 (owner adds mappings later — one table row each). **Other/ETF:** each index fund/ETF vs its own underlying where obvious (e.g., Gold ETF vs GOLDBEES), else none.

All mappings — including blend weights — live in `benchmarks` + `benchmark_components(index_id, component_index_id, weight)` tables: the owner changes any benchmark by editing rows, never code.

---

## P4. Database (SQLite, single file in the repo)

```
categories(category_id PK, asset_class, category_name, slug, benchmark_id FK, display_order)
amcs(amc_id PK, amc_name UNIQUE)
schemes(scheme_code PK, scheme_name, amc_id FK, category_id FK, isin, launch_date,
        first_nav_date, last_nav_date, is_active)
nav_history(scheme_code FK, nav_date, nav, PK(scheme_code, nav_date))
benchmarks(index_id PK, index_name, yahoo_ticker, is_synthetic, is_active)
benchmark_components(index_id FK, component_index_id FK, weight)   -- blended hybrid benchmarks (E7.1)
index_history(index_id FK, date, close, PK(index_id, date))        -- real closes AND synthetic blend series
ingestion_log(run_id PK, run_type, date_from, date_to, rows_inserted, rows_skipped, status, ts)
```
- Everything linked by keys (scheme→category→asset class→benchmark) → fully dynamic: adding a category/fund/index = inserting rows, all tables/charts/toggles pick it up automatically.
- Derived outputs (all File-1 engine results) are written at build time as **static JSON files** consumed by the frontend (P5) — the raw database itself is never exposed to the browser.

---

## P5. Automation — GitHub Actions + Netlify (No External Tokens)

**Architecture: a static site, rebuilt daily by a scheduled GitHub Action.**

```
GitHub repo  ──(daily cron ~23:45 IST + 08:15 IST catch-up)──▶ GitHub Action:
   1. python fetch_daily.py      → AMFI NAVOpen.txt + Yahoo closes → UPSERT into SQLite
   2. python run_engine.py       → File-1 engine recomputes ALL derived outputs
   3. python build_json.py       → writes /site/data/*.json (tables, rankings, chart series)
   4. git commit + push          → uses the automatic built-in GITHUB_TOKEN (no setup, no PAT)
                                          │
                                          ▼
Netlify (connected to the repo) auto-detects the push → rebuilds → deploys the updated site
```
- **No secrets, no API keys, no personal tokens anywhere** — GitHub's built-in workflow token commits to its own repo; Netlify's standard Git integration deploys on push.
- Failure-safe: if fetch fails, the workflow exits WITHOUT committing → yesterday's site stays live untouched; the run is retried at the catch-up schedule. `ingestion_log` records every run.
- Chart NAV series are pre-built as **one JSON per fund** (`/site/data/nav/{scheme_code}.json`) so the comparison chart loads only the ≤5 funds selected — fast on static hosting.
- The one-time 2010→today backfill runs as a manually-triggered (workflow_dispatch) Action or locally, committing the completed database once.

---

## P6. Access: the data layer (repo, database, workflows, logs) is the private/admin side — the public only ever sees the finished dashboard. A hidden `/status` page (linked nowhere) shows last-update date and row counts for the owner's checking.

---

## P7. Dashboard Structure (top to bottom, one continuous research page + sub-pages)

Every table: **filter buttons on every column**, sort arrows, "Data as of DD-MMM-YYYY" label. Every value from pre-computed engine JSON.

### Section 1 — MARKET PULSE (Index Strip)
Horizontal scrollable cards: **NIFTY 50, SENSEX, NIFTY 100, NIFTY MIDCAP 150, NIFTY SMALLCAP 250, NIFTY BANK, NIFTY 500, GOLD** — each card: index name, **latest closing value**, 1-day change (▲ green / ▼ red), 30-day sparkline. Gradient card backgrounds per index family (P8).

### Section 2 — CATEGORY SNAPSHOT (Categories At A Glance)
One table, all asset classes together (grouped, colored band per asset class: Equity / Hybrid / Debt / Other):
- **View selector (top of table):** `Trailing | Monthly | Quarterly | Annual` → columns switch:
  - Trailing → 1M 3M 6M 12M 3Y 5Y 10Y · Monthly → last 12 months + MTD · Quarterly → last 8 quarters + QTD · Annual → 2010…2025 + YTD
- Each row = a category; each cell = **category average** (engine E6) with full heat-map conditional formatting.
- **`Compare to Benchmark` toggle (right side of the table):** ON → under every category row, its benchmark's return row appears + a colored spread chip (green beats / red lags).
- Row click → jumps to that category in Section 4.

### Section 3 — CATEGORY TRENDS (Category Comparison Chart)
Linked to Section 2: tick up to 5 categories (checkbox in table's first column) → chart plots each category's **average daily NAV path, normalized to start at 0%** (engine E8; category path = equal-weighted mean of member funds' normalized series) + optionally any index overlay. Timeframe pills: 1M 3M 6M 12M 3Y 5Y · Annually (2017→today) · Custom (start/end date pickers). Hover crosshair shows every series' value + %.

### Section 4 — FUND SCREENER (THE MAIN RETURNS TABLE)
- **Level 1 tabs:** `Equity | Hybrid | Debt | Other` (asset-class colors).
- **Level 2:** sub-category pills (Large Cap, Mid Cap, … per asset class, from DB).
- **View selector:** `Trailing | Monthly | Quarterly | Annual` (same engine, same column sets as Section 2).
- **Table:** all Regular-Growth funds of the selected sub-category, **ascending by fund name**, heat-mapped returns, quartile pill next to each name.
- **Two FIXED rows pinned at the bottom of the table (always visible):**
  1. **Benchmark index** of that category — same timeframes, same engine.
  2. **Category Average** — across all timeframes.
- **AMC toggle (separate, top-right):** switch from *Category mode* to **AMC mode** — pick an AMC (e.g., HDFC) → the same table now shows ALL of that AMC's Regular-Growth funds within the selected asset class, grouped by category, same view selectors. Toggle back anytime.
- **Below the table — sub-section heading: LEADERS & LAGGARDS — Top 10 Performers ⬆ & Top 10 Losers ⬇ side by side:** period pills `1M | 3M | 6M | 12M`; each row: rank, fund, return, spread vs category average; click loads the fund into Section 5's chart.

### Section 5 — TREND FINDER (Fund Comparison Chart)
- **Benchmark is FIXED & AUTO-SHIFTS with the selected category** (Small Cap selected → NIFTY SMALLCAP 250 locked on the chart; Mid Cap → MIDCAP 150; etc.). It cannot be removed — distinct dashed styling.
- Add up to **5 funds** (search box + from Top-10 clicks). All series **normalized, starting at 0%**, plotted on **daily NAVs**.
- Mouse hover → crosshair tooltip: date, each fund's NAV, each fund's normalized % — readable multi-series tooltip.
- Timeframe pills: `1M | 3M | 6M | 12M | 3Y | 5Y | Annually (2017 → ongoing, auto-extends) | Custom (click-in start & end date)`.
- Purpose: reading this chart should immediately reveal fund/category trends — smooth zoom, legend toggles, export PNG.

### Section 6 — QUARTILE RANKING (Equity & Hybrid only)
- Category selector (Equity & Hybrid sub-categories only) + **mode switch: `Quarterly | Annual`** (engine E9: quarterly = quarter start→end point-to-point with +1/−1 date rules; annual = year start→end; the owner's Excel ROUNDUP formula is the authoritative quartile assignment).
- **Grid:** rows = funds (ascending by name), columns = completed periods (e.g., Q1-2023 … Q2-2026 or 2018…2025); each cell a colored quartile pill: **Q1 Green · Q2 Yellow · Q3 Light Orange · Q4 Red**, `-` grey when ineligible. One glance = consistency pattern.
- **Below, two boxes side by side:** 🏆 **MOST CONSISTENT** (Top 5, avg quartile) — mini quartile strip shown · ⚡ **MOST VOLATILE** (Top 5, return σ) — best/worst quarter shown — definitions in engine E10.

### Section 7 — ROLLING & POINT-TO-POINT RETURNS (engine E14)
- **Two mode pills only: `Current (Dynamic)` | `Point-to-Point`.**
- **Current mode:** date picker (default = latest trading day, moves forward automatically). Table of funds — Category view or AMC view (same selectors as Section 4) — showing 1M · 3M · 6M · 1Y · 3Y · 5Y anchored to the chosen date; pick any past date and the exact same calculation replays as of that day. Expandable row → that fund's rolling statistics per window: Avg · Min · Max · % positive · % beating benchmark.
- **Point-to-Point mode:** Start + End date pickers → return (plus CAGR when > 366 days) for all funds of the selected category or AMC, with category average and benchmark rows pinned.
- Heat-mapped, filters on all columns, as-of/date-range label always visible.

### Section 8 — RISK LAB (engine E12) · **INTERNAL USE ONLY** badge, end of dashboard
- Prominent amber "🔒 INTERNAL USE ONLY — not for client distribution" banner; excluded from any export/share features.
- **Layout:** category selector → per-fund risk table: `σ (ann.) | Sharpe | Sortino | Beta | Alpha | Max DD | Recovery | Up Capture | Down Capture | Composite Score (0–100)` — heat-mapped, sortable, filterable, composite-ranked by default.
- **Every metric column header carries an ⓘ hover + a one-line caption strip under the section title** — the short plain-language "what it means & how it's calculated" texts defined per metric in E12 (e.g., Max DD: "Worst peak-to-bottom fall an investor would have suffered, and how long to get their money back").
- **Dynamic graphs (required):**
  1. **Underwater / Drawdown chart:** pick a fund (or from the table) → shaded drawdown curve below 0%, max-DD trough marked, recovery point flagged, benchmark underwater overlay, hover tooltips, timeframe pills 3Y | 5Y | Full.
  2. **Risk-Return scatter:** all funds of the category plotted σ (x) vs 3Y CAGR (y), bubble = composite score, benchmark as a star marker — instantly shows who earns more per unit of risk.
- Data window labeled clearly on every card: "Based on 3-year monthly returns as of DD-MMM-YYYY · Rf = 6.5%".

### Section 9 — BLEND STUDIO (Hybrid Benchmark Blend Builder, small internal panel)
- Inside the Hybrid area: the current blend weights shown as editable number inputs (must total 100%); typing new weights **instantly recomputes and re-plots** the blended benchmark (engine E7.1's sanctioned client-side what-if) against the category average. A note reminds the owner that permanent changes are made in the config table.

### Extension rule
Every future section the owner adds: same page pattern (section header → controls → table/chart), same design tokens, same engine-first data flow, new JSON output — the layout system must make adding Section 10, 11, 12 trivial.

---

## P8. Design System — "MULTI-COLOR PROFESSIONAL" (Full Rework)

**Intent:** NOT a plain white corporate table site. A **dark, vibrant, premium research terminal** — the kind of dashboard that looks custom-built and expensive at first glance, with color used everywhere *meaningfully*: every asset class, index family, and data state has its own color identity, on a deep dark canvas that makes the colors glow. Unique, eye-catching, and still rigorously professional.

**Canvas (dark theme):**
| Token | Hex | Use |
|---|---|---|
| `bg-base` | `#0B1120` | Page background (deep ink navy) |
| `bg-card` | `#111A2E` | Cards/sections |
| `bg-raised` | `#18233C` | Table headers, hovers, pinned rows |
| `line` | `#24314F` | Hairline borders |
| `text-hi` | `#F1F5FB` | Primary text |
| `text-mid` | `#9FB0CC` | Secondary text, dates |
| `text-low` | `#5E6F8F` | Muted, `—` cells |

**Identity colors (used everywhere for coding, gradients, chart lines):**
| Token | Hex | Identity |
|---|---|---|
| `equity` | `#3B82F6` electric blue | Equity tab, bands, chips |
| `hybrid` | `#8B5CF6` violet | Hybrid |
| `debt` | `#14B8A6` teal | Debt |
| `other` | `#F59E0B` amber | ETFs/Index/Gold |
| `accent-a` | `#22D3EE` cyan | Primary accent, active states, links |
| `accent-b` | `#F472B6` pink | Secondary accent, highlights |
| `gain` | `#34D399` | Positive returns ONLY |
| `loss` | `#F87171` | Negative returns ONLY |
| Quartiles | `#16A34A` / `#EAB308` / `#FB923C` / `#DC2626` | Q1–Q4 pills (fixed, from engine E9) |

**Signature visual moves:**
- **Gradient hero header:** `linear-gradient(120°, #0B1120 → #16224A → #1E3A8A)` with a subtle cyan glow line; wordmark **ARMSTRONG MF RESEARCH CENTRE** + tagline + "Data as of" chip.
- **Index cards (Section 1):** each card carries a soft two-tone gradient of its family color (e.g., NIFTY 50 blue→cyan, GOLD amber→orange), white value in bold tabular numerals, sparkline in the identity color with glow.
- **Asset-class color banding:** Equity/Hybrid/Debt/Other rows and tabs carry a 3px left border + tinted chip in their identity color — instant orientation everywhere.
- **Heat maps:** return cells tinted `gain`/`loss` at 12–28% opacity over the dark card — vivid but readable; the dark canvas makes conditional formatting *pop* far more than a white site.
- **Charts:** series use a fixed vivid palette (cyan, pink, violet, amber, emerald) with soft glow; benchmark always white dashed; gridlines `line` color; area-fade under single-series views.
- **Quartile grid:** the Q1–Q4 pills on dark background become the page's most striking visual — a colored skill fingerprint per fund.
- **Micro-polish:** 10px card radius, one soft shadow, 140ms transitions, skeleton shimmer loaders, count-up numbers, sticky headers/first columns, filter buttons as small rounded chips with the section's identity color when active.
- **Typography:** Space Grotesk (display/headings) + Inter (UI/tables), tabular numerals everywhere, negative numbers with true minus in `loss`.
- **Discipline that keeps it professional:** color always MEANS something (asset class, direction, quartile, series) — never decoration for its own sake; WCAG AA contrast on all text; green/red reserved for return direction only.
- Fully responsive: cards wrap, tables scroll horizontally with sticky fund-name column, chart tooltips touch-friendly.

**Tech:** React + TypeScript + Tailwind (tokens above as CSS variables) + TanStack Table + ECharts (best-in-class hover/crosshair for multi-series NAV charts), static build deployed on Netlify, data from `/site/data/*.json`.

---

## P9. Build Order

1. **Database + AMFI backfill (P2, P4)** — the core engine; verify with Appendix PC gates before anything else.
2. Index backfill from Yahoo + ticker verification (P3).
3. File-1 calculation engine module + unit tests (hand-verify: one fund's 12M & 5Y CAGR vs a public factsheet ±0.1%; a quarterly return across a holiday quarter-start; the quartile formula vs the owner's Excel on a sample).
4. Daily pipeline + GitHub Action + Netlify wiring (P5) — prove one full automatic cycle end-to-end.
5. JSON build layer (all sections' data files).
6. Frontend: Section 1 → 2 → 3 → 4 → 5 → 6 → 7 (Rolling/P2P) → 8 (Risk, INTERNAL badge) → 9 (Blend Builder) in order, per P7/P8.

---

## Appendix PA — AMFI File Parsing (exact rules)
- Semicolon-delimited; 6 fields: `Scheme Code;ISIN…;ISIN…;Scheme Name;NAV;Date`.
- Line types: column header (skip) · blank (skip) · scheme-type header (no `;`, matches `…Schemes(…)`) → sets current type + category (text inside parentheses after the `-`) · AMC line (no `;`, not a type header) → sets current AMC · data row (5 `;`).
- Historical chunks in some periods carry 8 fields (adds Repurchase/Sale price) — map columns by that chunk's header line, never by position.
- NAV must parse to float > 0 (`N.A.`, blank, `0` → skip + log). Dates `%d-%b-%Y` → ISO.
- Category normalization map = seed data (`Large Cap Fund→Large Cap`, `Mid Cap Fund→Mid Cap`, `Small Cap Fund→Small Cap`, `Flexi Cap Fund→Flexi Cap`, `Multi Cap Fund→Multi Cap`, `Large & Mid Cap Fund→Large & Mid Cap`, `ELSS→ELSS`, `Focused Fund→Focused`, `Value Fund→Value/Contra`, `Contra Fund→Value/Contra`, `Dividend Yield Fund→Dividend Yield`, `Sectoral/Thematic…→Sectoral/Thematic`, Hybrid: `Aggressive Hybrid…`, `Balanced Advantage…`, `Conservative Hybrid…`, `Equity Savings…`, `Arbitrage…`, `Multi Asset…`, Debt: all SEBI debt categories, Other: `ETF`, `Index Fund`, `Gold ETF`, `FoF Overseas`).
- Etiquette: 2s sleep between requests, real User-Agent header, 90s timeout, 3 retries (2s/8s/30s backoff); HTTP-200-empty-body = failed batch → retry/`--repair`.

## Appendix PB — Pre-computed JSON contract (frontend reads only these)
`meta.json` (categories, benchmarks, blend weights, Rf, as_of) · `indices.json` (strip cards + sparklines) · `glance_{view}.json` (Section 2 per view) · `category_{slug}_{view}.json` (Section 4 tables incl. pinned benchmark+average rows) · `movers_{slug}.json` (top10 per period) · `amc_{amc}_{asset}.json` (AMC mode) · `quartiles_{slug}_{mode}.json` (grid + consistent/volatile boxes) · `rolling_{slug}.json` (E14 rolling stats per fund per window) · `risk_{slug}.json` (E12 full metric table + scatter data) · `drawdown/{scheme_code}.json` (underwater series + trough/recovery markers) · `nav/{scheme_code}.json` & `index/{index_id}.json` (chart series; index files also power Point-to-Point and the Blend Builder). All returns as decimals; `null` = `—`; every file carries `as_of`. Point-to-Point and as-of-date views compute from the served series using engine-identical lookup rules shipped as a shared, generated lookup utility — generated from the engine, never hand-written twice.

## Appendix PC — Acceptance Gates
- **Gate 1 (Data):** backfill complete, `--repair` leaves zero failed batches; known fund's NAV series continuous; no NAV ≤ 0; re-running any batch adds 0 duplicates; scheme codes captured for 100% of stored rows.
- **Gate 2 (Engine):** all File-1 unit tests pass; quartile output matches owner's Excel formula on a test sample exactly.
- **Gate 3 (Automation):** one full unattended cycle proven — cron fires, data fetched, engine runs, JSON rebuilt, commit pushed with built-in token, Netlify deploys; a forced-failure run leaves the previous site untouched.
- **Gate 4 (Frontend):** all 9 sections at spec; view selectors switch columns correctly; fixed benchmark+average rows pinned; AMC toggle works; chart series all start at exactly 0%; quartile colors exact; filters on every table; dates visible on every section; responsive at 1440/1024/390.

---

## P10. INTERNAL USE ONLY — Entire Project

**The complete ARMSTRONG MF RESEARCH CENTRE platform — every section, table, chart, and data output — is strictly for INTERNAL research use only. It is not for client distribution, public sharing, or commercial publication.**

- The footer of every page displays: **"🔒 Armstrong MF Research Centre — For Internal Research Use Only. Not for distribution."**
- The hero header carries a small `INTERNAL` badge beside the wordmark.
- All exports (Excel/CSV/PNG) carry the same internal-use footnote automatically.
- Data sources credited internally (AMFI, Yahoo Finance) for research purposes.
- The Risk Lab's stronger banner remains in addition to this project-wide notice.
