"""
sif_engine.py — run the COMMON calculation engine over the SIF desk.

    SIF catalogue + nav/history.parquet
        │
        ├─► a throwaway SQLite DB, in the MF schema  (scripts/init_db)
        │
        ├─► scripts/build_json.main()               <- the same code, unchanged
        │       which calls engine/calculation_engine
        │
        └─► the same JSON shapes, published to  SIF Data/data/*

WHY IT GOES THROUGH A DATABASE
Not because SIF needs one — nothing is stored — but because that is the only
interface the engine has. calculation_engine takes a sqlite3.Connection and
build_json is driven entirely by what it finds in the tables: it reads the
category list and loops. Give it a database holding SIF funds and it produces SIF
output, with no branch anywhere that knows which desk it is serving.

That is the point. There is exactly ONE implementation of a trailing return, a
quartile bracket, a category average, a rolling window and a risk measure, and
both desks run it. Anything else would drift: the moment SIF had its own
"simplified" return calculation the two dashboards would start disagreeing about
the same fund, and nobody would know which was right.

    MF   Supabase JSON -> temp DB -> build_json -> MF Data/*
    SIF  Supabase Parquet -> temp DB -> build_json -> SIF Data/data/*
                              ^^^^^^^^^^^^^^^^^^^^ identical

WHAT IS NOT PUBLISHED, AND WHY
build_json also writes indices.json and index/<id>.json — the benchmark series.
Those are MARKET data, identical for every desk, and already published once. The
publish step drops them rather than writing a second copy into a second bucket;
the dashboard reads them from the shared location whichever desk it is on.

BENCHMARKS ARE A PLACEHOLDER — SEE SIF_CATEGORY_BENCHMARK BELOW.
"""
from __future__ import annotations

import logging
import os
import shutil
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

log = logging.getLogger("sif_engine")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Where the engine's output lands in the bucket. Under data/ so the dashboard's
# path layout is byte-for-byte the MF one and the same components can read it.
REMOTE_PREFIX = "data"

# Index files the SIF tree deliberately does not carry — they are market data,
# not desk data, and duplicating them across buckets was the complication this
# avoids.
SHARED_MARKET_FILES = ("indices.json",)
SHARED_MARKET_DIRS = ("index",)

# ── Benchmarks ───────────────────────────────────────────────────────────────
#
# PLACEHOLDERS, CHOSEN BY ME, AND THEY NEED A DECISION.
#
# AMFI publishes no benchmark for a SIF, and SEBI's framework does not name one.
# But every screen the MF desk has — the snapshot's compare row, Trend Finder's
# auto-selected line, Risk Lab's beta and alpha — needs one, so leaving it null
# would blank those columns rather than leave them undecided.
#
# There is a real conceptual objection: these funds are LONG-SHORT, so measuring
# them against a long-only index overstates beta and misreads alpha in a falling
# market. A defensible answer is probably a cash-plus-spread hurdle rather than
# an index. Until that is settled, these are the closest long-only proxies:
SIF_CATEGORY_BENCHMARK = {
    # the fund can be long or short anything in the broad market
    "Equity Long-Short Fund":                 "NIFTY 500",
    # explicitly excludes the top 100, so the mid/small universe is the proxy
    "Equity Ex-Top 100 Long-Short Fund":      "NIFTY MIDCAP 150",
    "Sector Rotation Long-Short Fund":        "NIFTY 500",
    # allocation mandates: the existing hybrid blends already model these
    "Active Asset Allocator Long-Short Fund": "Balanced Advantage Blend",
    "Hybrid Long-Short Fund":                 "Aggressive Hybrid Blend",
    # nothing launched yet; wired so the first one to appear is not blank
    "Debt Long-Short Fund":                   "GILT ETF (LTGILTBEES)",
    "Sectoral Debt Long-Short Fund":          "GILT ETF (LTGILTBEES)",
}


def build_db(db_path: str, cat: dict, series_by_code: dict[str, dict],
             index_source_db: str | None = None) -> None:
    """
    A throwaway database holding the SIF desk, in the MF schema.

    index_source_db, when given, is an existing database to copy the benchmark
    series out of — normally the MF pipeline's own temp DB, which is still on
    disk when this runs inside daily_run. Copying it means both desks measure
    against provably the same closes, and nothing is re-downloaded. Without it
    the committed seed is used instead.
    """
    from scripts import init_db
    from scripts.sif_categories import CATEGORY_SEED

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    init_db.create_schema(conn)
    cur = conn.cursor()

    # ── config ───────────────────────────────────────────────────────────
    # The risk-free rate and the rest live here, and build_json reads them
    # directly. Reused from the MF seed rather than restated: a SIF Sharpe ratio
    # computed against a different risk-free rate than an MF one would be
    # quietly incomparable.
    for key, value, note in init_db.CONFIG_SEED:
        cur.execute("INSERT OR IGNORE INTO config(key, value, note) VALUES(?,?,?)",
                    (key, value, note))

    # ── benchmarks, reusing the MF seed so the index_ids line up ─────────
    for idx_name, ticker, is_synth in init_db.BENCHMARK_SEED:
        cur.execute("INSERT OR IGNORE INTO benchmarks(index_name, yahoo_ticker, "
                    "is_synthetic) VALUES(?,?,?)", (idx_name, ticker, is_synth))

    def index_id(name: str) -> int | None:
        row = cur.execute("SELECT index_id FROM benchmarks WHERE index_name=?",
                          (name,)).fetchone()
        return row[0] if row else None

    for blend, components in init_db.BLEND_COMPONENTS.items():
        bid = index_id(blend)
        if bid is None:
            continue
        for comp, weight in components:
            cid = index_id(comp)
            if cid is not None:
                cur.execute("INSERT OR IGNORE INTO benchmark_components"
                            "(index_id, component_index_id, weight) VALUES(?,?,?)",
                            (bid, cid, weight))

    # ── the seven SIF strategies ─────────────────────────────────────────
    for asset_class, name, slug, order in CATEGORY_SEED:
        cur.execute("INSERT OR IGNORE INTO categories(asset_class, category_name, "
                    "slug, display_order) VALUES(?,?,?,?)",
                    (asset_class, name, slug, order))
        bm = SIF_CATEGORY_BENCHMARK.get(name)
        if bm and (bid := index_id(bm)) is not None:
            cur.execute("UPDATE categories SET benchmark_id=? WHERE category_name=?",
                        (bid, name))
    conn.commit()

    cat_id = {row[0]: row[1] for row in
              cur.execute("SELECT slug, category_id FROM categories")}

    # ── AMCs and schemes ─────────────────────────────────────────────────
    for amc in sorted({f["amc"] for f in cat["funds"] if f["amc"]}):
        cur.execute("INSERT OR IGNORE INTO amcs(amc_name) VALUES(?)", (amc,))
    amc_id = {row[0]: row[1] for row in
              cur.execute("SELECT amc_name, amc_id FROM amcs")}

    for f in cat["funds"]:
        s = series_by_code.get(f["scheme_code"]) or {}
        cur.execute(
            "INSERT OR REPLACE INTO schemes(scheme_code, scheme_name, amc_id, "
            "category_id, isin, first_nav_date, last_nav_date, is_active) "
            "VALUES(?,?,?,?,?,?,?,1)",
            (f["scheme_code"], f["scheme_name"], amc_id.get(f["amc"]),
             cat_id.get(f["category_slug"]), f["isin"],
             min(s) if s else None, max(s) if s else None))

    cur.executemany(
        "INSERT OR IGNORE INTO nav_history(scheme_code, nav_date, nav) VALUES(?,?,?)",
        ((code, d, v) for code, s in series_by_code.items() for d, v in s.items()))
    # Without this the rows sit in an open transaction and the database comes out
    # EMPTY while the log cheerfully reports how many were loaded. The MF path
    # learned this the hard way.
    conn.commit()

    rows = conn.execute("SELECT COUNT(*) FROM nav_history").fetchone()[0]
    funds = conn.execute("SELECT COUNT(*) FROM schemes").fetchone()[0]
    log.info("SIF DB: %d fund(s), %s NAV row(s)", funds, f"{rows:,}")

    # ── benchmark series ─────────────────────────────────────────────────
    carried = 0
    if index_source_db:
        from scripts.build_db_from_api import carry_over_indices
        carried = carry_over_indices(conn, index_source_db)
    if not carried:
        from scripts.export_index_history import restore_into
        carried = restore_into(conn)
        # The committed seed stops where it was last exported, so top it up the
        # same way the MF desk does rather than leaving benchmarks weeks behind
        # the NAVs — a gap wider than the engine's 10-day search window makes
        # every benchmark column read null.
        try:
            from scripts.backfill_indices import build_synthetic_blends, run_index_backfill
            run_index_backfill(conn)
            build_synthetic_blends(conn)
        except Exception as exc:
            log.warning("index top-up failed (%s: %s) — benchmark columns may "
                        "stop short of the NAVs", type(exc).__name__, str(exc)[:90])
    else:
        from scripts.backfill_indices import build_synthetic_blends
        build_synthetic_blends(conn)

    newest = conn.execute("SELECT MAX(date) FROM index_history").fetchone()[0]
    log.info("SIF DB: benchmark history to %s", newest)
    conn.close()


def run_build_json(db_path: str, out_dir: str) -> int:
    """
    Run the shared builder against the SIF database.

    build_json reads MF_DB_PATH and MF_OUTPUT_DIR at import time, so both are set
    before it is imported and the module is dropped from sys.modules afterwards —
    otherwise a later import in the same process (daily_run has already imported
    it for the MF desk) would keep pointing at the MF database.
    """
    prev_db = os.environ.get("MF_DB_PATH")
    prev_out = os.environ.get("MF_OUTPUT_DIR")
    os.environ["MF_DB_PATH"] = db_path
    os.environ["MF_OUTPUT_DIR"] = out_dir
    for mod in ("scripts.build_json", "engine.calculation_engine"):
        sys.modules.pop(mod, None)
    try:
        from scripts import build_json
        build_json.main()
    finally:
        for mod in ("scripts.build_json", "engine.calculation_engine"):
            sys.modules.pop(mod, None)
        if prev_db is None:
            os.environ.pop("MF_DB_PATH", None)
        else:
            os.environ["MF_DB_PATH"] = prev_db
        if prev_out is None:
            os.environ.pop("MF_OUTPUT_DIR", None)
        else:
            os.environ["MF_OUTPUT_DIR"] = prev_out

    return sum(len(files) for _, _, files in os.walk(out_dir))


def publish_tree(out_dir: str) -> tuple[int, int]:
    """
    Push the engine's output to the SIF bucket, in the layout the dashboard
    already knows, skipping the shared market files.

    Returns (published, skipped).
    """
    from scripts import supabase_store as sb

    # publish_data reads MF_OUTPUT_DIR at IMPORT time, so it has to be set and the
    # module reimported — daily_run has already imported it for the MF tree and a
    # cached copy would map SIF files against MF paths.
    prev = os.environ.get("MF_OUTPUT_DIR")
    os.environ["MF_OUTPUT_DIR"] = out_dir
    sys.modules.pop("scripts.publish_data", None)
    try:
        from scripts import publish_data
        return _publish_with(publish_data, sb, out_dir)
    finally:
        sys.modules.pop("scripts.publish_data", None)
        if prev is None:
            os.environ.pop("MF_OUTPUT_DIR", None)
        else:
            os.environ["MF_OUTPUT_DIR"] = prev


def _publish_with(publish_data, sb, out_dir: str) -> tuple[int, int]:
    import json

    slug_ac, code_slug = publish_data.load_maps()
    items: list[tuple[str, str]] = []
    skipped = 0

    for dirpath, _dirs, files in os.walk(out_dir):
        for name in files:
            local = os.path.join(dirpath, name)
            rel = os.path.relpath(local, out_dir).replace(os.sep, "/")
            top = rel.split("/", 1)[0]
            if rel in SHARED_MARKET_FILES or top in SHARED_MARKET_DIRS:
                skipped += 1
                continue
            remote = publish_data.remote_path(rel, slug_ac, code_slug)
            if remote is None:
                skipped += 1
                continue
            items.append((local, f"{REMOTE_PREFIX}/{remote}"))

    ok, failures = sb.upload_many(items, bucket=sb.SIF_BUCKET)
    if failures:
        log.warning("%d upload(s) failed, first few: %s",
                    len(failures), failures[:5])

    # The manifest maps slug -> asset class and code -> folder, which is how the
    # dashboard turns a fund code into a path. Written last so it never points at
    # files that are not there yet.
    manifest = publish_data.build_manifest(slug_ac, code_slug)
    sb.upload_bytes(json.dumps(manifest, indent=2).encode("utf-8"),
                    f"{REMOTE_PREFIX}/manifest.json", bucket=sb.SIF_BUCKET,
                    content_type="application/json")
    log.info("published %d file(s) to %r/%s (skipped %d shared market file(s))",
             ok, sb.SIF_BUCKET, REMOTE_PREFIX, skipped)
    return ok, skipped


def run(cat: dict, series_by_code: dict[str, dict],
        index_source_db: str | None = None, publish: bool = True) -> dict:
    """Build, calculate, publish. Nothing survives on disk."""
    tmp_db = tempfile.mktemp(prefix="sif_engine_", suffix=".db")
    out_dir = tempfile.mkdtemp(prefix="sif_json_")
    try:
        build_db(tmp_db, cat, series_by_code, index_source_db)
        written = run_build_json(tmp_db, out_dir)
        log.info("engine wrote %d JSON file(s)", written)
        published = skipped = 0
        if publish:
            published, skipped = publish_tree(out_dir)
        return {"files": written, "published": published, "skipped": skipped}
    finally:
        for suffix in ("", "-wal", "-shm"):
            try:
                os.remove(tmp_db + suffix)
            except OSError:
                pass
        shutil.rmtree(out_dir, ignore_errors=True)
