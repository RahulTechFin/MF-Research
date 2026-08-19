"""
daily_run.py — The whole daily pipeline, start to finish, storing nothing.

    api.mfapi.in  ──►  temp SQLite  ──►  calculation_engine  ──►  site/public/data/*.json
                       (deleted at end)      (unchanged)              (~6 MB, deployed)

Run once a day by .github/workflows/daily_update.yml. The database exists only
for the lifetime of this process; on exit it is removed. The only durable
output is the JSON the dashboard reads.

Safety: if the API pull fails, or the data looks stale or thin, the run aborts
BEFORE overwriting any JSON — so a bad upstream day leaves yesterday's working
dashboard live instead of publishing a broken one.

Usage:
  python scripts/daily_run.py
  python scripts/daily_run.py --keep-db          # keep the temp DB for debugging
  python scripts/daily_run.py --skip-indices     # NAVs only, leave index data alone
  python scripts/daily_run.py --max-staleness 5  # allow older data than default
"""

from __future__ import annotations

import argparse
import logging
import os
import shutil
import sys
import tempfile
import time
from datetime import date, datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("daily_run")

# Guard rails — a run that trips these is treated as a bad build.
MIN_NAV_ROWS = 4_000_000        # full history should be ~5.5M
MIN_SCHEMES_WITH_DATA = 2_800   # of ~3,210 catalogued
MIN_INDEX_ROWS = 100_000        # committed history alone is ~133K
MIN_INDICES = 30                # 36 benchmarks, 5 of them synthetic
# NAVs older than this = upstream problem. Was 5; raised to 6 because
# build_db_from_api now caps history at IST-yesterday, so as_of is a day behind
# by design. After a weekend plus a Monday holiday the newest NAV is Friday's and
# a Tuesday run legitimately sees age 4 — a 5-day limit left almost no margin for
# a longer festival cluster.
DEFAULT_MAX_STALENESS_DAYS = 6


def _fail(msg: str):
    log.error("=" * 62)
    log.error("ABORT: %s", msg)
    log.error("Existing JSON was NOT modified — yesterday's dashboard stays live.")
    log.error("=" * 62)
    sys.exit(1)


def validate(db_path: str, max_staleness: int):
    """Sanity-check the freshly built database before it is allowed to publish."""
    import sqlite3

    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT COUNT(*) FROM nav_history").fetchone()[0]
        as_of = conn.execute("SELECT MAX(nav_date) FROM nav_history").fetchone()[0]
        with_data = conn.execute(
            "SELECT COUNT(*) FROM schemes WHERE last_nav_date IS NOT NULL"
        ).fetchone()[0]
        categorised = conn.execute(
            "SELECT COUNT(*) FROM schemes WHERE category_id IS NOT NULL"
        ).fetchone()[0]
        index_rows = conn.execute("SELECT COUNT(*) FROM index_history").fetchone()[0]
        indices_with_data = conn.execute(
            "SELECT COUNT(DISTINCT index_id) FROM index_history"
        ).fetchone()[0]
        index_as_of = conn.execute("SELECT MAX(date) FROM index_history").fetchone()[0]
    finally:
        conn.close()

    log.info("Validation: %s NAV rows, %d schemes with data, %d categorised, as_of=%s",
             f"{rows:,}", with_data, categorised, as_of)
    log.info("Validation: %s index rows across %d indices, newest=%s",
             f"{index_rows:,}", indices_with_data, index_as_of)

    # Yahoo Finance rate-limits hard. When it does, the run still "succeeds" but
    # every index series comes out empty and Market Pulse renders blank — which
    # is exactly what shipped once before this check existed.
    if index_rows < MIN_INDEX_ROWS:
        _fail(f"only {index_rows:,} index rows (expected >= {MIN_INDEX_ROWS:,}). "
              f"Yahoo Finance was probably rate-limited; not republishing.")
    if indices_with_data < MIN_INDICES:
        _fail(f"only {indices_with_data} indices have data (expected >= {MIN_INDICES})")

    if rows < MIN_NAV_ROWS:
        _fail(f"only {rows:,} NAV rows (expected >= {MIN_NAV_ROWS:,})")
    if with_data < MIN_SCHEMES_WITH_DATA:
        _fail(f"only {with_data} schemes have NAV data (expected >= {MIN_SCHEMES_WITH_DATA})")
    if not as_of:
        _fail("no NAV dates present")

    age = (date.today() - datetime.strptime(as_of, "%Y-%m-%d").date()).days
    if age > max_staleness:
        _fail(f"latest NAV is {as_of} — {age} days old (limit {max_staleness}). "
              f"Upstream API is likely stale; not republishing.")

    log.info("Validation passed (data is %d day(s) old).", age)
    return as_of


def sweep_orphaned_dbs(current: str, max_age_hours: int = 6):
    """
    Delete temp databases left behind by runs that were killed.

    The normal cleanup lives in a finally block, which a SIGKILL skips — and
    each abandoned file is ~650 MB. Anything older than max_age_hours cannot
    belong to a live run, so it is safe to remove.
    """
    tmp = tempfile.gettempdir()
    cutoff = time.time() - max_age_hours * 3600
    freed = 0
    try:
        names = os.listdir(tmp)
    except OSError:
        return
    for name in names:
        if not (name.startswith("mf_research_") and name.endswith((".db", ".db-wal", ".db-shm"))):
            continue
        path = os.path.join(tmp, name)
        if os.path.abspath(path) == os.path.abspath(current):
            continue
        try:
            if os.path.getmtime(path) > cutoff:
                continue
            size = os.path.getsize(path)
            os.remove(path)
            freed += size
        except OSError:
            pass          # in use by a concurrent run, or already gone
    if freed:
        log.info("Swept %.0f MB of temp databases orphaned by earlier runs", freed / 1024 / 1024)


def _walk_relative(root: str) -> set[str]:
    found = set()
    for dirpath, _, files in os.walk(root):
        for f in files:
            found.add(os.path.relpath(os.path.join(dirpath, f), root).replace("\\", "/"))
    return found


def publish(staging_dir: str, final_dir: str):
    """
    Move the freshly built JSON into place, file by file.

    This deliberately does NOT rename the directories. Renaming the published
    directory fails on Windows with PermissionError whenever another process
    holds a handle to it — the Vite dev server does exactly that, so a local
    `npm run dev` was enough to break the whole publish step.

    Replacing individual files sidesteps that entirely. os.replace is atomic
    per file, so a reader never sees a half-written file; the only weaker
    guarantee is that during the few seconds of the sync a reader could get a
    mix of old and new files, which the dashboard tolerates because every file
    carries its own as_of.
    """
    os.makedirs(final_dir, exist_ok=True)

    new_files = _walk_relative(staging_dir)
    old_files = _walk_relative(final_dir)

    for rel in new_files:
        src = os.path.join(staging_dir, rel)
        dst = os.path.join(final_dir, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.replace(src, dst)

    # Drop files the build no longer produces (e.g. movers_*.json, drawdown/).
    stale = old_files - new_files
    for rel in stale:
        try:
            os.remove(os.path.join(final_dir, rel))
        except OSError as exc:
            log.warning("Could not remove stale %s: %s", rel, exc)

    # Clear out any directories left empty by the removals.
    for dirpath, dirnames, files in os.walk(final_dir, topdown=False):
        if dirpath != final_dir and not files and not dirnames:
            try:
                os.rmdir(dirpath)
            except OSError:
                pass

    shutil.rmtree(staging_dir, ignore_errors=True)
    if os.path.exists(staging_dir):
        # Windows/OneDrive occasionally keeps a handle on a just-emptied folder.
        # Harmless — the next run recreates it — but say so rather than hide it.
        log.warning("Staging directory %s could not be fully removed", staging_dir)

    log.info("Published %d files to %s (%d stale removed)",
             len(new_files), final_dir, len(stale))


def main():
    ap = argparse.ArgumentParser(description="Daily pipeline: API -> engine -> JSON, storing nothing")
    ap.add_argument("--keep-db", action="store_true", help="do not delete the temp database")
    ap.add_argument("--skip-indices", action="store_true", help="skip the Yahoo Finance index refresh")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--max-staleness", type=int, default=DEFAULT_MAX_STALENESS_DAYS)
    ap.add_argument("--db", default=None, help="explicit temp DB path (default: system temp)")
    ap.add_argument("--from-date", default=None,
                    help="clip NAV history at this ISO date (default: the platform "
                         "baseline in build_db_from_api.HISTORY_START)")
    args = ap.parse_args()

    if args.from_date is None:
        from scripts.build_db_from_api import HISTORY_START
        args.from_date = HISTORY_START

    t0 = time.time()
    log.info("=" * 62)
    log.info("DAILY RUN  %s", datetime.now().isoformat(timespec="seconds"))
    log.info("=" * 62)

    if args.db:
        db_path = args.db
    else:
        fd, db_path = tempfile.mkstemp(prefix="mf_research_", suffix=".db")
        os.close(fd)
        os.remove(db_path)  # build_db_from_api creates it fresh

    # Point every downstream consumer (engine, build_json) at the temp DB.
    os.environ["MF_DB_PATH"] = db_path
    log.info("Temp database: %s", db_path)
    sweep_orphaned_dbs(db_path)

    try:
        # ── 1. NAVs from the API ──────────────────────────────────────────
        from scripts import build_db_from_api

        build_db_from_api.build(
            db_path=db_path,
            limit=None,
            workers=args.workers,
            mode="history",
            index_source=None,
            from_date=args.from_date,
        )

        # ── 2. Indices from Yahoo Finance ────────────────────────────────
        # mfapi.in carries no index data, so benchmarks still come from yfinance.
        if args.skip_indices:
            log.warning("--skip-indices: benchmark data will be EMPTY in this build")
        else:
            log.info("Topping up benchmark indices from Yahoo Finance ...")
            import sqlite3
            from scripts.backfill_indices import run_index_backfill, build_synthetic_blends

            conn = sqlite3.connect(db_path)
            try:
                # index_history was pre-seeded from data/index_history.json.gz,
                # so run_index_backfill only requests the days since then.
                #
                # Yahoo rate-limits aggressively. A failure here is survivable
                # because the committed history is already loaded — the strip
                # just shows slightly older closes. Far better than aborting a
                # run whose NAV data is perfectly good. validate() still refuses
                # to publish if the index data is missing outright.
                try:
                    run_index_backfill(conn)
                except Exception as exc:
                    log.warning("Yahoo Finance top-up failed (%s: %s) — "
                                "continuing with the committed index history",
                                type(exc).__name__, str(exc)[:90])
                build_synthetic_blends(conn)
            finally:
                conn.close()

        # ── 3. Validate before touching any published file ───────────────
        as_of = validate(db_path, args.max_staleness)

        # ── 4. Run the engine, writing to a staging directory ────────────
        # build_json writes ~5,000 files over several minutes. Writing straight
        # into the published directory would leave the dashboard half-updated
        # if it died partway, so build aside and swap only on success.
        final_dir = os.environ.get("MF_OUTPUT_DIR") or os.path.join(
            ROOT_DIR, "site", "public", "data"
        )
        # A leftover staging directory must not be able to kill a run whose NAV
        # data is already fetched and validated. publish() already tolerates
        # Windows/OneDrive holding a handle on a just-emptied folder; this line did
        # not, and a stuck data.staging/category_history aborted a run with
        # PermissionError right after "Validation passed" — 4.7M rows fetched and
        # thrown away. Fall back to a uniquely named directory instead of dying.
        staging_dir = final_dir + ".staging"
        if os.path.exists(staging_dir):
            shutil.rmtree(staging_dir, ignore_errors=True)
        if os.path.exists(staging_dir):
            staging_dir = f"{final_dir}.staging-{os.getpid()}"
            log.warning("Could not clear the old staging directory; using %s",
                        os.path.basename(staging_dir))
            shutil.rmtree(staging_dir, ignore_errors=True)
        os.makedirs(staging_dir, exist_ok=True)
        os.environ["MF_OUTPUT_DIR"] = staging_dir

        log.info("Running calculation engine (staging -> %s) ...", staging_dir)
        from scripts import build_json

        build_json.main()

        written = sum(len(f) for _, _, f in os.walk(staging_dir))
        if written == 0:
            _fail("engine produced no JSON files")
        log.info("Engine wrote %d files. Publishing ...", written)

        publish(staging_dir, final_dir)

        log.info("=" * 62)
        log.info("DAILY RUN COMPLETE  as_of=%s  files=%d  elapsed=%.0fs",
                 as_of, written, time.time() - t0)
        log.info("=" * 62)

    finally:
        # ── 5. Destroy the database — nothing is stored between runs ─────
        if args.keep_db:
            log.info("--keep-db: leaving %s in place", db_path)
        else:
            removed = 0
            for suffix in ("", "-wal", "-shm"):
                p = db_path + suffix
                if os.path.exists(p):
                    try:
                        size = os.path.getsize(p)
                        os.remove(p)
                        removed += size
                    except OSError as exc:
                        log.warning("Could not delete %s: %s", p, exc)
            if removed:
                log.info("Deleted temp database (%.0f MB freed). Nothing stored.", removed / 1024 / 1024)


if __name__ == "__main__":
    main()
