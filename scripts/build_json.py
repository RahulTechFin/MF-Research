"""
scripts/build_json.py — Pre-compute ALL engine outputs and write JSON files.

Implements Appendix PB contract. ALL returns stored as decimals; null = —.
Every file carries 'as_of'. This runs AFTER run_engine.py has updated the DB.

Output files (in site/public/data/):
  meta.json, indices.json, glance_{view}.json,
  category_{slug}_{view}.json, quartiles_{slug}_{mode}.json,
  rolling_{slug}.json, risk_{slug}.json,
  nav/{scheme_code}.json, index/{index_id}.json,
  category_history/{slug}.json

Deliberately NOT written — both are derived in the browser from data it has
already loaded, so generating and committing them daily was pure waste:
  drawdown/{scheme_code}.json  -> site/src/utils/drawdown.ts
  movers_{slug}.json           -> LeadersLaggards in sections/FundScreener.tsx
"""

from __future__ import annotations

import json
import os
import sys
import logging
from datetime import date, datetime, timezone
from typing import Optional

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

# Both are overridable so a run can be pointed at a throwaway database and a
# scratch output directory (used to diff a candidate build against the live one).
DB_PATH    = os.environ.get("MF_DB_PATH") or os.path.join(ROOT_DIR, "data", "mf_research.db")
OUTPUT_DIR = os.environ.get("MF_OUTPUT_DIR") or os.path.join(ROOT_DIR, "site", "public", "data")

from scripts.init_db import get_conn as _get_conn
from engine.calculation_engine import (
    trailing_return, trailing_return_index,
    annual_return,   annual_return_index,
    quarter_return,  quarter_return_index,
    month_return,    month_return_index,
    category_average, rank_and_quartile,
    quartile_journeys,
    risk_metrics, composite_risk_score,
    rolling_statistics,
)
from scripts.sectors import SECTORAL_THEMATIC_SLUG, sector_of, SECTOR_ORDER

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("build_json")


# ── Sectoral/Thematic: each sector is its own peer group ─────────────────────
#
# AMFI puts ~250 funds in one "Sectoral/Thematic" category. Ranking them
# together answers the wrong question: an IT fund in a bad year for IT would
# show Q4 while beating every other IT fund. So each sector is ranked within
# itself, exactly as Large Cap and Mid Cap are.
#
# Applies only to sectoral-thematic. Every other category keeps a single pool.


def sector_map(funds_names: list[tuple[str, str]], cat_slug: str) -> dict[str, str] | None:
    """{scheme_code: sector} for sectoral-thematic, else None."""
    if cat_slug != SECTORAL_THEMATIC_SLUG:
        return None
    return {sc: sector_of(name) for sc, name in funds_names}


def rank_within_sectors(period_returns: dict[str, Optional[float]],
                        sectors: dict[str, str] | None):
    """
    rank_and_quartile, applied per sector when `sectors` is given.

    A fund alone in its sector gets quartile 1 from rank_and_quartile, which is
    true but not informative — it is simply the only one. Callers get the same
    (rank, quartile) shape either way so the two ranking sites stay identical.
    """
    if sectors is None:
        return rank_and_quartile(period_returns)

    grouped: dict[str, dict[str, Optional[float]]] = {}
    for code, value in period_returns.items():
        grouped.setdefault(sectors[code], {})[code] = value

    out: dict[str, tuple[Optional[int], Optional[int]]] = {}
    for pool in grouped.values():
        out.update(rank_and_quartile(pool))
    return out


def sector_breakdown(sectors: dict[str, str]) -> list[dict]:
    """Sectors present, in canonical order, with fund counts — for the UI."""
    counts: dict[str, int] = {}
    for s in sectors.values():
        counts[s] = counts.get(s, 0) + 1
    return [{"sector": s, "fund_count": counts[s]}
            for s in sorted(counts, key=lambda x: SECTOR_ORDER.get(x, 999))]

TODAY = date.today()

# Month labels for the quartile grid, e.g. "Jun-2026". Written out rather than
# taken from strftime so the output does not shift with the machine's locale.
_MONTH_ABBR = {
    1: "Jan", 2: "Feb", 3: "Mar",  4: "Apr",  5: "May",  6: "Jun",
    7: "Jul", 8: "Aug", 9: "Sep", 10: "Oct", 11: "Nov", 12: "Dec",
}

# ── helpers ──────────────────────────────────────────────────────────────────

def write_json(path: str, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))


def out(filename: str) -> str:
    return os.path.join(OUTPUT_DIR, filename)


def get_as_of(conn) -> str:
    row = conn.execute(
        "SELECT MAX(nav_date) FROM nav_history WHERE nav_date<=?", (TODAY.isoformat(),)
    ).fetchone()
    return row[0] if row and row[0] else TODAY.isoformat()


def fmt(val: Optional[float]) -> Optional[float]:
    """Round to 6dp for JSON output; None stays None."""
    return round(val, 6) if val is not None else None


# ── meta.json ────────────────────────────────────────────────────────────────

def build_meta(conn):
    as_of = get_as_of(conn)
    rf    = float(conn.execute("SELECT value FROM config WHERE key='risk_free_rate'").fetchone()[0])

    categories = conn.execute("""
        SELECT c.category_id, c.asset_class, c.category_name, c.slug, c.display_order,
               b.index_id, b.index_name
        FROM categories c
        LEFT JOIN benchmarks b ON c.benchmark_id = b.index_id
        ORDER BY c.display_order
    """).fetchall()

    cat_list = []
    for row in categories:
        cat_list.append({
            "category_id":   row[0],
            "asset_class":   row[1],
            "category_name": row[2],
            "slug":          row[3],
            "display_order": row[4],
            "benchmark_id":  row[5],
            "benchmark_name":row[6],
        })

    benchmarks = conn.execute("""
        SELECT index_id, index_name, yahoo_ticker, is_synthetic
        FROM benchmarks WHERE is_active=1
    """).fetchall()

    bm_list = []
    for row in benchmarks:
        comps = conn.execute(
            "SELECT component_index_id, weight FROM benchmark_components WHERE index_id=?", (row[0],)
        ).fetchall()
        bm_list.append({
            "index_id":    row[0],
            "index_name":  row[1],
            "ticker":      row[2],
            "is_synthetic":bool(row[3]),
            "components":  [{"index_id": c[0], "weight": c[1]} for c in comps],
        })

    write_json(out("meta.json"), {
        "as_of":      as_of,
        "risk_free_rate": rf,
        "categories": cat_list,
        "benchmarks": bm_list,
        "generated":  datetime.now(timezone.utc).isoformat(),
    })
    log.info("✓ meta.json")


# ── funds_index.json (name search) ───────────────────────────────────────────

def build_funds_index(conn):
    """
    Every fund's name, category and asset class in one small file.

    The dashboard had no way to search by name. manifest.json maps a code to its
    category but carries no names, and the category tables only hold one category
    each -- so answering "which fund is this?" meant fetching all 41 of them.
    One flat list is a few hundred KB and is fetched once, on the first search.

    Names only, as the owner asked: no returns, no ranks. Those change daily and
    would make this file a second, competing source for numbers that the category
    tables already publish.
    """
    rows = conn.execute("""
        SELECT s.scheme_code, s.scheme_name, a.amc_name,
               c.slug, c.category_name, c.asset_class
        FROM schemes s
        JOIN categories c ON s.category_id = c.category_id
        LEFT JOIN amcs a  ON s.amc_id = a.amc_id
        WHERE s.is_active = 1
        ORDER BY s.scheme_name
    """).fetchall()

    write_json(out("funds_index.json"), {
        "as_of": get_as_of(conn),
        "funds": [
            {"code": r[0], "name": r[1], "amc": r[2],
             "slug": r[3], "category": r[4], "asset_class": r[5]}
            for r in rows
        ],
    })
    log.info("✓ funds_index.json (%d funds)", len(rows))


# ── indices.json (Market Pulse strip + sparklines) ────────────────────────────

STRIP_INDICES = [
    "NIFTY 50", "SENSEX", "NIFTY 100", "NIFTY MIDCAP 150",
    "NIFTY SMALLCAP 250", "NIFTY BANK", "NIFTY 500", "GOLD (GOLDBEES)",
]


def build_indices(conn):
    result = []
    for idx_name in STRIP_INDICES:
        row = conn.execute(
            "SELECT index_id FROM benchmarks WHERE index_name=?", (idx_name,)
        ).fetchone()
        if not row:
            continue
        index_id = row[0]

        # Latest close
        latest = conn.execute(
            "SELECT date, close FROM index_history WHERE index_id=? ORDER BY date DESC LIMIT 1",
            (index_id,)
        ).fetchone()
        if not latest:
            continue

        # Previous close (1 trading day back)
        prev = conn.execute(
            "SELECT close FROM index_history WHERE index_id=? AND date<? ORDER BY date DESC LIMIT 1",
            (index_id, latest[0])
        ).fetchone()

        # 30-day sparkline
        sparkline_rows = conn.execute("""
            SELECT date, close FROM index_history
            WHERE index_id=? ORDER BY date DESC LIMIT 30
        """, (index_id,)).fetchall()
        sparkline = list(reversed([(r[0], r[1]) for r in sparkline_rows]))

        change_1d     = ((latest[1] / prev[0]) - 1) if prev else None
        change_1d_abs = (latest[1] - prev[0]) if prev else None

        result.append({
            "index_id":     index_id,
            "index_name":   idx_name,
            "latest_close": latest[1],
            "date":         latest[0],
            "change_1d":    fmt(change_1d),
            "change_1d_abs":fmt(change_1d_abs),
            "sparkline":    sparkline,
        })

    # as_of is the newest close in the strip, not the run date. Stamping TODAY
    # made the header read "As of 20 Aug" above 18 Aug closes whenever the market
    # had not settled a bar yet -- the one date a reader actually checks.
    newest = max((r["date"] for r in result), default=get_as_of(conn))
    write_json(out("indices.json"), {"as_of": newest, "indices": result})
    log.info("✓ indices.json")


# ── Category Snapshot (glance_{view}.json) ────────────────────────────────────

def _trailing_columns():
    return ["1M", "3M", "6M", "12M", "3Y", "5Y", "10Y"]

def _monthly_columns():
    cols = []
    y, m = TODAY.year, TODAY.month
    for _ in range(12):
        m -= 1
        if m == 0:
            m = 12; y -= 1
        cols.append((y, m))
    cols.reverse()
    cols.append((TODAY.year, TODAY.month))   # MTD
    return cols

def _quarterly_columns():
    cols = []
    y, q = TODAY.year, (TODAY.month - 1) // 3 + 1
    for _ in range(8):
        q -= 1
        if q == 0:
            q = 4; y -= 1
        cols.append((y, q))
    cols.reverse()
    cols.append((TODAY.year, (TODAY.month - 1) // 3 + 1))   # QTD
    return cols

def _annual_columns():
    cols = list(range(2010, TODAY.year))  # completed years
    cols.append(TODAY.year)               # YTD
    return cols


def _category_funds(conn, category_id: int):
    return conn.execute(
        "SELECT scheme_code FROM schemes WHERE category_id=? AND is_active=1",
        (category_id,)
    ).fetchall()


def build_glance(conn, view: str = "trailing"):
    categories = conn.execute("""
        SELECT c.category_id, c.asset_class, c.category_name, c.slug, c.benchmark_id
        FROM categories c ORDER BY c.display_order
    """).fetchall()

    rows = []
    as_of = get_as_of(conn)

    for cat_id, asset_class, cat_name, slug, bm_id in categories:
        funds = [r[0] for r in _category_funds(conn, cat_id)]
        if not funds:
            continue

        if view == "trailing":
            cols = _trailing_columns()
            fund_rets = {}
            for sc in funds:
                fund_rets[sc] = {p: trailing_return(conn, sc, p) for p in cols}
            cell_avgs = {p: category_average([fund_rets[sc][p] for sc in funds]) for p in cols}
            # Benchmark
            bm_vals = {}
            if bm_id:
                for p in cols:
                    bm_vals[p] = trailing_return_index(conn, bm_id, p)
            row_obj = {"period_type": "trailing", "periods": cols}

        elif view == "monthly":
            cols = _monthly_columns()
            period_keys = [f"{y}-{m:02d}" for y, m in cols[:-1]] + ["MTD"]
            fund_rets = {}
            for sc in funds:
                rets = []
                for (y, m) in cols[:-1]:
                    rets.append(month_return(conn, sc, y, m))
                rets.append(month_return(conn, sc, TODAY.year, TODAY.month))   # MTD
                fund_rets[sc] = dict(zip(period_keys, rets))
            cell_avgs = {k: category_average([fund_rets[sc][k] for sc in funds]) for k in period_keys}
            bm_vals = {}
            if bm_id:
                for (y, m), k in zip(cols[:-1], period_keys[:-1]):
                    bm_vals[k] = month_return_index(conn, bm_id, y, m)
                bm_vals["MTD"] = month_return_index(conn, bm_id, TODAY.year, TODAY.month)
            row_obj = {"period_type": "monthly", "periods": period_keys}

        elif view == "quarterly":
            cols = _quarterly_columns()
            period_keys = [f"Q{q}-{y}" for y, q in cols[:-1]] + ["QTD"]
            fund_rets = {}
            for sc in funds:
                rets = []
                for (y, q) in cols[:-1]:
                    rets.append(quarter_return(conn, sc, y, q))
                rets.append(quarter_return(conn, sc, TODAY.year, (TODAY.month - 1) // 3 + 1))
                fund_rets[sc] = dict(zip(period_keys, rets))
            cell_avgs = {k: category_average([fund_rets[sc][k] for sc in funds]) for k in period_keys}
            bm_vals = {}
            if bm_id:
                for (y, q), k in zip(cols[:-1], period_keys[:-1]):
                    bm_vals[k] = quarter_return_index(conn, bm_id, y, q)
                bm_vals["QTD"] = quarter_return_index(conn, bm_id, TODAY.year, (TODAY.month - 1) // 3 + 1)
            row_obj = {"period_type": "quarterly", "periods": period_keys}

        elif view == "annual":
            cols = _annual_columns()
            period_keys = [str(y) if y < TODAY.year else f"YTD {y}" for y in cols]
            fund_rets = {}
            for sc in funds:
                fund_rets[sc] = {k: annual_return(conn, sc, y) for y, k in zip(cols, period_keys)}
            cell_avgs = {k: category_average([fund_rets[sc][k] for sc in funds]) for k in period_keys}
            bm_vals = {}
            if bm_id:
                for y, k in zip(cols, period_keys):
                    bm_vals[k] = annual_return_index(conn, bm_id, y)
            row_obj = {"period_type": "annual", "periods": period_keys}
        else:
            continue

        # Sanitize
        cell_avgs  = {k: fmt(v) for k, v in cell_avgs.items()}
        bm_vals    = {k: fmt(v) for k, v in bm_vals.items()}

        row = {
            **row_obj,
            "category_id":   cat_id,
            "asset_class":   asset_class,
            "category_name": cat_name,
            "slug":          slug,
            "benchmark_id":  bm_id,
            "fund_count":    len(funds),
            "averages":      cell_avgs,
            "benchmark":     bm_vals,
        }

        # Sectoral/Thematic carries a breakdown: the same averages, per theme.
        #
        # The single row above blends banking with pharma and technology, so it
        # describes no fund anyone can buy. Category Snapshot expands this row
        # into one line per theme, and the numbers come from here rather than
        # being averaged in the browser — the same reason every other figure on
        # the screen is precomputed.
        if slug == SECTORAL_THEMATIC_SLUG:
            names = dict(conn.execute(
                "SELECT scheme_code, scheme_name FROM schemes "
                "WHERE category_id=? AND is_active=1", (cat_id,)))
            by_sector: dict[str, list[str]] = {}
            for sc in funds:
                by_sector.setdefault(sector_of(names.get(sc, "")), []).append(sc)

            row["sectors"] = [
                {
                    "sector": sector,
                    "fund_count": len(codes),
                    "averages": {p: category_average([fund_rets[sc][p] for sc in codes])
                                 for p in row_obj["periods"]},
                }
                for sector in sorted(by_sector, key=lambda x: SECTOR_ORDER.get(x, 999))
                for codes in [by_sector[sector]]
            ]
            log.info("   glance %s: %d sector rows", view, len(row["sectors"]))

        rows.append(row)

    write_json(out(f"glance_{view}.json"), {"as_of": as_of, "view": view, "rows": rows})
    log.info("✓ glance_%s.json", view)


# ── Fund Screener (category_{slug}_{view}.json) ───────────────────────────────

def build_category_table(conn, cat_slug: str, view: str):
    row = conn.execute(
        "SELECT category_id, category_name, asset_class, benchmark_id FROM categories WHERE slug=?",
        (cat_slug,)
    ).fetchone()
    if not row:
        return
    cat_id, cat_name, asset_class, bm_id = row

    funds = conn.execute("""
        SELECT s.scheme_code, s.scheme_name, a.amc_name
        FROM schemes s
        JOIN amcs a ON s.amc_id = a.amc_id
        WHERE s.category_id=? AND s.is_active=1
        ORDER BY s.scheme_name
    """, (cat_id,)).fetchall()

    if not funds:
        return

    as_of = get_as_of(conn)

    # Determine period columns based on view
    if view == "trailing":
        period_keys = _trailing_columns()
        def get_ret(sc, pk): return trailing_return(conn, sc, pk)
        def get_bm(pk): return trailing_return_index(conn, bm_id, pk) if bm_id else None
    elif view == "monthly":
        month_cols  = _monthly_columns()
        period_keys = [f"{y}-{m:02d}" for y, m in month_cols[:-1]] + ["MTD"]
        _mc_list    = list(zip(month_cols, period_keys))
        def get_ret(sc, pk):
            for (y, m), k in _mc_list:
                if k == pk:
                    return month_return(conn, sc, y, m)
            return None
        def get_bm(pk):
            if not bm_id: return None
            for (y, m), k in _mc_list:
                if k == pk:
                    return month_return_index(conn, bm_id, y, m)
            return None
    elif view == "quarterly":
        q_cols      = _quarterly_columns()
        period_keys = [f"Q{q}-{y}" for y, q in q_cols[:-1]] + ["QTD"]
        _qc_list    = list(zip(q_cols, period_keys))
        def get_ret(sc, pk):
            for (y, q), k in _qc_list:
                if k == pk:
                    return quarter_return(conn, sc, y, q)
            return None
        def get_bm(pk):
            if not bm_id: return None
            for (y, q), k in _qc_list:
                if k == pk:
                    return quarter_return_index(conn, bm_id, y, q)
            return None
    elif view == "annual":
        ann_cols    = _annual_columns()
        period_keys = [str(y) if y < TODAY.year else f"YTD {y}" for y in ann_cols]
        _ac_list    = list(zip(ann_cols, period_keys))
        def get_ret(sc, pk):
            for y, k in _ac_list:
                if k == pk:
                    return annual_return(conn, sc, y)
            return None
        def get_bm(pk):
            if not bm_id: return None
            for y, k in _ac_list:
                if k == pk:
                    return annual_return_index(conn, bm_id, y)
            return None
    else:
        return

    # Build fund rows
    fund_rows = []
    all_returns_1y = {}   # for quartile ranking
    sectors = sector_map([(sc, name) for sc, name, _ in funds], cat_slug)

    for sc, name, amc in funds:
        ret_map = {pk: fmt(get_ret(sc, pk)) for pk in period_keys}
        fund_rows.append({
            "scheme_code": sc,
            "scheme_name": name,
            "amc_name":    amc,
            "returns":     ret_map,
            # Stamped for sectoral-thematic so the screener's sector filter reads
            # the same classification the quartiles were computed with, instead
            # of re-deriving it from the name in the browser.
            **({"sector": sectors[sc]} if sectors else {}),
        })
        # For Leaders & Laggards: store 12M / 1Y return
        if view == "trailing":
            all_returns_1y[sc] = trailing_return(conn, sc, "12M")
        elif view == "annual":
            all_returns_1y[sc] = annual_return(conn, sc, TODAY.year)

    # Category average + benchmark pinned rows
    avg_row = {pk: fmt(category_average([fr["returns"][pk] for fr in fund_rows])) for pk in period_keys}
    bm_row  = {pk: fmt(get_bm(pk)) for pk in period_keys}

    payload = {
        "as_of":         as_of,
        "view":          view,
        "category_id":   cat_id,
        "category_name": cat_name,
        "asset_class":   asset_class,
        "benchmark_id":  bm_id,
        "period_keys":   period_keys,
        "funds":         fund_rows,
        "category_avg":  avg_row,
        "benchmark":     bm_row,
    }
    if sectors:
        payload["sectors"] = sector_breakdown(sectors)
        # Per-sector averages, so selecting a sector can show its own average
        # row rather than the whole themed category's.
        payload["sector_avg"] = {
            s["sector"]: {
                pk: fmt(category_average([
                    fr["returns"][pk] for fr in fund_rows
                    if fr.get("sector") == s["sector"]
                ]))
                for pk in period_keys
            }
            for s in payload["sectors"]
        }

    write_json(out(f"category_{cat_slug}_{view}.json"), payload)
    log.info("✓ category_%s_%s.json (%d funds)", cat_slug, view, len(fund_rows))


# ── Leaders & Laggards — NO LONGER WRITTEN ────────────────────────────────────
#
# movers_{slug}.json was generated for all 37 categories every day and never
# read. The dashboard computes Leaders & Laggards in the browser from the
# category table it has already loaded — see the LeadersLaggards component in
# site/src/sections/FundScreener.tsx.


# ── Quartile grid (quartiles_{slug}_{mode}.json) ──────────────────────────────

def _quartile_periods(mode: str):
    """(periods, labels) for a mode — the single definition used everywhere."""
    if mode == "monthly":
        periods, y, m = [], TODAY.year, TODAY.month
        for _ in range(12):
            m -= 1
            if m == 0:
                m = 12; y -= 1
            periods.append((y, m))
        periods.reverse()
        return periods, [f"{_MONTH_ABBR[m]}-{y}" for y, m in periods]

    if mode == "quarterly":
        periods, y, q = [], TODAY.year, (TODAY.month - 1) // 3 + 1
        for _ in range(12):
            q -= 1
            if q == 0:
                q = 4; y -= 1
            periods.append((y, q))
        periods.reverse()
        return periods, [f"Q{q}-{y}" for y, q in periods]

    years = list(range(max(2018, TODAY.year - 7), TODAY.year))
    return years, [str(y) for y in years]


def _period_return(conn, scheme_code: str, mode: str, period):
    if mode == "monthly":
        return month_return(conn, scheme_code, period[0], period[1])
    if mode == "quarterly":
        return quarter_return(conn, scheme_code, period[0], period[1])
    return annual_return(conn, scheme_code, period)


def _trailing_streak(quartiles: list, good: bool) -> int:
    """
    Consecutive periods, counting back from the latest, spent in the top half
    (good=True -> Q1/Q2) or the bottom half (good=False -> Q3/Q4).

    Unranked periods break the streak rather than being skipped: a gap means we
    genuinely do not know how the fund did, and treating that as continuity
    would overstate the run.
    """
    streak = 0
    for q in reversed(quartiles):
        if q is None:
            break
        in_half = (q <= 2) if good else (q >= 3)
        if not in_half:
            break
        streak += 1
    return streak


# ── Watchlist (watchlist_{mode}.json) ─────────────────────────────────────────

def build_watchlist(conn, mode: str = "monthly"):
    """
    Cross-category exit/entry signals.

    Every other quartile file is per category; this one spans all of them so the
    dashboard can answer "which funds anywhere have been sliding?" without the
    browser fetching and stitching 17 separate files.

    Per fund it carries the streak in each direction, the full quartile history,
    and 1Y return against the fund's own category average — a Q3 fund in a
    strong peer group is a different proposition from one that is simply losing
    money, and the streak alone cannot tell them apart.
    """
    periods, labels = _quartile_periods(mode)

    # Minimum ranked history before a fund may appear in the exit/entry lists.
    # A fund three months old that ranks Q4 twice is not "consistently in the
    # bottom half" — there is simply not enough of a record to say. Gating here
    # keeps new launches out until they have one.
    MIN_HISTORY = {"monthly": 6, "quarterly": 3, "annual": 2}[mode]

    cats = conn.execute(
        """SELECT category_id, category_name, slug, asset_class
           FROM categories WHERE asset_class IN ('Equity','Hybrid')
           ORDER BY display_order"""
    ).fetchall()

    out_funds = []
    cat_meta = []

    for cat_id, cat_name, slug, asset_class in cats:
        funds = conn.execute(
            """SELECT s.scheme_code, s.scheme_name, a.amc_name
               FROM schemes s JOIN amcs a ON a.amc_id = s.amc_id
               WHERE s.category_id=? AND s.is_active=1
               ORDER BY s.scheme_name""",
            (cat_id,),
        ).fetchall()
        if not funds:
            continue

        returns_grid = {
            sc: [_period_return(conn, sc, mode, p) for p in periods]
            for sc, _, _ in funds
        }

        # Rank within the category, one period at a time — identical to
        # build_quartiles, so the two views can never disagree. For
        # sectoral-thematic that means within each sector.
        sectors = sector_map([(sc, name) for sc, name, _ in funds], slug)
        grid = {sc: [None] * len(periods) for sc, _, _ in funds}
        for i in range(len(periods)):
            rq = rank_within_sectors(
                {sc: returns_grid[sc][i] for sc, _, _ in funds}, sectors)
            for sc, _, _ in funds:
                grid[sc][i] = rq[sc][1]

        # 1Y trailing, plus the equal-weighted average of the same.
        r1y = {sc: trailing_return(conn, sc, "12M") for sc, _, _ in funds}
        cat_avg_1y = category_average(list(r1y.values()))

        # The verdict cards ask "is this fund beating its peers?". Once each
        # sector is its own peer group, the honest comparison is the sector's
        # average, not the whole themed category's — a pharma fund measured
        # against an average dominated by defence and quant funds is noise.
        peer_avg = {}
        if sectors:
            by_sector: dict[str, list] = {}
            for sc, _, _ in funds:
                by_sector.setdefault(sectors[sc], []).append(r1y[sc])
            sector_avg = {s: category_average(v) for s, v in by_sector.items()}
            peer_avg = {sc: sector_avg[sectors[sc]] for sc, _, _ in funds}

        cat_meta.append({
            "category_name": cat_name,
            "slug": slug,
            "asset_class": asset_class,
            "fund_count": len(funds),
            "avg_1y": fmt(cat_avg_1y),
            **({"ranked_within": "sector",
                "sectors": [{**s, "avg_1y": fmt(sector_avg[s["sector"]])}
                            for s in sector_breakdown(sectors)]} if sectors else {}),
        })

        for sc, name, amc in funds:
            qs = grid[sc]
            ranked = [q for q in qs if q is not None]
            out_funds.append({
                "scheme_code":   sc,
                "scheme_name":   name,
                "amc_name":      amc,
                "category_name": cat_name,
                "category_slug": slug,
                "asset_class":   asset_class,
                "quartiles":     qs,
                # Strictly the LAST period, not the last one that happened to be
                # ranked. Reading back to the most recent non-null let a fund
                # that stopped being ranked months ago keep contributing a stale
                # quartile to its AMC's current standing.
                "latest_q":      qs[-1] if qs else None,
                "last_ranked_q": next((q for q in reversed(qs) if q is not None), None),
                "exit_streak":   _trailing_streak(qs, good=False),
                "entry_streak":  _trailing_streak(qs, good=True),
                "top_half_pct":  round(sum(1 for q in ranked if q <= 2) / len(ranked), 4) if ranked else None,
                "ranked_periods": len(ranked),
                # False for a fund too new to judge — the dashboard keeps these
                # out of the exit/entry lists but still counts them elsewhere.
                "eligible":      len(ranked) >= MIN_HISTORY,
                "ret_1y":        fmt(r1y[sc]),
                # The fund's own peer group average: its sector for
                # sectoral-thematic, its category everywhere else. The dashboard
                # reads this to decide "beating its peers or not", so it has to
                # match whatever pool the quartile was computed in.
                "cat_avg_1y":    fmt(peer_avg.get(sc, cat_avg_1y) if sectors else cat_avg_1y),
                **({"sector": sectors[sc],
                    # Kept alongside so the whole-category figure is still
                    # available without recomputing it in the browser.
                    "category_avg_1y": fmt(cat_avg_1y)} if sectors else {}),
            })

    # ── AMC leaderboard ──────────────────────────────────────────────────────
    # Counted on the LATEST period only. An AMC's standing should reflect where
    # its funds sit now, not an average that a long tail of history can mask.
    amc: dict[str, dict] = {}
    for f in out_funds:
        a = amc.setdefault(f["amc_name"], {
            "amc_name": f["amc_name"], "funds": 0,
            "q1": 0, "q2": 0, "q3": 0, "q4": 0, "ranked": 0, "_q_sum": 0,
        })
        a["funds"] += 1
        q = f["latest_q"]
        if q:
            a[f"q{q}"] += 1
            a["ranked"] += 1
            a["_q_sum"] += q

    leaderboard = []
    for a in amc.values():
        if a["ranked"] == 0:
            continue
        leaderboard.append({
            "amc_name":     a["amc_name"],
            "funds":        a["funds"],
            "ranked":       a["ranked"],
            "q1":           a["q1"],
            "q2":           a["q2"],
            "q3":           a["q3"],
            "q4":           a["q4"],
            "top_half":     a["q1"] + a["q2"],
            "top_half_pct": round((a["q1"] + a["q2"]) / a["ranked"], 4),
            "avg_quartile": round(a["_q_sum"] / a["ranked"], 2),
        })
    # Best average quartile first; ties broken by the larger fund count, so a
    # house with 12 funds outranks one with a single lucky performer.
    leaderboard.sort(key=lambda x: (x["avg_quartile"], -x["ranked"]))

    write_json(out(f"watchlist_{mode}.json"), {
        "as_of":         get_as_of(conn),
        "mode":          mode,
        "min_history":   MIN_HISTORY,
        "period_labels": labels,
        "categories":    cat_meta,
        "funds":         out_funds,
        "amc_leaderboard": leaderboard,
    })
    log.info("✓ watchlist_%s.json (%d funds, %d AMCs)", mode, len(out_funds), len(leaderboard))


def build_quartiles(conn, cat_slug: str, mode: str = "quarterly"):
    row = conn.execute(
        "SELECT category_id, category_name, asset_class FROM categories WHERE slug=?", (cat_slug,)
    ).fetchone()
    if not row:
        return
    cat_id, cat_name, asset_class = row

    if asset_class not in ("Equity", "Hybrid"):
        return

    funds = conn.execute(
        "SELECT scheme_code, scheme_name FROM schemes WHERE category_id=? AND is_active=1 ORDER BY scheme_name",
        (cat_id,)
    ).fetchall()

    if mode == "monthly":
        # Last 12 completed months. Same construction as the quarterly branch:
        # step back from the current period so the current, incomplete one is
        # excluded — a partial month would rank against full ones.
        periods = []
        y, m = TODAY.year, TODAY.month
        for _ in range(12):
            m -= 1
            if m == 0:
                m = 12; y -= 1
            periods.append((y, m))
        periods.reverse()
        period_labels = [f"{_MONTH_ABBR[m]}-{y}" for y, m in periods]

        returns_grid = {}
        for sc, _ in funds:
            # month_return: start = first NAV on/after the 1st,
            #               end   = last NAV on/before the month's final day.
            returns_grid[sc] = [month_return(conn, sc, y, m) for y, m in periods]

    elif mode == "quarterly":
        # Last 12 completed quarters
        periods = []
        y, q = TODAY.year, (TODAY.month - 1) // 3 + 1
        for _ in range(12):
            q -= 1
            if q == 0:
                q = 4; y -= 1
            periods.append((y, q))
        periods.reverse()
        period_labels = [f"Q{q}-{y}" for y, q in periods]

        returns_grid = {}
        for sc, _ in funds:
            returns_grid[sc] = [quarter_return(conn, sc, y, q) for y, q in periods]

    else:  # annual
        years = list(range(max(2018, TODAY.year - 7), TODAY.year))  # last ~7 completed years
        period_labels = [str(y) for y in years]
        returns_grid = {}
        for sc, _ in funds:
            returns_grid[sc] = [annual_return(conn, sc, y) for y in years]

    # Per-period rank + quartile.
    #
    # For sectoral-thematic each sector is ranked on its own, so a Q1 here means
    # top quartile among IT funds rather than among all ~250 themed funds.
    sectors = sector_map(funds, cat_slug)
    n_periods = len(period_labels)
    all_quartiles = {sc: [None] * n_periods for sc, _ in funds}

    for p_idx in range(n_periods):
        period_returns = {sc: returns_grid[sc][p_idx] for sc, _ in funds}
        rq = rank_within_sectors(period_returns, sectors)
        for sc, _ in funds:
            all_quartiles[sc][p_idx] = rq[sc][1]   # quartile value 1–4 or None

    # Consistency + Volatility boxes (E10). Roughly half the periods shown, so a
    # fund needs a real track record before it can top either list.
    #
    # Both lists are read off the SAME quartile history, which is what stops a
    # fund appearing in both. The old pair ranked consistency on mean quartile and
    # volatility on the standard deviation of returns -- different quantities off
    # different inputs, so a fund that never left Q1 while swinging hard in
    # absolute terms legitimately topped both. See engine.quartile_journeys.
    min_p = 6 if mode in ("quarterly", "monthly") else 4
    journeys = quartile_journeys(all_quartiles, min_periods=min_p)

    fund_rows = [
        {
            "scheme_code": sc,
            "scheme_name": name,
            "quartiles":   all_quartiles[sc],
            # The return each quartile was computed from, same index as
            # `quartiles`. Emitted so the table can show it: a Q box beside an
            # unrelated 1Y figure reads as a bug — a fund can be top for the year
            # and bottom for the quarter, and without the period return on screen
            # there is no way to see that is what happened.
            "returns":     [fmt(v) for v in returns_grid[sc]],
            # Stamped here so the browser never has to classify a fund itself.
            # The rules live in scripts/sectors.py alone.
            **({"sector": sectors[sc]} if sectors else {}),
        }
        for sc, name in funds
    ]

    payload = {
        # The NAV date the quartiles were computed from, not the run date.
        "as_of":          get_as_of(conn),
        "category_name":  cat_name,
        "mode":           mode,
        "period_labels":  period_labels,
        "funds":          fund_rows,
        "most_consistent":journeys["consistent"],
        "most_volatile":  journeys["volatile"],
        # Level rather than stability, so these are share-based ("most of the
        # time in Q1/Q2") and may overlap the two lists above by design.
        "best_performers":  journeys["best"],
        "worst_performers": journeys["worst"],
    }
    if sectors:
        # Tells the UI that quartiles here are sector-relative, and which
        # sectors exist, so the filter is built from the data rather than a
        # hardcoded list that could drift.
        payload["ranked_within"] = "sector"
        payload["sectors"] = sector_breakdown(sectors)

    write_json(out(f"quartiles_{cat_slug}_{mode}.json"), payload)
    log.info("✓ quartiles_%s_%s.json (%d funds%s)", cat_slug, mode, len(funds),
             f", {len(payload['sectors'])} sectors ranked separately" if sectors else "")


# ── Rolling stats (rolling_{slug}.json) ───────────────────────────────────────

def build_rolling(conn, cat_slug: str):
    row = conn.execute(
        "SELECT category_id, category_name, benchmark_id FROM categories WHERE slug=?", (cat_slug,)
    ).fetchone()
    if not row:
        return
    cat_id, cat_name, bm_id = row

    funds = conn.execute(
        "SELECT scheme_code, scheme_name FROM schemes WHERE category_id=? AND is_active=1 ORDER BY scheme_name",
        (cat_id,)
    ).fetchall()

    fund_data = []
    windows   = ["1M", "3M", "6M", "1Y", "3Y", "5Y"]

    for sc, name in funds:
        stats = {}
        for w in windows:
            stats[w] = rolling_statistics(conn, sc, bm_id, w) if bm_id else {}
        fund_data.append({"scheme_code": sc, "scheme_name": name, "rolling": stats})

    write_json(out(f"rolling_{cat_slug}.json"), {
        "as_of": get_as_of(conn), "category": cat_name, "funds": fund_data
    })
    log.info("✓ rolling_%s.json", cat_slug)


# ── Risk Lab (risk_{slug}.json) ───────────────────────────────────────────────

def build_risk(conn, cat_slug: str):
    row = conn.execute(
        "SELECT category_id, category_name, benchmark_id FROM categories WHERE slug=?", (cat_slug,)
    ).fetchone()
    if not row:
        return
    cat_id, cat_name, bm_id = row
    if not bm_id:
        return

    rf = float(conn.execute("SELECT value FROM config WHERE key='risk_free_rate'").fetchone()[0])

    funds = conn.execute(
        "SELECT scheme_code, scheme_name FROM schemes WHERE category_id=? AND is_active=1 ORDER BY scheme_name",
        (cat_id,)
    ).fetchall()

    metrics_list = []
    for sc, name in funds:
        m = risk_metrics(conn, sc, bm_id, risk_free_rate=rf)
        m["scheme_code"] = sc
        m["scheme_name"] = name
        metrics_list.append(m)

    # Composite scoring
    wt_rows = conn.execute(
        "SELECT key, value FROM config WHERE key LIKE 'composite_weights_%'"
    ).fetchall()
    raw_weights = {k.replace("composite_weights_", ""): float(v) for k, v in wt_rows}
    # Map database config keys to engine expected keys
    key_map = {"maxdd": "max_drawdown", "capture": "capture_spread"}
    weights = {key_map.get(k, k): v for k, v in raw_weights.items()}
    metrics_list = composite_risk_score(metrics_list, weights or None)

    write_json(out(f"risk_{cat_slug}.json"), {
        "as_of":        get_as_of(conn),
        "category":     cat_name,
        "benchmark_id": bm_id,
        "risk_free_rate": rf,
        "funds":        metrics_list,
    })
    log.info("✓ risk_%s.json", cat_slug)


# ── Drawdown series — NO LONGER WRITTEN ───────────────────────────────────────
#
# This used to emit drawdown/{scheme_code}.json for all 2,372 funds: 303 MB,
# three quarters of the entire published payload, regenerated and committed
# every single day.
#
# Every value in it — drawdown_pct, is_trough, is_recovery — is a pure function
# of the fund's NAV series, which is already published as nav/{scheme_code}.json
# (85.6 MB). The frontend now derives the curve on demand in useData.ts
# (computeDrawdown), which is a direct port of
# engine/calculation_engine.py::drawdown_series.
#
# drawdown_series() itself is untouched and still backs risk_metrics().


# ── NAV series (nav/{scheme_code}.json) ───────────────────────────────────────

def build_nav_series(conn, cat_slug: str):
    row = conn.execute("SELECT category_id FROM categories WHERE slug=?", (cat_slug,)).fetchone()
    if not row:
        return
    # The name travels WITH the series. Trend Finder is handed bare fund codes
    # (that is the whole point of the manifest lookup) and had no way to resolve
    # one to a name, so every chart legend read "Fund 102434". Carrying the name
    # here costs a few bytes a file and saves the client fetching a whole category
    # table just to label a line.
    funds = conn.execute(
        "SELECT scheme_code, scheme_name FROM schemes "
        "WHERE category_id=? AND is_active=1", (row[0],)
    ).fetchall()
    for sc, name in funds:
        rows = conn.execute(
            "SELECT nav_date, nav FROM nav_history WHERE scheme_code=? ORDER BY nav_date", (sc,)
        ).fetchall()
        write_json(out(f"nav/{sc}.json"),
                   {"scheme_code": sc, "scheme_name": name, "series": rows})


# ── Category history series (category_history/{slug}.json) ─────────────────────

def build_category_history(conn, cat_slug: str):
    row = conn.execute("SELECT category_id FROM categories WHERE slug=?", (cat_slug,)).fetchone()
    if not row:
        return
    cat_id = row[0]
    
    # Get all active scheme codes for this category
    schemes = [r[0] for r in conn.execute(
        "SELECT scheme_code FROM schemes WHERE category_id = ? AND is_active = 1", (cat_id,)
    ).fetchall()]
    
    if not schemes:
        write_json(out(f"category_history/{cat_slug}.json"), {"category_slug": cat_slug, "series": []})
        return
        
    placeholders = ",".join("?" for _ in schemes)
    rows = conn.execute(f"""
        SELECT nav_date, AVG(nav)
        FROM nav_history
        WHERE scheme_code IN ({placeholders}) AND nav_date >= '2010-01-01'
        GROUP BY nav_date
        ORDER BY nav_date
    """, schemes).fetchall()
    
    payload = {"category_slug": cat_slug, "series": rows}

    # Sectoral/Thematic gets one extra series PER SECTOR.
    #
    # AMFI files every theme under a single category, so the one average above
    # blends banking funds with pharma and technology — a line that no fund
    # actually tracks. Category Trends can now open the sector list and chart each
    # theme's own average, which is the comparison a reader of that screen wants.
    #
    # These ride in the same file rather than one file per sector: there are ~22
    # sectors, the series are the same shape, and the screen needs several at once
    # to be worth anything.
    if cat_slug == SECTORAL_THEMATIC_SLUG:
        names = conn.execute(
            "SELECT scheme_code, scheme_name FROM schemes "
            "WHERE category_id=? AND is_active=1", (cat_id,)
        ).fetchall()
        by_sector: dict[str, list[str]] = {}
        for sc, name in names:
            by_sector.setdefault(sector_of(name), []).append(sc)

        sectors = []
        for sector in [s for s in SECTOR_ORDER if s in by_sector]:
            codes = by_sector[sector]
            ph = ",".join("?" for _ in codes)
            series = conn.execute(f"""
                SELECT nav_date, AVG(nav)
                FROM nav_history
                WHERE scheme_code IN ({ph}) AND nav_date >= '2010-01-01'
                GROUP BY nav_date
                ORDER BY nav_date
            """, codes).fetchall()
            sectors.append({"sector": sector, "fund_count": len(codes),
                            "series": series})
        payload["sectors"] = sectors
        log.info("   %s: %d sector series", cat_slug, len(sectors))

    write_json(out(f"category_history/{cat_slug}.json"), payload)


# ── Index series (index/{index_id}.json) ─────────────────────────────────────

def build_index_series(conn):
    indices = conn.execute("SELECT index_id, index_name FROM benchmarks WHERE is_active=1").fetchall()
    for index_id, name in indices:
        rows = conn.execute(
            "SELECT date, close FROM index_history WHERE index_id=? ORDER BY date", (index_id,)
        ).fetchall()
        write_json(out(f"index/{index_id}.json"), {"index_id": index_id, "index_name": name, "series": rows})
    log.info("✓ %d index series written", len(indices))


# ── Main orchestrator ─────────────────────────────────────────────────────────

def main():
    conn = _get_conn()
    as_of = get_as_of(conn)
    log.info("Building JSON outputs. Data as of: %s", as_of)

    build_meta(conn)
    build_indices(conn)
    build_funds_index(conn)

    categories = conn.execute(
        "SELECT category_id, slug, asset_class FROM categories ORDER BY display_order"
    ).fetchall()

    for _, slug, asset_class in categories:
        log.info("Processing category: %s", slug)
        for view in ["trailing", "monthly", "quarterly", "annual"]:
            build_category_table(conn, slug, view)
        if asset_class in ("Equity", "Hybrid"):
            for mode in ["monthly", "quarterly", "annual"]:
                build_quartiles(conn, slug, mode)
        build_rolling(conn, slug)
        build_risk(conn, slug)
        # build_drawdowns removed — the frontend derives the curve from nav/.
        build_nav_series(conn, slug)
        build_category_history(conn, slug)

    # Glance (all 4 views)
    for view in ["trailing", "monthly", "quarterly", "annual"]:
        build_glance(conn, view)

    # Cross-category exit/entry signals — one file per mode.
    for mode in ["monthly", "quarterly", "annual"]:
        build_watchlist(conn, mode)

    build_index_series(conn)

    log.info("✅  All JSON outputs written to %s", OUTPUT_DIR)
    conn.close()


if __name__ == "__main__":
    main()
