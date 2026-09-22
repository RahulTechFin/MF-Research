"""
export_catalogue.py — Freeze the scheme universe into a small committed JSON file.

WHY THIS EXISTS
---------------
The 513 MB SQLite database is being replaced by live pulls from api.mfapi.in.
But the API cannot tell us *which* schemes belong in the platform:

  - api.mfapi.in/mf lists 37,693 schemes with no category and no fund house.
  - Filtering by name alone yields 9,659 candidates — 6,986 of them are FMPs
    and closed-ended series funds that do not belong, and it wrongly rejects
    949 ETFs that do.

The correct universe (3,622 schemes with categories) was derived from AMFI's
*structured* NAV file, whose section headers carry the SEBI category. That
mapping is the valuable part of the database and must not be lost.

So we export it once to data/scheme_catalogue.json (~600 KB, committed to git).
Every later run reads the catalogue and only needs NAVs from the API.

Usage:
  python scripts/export_catalogue.py                 # from the existing DB
  python scripts/export_catalogue.py --verify        # check against the API
"""

import argparse
import collections
import json
import logging
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

from scripts.init_db import get_conn

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("export_catalogue")

CATALOGUE_PATH = os.path.join(ROOT_DIR, "data", "scheme_catalogue.json")


def export(conn) -> dict:
    """Read the scheme universe + reference data out of the database."""
    schemes = []
    rows = conn.execute(
        """
        SELECT s.scheme_code, s.scheme_name, a.amc_name, c.category_name,
               c.slug, s.isin, s.is_active
        FROM schemes s
        LEFT JOIN amcs       a ON a.amc_id      = s.amc_id
        LEFT JOIN categories c ON c.category_id = s.category_id
        ORDER BY CAST(s.scheme_code AS INTEGER)
        """
    ).fetchall()

    uncategorised = 0
    for code, name, amc, cat_name, cat_slug, isin, active in rows:
        if cat_name is None:
            uncategorised += 1
        schemes.append(
            {
                "scheme_code": str(code),
                "scheme_name": name,
                "amc_name": amc,
                "category_name": cat_name,
                "category_slug": cat_slug,
                "isin": isin,
                "is_active": int(active or 0),
            }
        )

    if uncategorised:
        log.warning("%d schemes have no category — they will be skipped by the engine", uncategorised)

    # Benchmarks must travel with the catalogue too. init_db seeds only 16 of
    # the 36 live benchmarks — the extra sector indices came from
    # ingest_excel_indices.py and would otherwise be lost on a fresh build.
    benchmarks = [
        {
            "index_id": iid,
            "index_name": name,
            "yahoo_ticker": ticker,
            "is_synthetic": int(synth or 0),
            "is_active": int(active or 0),
        }
        for iid, name, ticker, synth, active in conn.execute(
            "SELECT index_id, index_name, yahoo_ticker, is_synthetic, is_active "
            "FROM benchmarks ORDER BY index_id"
        )
    ]
    components = [
        {"index_id": a, "component_index_id": b, "weight": w}
        for a, b, w in conn.execute(
            "SELECT index_id, component_index_id, weight FROM benchmark_components "
            "ORDER BY index_id, component_index_id"
        )
    ]
    log.info("Exporting %d benchmarks, %d blend components", len(benchmarks), len(components))

    return {
        "version": 2,
        "source": "derived from AMFI structured NAV file via backfill_amfi.py",
        "scheme_count": len(schemes),
        "schemes": schemes,
        "benchmarks": benchmarks,
        "benchmark_components": components,
    }


def verify_against_api(catalogue: dict) -> bool:
    """Confirm every catalogued scheme still exists upstream."""
    import requests

    log.info("Fetching scheme list from api.mfapi.in ...")
    listing = requests.get("https://api.mfapi.in/mf", timeout=60).json()
    api_codes = {str(x["schemeCode"]) for x in listing}

    ours = {s["scheme_code"] for s in catalogue["schemes"]}
    missing = sorted(ours - api_codes)

    log.info("API schemes      : %d", len(api_codes))
    log.info("Catalogue schemes: %d", len(ours))
    log.info("Missing from API : %d", len(missing))

    if missing:
        name = {s["scheme_code"]: s["scheme_name"] for s in catalogue["schemes"]}
        for c in missing[:20]:
            log.warning("   MISSING  %s  %s", c, name.get(c, "?")[:70])
    return not missing


def refresh_from_amfi(existing: dict | None) -> dict:
    """
    Merge newly launched funds from AMFI's live NAV file into the catalogue.
    No database required.

    This is ADDITIVE on purpose. AMFI's NAVOpen.txt lists only schemes that
    reported a NAV that day — a snapshot, not the universe. A live pull returns
    roughly 2,750 schemes against a catalogue of 3,622, because funds that have
    stopped reporting (merged, wound up, or simply quiet that day) are absent
    but still have history the dashboard shows. Replacing the catalogue with the
    snapshot would silently delete ~900 funds, so entries are only ever added or
    updated, never dropped.

    AMFI's file carries the SEBI category in its section headers, which is the
    one thing api.mfapi.in cannot give us. Benchmarks are not an AMFI concept,
    so they are carried over untouched.
    """
    from scripts import amfi_catalogue as amfi

    log.info("Fetching AMFI NAV file ...")
    text = amfi.fetch_with_retry(amfi.AMFI_DAILY_URL)
    if not text:
        raise SystemExit("Could not download the AMFI NAV file — catalogue not refreshed.")

    # Collects the codes rejected on share-class grounds, for the prune below.
    rejected_share_class: set[str] = set()
    records = amfi.parse_amfi_text(
        text, rejected_share_class=rejected_share_class)
    log.info("AMFI listed %d qualifying scheme records today", len(records))
    if len(records) < 2000:
        raise SystemExit(
            f"Only {len(records)} schemes parsed — far below the ~2,700 expected. "
            f"Refusing to touch the catalogue on a suspect parse."
        )

    merged: dict[str, dict] = {
        s["scheme_code"]: dict(s) for s in (existing or {}).get("schemes", [])
    }
    before = set(merged)

    # One-time repair of names stored while fetch_with_retry trusted AMFI's
    # mis-declared ISO-8859-1 charset: UTF-8 bytes were decoded as latin-1, so
    # "Children's" was saved as "Childrena<80><99>s". Funds still listed by AMFI
    # get a correct name from today's file anyway; this reaches the wound-up ones
    # that will never be refreshed again. Round-tripping only sticks when it
    # produces valid UTF-8, so a name that was always latin-1 is left alone.
    repaired = 0
    for entry in merged.values():
        nm = entry.get("scheme_name") or ""
        if "â" in nm or "Â" in nm:
            try:
                fixed = nm.encode("latin-1").decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                continue
            if fixed != nm:
                entry["scheme_name"] = fixed
                repaired += 1
    if repaired:
        log.info("Repaired %d mojibaked scheme name(s) from the old charset bug",
                 repaired)

    added, updated = 0, 0
    for r in records:
        code = str(r["scheme_code"])
        entry = {
            "scheme_code": code,
            "scheme_name": r["scheme_name"],
            "amc_name": r["amc_name"],
            "category_name": r["category_name"],
            "category_slug": None,      # resolved against `categories` at build time
            "isin": r["isin"] or None,
            "is_active": 1,
        }
        if code not in merged:
            merged[code] = entry
            added += 1
        else:
            prev = merged[code]
            entry["category_slug"] = prev.get("category_slug")
            # Never let a blank from today's file erase what we already knew.
            for k in ("category_name", "amc_name", "isin"):
                if not entry[k] and prev.get(k):
                    entry[k] = prev[k]
            if entry != prev:
                merged[code] = entry
                updated += 1

    # ── correction: Direct plans that never belonged ────────────────────────
    # The platform is Regular-Growth only. Direct plans leaked into Index Fund
    # and FoF Overseas because AMFI files them under "Other Scheme", which the
    # parser treated wholesale as ETFs and so skipped the Direct exclusion.
    # Genuine ETFs are single-plan and keep their exemption.
    #
    # The category test used to be `if s.get("category_name") and ...`, which
    # exempted every UNCATEGORISED entry -- and 147 Direct-plan FoFs had no
    # category precisely because their AMFI section was unmapped, so they were
    # immune to the very cleanup meant to remove them. Genuine ETFs always carry
    # a category, so requiring one to earn the exemption is the correct test.
    ETF_CATEGORIES = {"ETF", "Gold ETF"}
    bogus = [
        c for c, s in merged.items()
        if s.get("category_name") not in ETF_CATEGORIES
        and "direct" in (s.get("scheme_name") or "").lower()
    ]
    if bogus:
        dropped = collections.Counter(merged[c]["category_name"] for c in bogus)
        log.warning("Dropping %d Direct-plan duplicates (Regular-Growth platform):", len(bogus))
        for k, v in dropped.most_common():
            log.warning("   %-26s %d", k, v)
        for c in bogus:
            del merged[c]

    # ── correction: share classes AMFI lists today but that no longer qualify ─
    #
    # The merge above is additive, and deliberately so: NAVOpen.txt is a snapshot,
    # and replacing the catalogue with it would delete ~900 funds that are quiet
    # today but still have history the dashboard shows. The cost of that safety
    # is that a row admitted by an older, looser filter can never leave.
    #
    # That is how three extra "Nippon India Growth Mid Cap Fund" rows survived.
    # AMFI publishes four share classes under that one name — Growth, IDCW, Bonus
    # and Institutional-IDCW — and the filter used to accept any row whose NAME
    # contained "growth", which that fund's title does. One fund was counted four
    # times in the Mid Cap average and ranked four times in the quartiles.
    #
    # A ROW IS ONLY PRUNED WHERE AMFI ITSELF SAID WHAT SHARE CLASS IT IS.
    # Three earlier attempts got this wrong, each in its own way, and the shape
    # of the mistake is worth keeping:
    #
    #   1. Comparing the catalogue against the codes parse_amfi_text RETURNED
    #      deleted 31 good funds. The parser also skips unmapped sections,
    #      closed-end sections, missing NAVs and unparseable dates; "the parser
    #      skipped it" is not "it is a duplicate share class".
    #   2. Re-running is_regular_growth over the raw file rejected 377, because
    #      ETFs are exempt from that test and only the parser knows which
    #      section header a row sat under.
    #   3. Having the parser report its share-class rejections STILL deleted 32
    #      good funds, because AMFI leaves Plan and Option blank for many
    #      schemes and publishes several such rows under one identical name.
    #      "Motilal Oswal Midcap Fund" ships four indistinguishable rows today;
    #      silent_growth_codes rightly declines to guess and skips all four, yet
    #      127039 is the real Regular Growth row, catalogued years ago under the
    #      fuller name AMFI used to publish and has since dropped.
    #
    # So the parser records a rejection only when the row states its class — an
    # option named in the name or the Option column, or a legacy plan marker.
    # Silence is not a verdict, and neither is absence: a code missing from
    # today's file is left alone, which is the case the additive rule exists to
    # protect. Of 2,150 entries this prunes 27, every one of which AMFI labels
    # Institutional, Super Institutional, Retail, Discontinued, Unclaimed, IDCW
    # or Bonus in its own Option column, and none of which is the last surviving
    # row of its fund.
    superseded = [c for c in merged if c in rejected_share_class]
    # A filter bug must not be able to empty the catalogue.
    MAX_SUPERSEDED_FRACTION = 0.10
    if superseded and len(superseded) > len(merged) * MAX_SUPERSEDED_FRACTION:
        log.error("%d of %d catalogue entries were rejected on share-class "
                  "grounds (>%.0f%%). That is a filter fault, not a real change "
                  "— refusing to prune.",
                  len(superseded), len(merged), MAX_SUPERSEDED_FRACTION * 100)
    elif superseded:
        by_cat = collections.Counter(
            merged[c].get("category_name") or "(uncategorised)" for c in superseded
        )
        log.warning("Dropping %d share class(es) AMFI still lists but that are "
                    "not Regular-Growth (the qualifier is in the Plan/Option "
                    "column, not the name):", len(superseded))
        for k, v in by_cat.most_common(10):
            log.warning("   %-26s %d", k, v)
        for c in sorted(superseded)[:12]:
            log.warning("     %s  %s", c, merged[c].get("scheme_name"))

        report = os.path.join(os.path.dirname(os.path.abspath(CATALOGUE_PATH)),
                              "removed_share_classes.json")
        with open(report, "w", encoding="utf-8") as fh:
            json.dump(
                [{k: merged[c].get(k) for k in
                  ("scheme_code", "scheme_name", "category_name", "isin")}
                 for c in sorted(superseded)],
                fh, indent=2, ensure_ascii=False,
            )
        log.warning("   audit trail: %s", report)
        for c in superseded:
            del merged[c]

    # ── correction: legacy share classes ────────────────────────────────────
    # Institutional / Super Institutional / Retail and the old Plan A/B/C split
    # were retired by SEBI's single-plan rule but AMFI still lists many of them,
    # where they duplicate the parent fund in every table. Unclaimed /
    # Discontinued / Segregated entries are not investable schemes at all.
    legacy = [c for c, s in merged.items() if amfi.is_legacy_plan_variant(s.get("scheme_name"))]
    if legacy:
        by_cat = collections.Counter(
            merged[c].get("category_name") or "(uncategorised)" for c in legacy
        )
        log.warning("Dropping %d legacy plan variants (Institutional/Retail/Plan A-B-C/…):",
                    len(legacy))
        for k, v in by_cat.most_common(10):
            log.warning("   %-26s %d", k, v)

        # Leave an audit trail — this removes funds, so it must be reviewable.
        report = os.path.join(os.path.dirname(os.path.abspath(CATALOGUE_PATH)),
                              "removed_legacy_plans.json")
        with open(report, "w", encoding="utf-8") as fh:
            json.dump(
                [{k: merged[c].get(k) for k in ("scheme_code", "scheme_name",
                                                "amc_name", "category_name")}
                 for c in sorted(legacy, key=lambda x: int(x))],
                fh, ensure_ascii=False, indent=2,
            )
        log.info("   full list written to %s", report)

        for c in legacy:
            del merged[c]

    schemes = [merged[c] for c in sorted(merged, key=lambda x: int(x))]

    log.info("Catalogue: %d -> %d schemes (%d new, %d updated, %d Direct dupes, %d legacy plans removed)",
             len(before), len(schemes), added, updated, len(bogus), len(legacy))
    for code in list(set(merged) - before)[:10]:
        log.info("   + %s  %s", code, merged[code]["scheme_name"][:65])

    uncategorised = sum(1 for s in schemes if not s["category_name"])
    if uncategorised:
        log.warning("%d schemes have no category — they will be skipped by the engine", uncategorised)

    return {
        "version": 2,
        "source": "AMFI NAVOpen.txt merged into the existing catalogue via amfi_catalogue.py",
        "scheme_count": len(schemes),
        "schemes": schemes,
        "benchmarks": (existing or {}).get("benchmarks", []),
        "benchmark_components": (existing or {}).get("benchmark_components", []),
    }


def main():
    ap = argparse.ArgumentParser(
        description="Build data/scheme_catalogue.json — the platform's fund universe."
    )
    ap.add_argument("--refresh", action="store_true",
                    help="rebuild from AMFI's live NAV file (picks up newly launched funds); "
                         "no database required")
    ap.add_argument("--verify", action="store_true", help="cross-check the catalogue against the live API")
    ap.add_argument("--out", default=CATALOGUE_PATH)
    args = ap.parse_args()

    if args.refresh:
        existing = None
        if os.path.exists(args.out):
            with open(args.out, encoding="utf-8") as fh:
                existing = json.load(fh)
        catalogue = refresh_from_amfi(existing)
    else:
        # Original path: read the universe out of an existing database.
        conn = get_conn()
        try:
            catalogue = export(conn)
        finally:
            conn.close()

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(catalogue, fh, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(args.out) / 1024
    log.info("Wrote %d schemes to %s (%.0f KB)", catalogue["scheme_count"], args.out, size_kb)

    if args.verify:
        ok = verify_against_api(catalogue)
        if not ok:
            log.error("Some catalogued schemes are not available from the API.")
            sys.exit(1)
        log.info("Verified: every catalogued scheme is available from the API.")


if __name__ == "__main__":
    main()
