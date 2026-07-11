"""
backfill_indices.py — Fetch and store Yahoo Finance closing prices for all
index tickers defined in the benchmarks table.

- Verifies each ticker actually returns data (logs failures)
- Backfills from 2010-01-01 (or listing date) to today
- Builds synthetic blended benchmark series (E7.1) after real data is in
- Safe to re-run (upserts only)

Usage:
  python scripts/backfill_indices.py           # full index backfill + synth
  python scripts/backfill_indices.py --synth   # re-build synthetics only
  python scripts/backfill_indices.py --daily   # today's closes only
"""

import os
import sys
import logging
import argparse
import sqlite3
import time
import requests
from datetime import date, datetime, timedelta

import yfinance as yf
import pandas as pd

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

DB_PATH = os.path.join(ROOT_DIR, "data", "mf_research.db")

from scripts.init_db import get_conn as _get_conn

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("backfill_indices")

BACKFILL_START = "2010-01-01"

# Create a session with browser User-Agent to bypass rate limit blocks
session = requests.Session()
session.headers.update({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
})

def fetch_yahoo(ticker: str, start: str, end: str) -> pd.DataFrame | None:
    """
    Download daily closing prices from Yahoo Finance.
    Returns DataFrame with columns [date(str), close(float)] or None.
    Attempts later start dates if the index did not exist in 2010.
    """
    # Start date fallback list
    start_candidates = [start, "2016-01-01", "2018-01-01", "2020-01-01"]
    
    for s_date in start_candidates:
        if s_date > start:
            if s_date >= end:
                continue
            log.warning("    Retrying %s with later start date: %s", ticker, s_date)
            
        try:
            # yfinance rate-limiting workaround: sleep before requesting
            time.sleep(2.0)
            df = yf.download(
                ticker,
                start=s_date,
                end=end,
                progress=False,
                auto_adjust=True,
                threads=False,
                session=session
            )
            if df is not None and not df.empty:
                # Handle MultiIndex columns if yfinance returns them
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = df.columns.get_level_values(0)

                df = df[["Close"]].copy()
                df.index = pd.to_datetime(df.index)
                df = df.dropna()
                df.columns = ["close"]
                df.index.name = "date"
                df = df.reset_index()
                df["date"] = df["date"].dt.strftime("%Y-%m-%d")
                df["close"] = df["close"].astype(float).round(4)
                return df

        except Exception as exc:
            log.warning("    yf.download failed for %s: %s — trying direct CSV fallback", ticker, exc)
            
        # Try direct CSV download as fallback
        try:
            p1 = int(datetime.strptime(s_date, "%Y-%m-%d").timestamp())
            p2 = int(datetime.strptime(end, "%Y-%m-%d").timestamp())
            csv_url = f"https://query1.finance.yahoo.com/v7/finance/download/{ticker}?period1={p1}&period2={p2}&interval=1d&events=history&includeAdjustedClose=true"
            time.sleep(1.0)
            r = session.get(csv_url, timeout=15)
            if r.status_code == 200:
                import io
                df = pd.read_csv(io.StringIO(r.text))
                if not df.empty:
                    df = df.rename(columns={"Date": "date", "Close": "close"})
                    df = df[["date", "close"]].copy()
                    df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
                    df["close"] = df["close"].astype(float).round(4)
                    return df
            else:
                log.warning("    Direct CSV HTTP %d for %s", r.status_code, ticker)
        except Exception as direct_exc:
            log.warning("    Direct CSV fallback failed for %s: %s", ticker, direct_exc)
            
    log.error("  All download attempts failed for %s", ticker)
    return None


# ── DB helpers ────────────────────────────────────────────────────────────────

def upsert_index_data(conn: sqlite3.Connection, index_id: int, df: pd.DataFrame) -> tuple[int, int]:
    """Insert daily closes into index_history. Returns (inserted, skipped)."""
    cur = conn.cursor()
    inserted = skipped = 0
    for _, row in df.iterrows():
        res = cur.execute(
            "INSERT OR IGNORE INTO index_history(index_id, date, close) VALUES(?,?,?)",
            (index_id, row["date"], row["close"])
        )
        if res.rowcount:
            inserted += 1
        else:
            skipped += 1
    conn.commit()
    return inserted, skipped


def get_last_date(conn: sqlite3.Connection, index_id: int) -> str | None:
    row = conn.execute(
        "SELECT MAX(date) FROM index_history WHERE index_id=?", (index_id,)
    ).fetchone()
    return row[0] if row else None


# ── Main index backfill ───────────────────────────────────────────────────────

def run_index_backfill(conn: sqlite3.Connection, start: str = BACKFILL_START):
    """Fetch all real (non-synthetic) tickers from the benchmarks table."""
    benchmarks = conn.execute(
        "SELECT index_id, index_name, yahoo_ticker FROM benchmarks WHERE is_synthetic=0 AND is_active=1"
    ).fetchall()

    log.info("Fetching %d real index tickers …", len(benchmarks))
    failed = []

    for index_id, index_name, ticker in benchmarks:
        if not ticker:
            log.warning("No ticker for %s — skipping", index_name)
            continue

        # If we already have data, only fetch what's missing.
        # Otherwise, override start date to 2019-01-01 for indices that don't have historical data back to 2010 on Yahoo
        last = get_last_date(conn, index_id)
        if last:
            fetch_start = (datetime.fromisoformat(last) + timedelta(days=1)).strftime("%Y-%m-%d")
        else:
            if ticker in ["NIFTYSMLCAP250.NS", "NIFTY_LARGEMID250.NS"]:
                fetch_start = "2019-01-01"
            else:
                fetch_start = start
        fetch_end = (date.today() + timedelta(days=1)).strftime("%Y-%m-%d")

        if fetch_start >= fetch_end:
            log.info("  %-35s already up-to-date (%s)", index_name, last)
            continue

        log.info("  %-35s %s → %s …", index_name, fetch_start, fetch_end)
        df = fetch_yahoo(ticker, fetch_start, fetch_end)

        if df is None or df.empty:
            log.error("  FAILED: %s (%s) — no data returned", index_name, ticker)
            failed.append((index_name, ticker))
            continue

        ins, skp = upsert_index_data(conn, index_id, df)
        log.info("  ✓ %-35s rows=%d  inserted=%d  skipped=%d", index_name, len(df), ins, skp)

    if failed:
        log.warning("\n⚠️  FAILED TICKERS — fix in benchmarks table:")
        for name, ticker in failed:
            log.warning("   %-35s  ticker=%s", name, ticker)
    else:
        log.info("All tickers fetched successfully.")


# ── Synthetic blend builder (E7.1) ────────────────────────────────────────────

def build_synthetic_blends(conn: sqlite3.Connection):
    """
    Build daily-rebalanced blended benchmark series for hybrid categories.
    Formula (E7.1):
        blend_t = blend_{t-1} × (1 + Σ_i w_i × r_{i,t})
        where r_{i,t} = (close_{i,t} / close_{i,t-1}) − 1
    Series starts at 100.00.
    Stored in index_history like any real index.
    """
    synthetics = conn.execute(
        "SELECT index_id, index_name FROM benchmarks WHERE is_synthetic=1 AND is_active=1"
    ).fetchall()

    if not synthetics:
        log.info("No synthetic benchmarks to build.")
        return

    log.info("Building %d synthetic blend series …", len(synthetics))

    for blend_id, blend_name in synthetics:
        # Get components + weights
        components = conn.execute("""
            SELECT bc.component_index_id, bc.weight, b.index_name
            FROM benchmark_components bc
            JOIN benchmarks b ON bc.component_index_id = b.index_id
            WHERE bc.index_id = ?
        """, (blend_id,)).fetchall()

        if not components:
            log.warning("  No components for %s — skip", blend_name)
            continue

        # Load all component close series
        comp_frames = {}
        for comp_id, weight, comp_name in components:
            rows = conn.execute(
                "SELECT date, close FROM index_history WHERE index_id=? ORDER BY date",
                (comp_id,)
            ).fetchall()
            if not rows:
                log.warning("  Component %s has no data — skipping blend %s", comp_name, blend_name)
                comp_frames = {}
                break
            comp_frames[comp_id] = {"weight": weight, "name": comp_name,
                                     "data": {r[0]: r[1] for r in rows}}

        if not comp_frames:
            continue

        # Find common date range
        all_dates = sorted(
            set.intersection(*[set(v["data"].keys()) for v in comp_frames.values()])
        )
        if len(all_dates) < 2:
            log.warning("  Not enough common dates for %s", blend_name)
            continue

        # Build blend series (daily rebalanced, starting at 100)
        blend_series = {}
        prev_value   = 100.0
        prev_dates   = {cid: None for cid in comp_frames}
        first_date   = True

        for d in all_dates:
            if first_date:
                # Initialize first date at index value 100.0
                blend_series[d] = 100.0
                for cid in comp_frames:
                    prev_dates[cid] = d
                first_date = False
                continue

            # Daily return: need previous close for each component
            daily_return = 0.0
            valid = True
            for cid, info in comp_frames.items():
                close_t = info["data"].get(d)
                close_prev = info["data"].get(prev_dates.get(cid)) if prev_dates.get(cid) else None

                if close_t is None or close_prev is None:
                    valid = False
                    break
                r_i = (close_t / close_prev) - 1
                daily_return += info["weight"] * r_i

            if not valid:
                # Carry forward last known index value on index holiday/missing component close
                blend_series[d] = prev_value
                # If the current day is partially missing, still update the available components
                for cid in comp_frames:
                    if comp_frames[cid]["data"].get(d) is not None:
                        prev_dates[cid] = d
                continue

            new_value = prev_value * (1 + daily_return)
            blend_series[d] = round(new_value, 6)
            prev_value = new_value

            for cid in comp_frames:
                if comp_frames[cid]["data"].get(d) is not None:
                    prev_dates[cid] = d

        if not blend_series:
            log.warning("  Empty blend series for %s", blend_name)
            continue

        # Delete existing synthetic series and re-insert (full rebuild)
        conn.execute("DELETE FROM index_history WHERE index_id=?", (blend_id,))
        df = pd.DataFrame(list(blend_series.items()), columns=["date", "close"])
        ins, _ = upsert_index_data(conn, blend_id, df)
        log.info("  ✓ %-40s  dates=%d  rows_inserted=%d", blend_name, len(blend_series), ins)

    log.info("Synthetic blends done.")


# ── Daily update ──────────────────────────────────────────────────────────────

def run_daily_indices(conn: sqlite3.Connection):
    """Fetch today's closes for all real indices and rebuild synthetics."""
    run_index_backfill(conn)      # will only fetch missing dates (today)
    build_synthetic_blends(conn)  # rebuild synthetics with new data


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Yahoo Finance index backfill")
    parser.add_argument("--synth",   action="store_true", help="Re-build synthetic blends only")
    parser.add_argument("--daily",   action="store_true", help="Today's data only (then rebuild synthetics)")
    parser.add_argument("--from",    dest="from_date", default=BACKFILL_START)
    args = parser.parse_args()

    conn = _get_conn()

    if args.synth:
        build_synthetic_blends(conn)
    elif args.daily:
        run_daily_indices(conn)
    else:
        run_index_backfill(conn, start=args.from_date)
        build_synthetic_blends(conn)

    conn.close()


if __name__ == "__main__":
    main()
