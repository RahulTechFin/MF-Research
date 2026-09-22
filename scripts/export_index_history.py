"""
export_index_history.py — Freeze benchmark index history into a committed file.

WHY THIS IS STORED WHEN NAVs ARE NOT
------------------------------------
NAVs come from api.mfapi.in, which happily serves 3,200 full histories in ~2
minutes, so they are re-fetched every run and never stored.

Index data cannot work that way. Yahoo Finance is the only source, and pulling
31 tickers x 16 years on every run gets the account rate-limited:

    YFRateLimitError: Too Many Requests. Rate limited. Try after a while.

When that happens the pipeline still succeeds, but every index series comes out
empty and the Market Pulse strip renders blank. So the history is committed
(~133K rows, a few MB) and each run only tops up the missing recent days —
a handful of small requests instead of a full backfill.

Usage:
  python scripts/export_index_history.py --from-db data/mf_research.db
  python scripts/export_index_history.py --status
"""

from __future__ import annotations

import argparse
import gzip
import json
import logging
import os
import sqlite3
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("export_index_history")

INDEX_HISTORY_PATH = os.path.join(ROOT_DIR, "data", "index_history.json.gz")


def export_from_db(db_path: str, out_path: str):
    if not os.path.exists(db_path):
        raise SystemExit(f"No database at {db_path}")

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT index_id, date, close FROM index_history ORDER BY index_id, date"
        ).fetchall()
    finally:
        conn.close()

    if not rows:
        raise SystemExit("Source database has no index_history rows")

    # Group by index so dates and closes compress well as parallel arrays.
    series: dict[str, dict] = {}
    for index_id, d, close in rows:
        s = series.setdefault(str(index_id), {"dates": [], "closes": []})
        s["dates"].append(d)
        s["closes"].append(close)

    payload = {
        "version": 1,
        "row_count": len(rows),
        "index_count": len(series),
        "series": series,
    }

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    log.info("Wrote %s rows across %d indices to %s (%.1f MB gzipped)",
             f"{len(rows):,}", len(series), out_path, size_mb)
    for iid, s in sorted(series.items(), key=lambda x: int(x[0]))[:5]:
        log.info("   index %-3s %s -> %s  (%d points)",
                 iid, s["dates"][0], s["dates"][-1], len(s["dates"]))


def load(path: str = INDEX_HISTORY_PATH) -> dict | None:
    """Read the committed index history, or None if it has not been created."""
    if not os.path.exists(path):
        return None
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def restore_into(conn: sqlite3.Connection, path: str = INDEX_HISTORY_PATH) -> int:
    """Load the committed history into a database. Returns rows inserted."""
    payload = load(path)
    if not payload:
        log.warning("No committed index history at %s", path)
        return 0

    # The committed file is the build's ONLY source of index history before the
    # Yahoo top-up, so a glitch in it reaches every published risk figure. See
    # index_store.drop_isolated_outliers for what this catches and what it
    # deliberately leaves alone.
    from scripts.index_store import drop_isolated_outliers

    rows = []
    dropped = 0
    for iid, s in payload["series"].items():
        idx = int(iid)
        points = dict(zip(s["dates"], s["closes"]))
        cleaned, notes = drop_isolated_outliers(points, f"index {iid}")
        for note in notes:
            log.warning("   %s", note)
        dropped += len(points) - len(cleaned)
        rows.extend((idx, d, c) for d, c in sorted(cleaned.items()))

    conn.executemany(
        "INSERT OR IGNORE INTO index_history(index_id, date, close) VALUES(?,?,?)", rows
    )
    conn.commit()
    log.info("Restored %s index rows from the committed history%s",
             f"{len(rows):,}",
             f" ({dropped} glitched point(s) dropped)" if dropped else "")
    return len(rows)


def status(path: str = INDEX_HISTORY_PATH):
    payload = load(path)
    if not payload:
        log.info("No index history file at %s", path)
        return
    log.info("%s rows across %d indices (%.1f MB)",
             f"{payload['row_count']:,}", payload["index_count"],
             os.path.getsize(path) / 1024 / 1024)
    latest = max(s["dates"][-1] for s in payload["series"].values() if s["dates"])
    log.info("newest date: %s", latest)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-db", default=os.path.join(ROOT_DIR, "data", "mf_research.db"))
    ap.add_argument("--out", default=INDEX_HISTORY_PATH)
    ap.add_argument("--status", action="store_true")
    args = ap.parse_args()

    if args.status:
        status(args.out)
    else:
        export_from_db(args.from_db, args.out)


if __name__ == "__main__":
    main()
