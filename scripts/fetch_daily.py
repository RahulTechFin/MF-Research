"""
scripts/fetch_daily.py — Daily data update orchestrator.

Run daily by GitHub Actions (P5):
  1. Fetch latest NAVs from AMFI NAVOpen.txt
  2. Fetch latest index closes from Yahoo Finance
  3. Run gap repair if any scheme is >3 trading days stale
  4. Rebuild synthetic blends

Usage:
  python scripts/fetch_daily.py
"""

import os, sys, logging
from datetime import date

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

from scripts.init_db import get_conn
from scripts.backfill_amfi import run_daily, run_repair
from scripts.backfill_indices import run_daily_indices

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("fetch_daily")


def check_staleness(conn):
    """Check if any scheme has been stale for >3 trading days."""
    row = conn.execute(
        "SELECT COUNT(*) FROM schemes s WHERE s.is_active=1 AND ("
        "  SELECT MAX(nav_date) FROM nav_history WHERE scheme_code=s.scheme_code"
        ") < date('now', '-4 days')"
    ).fetchone()
    stale_count = row[0] if row else 0
    if stale_count:
        log.warning("%d schemes are >3 trading days stale — running repair", stale_count)
    return stale_count > 0


def main():
    log.info("=== Daily data update starting (%s) ===", date.today())
    conn = get_conn()

    try:
        run_daily(conn)
        run_daily_indices(conn)

        if check_staleness(conn):
            run_repair(conn)

        log.info("=== Daily update complete ===")
        sys.exit(0)

    except Exception as exc:
        log.error("FATAL ERROR in daily update: %s", exc)
        sys.exit(1)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
