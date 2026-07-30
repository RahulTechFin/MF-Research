"""
backup_gsheets.py — Mirror the full NAV history into Google Sheets as a
second, independent backup of api.mfapi.in.

WHY IT IS SPLIT
---------------
Google Sheets allows a hard maximum of 10,000,000 cells per spreadsheet.
The full history is ~5.9M NAV rows x 3 columns = ~17.7M cells — comfortably
over the limit. So the data is partitioned by year-range across several
spreadsheets, each kept under a safety ceiling (default 8M cells).

Be aware of what this costs: the Sheets API accepts roughly 300 write requests
per minute, and a full seed writes millions of rows in ~20k-row chunks. Expect
the first run to take a long time (typically 1-3 hours) and to be rate-limited
along the way. It checkpoints after every chunk and is safe to re-run — it
resumes where it stopped.

SETUP (one time)
----------------
  1. Google Cloud Console -> create project -> enable "Google Sheets API"
     and "Google Drive API".
  2. Create a Service Account -> Keys -> Add key -> JSON. Download it.
  3. Save it as  secrets/gsheets_service_account.json  (git-ignored), or set
     GOOGLE_SERVICE_ACCOUNT_JSON to the file path or the raw JSON.
  4. pip install gspread google-auth
  5. Share each created spreadsheet with your own Google account — the script
     prints the URLs and can do this automatically via --share you@email.com

USAGE
-----
  python scripts/backup_gsheets.py --seed        # first full upload (slow)
  python scripts/backup_gsheets.py --daily       # append the newest day only
  python scripts/backup_gsheets.py --status      # show what exists
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sqlite3
import sys
import time
from datetime import date, datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("gsheets_backup")

STATE_PATH = os.path.join(ROOT_DIR, "data", "gsheets_backup_state.json")
CREDS_DEFAULT = os.path.join(ROOT_DIR, "secrets", "gsheets_service_account.json")

CELL_LIMIT = 10_000_000
SAFE_CELL_CEILING = 8_000_000     # leave headroom for daily appends
COLUMNS = ["scheme_code", "nav_date", "nav"]
ROWS_PER_SPREADSHEET = SAFE_CELL_CEILING // len(COLUMNS)   # ~2.66M rows
CHUNK_ROWS = 20_000               # rows per API write call
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


# ── state ────────────────────────────────────────────────────────────────────

def load_state() -> dict:
    if os.path.exists(STATE_PATH):
        with open(STATE_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    return {"version": 1, "spreadsheets": [], "last_appended_date": None}


def save_state(state: dict):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, STATE_PATH)


# ── auth ─────────────────────────────────────────────────────────────────────

def get_client():
    try:
        import gspread
        from google.oauth2.service_account import Credentials
    except ImportError:
        raise SystemExit(
            "Missing dependencies. Run:\n    pip install gspread google-auth"
        )

    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if raw and raw.strip().startswith("{"):
        info = json.loads(raw)
    else:
        path = raw or CREDS_DEFAULT
        if not os.path.exists(path):
            raise SystemExit(
                f"Service account JSON not found at {path}\n"
                f"See the SETUP section at the top of this file."
            )
        with open(path, encoding="utf-8") as fh:
            info = json.load(fh)

    creds = Credentials.from_service_account_info(info, scopes=SCOPES)
    return gspread.authorize(creds)


def with_retry(fn, *a, what="sheets call", tries=6, **kw):
    """Sheets API rate limits aggressively; back off and keep going."""
    for attempt in range(1, tries + 1):
        try:
            return fn(*a, **kw)
        except Exception as exc:
            msg = str(exc)
            transient = any(s in msg for s in ("429", "500", "502", "503", "504",
                                               "Quota", "quota", "rateLimit", "timed out"))
            if not transient or attempt == tries:
                raise
            wait = min(60, 2 ** attempt) + (attempt * 0.5)
            log.warning("%s hit a limit (attempt %d/%d) — waiting %.0fs", what, attempt, tries, wait)
            time.sleep(wait)


# ── data source ──────────────────────────────────────────────────────────────

def open_source_db(db_path: str | None) -> sqlite3.Connection:
    path = db_path or os.environ.get("MF_DB_PATH") or os.path.join(ROOT_DIR, "data", "mf_research.db")
    if not os.path.exists(path):
        raise SystemExit(
            f"No source database at {path}\n"
            f"Build one first:  python scripts/build_db_from_api.py --db {path}"
        )
    return sqlite3.connect(path)


def year_row_counts(conn) -> list[tuple[str, int]]:
    return conn.execute(
        "SELECT substr(nav_date,1,4) AS y, COUNT(*) FROM nav_history GROUP BY y ORDER BY y"
    ).fetchall()


def plan_partitions(counts: list[tuple[str, int]]) -> list[dict]:
    """Group consecutive years so each spreadsheet stays under the cell ceiling."""
    parts: list[dict] = []
    cur = {"years": [], "rows": 0}
    for year, n in counts:
        if cur["years"] and cur["rows"] + n > ROWS_PER_SPREADSHEET:
            parts.append(cur)
            cur = {"years": [], "rows": 0}
        cur["years"].append(year)
        cur["rows"] += n
    if cur["years"]:
        parts.append(cur)

    for p in parts:
        p["from_year"] = p["years"][0]
        p["to_year"] = p["years"][-1]
        p["title"] = f"MF_NAV_{p['from_year']}_{p['to_year']}"
        p["cells"] = p["rows"] * len(COLUMNS)
    return parts


# ── seeding ──────────────────────────────────────────────────────────────────

def ensure_spreadsheet(gc, state: dict, part: dict, share_with: str | None):
    existing = next((s for s in state["spreadsheets"] if s["title"] == part["title"]), None)
    if existing:
        return existing

    log.info("Creating spreadsheet %s (~%s rows, %s cells)",
             part["title"], f"{part['rows']:,}", f"{part['cells']:,}")
    sh = with_retry(gc.create, part["title"], what="create spreadsheet")

    ws = sh.sheet1
    with_retry(ws.update_title, "nav_history", what="rename worksheet")
    # Size the grid up front — Sheets grows lazily otherwise and appends fail.
    with_retry(ws.resize, rows=part["rows"] + 1000, cols=len(COLUMNS), what="resize grid")
    with_retry(ws.update, [COLUMNS], "A1", what="write header")

    if share_with:
        with_retry(sh.share, share_with, perm_type="user", role="writer",
                   what="share spreadsheet")
        log.info("  shared with %s", share_with)

    entry = {
        "title": part["title"],
        "id": sh.id,
        "url": f"https://docs.google.com/spreadsheets/d/{sh.id}",
        "from_year": part["from_year"],
        "to_year": part["to_year"],
        "rows_written": 0,
        "expected_rows": part["rows"],
        "complete": False,
    }
    state["spreadsheets"].append(entry)
    save_state(state)
    log.info("  %s", entry["url"])
    return entry


def seed_partition(gc, conn, entry: dict):
    """Stream one year-range into its spreadsheet, resuming from a checkpoint."""
    if entry.get("complete"):
        log.info("%s already complete (%s rows) — skipping",
                 entry["title"], f"{entry['rows_written']:,}")
        return

    sh = with_retry(gc.open_by_key, entry["id"], what="open spreadsheet")
    ws = with_retry(sh.worksheet, "nav_history", what="open worksheet")

    offset = entry["rows_written"]
    cur = conn.execute(
        """SELECT scheme_code, nav_date, nav FROM nav_history
           WHERE substr(nav_date,1,4) BETWEEN ? AND ?
           ORDER BY nav_date, scheme_code
           LIMIT -1 OFFSET ?""",
        (entry["from_year"], entry["to_year"], offset),
    )

    log.info("Seeding %s from row %s ...", entry["title"], f"{offset:,}")
    t0 = time.time()
    while True:
        batch = cur.fetchmany(CHUNK_ROWS)
        if not batch:
            break
        values = [[c, d, float(n)] for c, d, n in batch]
        start_row = entry["rows_written"] + 2          # +1 header, +1 for 1-indexing
        end_row = start_row + len(values) - 1
        rng = f"A{start_row}:C{end_row}"

        with_retry(ws.update, values, rng,
                   value_input_option="USER_ENTERED", what=f"write {rng}")

        entry["rows_written"] += len(values)
        save_state_for(entry)

        done = entry["rows_written"]
        rate = done / max(time.time() - t0, 0.001)
        log.info("  %s: %s / %s rows (%.0f rows/s)",
                 entry["title"], f"{done:,}", f"{entry['expected_rows']:,}", rate)

    entry["complete"] = True
    save_state_for(entry)
    log.info("%s COMPLETE — %s rows", entry["title"], f"{entry['rows_written']:,}")


_STATE_CACHE: dict = {}


def save_state_for(entry: dict):
    """Persist the shared state object after mutating one entry."""
    state = _STATE_CACHE.get("state")
    if state is not None:
        save_state(state)


def cmd_seed(args):
    gc = get_client()
    conn = open_source_db(args.db)
    state = load_state()
    _STATE_CACHE["state"] = state

    counts = year_row_counts(conn)
    total = sum(n for _, n in counts)
    parts = plan_partitions(counts)

    log.info("=" * 62)
    log.info("Full history: %s rows, %s cells", f"{total:,}", f"{total * 3:,}")
    log.info("Sheets cap  : %s cells per spreadsheet", f"{CELL_LIMIT:,}")
    log.info("Partitions  : %d spreadsheets", len(parts))
    for p in parts:
        log.info("   %-22s %s -> %s   %s rows",
                 p["title"], p["from_year"], p["to_year"], f"{p['rows']:,}")
    log.info("=" * 62)

    if not args.yes:
        log.warning("This will take a long time (typically 1-3 hours) and is resumable.")
        log.warning("Re-run with --yes to start.")
        return

    for part in parts:
        entry = ensure_spreadsheet(gc, state, part, args.share)
        save_state(state)
        seed_partition(gc, conn, entry)

    conn.close()
    log.info("Seed complete. Spreadsheets:")
    for s in state["spreadsheets"]:
        log.info("   %-22s %s", s["title"], s["url"])


# ── daily append ─────────────────────────────────────────────────────────────

def cmd_daily(args):
    """Append the newest NAV day to the most recent spreadsheet."""
    gc = get_client()
    conn = open_source_db(args.db)
    state = load_state()
    _STATE_CACHE["state"] = state

    if not state["spreadsheets"]:
        raise SystemExit("Nothing seeded yet. Run:  python scripts/backup_gsheets.py --seed --yes")

    target_date = args.date or conn.execute(
        "SELECT MAX(nav_date) FROM nav_history"
    ).fetchone()[0]

    if state.get("last_appended_date") == target_date:
        log.info("%s already appended — nothing to do.", target_date)
        return

    rows = conn.execute(
        "SELECT scheme_code, nav_date, nav FROM nav_history WHERE nav_date=? ORDER BY scheme_code",
        (target_date,),
    ).fetchall()
    if not rows:
        log.warning("No NAV rows for %s — nothing appended.", target_date)
        return

    year = target_date[:4]
    entry = next((s for s in state["spreadsheets"]
                  if s["from_year"] <= year <= s["to_year"]), None)
    if entry is None:
        entry = state["spreadsheets"][-1]
        log.warning("No partition covers %s; appending to %s", year, entry["title"])

    # Rotate to a new spreadsheet if this one is near the cell ceiling.
    if (entry["rows_written"] + len(rows)) * len(COLUMNS) > SAFE_CELL_CEILING:
        log.warning("%s is near the cell limit — creating an overflow spreadsheet", entry["title"])
        part = {
            "title": f"MF_NAV_{year}_overflow_{len(state['spreadsheets'])}",
            "from_year": year, "to_year": "9999",
            "rows": 500_000, "cells": 1_500_000,
        }
        entry = ensure_spreadsheet(gc, state, part, args.share)

    sh = with_retry(gc.open_by_key, entry["id"], what="open spreadsheet")
    ws = with_retry(sh.worksheet, "nav_history", what="open worksheet")

    values = [[c, d, float(n)] for c, d, n in rows]
    start_row = entry["rows_written"] + 2
    rng = f"A{start_row}:C{start_row + len(values) - 1}"
    with_retry(ws.update, values, rng, value_input_option="USER_ENTERED", what="append day")

    entry["rows_written"] += len(values)
    state["last_appended_date"] = target_date
    save_state(state)

    log.info("Appended %s rows for %s to %s", f"{len(values):,}", target_date, entry["title"])
    conn.close()


def cmd_status(args):
    state = load_state()
    if not state["spreadsheets"]:
        log.info("Nothing seeded yet.")
        return
    log.info("Last appended date: %s", state.get("last_appended_date"))
    total = 0
    for s in state["spreadsheets"]:
        total += s["rows_written"]
        log.info("%-24s %-9s rows  complete=%-5s  %s",
                 s["title"], f"{s['rows_written']:,}", s["complete"], s["url"])
    log.info("TOTAL backed up: %s rows (%s cells)", f"{total:,}", f"{total*3:,}")


def main():
    ap = argparse.ArgumentParser(description="Google Sheets backup of the NAV history")
    ap.add_argument("--seed", action="store_true", help="full historical upload (resumable)")
    ap.add_argument("--daily", action="store_true", help="append the latest NAV day")
    ap.add_argument("--status", action="store_true", help="show backup state")
    ap.add_argument("--db", default=None, help="source database (default: data/mf_research.db)")
    ap.add_argument("--date", default=None, help="explicit date to append (YYYY-MM-DD)")
    ap.add_argument("--share", default=None, help="Google account to share the sheets with")
    ap.add_argument("--yes", action="store_true", help="confirm the long seeding run")
    args = ap.parse_args()

    if args.seed:
        cmd_seed(args)
    elif args.daily:
        cmd_daily(args)
    elif args.status:
        cmd_status(args)
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
