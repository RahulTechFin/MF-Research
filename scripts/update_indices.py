"""
update_indices.py — refresh the 8 Market Pulse indices into Supabase Storage.

One file per index at the bucket root, no folders:

    nifty-50.json  sensex.json  nifty-100.json  nifty-midcap-150.json
    nifty-smallcap-250.json  nifty-bank.json  nifty-500.json  gold-goldbees.json

Each holds that index's identity, latest close, 1-day move, a 30-point sparkline
and its full 6-year daily history. The deployed site reads them directly through
the netlify.toml proxy, so a refresh is live without a commit or a rebuild.

Runs on its own schedule (.github/workflows/update_indices.yml), separate from
the NAV pipeline. The index top-up inside daily_run.py is deliberately non-fatal
— good NAV data should still publish — which is exactly why a silent Yahoo
failure there went unnoticed for three weeks. Here a failure is the whole job.

This does NOT feed the calculation pipeline. That still reads the committed
data/index_history.json.gz for all 36 benchmarks, because category benchmarks
need the other 28 and a 10Y benchmark return needs closes from 10 years back.

Usage:
  python scripts/update_indices.py            # refresh and publish the 8
  python scripts/update_indices.py --status    # report what is published
  python scripts/update_indices.py --dry-run   # build and validate, no upload
  python scripts/update_indices.py --seed      # rebuild each file from scratch
  python scripts/update_indices.py --cleanup   # delete objects outside the 8
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import date, datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("update_indices")

CATALOGUE = os.path.join(ROOT_DIR, "data", "scheme_catalogue.json")


def tickers_by_index_id() -> dict[int, str]:
    """Yahoo ticker per index_id, from the committed catalogue."""
    with open(CATALOGUE, encoding="utf-8") as fh:
        cat = json.load(fh)
    out = {b["index_id"]: b["yahoo_ticker"] for b in cat.get("benchmarks", [])
           if b.get("yahoo_ticker")}
    if not out:
        raise SystemExit(f"{CATALOGUE} carries no benchmark tickers — "
                         f"run scripts/export_catalogue.py first")
    return out


def cmd_status() -> int:
    from scripts import index_store as store
    from scripts import supabase_store as sb

    if not sb.enabled():
        log.error("Supabase not configured (%s)", sb.why_disabled())
        return 1

    objects = sb.list_objects()
    expected = {f"{s}.json" for s in store.strip_slugs()}
    extra = sorted(o["name"] for o in objects if o["name"] not in expected)
    total = sum(o["size"] for o in objects)
    log.info("Bucket %r: %d object(s), %.0f KB", sb.BUCKET, len(objects), total / 1024)

    newest_all = []
    for index_id, name, slug in store.STRIP:
        raw = sb.download_bytes(f"{slug}.json")
        if raw is None:
            log.warning("  %-22s %-26s MISSING", name, slug + ".json")
            continue
        d = json.loads(raw)
        pts = len(d.get("history") or [])
        newest_all.append(d["as_of"])
        age = (date.today() - date.fromisoformat(d["as_of"])).days
        flag = "" if age <= 5 else f"  <-- {age} days old"
        log.info("  %-22s %-26s %s  %10.2f  %4d pts%s",
                 name, slug + ".json", d["as_of"], d["latest_close"], pts, flag)

    if extra:
        log.warning("  %d object(s) outside the 8: %s", len(extra),
                    ", ".join(extra[:8]) + (" ..." if len(extra) > 8 else ""))
        log.warning("  run with --cleanup to remove them")
    return 0


def cmd_cleanup(dry_run: bool) -> int:
    """Remove anything in the bucket that is not one of the 8 index files."""
    from scripts import index_store as store
    from scripts import supabase_store as sb

    if not sb.enabled():
        log.error("Supabase not configured (%s)", sb.why_disabled())
        return 1

    keep = {f"{s}.json" for s in store.strip_slugs()}
    objects = sb.list_objects()
    doomed = sorted(o["name"] for o in objects if o["name"] not in keep)
    if not doomed:
        log.info("Bucket already holds only the %d index files.", len(keep))
        return 0

    freed = sum(o["size"] for o in objects if o["name"] in set(doomed))
    log.info("%d object(s) to remove (%.0f KB):", len(doomed), freed / 1024)
    for name in doomed[:40]:
        log.info("   %s", name)
    if len(doomed) > 40:
        log.info("   ... and %d more", len(doomed) - 40)

    if dry_run:
        log.info("--dry-run: nothing deleted.")
        return 0

    removed = sb.delete_objects(doomed)
    log.info("Deleted %d object(s).", removed)
    return 0 if removed == len(doomed) else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Refresh the 8 Market Pulse indices")
    ap.add_argument("--status", action="store_true", help="report and exit")
    ap.add_argument("--dry-run", action="store_true", help="do everything except upload")
    ap.add_argument("--seed", action="store_true",
                    help="ignore what is published and rebuild each file")
    ap.add_argument("--cleanup", action="store_true",
                    help="delete bucket objects that are not one of the 8")
    ap.add_argument("--retention-years", type=int, default=None,
                    help="override the retention window (default 6)")
    args = ap.parse_args()

    from scripts import index_store as store
    from scripts import supabase_store as sb
    from scripts.yahoo_chart import make_session

    if args.retention_years:
        store.RETENTION_YEARS = args.retention_years

    if args.status:
        return cmd_status()
    if args.cleanup:
        return cmd_cleanup(args.dry_run)

    log.info("=" * 62)
    log.info("MARKET PULSE INDICES  %s", datetime.now().isoformat(timespec="seconds"))
    log.info("Supabase: %s  |  bucket=%r  |  retention=%dy  |  %d indices",
             sb.why_disabled(), sb.BUCKET, store.RETENTION_YEARS, len(store.STRIP))
    log.info("=" * 62)

    # The eight are listed here and in build_json.STRIP_INDICES. Drift would mean
    # the site and the pipeline disagree, so refuse rather than publish a mismatch.
    drift = store.test_strip_matches_build_json()
    if drift:
        for d in drift:
            log.error("%s", d)
        return 1

    tickers = tickers_by_index_id()
    missing = [n for i, n, _ in store.STRIP if i not in tickers]
    if missing:
        log.error("No Yahoo ticker in the catalogue for: %s", ", ".join(missing))
        return 1

    seed = store.seed_from_committed()
    session = make_session()
    published = skipped = 0
    failures: list[str] = []

    for index_id, name, slug in store.STRIP:
        payload, problems = store.refresh_one(
            index_id, name, slug, tickers[index_id],
            session=session, seed=seed, force_seed=args.seed,
        )
        if problems:
            log.error("  %-22s REJECTED: %s", name, "; ".join(problems))
            failures.append(name)
            continue
        if payload is None:
            skipped += 1
            continue
        if args.dry_run:
            published += 1
            continue
        if store.push_one(slug, payload):
            published += 1
        else:
            log.error("  %-22s upload FAILED", name)
            failures.append(name)

    log.info("-" * 62)
    verb = "would publish" if args.dry_run else "published"
    log.info("%s %d, unchanged %d, failed %d", verb, published, skipped, len(failures))

    if failures:
        log.error("Failed: %s", ", ".join(failures))
        log.error("Previously published files for those indices are untouched.")
        return 1

    if args.dry_run:
        log.info("--dry-run: nothing uploaded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
