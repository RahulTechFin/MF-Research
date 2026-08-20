"""
build_db_from_api.py — Build a complete, throwaway NAV database from api.mfapi.in.

This replaces the permanent 513 MB SQLite file. The database it produces is a
*build artifact*: created in the CI runner, consumed by build_json.py, deleted
at the end of the run. Nothing is stored between runs.

The schema it writes is byte-identical to init_db.py's, so calculation_engine.py
and build_json.py run completely unchanged — they still receive an ordinary
sqlite3.Connection and have no idea the data came from an API.

Usage:
  python scripts/build_db_from_api.py                       # -> data/mf_research.db
  python scripts/build_db_from_api.py --db /tmp/mf.db        # explicit path
  python scripts/build_db_from_api.py --limit 50             # quick smoke test
  python scripts/build_db_from_api.py --keep-indices         # reuse index_history
                                                             # from an existing DB
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

from scripts import mfapi_client as api
from scripts.init_db import create_schema, seed_data

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("build_db")

CATALOGUE_PATH = os.path.join(ROOT_DIR, "data", "scheme_catalogue.json")
DEFAULT_DB = os.path.join(ROOT_DIR, "data", "mf_research.db")

# A run that loses more than this fraction of schemes is treated as a bad build
# and aborts rather than publishing a half-empty dashboard.
MAX_FAILURE_RATE = 0.02

# The platform's documented baseline (MF_Platform_Specification.md, README) is
# "all Regular-Growth NAVs from 2010". api.mfapi.in reaches back to 2006, and
# pulling those extra years in silently changes every Risk Lab figure — the
# 2008 crash enters the drawdown window (measured: max drawdown -0.45 -> -0.69).
# Keep 2010 to stay consistent with what the dashboard has always published;
# pass --from-date 2006-01-01 to deliberately extend it.
HISTORY_START = "2010-01-01"

# India does not observe DST, so a fixed offset is exact. The runner's clock is
# UTC and the job fires at 18:15 UTC, which is 23:45 the same IST day — but a
# slow run can cross 18:30 UTC (00:00 IST), after which a UTC-derived "today"
# would be a day behind the Indian one and the cap below would remove two days
# instead of one.
IST = timezone(timedelta(hours=5, minutes=30))


def previous_business_close(now: datetime | None = None) -> str:
    """
    The newest NAV date the dashboard is allowed to show: yesterday, IST.

    WHY NOT TODAY
    AMFI publishes a day's NAVs late that evening, and a run at 23:45 IST can
    therefore land mid-publication. Every fund's returns anchor on its own latest
    NAV, so a partial set does not corrupt the maths — but it does mean the "As
    of" date claims today while most funds are still on yesterday, and the funds
    that did report are compared against peers that have not. Capping at
    yesterday makes the published date mean the same thing for every fund.
    """
    today_ist = (now or datetime.now(IST)).astimezone(IST).date()
    return (today_ist - timedelta(days=1)).isoformat()


# ── catalogue ────────────────────────────────────────────────────────────────

def load_catalogue(path: str = CATALOGUE_PATH) -> dict:
    if not os.path.exists(path):
        raise SystemExit(
            f"Scheme catalogue not found at {path}\n"
            f"Create it once from the existing database:\n"
            f"    python scripts/export_catalogue.py"
        )
    with open(path, encoding="utf-8") as fh:
        cat = json.load(fh)
    if not cat.get("schemes"):
        raise SystemExit(f"Catalogue at {path} is empty")
    log.info("Catalogue: %d schemes, %d benchmarks",
             len(cat["schemes"]), len(cat.get("benchmarks") or []))
    return cat


# ── bulk writer ──────────────────────────────────────────────────────────────

class NavWriter:
    """
    Collects NAV rows as they arrive and flushes them to SQLite in batches.

    fetch_many invokes this on the calling thread, not on the fetch workers,
    so the plain sqlite3 connection is only ever touched by its owning thread.
    The lock is belt-and-braces in case that contract ever changes.
    """

    def __init__(self, conn: sqlite3.Connection, batch_size: int = 50_000):
        self.conn = conn
        self.batch_size = batch_size
        self.buf: list[tuple[str, str, float]] = []
        self.lock = threading.Lock()
        self.total = 0
        self.empty_schemes: list[str] = []

    def __call__(self, scheme_code: str, meta: dict, rows: list):
        if not rows:
            with self.lock:
                self.empty_schemes.append(scheme_code)
            return
        with self.lock:
            self.buf.extend(rows)
            if len(self.buf) >= self.batch_size:
                self._flush_locked()

    def _flush_locked(self):
        if not self.buf:
            return
        self.conn.executemany(
            "INSERT OR IGNORE INTO nav_history(scheme_code, nav_date, nav) VALUES(?,?,?)",
            self.buf,
        )
        self.total += len(self.buf)
        self.buf.clear()

    def flush(self):
        with self.lock:
            self._flush_locked()
        self.conn.commit()


# ── build ────────────────────────────────────────────────────────────────────

def _bulk_load_pragmas(conn: sqlite3.Connection):
    """Trade durability for speed — the file is disposable."""
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-262144")   # ~256 MB page cache
    conn.execute("PRAGMA foreign_keys=OFF")


def _restore_pragmas(conn: sqlite3.Connection):
    conn.execute("PRAGMA foreign_keys=ON")


def populate_reference(conn: sqlite3.Connection, schemes: list[dict]):
    """Insert AMCs and schemes from the catalogue. Categories come from the seed."""
    cur = conn.cursor()

    amcs = sorted({s["amc_name"] for s in schemes if s.get("amc_name")})
    cur.executemany("INSERT OR IGNORE INTO amcs(amc_name) VALUES(?)", [(a,) for a in amcs])

    # name -> id (build_json INNER JOINs amcs, so a null amc_id silently drops
    # the fund from every category table).
    amc_id = {name: aid for name, aid in cur.execute("SELECT amc_name, amc_id FROM amcs")}
    cat_id = {name: cid for name, cid in cur.execute("SELECT category_name, category_id FROM categories")}

    unmapped = set()
    payload = []
    for s in schemes:
        cid = cat_id.get(s.get("category_name")) if s.get("category_name") else None
        if s.get("category_name") and cid is None:
            unmapped.add(s["category_name"])
        payload.append(
            (
                s["scheme_code"],
                s["scheme_name"],
                amc_id.get(s.get("amc_name")),
                cid,
                s.get("isin"),
                int(s.get("is_active", 1)),
            )
        )

    cur.executemany(
        """INSERT OR REPLACE INTO schemes
               (scheme_code, scheme_name, amc_id, category_id, isin, is_active)
           VALUES (?,?,?,?,?,?)""",
        payload,
    )
    conn.commit()

    if unmapped:
        log.warning("Catalogue categories with no row in `categories`: %s", sorted(unmapped))

    orphan = cur.execute("SELECT COUNT(*) FROM schemes WHERE amc_id IS NULL").fetchone()[0]
    if orphan:
        raise SystemExit(
            f"ABORT: {orphan} schemes have no amc_id. build_json INNER JOINs amcs, "
            f"so these would vanish from every category table."
        )

    log.info("Loaded %d AMCs, %d schemes", len(amcs), len(payload))


def populate_benchmarks(conn: sqlite3.Connection, catalogue: dict):
    """
    Restore the benchmark universe from the catalogue.

    init_db's BENCHMARK_SEED only defines 16 benchmarks; the live database has
    36 — the extra 20 sector indices were added by ingest_excel_indices.py.
    Without them, index_history rows point at benchmarks that do not exist and
    the Market Pulse strip loses most of its indices.
    """
    benchmarks = catalogue.get("benchmarks") or []
    components = catalogue.get("benchmark_components") or []
    if not benchmarks:
        log.warning("Catalogue has no benchmarks — only the 16 seeded ones will exist")
        return

    cur = conn.cursor()
    cur.executemany(
        """INSERT OR REPLACE INTO benchmarks
               (index_id, index_name, yahoo_ticker, is_synthetic, is_active)
           VALUES (?,?,?,?,?)""",
        [(b["index_id"], b["index_name"], b.get("yahoo_ticker"),
          int(b.get("is_synthetic", 0)), int(b.get("is_active", 1))) for b in benchmarks],
    )
    cur.executemany(
        """INSERT OR REPLACE INTO benchmark_components
               (index_id, component_index_id, weight) VALUES (?,?,?)""",
        [(c["index_id"], c["component_index_id"], c["weight"]) for c in components],
    )
    conn.commit()
    log.info("Loaded %d benchmarks, %d blend components", len(benchmarks), len(components))


def carry_over_indices(conn: sqlite3.Connection, source_db: str):
    """
    Copy benchmarks / index_history from an existing database.

    mfapi.in has no index data — that still comes from Yahoo Finance via
    backfill_indices.py. Carrying it over lets a rebuild skip re-downloading
    ~133K index rows.
    """
    if not os.path.exists(source_db):
        log.warning("No source DB at %s — skipping index carry-over", source_db)
        return 0

    conn.execute("ATTACH DATABASE ? AS src", (source_db,))
    try:
        n = conn.execute("SELECT COUNT(*) FROM src.index_history").fetchone()[0]
        conn.execute(
            "INSERT OR IGNORE INTO index_history(index_id, date, close) "
            "SELECT index_id, date, close FROM src.index_history"
        )
        conn.commit()
        log.info("Carried over %s index rows", f"{n:,}")
        return n
    except sqlite3.Error as exc:
        log.warning("Index carry-over failed: %s", exc)
        return 0
    finally:
        conn.execute("DETACH DATABASE src")


def load_history_from_supabase(conn, schemes: list[dict], from_date: str | None,
                               workers: int) -> list[tuple[str, str]]:
    """
    Fill nav_history from the published files, extended by AMFI's latest day.

    Returns the same (code, error) failure list shape as api.fetch_many, so the
    caller's tolerance check is unchanged.

    A fund with no published file is bootstrapped from api.mfapi.in -- that is the
    only thing still reading it, and only for funds the bucket has never seen
    (newly launched schemes, or a first run against an empty bucket).
    """
    from scripts import nav_store

    folders, unmapped = nav_store.folders_for(schemes)
    if unmapped:
        log.warning("%d scheme(s) have no category and so no published folder: %s",
                    len(unmapped), ", ".join(unmapped[:8]))

    log.info("Reading published NAV history for %s fund(s) from Supabase ...",
             f"{len(folders):,}")

    def progress(done, total, found):
        log.info("   %5d/%d read, %d with history", done, total, found)

    series = nav_store.pull_many(folders, workers=workers, on_progress=progress)
    published = {c: dict(s) for c, s in series.items()}

    # Bootstrap anything the bucket has never held.
    missing = [str(s["scheme_code"]) for s in schemes
               if str(s["scheme_code"]) not in series]
    failures: list[tuple[str, str]] = []
    if missing:
        log.info("Bootstrapping %d fund(s) with no published history from "
                 "api.mfapi.in ...", len(missing))
        rows_by_code: dict[str, list[tuple[str, float]]] = {}

        def collect(code, meta, rows):
            rows_by_code[str(code)] = rows

        _ok, boot_failures = api.fetch_many(
            missing, mode="history", workers=workers, on_result=collect,
            min_date=from_date)
        failures.extend(boot_failures)
        for code, rows in rows_by_code.items():
            # fetch_many hands over (scheme_code, nav_date, nav) triples, ready
            # for a bulk INSERT — not (date, nav) pairs.
            series.setdefault(code, {}).update(
                {d: v for _sc, d, v in rows if v and v > 0})

    # AMFI extends every series by its own day, and only forward.
    from scripts.amfi_topup import fetch_navall, parse_navall
    text = fetch_navall()
    if text:
        amfi = parse_navall(text)
        stats = nav_store.merge_amfi(series, amfi, cap=previous_business_close())
        log.info("AMFI extended %s series (%s already current, %s not in the "
                 "file, %s beyond the previous-day cap)",
                 f"{stats['extended']:,}", f"{stats['already_current']:,}",
                 f"{stats['absent_from_amfi']:,}", f"{stats['capped']:,}")
    else:
        log.warning("AMFI NAVAll.txt unavailable — today's day will be missing")

    # Gate each fund before it reaches the database.
    rejected = 0
    for code, new in list(series.items()):
        problems = nav_store.validate(new, published.get(code, {}))
        if problems:
            rejected += 1
            if rejected <= 10:
                log.warning("   %s rejected (%s) — keeping the published series",
                            code, "; ".join(problems))
            series[code] = published.get(code, {}) or new
    if rejected:
        log.warning("%d fund(s) failed the history gate", rejected)

    floor = from_date or "0000-01-01"
    conn.executemany(
        "INSERT OR IGNORE INTO nav_history(scheme_code, nav_date, nav) VALUES(?,?,?)",
        ((code, d, v) for code, s in series.items()
         for d, v in s.items() if d >= floor),
    )
    # The mfapi path commits inside NavWriter.flush(); this path has to do it
    # itself. Without it the rows sat in an open transaction and the database came
    # out EMPTY while the log cheerfully reported how many had been loaded.
    conn.commit()
    info = nav_store.summarise(series)
    log.info("Loaded %s NAV rows for %s fund(s) (%s .. %s)",
             f"{info['rows']:,}", f"{info['funds']:,}",
             info["oldest"], info["newest"])
    return failures


def build(db_path: str, limit: int | None, workers: int, mode: str,
          index_source: str | None, from_date: str | None = HISTORY_START,
          skip_amfi_topup: bool = False, history_source: str = "supabase"):
    catalogue = load_catalogue()
    schemes = catalogue["schemes"]
    if limit:
        schemes = schemes[:limit]
        log.info("--limit active: building with %d schemes only", len(schemes))

    if os.path.exists(db_path):
        os.remove(db_path)
    for suffix in ("-wal", "-shm"):
        stale = db_path + suffix
        if os.path.exists(stale):
            os.remove(stale)

    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path)
    t0 = time.time()

    try:
        _bulk_load_pragmas(conn)
        create_schema(conn)
        seed_data(conn)
        populate_benchmarks(conn, catalogue)
        populate_reference(conn, schemes)

        # Seed index history from the committed file. Without this, every run
        # asks Yahoo Finance for 31 tickers x 16 years and gets rate-limited
        # (YFRateLimitError), leaving every index series empty. With it, the
        # caller's Yahoo step only has to top up the last few days.
        #
        # This stays on the committed 2010-onward file rather than the Supabase
        # bucket on purpose. The bucket holds only the 8 Market Pulse indices
        # over a 6-year window; the engine needs all 36 benchmarks, and a 10Y
        # benchmark return needs a close from 10 years back.
        from scripts.export_index_history import restore_into
        restore_into(conn)

        if index_source:
            carry_over_indices(conn, index_source)

        codes = [s["scheme_code"] for s in schemes]

        # Only the mfapi path uses a NavWriter; the Supabase path assembles each
        # whole series first, gates it, and writes its own rows.
        writer = None
        if history_source == "supabase":
            # Read the history back from what we published, and let AMFI add only
            # the day it actually knows about. api.mfapi.in is touched only to
            # bootstrap a fund with no published file — see scripts/nav_store.
            failures = load_history_from_supabase(
                conn, schemes, from_date=from_date, workers=workers)
        else:
            log.info("Fetching %s from api.mfapi.in with %d workers (history from %s) ...",
                     "full history" if mode == "history" else "latest NAV",
                     workers, from_date or "inception")

            writer = NavWriter(conn)
            ok, failures = api.fetch_many(
                codes, mode=mode, workers=workers, on_result=writer, min_date=from_date
            )
            writer.flush()

        failure_rate = len(failures) / max(len(codes), 1)
        if failures:
            log.warning("%d schemes failed:", len(failures))
            for code, err in failures[:15]:
                log.warning("   %s -> %s", code, err)
        if failure_rate > MAX_FAILURE_RATE:
            raise SystemExit(
                f"ABORT: {len(failures)}/{len(codes)} schemes failed "
                f"({failure_rate:.1%} > {MAX_FAILURE_RATE:.0%} tolerance). "
                f"Refusing to publish an incomplete dataset."
            )
        if writer is not None and writer.empty_schemes:
            log.warning("%d schemes returned zero usable NAV rows (e.g. %s)",
                        len(writer.empty_schemes), ", ".join(writer.empty_schemes[:8]))

        # api.mfapi.in trails AMFI by one day, and Value Research reads AMFI, so
        # without this our "as of" is a day behind everything we get compared
        # against. Matched on scheme code only -- the file's Plan/Option columns
        # are blank for 6,598 of its 14,283 rows and filtering on them dropped
        # 1,368 of our funds. See scripts/amfi_topup.py.
        #
        # Placed after the mfapi load so mfapi owns the history and this only ever
        # adds a newer day, and before the cap below so the same previous-day rule
        # applies to it -- AMFI publishes today's NAVs during the evening, and
        # they must not reach the dashboard before every fund has reported.
        if history_source == "supabase":
            # load_history_from_supabase already merged AMFI into every series
            # before writing them, so running it again would only re-check rows
            # that are already there.
            log.info("AMFI already merged while reading the published history")
        elif not skip_amfi_topup:
            from scripts.amfi_topup import top_up
            top_up(conn)
        else:
            log.info("AMFI top-up disabled (--no-amfi-topup)")

        # Cap at yesterday (IST). Applied here as one statement rather than
        # threaded through parse_nav_rows/fetch_history/fetch_many, so no fetch
        # path can quietly bypass it — and before last_nav_date is derived below,
        # which must not point at a row that is about to be deleted.
        cutoff = previous_business_close()
        removed = conn.execute(
            "DELETE FROM nav_history WHERE nav_date > ?", (cutoff,)
        ).rowcount
        if removed:
            log.info("Capped NAV history at %s (IST yesterday): dropped %s "
                     "same-day row(s)", cutoff, f"{removed:,}")
        else:
            log.info("Capped NAV history at %s (IST yesterday): nothing newer "
                     "had been published", cutoff)
        # A fund whose only NAV was today now has none. In 'history' mode that
        # cannot happen for an established fund, but a launch today would vanish
        # from the universe until tomorrow, which is the correct answer.

        log.info("Rebuilding indexes and scheme date ranges ...")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_nav_date ON nav_history(nav_date)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_nav_scheme ON nav_history(scheme_code)")
        conn.execute(
            """
            UPDATE schemes SET
                first_nav_date = (SELECT MIN(nav_date) FROM nav_history
                                  WHERE nav_history.scheme_code = schemes.scheme_code),
                last_nav_date  = (SELECT MAX(nav_date) FROM nav_history
                                  WHERE nav_history.scheme_code = schemes.scheme_code)
            """
        )
        conn.execute(
            """INSERT INTO ingestion_log(run_type, date_from, date_to,
                                         rows_inserted, rows_skipped, status, ts)
               VALUES(?,?,?,?,?,?,?)""",
            # writer only exists on the mfapi path; count the table on the other.
            (f"build:{history_source}", None, None,
             writer.total if writer is not None else
             conn.execute("SELECT COUNT(*) FROM nav_history").fetchone()[0],
             0,
             "success" if not failures else "partial",
             datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        conn.execute("ANALYZE")
        conn.commit()
        _restore_pragmas(conn)

        rows = conn.execute("SELECT COUNT(*) FROM nav_history").fetchone()[0]
        as_of = conn.execute("SELECT MAX(nav_date) FROM nav_history").fetchone()[0]
        oldest = conn.execute("SELECT MIN(nav_date) FROM nav_history").fetchone()[0]
        size_mb = os.path.getsize(db_path) / 1024 / 1024

        log.info("=" * 62)
        log.info("Database built : %s", db_path)
        log.info("NAV rows       : %s", f"{rows:,}")
        log.info("Date range     : %s -> %s", oldest, as_of)
        log.info("Size on disk   : %.0f MB  (temporary — delete after build)", size_mb)
        log.info("Elapsed        : %.0f s", time.time() - t0)
        log.info("=" * 62)

        if rows == 0:
            raise SystemExit("ABORT: no NAV rows were written")

        return {"rows": rows, "as_of": as_of, "failures": len(failures)}

    finally:
        conn.close()


def main():
    ap = argparse.ArgumentParser(description="Build a disposable NAV database from api.mfapi.in")
    ap.add_argument("--db", default=os.environ.get("MF_DB_PATH") or DEFAULT_DB,
                    help="output database path")
    ap.add_argument("--limit", type=int, help="only build N schemes (smoke test)")
    ap.add_argument("--workers", type=int, default=api.DEFAULT_WORKERS)
    ap.add_argument("--mode", choices=["history", "latest"], default="history",
                    help="'history' = full series (required for the engine)")
    ap.add_argument("--index-source", default=None,
                    help="existing .db to copy benchmarks/index_history from")
    ap.add_argument("--from-date", default=HISTORY_START,
                    help=f"clip history at this ISO date (default {HISTORY_START}; "
                         f"use 2006-01-01 to take everything the API has)")
    ap.add_argument("--history-source", choices=["supabase", "mfapi"],
                    default="supabase",
                    help="where NAV history comes from. 'supabase' (default) "
                         "reads back what was published and lets AMFI add only "
                         "the newest day, touching api.mfapi.in solely to "
                         "bootstrap funds the bucket has never held. 'mfapi' is "
                         "the old behaviour: re-download every fund's whole "
                         "history on every run.")
    ap.add_argument("--no-amfi-topup", action="store_true",
                    help="skip the AMFI latest-day top-up (api.mfapi.in only). "
                         "Use to reproduce a build exactly as it was before the "
                         "top-up existed, or if AMFI ships bad data.")
    args = ap.parse_args()

    build(args.db, args.limit, args.workers, args.mode, args.index_source,
          args.from_date, args.no_amfi_topup, args.history_source)


if __name__ == "__main__":
    main()
