# FILE 1 of 2 — CALCULATION ENGINE SPECIFICATION (`MF_Calculation_Engine.md`)

> **THE SINGLE SOURCE OF TRUTH FOR ALL MATH.**
> Every return, average, ranking, quartile, and chart value shown anywhere in the platform is computed ONLY by the logic in this file, implemented as ONE Python module: `engine/calculation_engine.py`.
> **Rule for the agent:** never re-implement, duplicate, or "optimize" any formula elsewhere (not in SQL, not in JavaScript, not in a second Python file). When the owner wants a logic change, it is changed HERE and only here, and the whole platform updates automatically.
> **Status: LOCKED.** Modify only when the owner explicitly instructs a logic change.

---

## E1. NAV Lookup Conventions (Used by Everything Below)

Three date-resolution rules. Use exactly the rule named by each calculation:

| Rule | Meaning | Used for |
|---|---|---|
| **NEAREST-PREVIOUS** | If NAV missing on target date, step BACKWARD: −1, −2, −3 … days until a NAV is found | Trailing return start dates; all period END dates |
| **NEAREST-NEXT** | If NAV missing on target date, step FORWARD: +1, +2, +3 … days until a NAV is found | All period START dates (start of month / quarter / year) |
| **ANCHOR (T)** | Latest available NAV date ≤ selected date (default: today) | The "as of" date for trailing returns and all live tables |

- Search window cap: 10 calendar days. If no NAV found within 10 days → value is `null` → display `—`.
- A fund is **eligible** for a period only if its first-ever NAV date ≤ the period's resolved start date. Otherwise `—`. Never annualize or extrapolate short histories.

---

## E2. Trailing Returns (T-Anchored) — periods: 1M, 3M, 6M, 12M, 3Y, 5Y, 10Y

1. **T** = ANCHOR date (latest NAV ≤ today). Updates automatically every trading day as new NAVs arrive.
2. Start target = T − period (calendar arithmetic). Resolve start NAV with **NEAREST-PREVIOUS**.
3. Formulas:
   - **≤ 12M (simple absolute):** `(NAV_T / NAV_start) − 1`
   - **> 12M (CAGR, exact day count):** `(NAV_T / NAV_start) ^ (365 / actual_days_between_the_two_NAV_dates) − 1`

## E3. Annual Returns (Calendar Year) — 2010 → current year

- **Start NAV:** first trading day of the year → target 01-Jan, resolve with **NEAREST-NEXT** (+1, +2 …).
- **End NAV:** last trading day of the year → target 31-Dec, resolve with **NEAREST-PREVIOUS** (−1, −2 …).
- **Return:** `(NAV_end / NAV_start) − 1` (simple, never annualized).
- **Current year = YTD:** start NAV as above; end NAV = ANCHOR (T). Label the column `YTD 2026`, never just the year. Rolls into a completed year automatically when the calendar year ends.

## E4. Quarterly Returns (Point-to-Point)

- Quarters: Q1 = 01-Jan→31-Mar, Q2 = 01-Apr→30-Jun, Q3 = 01-Jul→30-Sep, Q4 = 01-Oct→31-Dec.
- **Start NAV:** quarter start date, resolve **NEAREST-NEXT** (+1, +2 …).
- **End NAV:** quarter end date, resolve **NEAREST-PREVIOUS** (−1, −2 …).
- **Return:** `(NAV_end / NAV_start) − 1`.
- **Current (incomplete) quarter:** end NAV = ANCHOR (T), label `QTD`. Rolls automatically at quarter end.

## E5. Monthly Returns (Point-to-Point)

- **Start NAV:** 1st of month, resolve **NEAREST-NEXT**. **End NAV:** last calendar day of month, resolve **NEAREST-PREVIOUS**.
- **Return:** `(NAV_end / NAV_start) − 1`. Current month = `MTD` (end = ANCHOR T), rolls automatically.

## E5.1 WORKED EXAMPLES — Every Return Type (follow these exactly)

Assume today = 08-Jul-2026 and this fund's data where needed:

**Trailing 1M (simple):**
- T = 08-Jul-2026, NAV_T = 150.00. Target start = 08-Jun-2026 → no NAV (Sunday) → NEAREST-PREVIOUS → 06-Jun-2026, NAV = 145.00.
- Return = (150.00 / 145.00) − 1 = **+3.45%**
- *Identical procedure for 3M (target 08-Apr-2026), 6M (08-Jan-2026), 12M (08-Jul-2025) — always simple, never annualized.*

**Trailing 3Y (CAGR):**
- Target start = 08-Jul-2023 → NEAREST-PREVIOUS → 07-Jul-2023, NAV = 100.00.
- Actual days between 07-Jul-2023 and 08-Jul-2026 = 1097.
- CAGR = (150.00 / 100.00) ^ (365 / 1097) − 1 = 1.5^0.33272 − 1 = **+14.44% p.a.**
- *Identical procedure for 5Y and 10Y — always CAGR with the actual day count between the two NAV dates actually used.*

**Monthly (June 2026):**
- Start: 01-Jun-2026 has NAV 148.00 (if missing → +1, +2 …). End: 30-Jun-2026 has NAV 152.00 (if missing → −1, −2 …).
- Return = (152.00 / 148.00) − 1 = **+2.70%**

**Quarterly (Q1-2026):**
- Start: 01-Jan-2026 is a holiday → NEAREST-NEXT → 02-Jan-2026, NAV = 140.00.
- End: 31-Mar-2026, NAV = 146.00 (if missing → −1, −2 …).
- Return = (146.00 / 140.00) − 1 = **+4.29%**

**Annual (2025):**
- Start: 01-Jan-2025 holiday → +1 → 02-Jan-2025, NAV = 120.00. End: 31-Dec-2025, NAV = 138.00.
- Return = (138.00 / 120.00) − 1 = **+15.00%**

**YTD (2026, today = 08-Jul-2026):**
- Start: 02-Jan-2026 (NEAREST-NEXT from 01-Jan), NAV = 138.00. End: ANCHOR T = 08-Jul-2026, NAV = 150.00.
- YTD = (150.00 / 138.00) − 1 = **+8.70%** — recomputed every trading day; becomes "2026" automatically after the year's last trading day.

**Ineligibility:** fund launched 15-Mar-2024 → 3Y/5Y/10Y trailing, Annual 2010–2023, and Q1-2024-and-earlier quarters all = `—`.

## E6. Category Average

For any category and any timeframe (trailing / monthly / quarterly / annual):
`Category Average = equal-weighted mean of all eligible funds' returns` — funds showing `—` for that timeframe are EXCLUDED from that cell's average (never counted as zero). Fund count per cell available on hover.

## E7. Benchmark / Index Returns

Index returns use **THE SAME FUNCTIONS E2–E5** applied to the index's daily closing prices (stored like NAVs). One engine, identical methodology → fund vs index comparisons are always like-for-like.

### E7.1 Synthetic Blended Benchmarks (for Hybrid & Multi-Asset categories)

Composite hybrid indices (e.g., "NIFTY 50 Hybrid Composite Debt 65:35") are not available on Yahoo Finance, so hybrid benchmarks are built as **daily-rebalanced blends of available component indices**:

1. Each blended benchmark is defined in config as components + weights, e.g. `65% NIFTY 50 + 35% Gilt ETF`.
2. Build a synthetic daily series starting at 100:
   ```
   blend_value_0 = 100
   blend_value_t = blend_value_{t-1} × (1 + Σ_i [ w_i × r_{i,t} ])
   where r_{i,t} = (close_{i,t} / close_{i,t-1}) − 1   (component daily return)
   ```
   Dates where any component is missing a close are skipped (carried forward) for all components together, keeping the blend internally consistent.
3. Store the synthetic series in `index_history` like any real index — every downstream calculation (E2–E5, charts, tables) then treats it identically. Weights/components are data (config table), changeable without code.
4. **Interactive Blend Builder (dashboard):** the owner can type new weight numbers into the Hybrid benchmark panel and the blended series recomputes instantly on screen (client-side implementation of THIS formula only — the single sanctioned UI-side calculation, because it is an interactive what-if tool). The stored/permanent blend still comes from the config table.

## E8. Chart Normalization (All Comparison Charts)

- All series (funds + index) are rebased to **start at 0%**:
  `value_t = ((NAV_t / NAV_series_start) − 1) × 100`
- Common start date = latest first-available date across all selected series, resolved NEAREST-NEXT.
- Timeframe presets resolve start dates exactly as: 1M/3M/6M/12M/3Y/5Y → T minus period (NEAREST-PREVIOUS); **Annually** → fixed start 01-Jan-2017 (NEAREST-NEXT), end = ANCHOR, keeps extending automatically; **Custom** → user's start (NEAREST-NEXT) and end (NEAREST-PREVIOUS) dates.
- Hover tooltip shows: date, each series' NAV/close AND its normalized % value.

## E9. Quartile Ranking — Equity & Hybrid categories only

**Step 1 — Period returns:** Quarterly mode uses E4 returns; Annual mode uses E3 returns. Only COMPLETED periods are ranked (no QTD/YTD ranking).

**Step 2 — Rank** all eligible funds in the category for that period by return, descending (rank 1 = best). Funds with `—` are excluded and display `-`.

**Step 3 — Quartile assignment (owner's Excel formula, transcribed exactly — AUTHORITATIVE):**
```
=IFERROR( IF(rank <= ROUNDUP(N*0.25,0), 1,
          IF(rank <= ROUNDUP(N*0.50,0), 2,
          IF(rank <= ROUNDUP(N*0.75,0), 3, 4))), "-")
```
Python equivalent (must match the Excel output exactly, including remainder distribution):
```python
import math
def quartile(rank: int, n: int):
    if rank is None or n == 0:
        return None                      # displays '-'
    if rank <= math.ceil(n * 0.25): return 1
    if rank <= math.ceil(n * 0.50): return 2
    if rank <= math.ceil(n * 0.75): return 3
    return 4
```

**Step 4 — Colors (fixed):** Q1 = Green `#16A34A` · Q2 = Yellow `#EAB308` · Q3 = Light Orange `#FB923C` · Q4 = Red `#DC2626`. Rendered as colored pills/cells in the quartile grid (funds as rows, periods as columns).

## E10. Consistency & Volatility Boxes (beside Quartile section)

*Default definitions — owner may revise; change here only.* Computed over the last 8 completed quarters (minimum 6 with data):

- **Top 5 Consistent Performers:** lowest average quartile number; tie-break = higher % of periods in Q1. Shown with their avg-quartile score and mini quartile-history strip.
- **Top 5 Volatile Performers:** highest standard deviation of quarterly returns (population σ). Shown with σ and their best/worst quarter.
- In Annual mode: same definitions over the last 5 completed years (minimum 4).

## E11. Automatic Update Rules (No Manual Intervention, Ever)

After every daily data ingestion, the engine recomputes and republishes ALL derived outputs:
1. Trailing returns — recomputed daily (anchor T moves with each trading day).
2. MTD / QTD / YTD — recomputed daily; automatically become the completed month/quarter/year when the calendar rolls (a new column/period appears by itself, correctly labeled).
3. Category averages, benchmark returns, quartile ranks, consistency/volatility boxes, Top-10 winners/losers, chart series — all refreshed in the same run.
4. Every table and chart displays its **"Data as of DD-MMM-YYYY"** (the ANCHOR date) — dates always visible, never ambiguous.
5. The pipeline must be idempotent and fail-safe: a failed run leaves the previous day's published data intact; nothing ever half-updates or gets stuck.

## E12. RISK ANALYTICS — LOCKED (Industry-Standard Formulas) · **INTERNAL USE ONLY**

> **These metrics are for INTERNAL research use only** — the dashboard section must carry a visible "INTERNAL USE ONLY" badge and is never part of client-facing exports.

**Data conventions (apply to all metrics below):**
- Computation window: **trailing 3 years of MONTHLY returns (36 observations)** — the industry standard (Morningstar / factsheet convention). Minimum 30 monthly observations, else `—`.
- Monthly returns derived from month-end NAVs (E5 end-of-month convention): `r_m = (NAV_end_this_month / NAV_end_prev_month) − 1`. Benchmark monthly returns identically from index closes.
- **Risk-free rate (Rf):** configurable constant in config, default **6.5% p.a.** (India 91-day T-Bill proxy); monthly Rf = `(1 + Rf)^(1/12) − 1`. Owner changes it as data, not code.
- Fund annualized return over the window = 3Y CAGR (E2 logic).

**R1 — Standard Deviation (annualized):**
`σ_annual = STDEV(36 monthly returns, sample) × √12`
*Caption: "How much the fund's returns swing around their average — higher = bumpier ride."*

**R2 — Sharpe Ratio:**
`Sharpe = (Fund 3Y CAGR − Rf) / σ_annual`
*Caption: "Extra return earned per unit of total risk — higher is better."*

**R3 — Sortino Ratio:**
`Downside deviation σ_d = √( mean( min(r_m − Rf_monthly, 0)² ) ) × √12`
`Sortino = (Fund 3Y CAGR − Rf) / σ_d`
*Caption: "Like Sharpe, but only punishes downside swings — higher is better."*

**R4 — Beta & Alpha (vs category benchmark):**
`Beta = COVAR(fund monthly returns, benchmark monthly returns) / VAR(benchmark monthly returns)`
`Alpha (Jensen's, annualized) = Fund 3Y CAGR − [ Rf + Beta × (Benchmark 3Y CAGR − Rf) ]`
*Caption: "Beta = how hard the fund moves when its index moves (1 = same). Alpha = return the manager added beyond what Beta alone explains."*

**R5 — Maximum Drawdown + Recovery Time (daily NAVs, full available history):**
```
running_peak_t = max(NAV_0 … NAV_t)
drawdown_t     = NAV_t / running_peak_t − 1          # the underwater curve
Max Drawdown   = min(drawdown_t)                      # deepest fall, e.g. −38.4%
Recovery Time  = calendar days from the trough date until NAV first regains the prior peak
                 (display "Ongoing" if not yet recovered)
```
*Caption: "Worst peak-to-bottom fall an investor would have suffered, and how long it took to get their money back."*
**Dynamic graph (required):** interactive **underwater chart** — drawdown_t plotted as a shaded area below 0%, with the max-drawdown trough marked, the recovery point flagged, hover showing date/drawdown%, and the benchmark's underwater curve overlaid for comparison. Timeframe pills: 3Y | 5Y | Full history.

**R6 — Upside / Downside Capture Ratio (36 monthly returns):**
```
Up months  = months where benchmark return > 0;  Down months = benchmark return < 0
Upside Capture   = [ (Π(1+fund r_m in up months))^(12/n_up) − 1 ]  /  [ (Π(1+bench r_m in up months))^(12/n_up) − 1 ] × 100
Downside Capture = same construction over down months × 100
```
*Caption: "Of the index's gains, how much the fund captured (>100 = more than index); of the index's falls, how much it suffered (<100 = fell less). Ideal: high upside, low downside."*

**R7 — Risk-Adjusted Composite Ranking (0–100, within category):**
Percentile-score each fund within its category on: Sharpe (30%), Sortino (20%), Alpha (20%), Max Drawdown (15%, shallower = better), Capture Spread = Upside − Downside (15%). Composite = weighted sum → rank funds. *Weights are defaults in config — owner-editable as data.*
*Caption: "One 0–100 score combining all risk-adjusted measures — who delivers the best returns for the risk taken."*

## E13. Extension Protocol

Any future section the owner adds (new metric, new ranking, new analysis) follows this same pattern: its calculation is appended to THIS file as E15, E16, …, implemented only in the engine module, and consumed by the dashboard as pre-computed data. The engine file stays the only place math lives.

## E14. Rolling & Point-to-Point Returns (Separate Section)

**Mode A — "Current" (dynamic as-of date):**
- A date picker sets the **ANCHOR date** (default = today's latest NAV). ALL trailing windows — **1M, 3M, 6M, 1Y, 3Y, 5Y** — are computed with the exact E2 logic, just with ANCHOR = the selected date instead of today (e.g., pick 07-Jun-2024 → "1Y" = 07-Jun-2023 → 07-Jun-2024).
- Same lookup rules, same simple/CAGR split. Selecting any historical date replays the calculation exactly as it stood on that day. Default view = today, updating dynamically with each trading day.
- **Rolling statistics (per fund, per window length):** across ALL historical windows of that length (rolled daily) up to the anchor: `Average · Minimum · Maximum · % of windows positive · % of windows beating the category benchmark` (benchmark windows computed identically over index closes).

**Mode B — Point-to-Point:**
- Two date pickers: Start (resolve NEAREST-NEXT) and End (resolve NEAREST-PREVIOUS).
- Return = `(NAV_end / NAV_start) − 1`; if the two resolved dates are **> 366 days apart**, also show the CAGR: `(NAV_end/NAV_start)^(365/days) − 1`.
- Runs across **all categories, all funds, and AMC groupings** — the section offers Category view / AMC view exactly like the Returns Explorer.

Only these two modes exist in this section. All outputs recompute automatically as new data arrives.
