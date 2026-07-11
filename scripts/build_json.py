"""
scripts/build_json.py — Pre-compute ALL engine outputs and write JSON files.

Implements Appendix PB contract. ALL returns stored as decimals; null = —.
Every file carries 'as_of'. This runs AFTER run_engine.py has updated the DB.

Output files (in site/data/):
  meta.json, indices.json, glance_{view}.json,
  category_{slug}_{view}.json, movers_{slug}.json,
  amc_{amc}_{asset}.json, quartiles_{slug}_{mode}.json,
  rolling_{slug}.json, risk_{slug}.json,
  drawdown/{scheme_code}.json, nav/{scheme_code}.json,
  index/{index_id}.json
"""

from __future__ import annotations

import json
import os
import sys
import sqlite3
import logging
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

DB_PATH    = os.path.join(ROOT_DIR, "data", "mf_research.db")
OUTPUT_DIR = os.path.join(ROOT_DIR, "site", "public", "data")

from scripts.init_db import get_conn as _get_conn
from engine.calculation_engine import (
    trailing_return, trailing_return_index,
    annual_return,   annual_return_index,
    quarter_return,  quarter_return_index,
    month_return,    month_return_index,
    category_average, rank_and_quartile,
    normalize_series, consistency_top5, volatility_top5,
    risk_metrics, composite_risk_score, drawdown_series,
    rolling_statistics, anchor_date, index_anchor_date,
    TRAILING_PERIODS, QUARTER_STARTS, QUARTER_ENDS,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("build_json")

TODAY = date.today()

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

    write_json(out("indices.json"), {"as_of": TODAY.isoformat(), "indices": result})
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

        rows.append({
            **row_obj,
            "category_id":   cat_id,
            "asset_class":   asset_class,
            "category_name": cat_name,
            "slug":          slug,
            "benchmark_id":  bm_id,
            "fund_count":    len(funds),
            "averages":      cell_avgs,
            "benchmark":     bm_vals,
        })

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

    for sc, name, amc in funds:
        ret_map = {pk: fmt(get_ret(sc, pk)) for pk in period_keys}
        fund_rows.append({
            "scheme_code": sc,
            "scheme_name": name,
            "amc_name":    amc,
            "returns":     ret_map,
        })
        # For Leaders & Laggards: store 12M / 1Y return
        if view == "trailing":
            all_returns_1y[sc] = trailing_return(conn, sc, "12M")
        elif view == "annual":
            all_returns_1y[sc] = annual_return(conn, sc, TODAY.year)

    # Category average + benchmark pinned rows
    avg_row = {pk: fmt(category_average([fr["returns"][pk] for fr in fund_rows])) for pk in period_keys}
    bm_row  = {pk: fmt(get_bm(pk)) for pk in period_keys}

    write_json(out(f"category_{cat_slug}_{view}.json"), {
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
    })
    log.info("✓ category_%s_%s.json (%d funds)", cat_slug, view, len(fund_rows))


# ── Leaders & Laggards (movers_{slug}.json) ───────────────────────────────────

def build_movers(conn, cat_slug: str):
    row = conn.execute(
        "SELECT category_id, category_name, benchmark_id FROM categories WHERE slug=?", (cat_slug,)
    ).fetchone()
    if not row:
        return
    cat_id, cat_name, bm_id = row

    funds = conn.execute(
        "SELECT scheme_code, scheme_name FROM schemes WHERE category_id=? AND is_active=1",
        (cat_id,)
    ).fetchall()

    result = {}
    for period in ["1M", "3M", "6M", "12M"]:
        rets = {sc: trailing_return(conn, sc, period) for sc, _ in funds}
        cat_avg = category_average(list(rets.values()))

        eligible = [(sc, v) for sc, v in rets.items() if v is not None]
        eligible.sort(key=lambda x: x[1], reverse=True)

        # Map scheme_code → name
        name_map = {sc: name for sc, name in funds}

        top10 = [
            {"rank": i + 1, "scheme_code": sc, "scheme_name": name_map[sc],
             "return": fmt(v), "spread_vs_avg": fmt(v - cat_avg) if cat_avg else None}
            for i, (sc, v) in enumerate(eligible[:10])
        ]
        bottom10 = [
            {"rank": i + 1, "scheme_code": sc, "scheme_name": name_map[sc],
             "return": fmt(v), "spread_vs_avg": fmt(v - cat_avg) if cat_avg else None}
            for i, (sc, v) in enumerate(eligible[-10:][::-1])
        ]
        result[period] = {"top10": top10, "bottom10": bottom10, "cat_avg": fmt(cat_avg)}

    write_json(out(f"movers_{cat_slug}.json"), {"as_of": TODAY.isoformat(), "category": cat_name, "periods": result})
    log.info("✓ movers_%s.json", cat_slug)


# ── Quartile grid (quartiles_{slug}_{mode}.json) ──────────────────────────────

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

    if mode == "quarterly":
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

    # Per-period rank + quartile
    n_periods = len(period_labels)
    all_quartiles = {sc: [None] * n_periods for sc, _ in funds}

    for p_idx in range(n_periods):
        period_returns = {sc: returns_grid[sc][p_idx] for sc, _ in funds}
        rq = rank_and_quartile(period_returns)
        for sc, _ in funds:
            all_quartiles[sc][p_idx] = rq[sc][1]   # quartile value 1–4 or None

    # Consistency + Volatility boxes (E10)
    min_p = 6 if mode == "quarterly" else 4
    top_consistent = consistency_top5(all_quartiles, min_periods=min_p)
    top_volatile   = volatility_top5(returns_grid, min_periods=min_p)

    fund_rows = [
        {
            "scheme_code": sc,
            "scheme_name": name,
            "quartiles":   all_quartiles[sc],
        }
        for sc, name in funds
    ]

    write_json(out(f"quartiles_{cat_slug}_{mode}.json"), {
        "as_of":          TODAY.isoformat(),
        "category_name":  cat_name,
        "mode":           mode,
        "period_labels":  period_labels,
        "funds":          fund_rows,
        "most_consistent":top_consistent,
        "most_volatile":  top_volatile,
    })
    log.info("✓ quartiles_%s_%s.json (%d funds)", cat_slug, mode, len(funds))


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
        "as_of": TODAY.isoformat(), "category": cat_name, "funds": fund_data
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
        "as_of":        TODAY.isoformat(),
        "category":     cat_name,
        "benchmark_id": bm_id,
        "risk_free_rate": rf,
        "funds":        metrics_list,
    })
    log.info("✓ risk_%s.json", cat_slug)


# ── Drawdown series (drawdown/{scheme_code}.json) ─────────────────────────────

def build_drawdowns(conn, cat_slug: str):
    row = conn.execute("SELECT category_id FROM categories WHERE slug=?", (cat_slug,)).fetchone()
    if not row:
        return
    funds = conn.execute(
        "SELECT scheme_code FROM schemes WHERE category_id=? AND is_active=1", (row[0],)
    ).fetchall()
    for (sc,) in funds:
        dd = drawdown_series(conn, sc, "full")
        write_json(out(f"drawdown/{sc}.json"), {"scheme_code": sc, "drawdown": dd})


# ── NAV series (nav/{scheme_code}.json) ───────────────────────────────────────

def build_nav_series(conn, cat_slug: str):
    row = conn.execute("SELECT category_id FROM categories WHERE slug=?", (cat_slug,)).fetchone()
    if not row:
        return
    funds = conn.execute(
        "SELECT scheme_code FROM schemes WHERE category_id=? AND is_active=1", (row[0],)
    ).fetchall()
    for (sc,) in funds:
        rows = conn.execute(
            "SELECT nav_date, nav FROM nav_history WHERE scheme_code=? ORDER BY nav_date", (sc,)
        ).fetchall()
        write_json(out(f"nav/{sc}.json"), {"scheme_code": sc, "series": rows})


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
    
    write_json(out(f"category_history/{cat_slug}.json"), {"category_slug": cat_slug, "series": rows})


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

    categories = conn.execute(
        "SELECT category_id, slug, asset_class FROM categories ORDER BY display_order"
    ).fetchall()

    for _, slug, asset_class in categories:
        log.info("Processing category: %s", slug)
        for view in ["trailing", "monthly", "quarterly", "annual"]:
            build_category_table(conn, slug, view)
        build_movers(conn, slug)
        if asset_class in ("Equity", "Hybrid"):
            for mode in ["quarterly", "annual"]:
                build_quartiles(conn, slug, mode)
        build_rolling(conn, slug)
        build_risk(conn, slug)
        build_drawdowns(conn, slug)
        build_nav_series(conn, slug)
        build_category_history(conn, slug)

    # Glance (all 4 views)
    for view in ["trailing", "monthly", "quarterly", "annual"]:
        build_glance(conn, view)

    build_index_series(conn)

    log.info("✅  All JSON outputs written to %s", OUTPUT_DIR)
    conn.close()


if __name__ == "__main__":
    main()
