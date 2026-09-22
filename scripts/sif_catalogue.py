"""
sif_catalogue.py — the SIF fund list and its category mapping.

    SIF_NAVAll.txt  ─┐
                     ├─► merge by scheme code ─► resolve plan/option ─►
    history report  ─┘        filter Regular + Growth ─► map to strategy ─►
                              data/sif_catalogue.json ─► Supabase "SIF Data"

WHY SCHEME CODE IS THE KEY, NOT ISIN
Both feeds carry both identifiers, so either could have been the key. Measured
on the real data:

    112 scheme codes, every one unique, never blank
    109 ISINs        — FOUR schemes have no ISIN at all (SIF-27, SIF-28,
                       SIF-101, SIF-103, all Titanium IDCW Reinvestment),
                       404 history rows between them
    no code maps to two ISINs, and no ISIN to two codes

A key that is absent for four schemes is not a key. Scheme code it is, with the
ISIN kept alongside as a CONTINUITY CHECK: if a code's ISIN ever changes, AMFI
has renumbered something and two different funds are about to be blended into
one series. That is worth an alarm, and it is only possible to detect because
both identifiers are stored.

WHAT "REGULAR GROWTH" MEANS HERE, AND WHAT IT COSTS TO GET IT WRONG
A fund is kept only when the plan resolves to Regular and the option to Growth.
Everything else is recorded in `excluded` with its reason rather than dropped
quietly, because the failure that matters is not a wrong row — it is a fund
that vanishes and is never noticed. The same instinct as the MF side, where
"don't miss any funds" was the whole point.

Four schemes state neither plan nor option anywhere: iSIF's, whose NAV Name
reads "iSIF Equity Long-Short Fund - Growth" with no plan at all. Each sits
beside exactly one sibling that IS explicitly Direct, so the silent one is
Regular by elimination — and the NAV corroborates it, since a Regular plan
carries the distributor commission and must therefore trade BELOW its Direct
twin. Both tests have to agree before the inference is accepted.
"""
from __future__ import annotations

import argparse
import collections
import io
import json
import logging
import os
import sys
from datetime import date, datetime, timedelta

import pyarrow as pa
import pyarrow.parquet as pq

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts import sif_categories as cats           # noqa: E402
from scripts import sif_source as src                # noqa: E402

log = logging.getLogger("sif_catalogue")

# NOTHING IS KEPT IN THE REPOSITORY. Every one of these lives in the "SIF Data"
# bucket and nowhere else, so there is exactly one copy of the truth and no
# committed file that can quietly go stale beside it.
#
#   catalogue/funds.parquet       the data sheet: one row per Regular Growth fund
#   catalogue/categories.parquet  the seven SEBI strategies and their counts
#   catalogue/manifest.json       run metadata -- as-of, coverage, what was
#                                 excluded and why, every inference made
#
# The two tables are Parquet because they are tables. The manifest is JSON
# because it is not: it carries nested diagnostics that exist to be read by a
# person when a fund turns up missing.
REMOTE_FUNDS = "catalogue/funds.parquet"
REMOTE_CATEGORIES = "catalogue/categories.parquet"
REMOTE_MANIFEST = "catalogue/manifest.json"

COMPRESSION = "zstd"
COMPRESSION_LEVEL = 19

# A Regular plan pays the distributor out of the same pool, so its NAV can only
# be at or below its Direct twin. Used to corroborate an inferred plan, with room
# for a scheme whose plans launched days apart.
DIRECT_PREMIUM_TOLERANCE = 0.02


# ── merging the two feeds ───────────────────────────────────────────────────

def _merge(navall: list[src.Row], history: list[src.Row]) -> dict[str, dict]:
    """
    One record per scheme code, drawing each field from whichever feed has it.

    The snapshot is authoritative for the clean fund name, the ISINs and the
    latest NAV. The history report is authoritative for the DESCRIPTION, because
    its NAV Name spells out the plan and option that the snapshot leaves blank.
    """
    by_code: dict[str, dict] = {}

    def slot(code: str) -> dict:
        return by_code.setdefault(code, {
            "scheme_code": code, "scheme_name": "", "descriptive_name": "",
            "isin": "", "isin_reinvest": "", "amc": "", "structure": "",
            "section": "", "plan_col": "", "option_col": "",
            "nav": None, "nav_date": None,
            "history_first": None, "history_last": None,
            # Distinct DAYS, not rows. A day arriving twice is harmless
            # downstream because every series merges by date, but counted as two
            # it would overstate how much history a fund actually has.
            "history_days": set(),
            "isin_variants": set(), "in_navall": False, "in_history": False,
        })

    for r in navall:
        d = slot(r.scheme_code)
        d["in_navall"] = True
        d["scheme_name"] = d["scheme_name"] or r.name
        d["isin"] = d["isin"] or r.isin
        d["isin_reinvest"] = d["isin_reinvest"] or r.isin_reinvest
        d["amc"] = d["amc"] or r.amc
        d["structure"] = d["structure"] or r.structure
        d["section"] = d["section"] or r.section
        d["plan_col"] = d["plan_col"] or r.plan_col
        d["option_col"] = d["option_col"] or r.option_col
        if r.isin:
            d["isin_variants"].add(r.isin)
        # The snapshot is one day, but take the latest defensively.
        if r.nav_date and (d["nav_date"] is None or r.nav_date >= d["nav_date"]):
            d["nav"], d["nav_date"] = r.nav, r.nav_date

    for r in history:
        d = slot(r.scheme_code)
        d["in_history"] = True
        # Longest NAV Name wins: it is the one that spells out plan AND option.
        if len(r.name) > len(d["descriptive_name"]):
            d["descriptive_name"] = r.name
        d["plan_col"] = d["plan_col"] or r.plan_col
        d["option_col"] = d["option_col"] or r.option_col
        d["section"] = d["section"] or r.section
        d["structure"] = d["structure"] or r.structure
        d["amc"] = d["amc"] or r.amc
        d["isin"] = d["isin"] or r.isin
        if r.isin:
            d["isin_variants"].add(r.isin)
        if r.nav_date:
            d["history_days"].add(r.nav_date)
            if d["history_first"] is None or r.nav_date < d["history_first"]:
                d["history_first"] = r.nav_date
            if d["history_last"] is None or r.nav_date > d["history_last"]:
                d["history_last"] = r.nav_date

    for d in by_code.values():
        # Fall back the other way when a feed is missing a field entirely.
        d["scheme_name"] = d["scheme_name"] or d["descriptive_name"]
        d["descriptive_name"] = d["descriptive_name"] or d["scheme_name"]
    return by_code


# ── plan / option ───────────────────────────────────────────────────────────

def _classify(by_code: dict[str, dict]) -> None:
    """Attach plan, option and how each was decided."""
    for d in by_code.values():
        # The description is the richer text, so classify against it, not the
        # clean fund name which by design carries no share class at all.
        d["option"] = src.classify_option(d["option_col"], d["descriptive_name"])
        d["plan"] = src.classify_plan(d["plan_col"], d["descriptive_name"])
        d["plan_source"] = ("column" if d["plan_col"].strip()
                            else "name" if d["plan"] != "silent"
                            else "unresolved")
        d["option_source"] = ("column" if d["option_col"].strip()
                              else "name" if d["option"] != "unknown"
                              else "unresolved")
        d["fund_base"] = src.fund_base(d["scheme_name"])


def _resolve_silent(by_code: dict[str, dict]) -> list[dict]:
    """
    Give a plan to schemes that state none, but only by elimination.

    A silent scheme becomes Regular when its fund has exactly one silent share
    class for that option, at least one sibling explicitly Direct, and no sibling
    already claiming Regular. Anything else stays silent and is reported — a
    guess that cannot be checked is worse than a gap that can be seen.
    """
    groups: dict[tuple, list[dict]] = collections.defaultdict(list)
    for d in by_code.values():
        groups[(cats.normalise(d["amc"]), d["fund_base"], d["option"])].append(d)

    notes: list[dict] = []
    for (_amc, base, option), members in groups.items():
        silent = [m for m in members if m["plan"] == "silent"]
        if not silent:
            continue
        direct = [m for m in members if m["plan"] == "direct"]
        regular = [m for m in members if m["plan"] == "regular"]

        if len(silent) == 1 and direct and not regular:
            s = silent[0]
            # Corroboration: Regular carries the commission, so it must not trade
            # above its Direct twin by more than a rounding tolerance.
            navs = [m["nav"] for m in direct if m["nav"]]
            ok = None
            if navs and s["nav"]:
                ok = s["nav"] <= max(navs) * (1 + DIRECT_PREMIUM_TOLERANCE)
            if ok is False:
                notes.append({
                    "scheme_code": s["scheme_code"], "outcome": "left unresolved",
                    "why": (f"only non-Direct share class of {base!r} ({option}), "
                            f"but its NAV {s['nav']} is above the Direct "
                            f"{max(navs)} — that is the wrong way round"),
                })
                continue
            s["plan"] = "regular"
            s["plan_source"] = "inferred"
            notes.append({
                "scheme_code": s["scheme_code"], "outcome": "Regular",
                "why": (f"the only share class of {base!r} ({option}) that does "
                        f"not say Direct; NAV {s['nav']} sits below the Direct "
                        f"{max(navs) if navs else '?'}, as a Regular plan must"),
            })
        else:
            for s in silent:
                notes.append({
                    "scheme_code": s["scheme_code"], "outcome": "left unresolved",
                    "why": (f"{len(silent)} silent share class(es) of {base!r} "
                            f"({option}), {len(direct)} Direct, "
                            f"{len(regular)} Regular — not decidable"),
                })
    return notes


# ── building ────────────────────────────────────────────────────────────────

def _carry_forward(by_code: dict[str, dict],
                   previous: dict[str, dict]) -> list[dict]:
    """
    Reuse what a previous run already decided, for a scheme this run cannot read.

    NEEDED BECAUSE THE DAILY WINDOW IS SHORT. Plan and option are read out of the
    history report's NAV Name, and the daily run only asks for the last ~90 days.
    A fund that has stopped reporting drops out of that window, and the snapshot's
    Scheme Name carries no share class at all — so iSIF's four funds, whose plan
    is stated nowhere else, would become unreadable and silently fall out of the
    list. Their published classification is the authority instead.

    Only ever fills a GAP, and runs AFTER _resolve_silent for the same reason: a
    scheme the current feeds can read -- or that today's NAVs can settle by
    elimination -- is classified from today, so a genuine reclassification is
    picked up rather than pinned to whatever was decided first.
    """
    notes: list[dict] = []
    for code, d in by_code.items():
        prev = previous.get(code)
        if not prev:
            continue
        if d["plan"] == "silent" and prev.get("plan"):
            d["plan"] = str(prev["plan"]).lower()
            d["plan_source"] = "carried forward"
            notes.append({"scheme_code": code, "outcome": prev["plan"],
                          "why": "not readable in this window; kept the "
                                 "classification already published"})
        if d["option"] == "unknown" and prev.get("option"):
            d["option"] = str(prev["option"]).lower()
            d["option_source"] = "carried forward"
    return notes


def build(navall_text: str, history_text: str,
          previous: dict[str, dict] | None = None) -> dict:
    """The whole catalogue, from the two feed bodies. No network, no files."""
    nav_rows, nav_stats = src.parse(navall_text, "navall")
    hist_rows, hist_stats = src.parse(history_text, "history")

    by_code = _merge(nav_rows, hist_rows)
    _classify(by_code)
    # ORDER MATTERS. Inference runs FIRST, because it re-derives the answer from
    # today's feed and re-checks it against today's NAVs every single run. Carry-
    # forward is the fallback for what inference could not reach, never the first
    # answer -- otherwise the moment a classification was published it would be
    # pinned there, and a swap of which share class is Direct would be carried
    # forward for ever instead of being caught the next morning.
    notes = _resolve_silent(by_code)
    carried = _carry_forward(by_code, previous or {})
    if carried:
        # A scheme that inference gave up on and carry-forward then settled has
        # two notes. Drop the giving-up one so the record shows what happened.
        settled = {n["scheme_code"] for n in carried}
        notes = [n for n in notes
                 if not (n["scheme_code"] in settled
                         and n["outcome"] == "left unresolved")]
    notes += carried

    warnings: list[str] = []
    for key, stats, label in (("navall", nav_stats, "snapshot"),
                              ("history", hist_stats, "history report")):
        for problem in ("no_header", "short", "bad_date", "no_section", "unnamed"):
            if stats[problem]:
                warnings.append(f"{label}: {stats[problem]} row(s) {problem}")

    # Category mapping, with the family cross-check.
    seeded = {c["slug"]: c for c in cats.all_categories()}
    for d in by_code.values():
        cat = cats.resolve(d["section"])
        d["category_name"] = cat["name"] if cat else None
        d["category_slug"] = cat["slug"] if cat else None
        d["asset_class"] = cat["asset_class"] if cat else None
        if cat is None:
            warnings.append(f"{d['scheme_code']}: no strategy matches section "
                            f"{d['section']!r}")
        elif not cats.family_matches(d["section"], cat["asset_class"]):
            warnings.append(f"{d['scheme_code']}: section {d['section']!r} maps to "
                            f"{cat['name']} but its family is not "
                            f"{cat['asset_class']}")

    # ISIN continuity.
    for d in by_code.values():
        if len(d["isin_variants"]) > 1:
            warnings.append(f"{d['scheme_code']} has {len(d['isin_variants'])} "
                            f"different ISINs: {sorted(d['isin_variants'])} — "
                            f"AMFI may have renumbered it")

    kept, excluded = [], []
    for d in sorted(by_code.values(), key=lambda x: (
            cats.ASSET_ORDER.index(x["asset_class"]) if x["asset_class"] in cats.ASSET_ORDER else 9,
            seeded[x["category_slug"]]["order"] if x["category_slug"] in seeded else 99,
            x["scheme_name"].lower())):
        if d["plan"] == "regular" and d["option"] == "growth" and d["category_slug"]:
            kept.append({
                "scheme_code": d["scheme_code"],
                "isin": d["isin"] or None,
                "scheme_name": d["scheme_name"],
                "amc": d["amc"],
                "category_name": d["category_name"],
                "category_slug": d["category_slug"],
                "asset_class": d["asset_class"],
                "folder": cats.folder(d["asset_class"], d["category_slug"]),
                "structure": d["structure"],
                "plan": "Regular",
                "option": "Growth",
                "plan_source": d["plan_source"],
                "option_source": d["option_source"],
                "latest_nav": d["nav"],
                "latest_nav_date": d["nav_date"],
                "history_first": d["history_first"],
                "history_last": d["history_last"],
                "history_points": len(d["history_days"]),
            })
        else:
            if not d["category_slug"]:
                reason = "no category"
            elif d["plan"] != "regular":
                reason = f"plan is {d['plan']}"
            else:
                reason = f"option is {d['option']}"
            excluded.append({
                "scheme_code": d["scheme_code"],
                "scheme_name": d["descriptive_name"] or d["scheme_name"],
                "reason": reason,
            })

    counts = collections.Counter(k["category_slug"] for k in kept)
    categories = []
    for c in cats.all_categories():
        c = dict(c)
        c["fund_count"] = counts.get(c["slug"], 0)
        c["folder"] = cats.folder(c["asset_class"], c["slug"])
        categories.append(c)

    days = {r.nav_date for r in hist_rows if r.nav_date}
    return {
        "version": 1,
        "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
        "key": "scheme_code",
        "as_of": max((r.nav_date for r in nav_rows if r.nav_date), default=None),
        "sources": {"snapshot": src.NAVALL_URL, "history": src.HISTORY_URL},
        "history": {
            "first": min(days) if days else None,
            "last": max(days) if days else None,
            "days": len(days),
            "rows": len(hist_rows),
        },
        "universe": {
            "schemes_seen": len(by_code),
            "in_snapshot": sum(1 for d in by_code.values() if d["in_navall"]),
            "in_history": sum(1 for d in by_code.values() if d["in_history"]),
            "regular_growth": len(kept),
            "excluded": len(excluded),
        },
        "categories": categories,
        "funds": kept,
        "excluded": excluded,
        "plan_inferences": notes,
        "warnings": warnings,
    }


# ── review output ───────────────────────────────────────────────────────────

def review(cat: dict) -> str:
    """The catalogue as something a person can actually check."""
    out = io.StringIO()
    w = out.write
    u = cat["universe"]
    w(f"SIF CATALOGUE  as of {cat['as_of']}   key: {cat['key']}\n")
    w(f"history {cat['history']['first']} .. {cat['history']['last']}  "
      f"({cat['history']['days']} days, {cat['history']['rows']:,} rows)\n\n")
    w(f"{u['schemes_seen']} scheme(s) published  ->  "
      f"{u['regular_growth']} Regular Growth, {u['excluded']} excluded\n\n")

    for ac in cats.ASSET_ORDER:
        acs = [c for c in cat["categories"] if c["asset_class"] == ac]
        if not acs:
            continue
        w(f"── {ac.upper()} " + "─" * (66 - len(ac)) + "\n")
        for c in acs:
            mark = "" if c["fund_count"] else "   (no funds launched yet)"
            w(f"  {c['name']}  [{c['slug']}]  {c['fund_count']} fund(s){mark}\n")
            for f in cat["funds"]:
                if f["category_slug"] != c["slug"]:
                    continue
                src_tag = "" if f["plan_source"] == "column" else f"  <{f['plan_source']}>"
                w(f"      {f['scheme_code']:<9} {f['scheme_name'][:52]:<52} "
                  f"{(f['latest_nav'] or 0):>10.4f}  "
                  f"{f['history_points']:>3}d from {f['history_first']}{src_tag}\n")
        w("\n")

    if cat["plan_inferences"]:
        w("PLAN INFERRED WITHOUT AN EXPLICIT LABEL\n")
        for n in cat["plan_inferences"]:
            w(f"  {n['scheme_code']:<9} -> {n['outcome']}\n      {n['why']}\n")
        w("\n")

    by_reason = collections.Counter(e["reason"] for e in cat["excluded"])
    w("EXCLUDED\n")
    for reason, n in by_reason.most_common():
        w(f"  {n:>3}  {reason}\n")
    unresolved = [e for e in cat["excluded"]
                  if "silent" in e["reason"] or "unknown" in e["reason"]
                  or "ambiguous" in e["reason"] or e["reason"] == "no category"]
    if unresolved:
        w("\n  NEEDS A DECISION — excluded because it could not be read, not "
          "because it is Direct or IDCW:\n")
        for e in unresolved:
            w(f"    {e['scheme_code']:<9} {e['reason']:<22} {e['scheme_name'][:60]}\n")

    if cat["warnings"]:
        w(f"\nWARNINGS ({len(cat['warnings'])})\n")
        for x in cat["warnings"][:25]:
            w(f"  ! {x}\n")
    else:
        w("\nno warnings\n")
    return out.getvalue()


# ── PUBLISHING ─────────────────────────────────────────────────────────

FUND_COLUMNS = [
    ("scheme_code", pa.string()), ("isin", pa.string()),
    ("scheme_name", pa.string()), ("amc", pa.string()),
    ("category_name", pa.string()), ("category_slug", pa.string()),
    ("asset_class", pa.string()), ("folder", pa.string()),
    ("structure", pa.string()), ("plan", pa.string()), ("option", pa.string()),
    ("plan_source", pa.string()), ("option_source", pa.string()),
    ("latest_nav", pa.float64()), ("latest_nav_date", pa.string()),
    ("history_first", pa.string()), ("history_last", pa.string()),
    ("history_points", pa.int32()),
]

CATEGORY_COLUMNS = [
    ("name", pa.string()), ("slug", pa.string()), ("asset_class", pa.string()),
    ("order", pa.int32()), ("folder", pa.string()), ("fund_count", pa.int32()),
]


def _table(rows: list[dict], columns) -> bytes:
    """Rows -> a zstd Parquet body, with every column type pinned."""
    table = pa.table({
        name: pa.array([r.get(name) for r in rows], typ)
        for name, typ in columns
    })
    buf = io.BytesIO()
    pq.write_table(table, buf, compression=COMPRESSION,
                   compression_level=COMPRESSION_LEVEL,
                   write_statistics=True, data_page_version="2.0")
    return buf.getvalue()


def apply_coverage(cat: dict, series_by_code: dict[str, dict]) -> dict:
    """
    Restate each fund history span from the MERGED series, not the feed window.

    build() can only report what it saw, and on a normal day that is the last 90
    days. The published Parquet is the whole record, so once the NAVs are merged
    the coverage figures are corrected from it. Without this the data sheet would
    claim every fund had 90 days of history and no more.
    """
    for f in cat["funds"]:
        s = series_by_code.get(f["scheme_code"]) or {}
        f["history_first"] = min(s) if s else None
        f["history_last"] = max(s) if s else None
        f["history_points"] = len(s)
    days = {d for s in series_by_code.values() for d in s}
    cat["history"] = {
        "first": min(days) if days else None,
        "last": max(days) if days else None,
        "days": len(days),
        "rows": sum(len(s) for s in series_by_code.values()),
    }
    return cat


def load_previous() -> dict[str, dict]:
    """
    The published data sheet, keyed by scheme code, as the carry-forward source.

    An absent or unreadable file gives an empty dict rather than an error: that
    is simply the first run.
    """
    from scripts import supabase_store as sb
    if not sb.enabled():
        return {}
    raw = sb.download_bytes(REMOTE_FUNDS, bucket=sb.SIF_BUCKET)
    if not raw:
        return {}
    try:
        table = pq.read_table(io.BytesIO(raw))
    except Exception as exc:
        log.warning("published fund sheet is unreadable (%s) - ignoring it", exc)
        return {}
    return {r["scheme_code"]: r for r in table.to_pylist() if r.get("scheme_code")}


def publish(cat: dict) -> bool:
    """Write the data sheet, the categories and the manifest to the SIF bucket."""
    from scripts import supabase_store as sb
    if not sb.enabled():
        log.error("Supabase not configured (%s) - nothing published",
                  sb.why_disabled())
        return False

    manifest = {k: v for k, v in cat.items() if k not in ("funds", "categories")}
    manifest["fund_count"] = len(cat["funds"])
    manifest["category_count"] = len(cat["categories"])

    writes = [
        (_table(cat["funds"], FUND_COLUMNS), REMOTE_FUNDS,
         "application/vnd.apache.parquet"),
        (_table(cat["categories"], CATEGORY_COLUMNS), REMOTE_CATEGORIES,
         "application/vnd.apache.parquet"),
        (json.dumps(manifest, indent=2, ensure_ascii=False, default=str)
         .encode("utf-8"), REMOTE_MANIFEST, "application/json"),
    ]
    ok = True
    for body, path, ctype in writes:
        wrote = sb.upload_bytes(body, path, bucket=sb.SIF_BUCKET,
                                content_type=ctype)
        log.info("  %-28s %6.1f KB  %s", path, len(body) / 1024,
                 "ok" if wrote else "FAILED")
        ok = ok and wrote
    return ok


# ── CLI ───────────────────────────────────────────────────────────────
#
# Ad-hoc use only. The real entry point is scripts/sif_daily.py, which runs
# inside the same daily job as the mutual fund pipeline so both desks land on
# the same NAV date at the same time.

def main() -> int:
    ap = argparse.ArgumentParser(description="Build the SIF catalogue")
    ap.add_argument("--full-history", action="store_true",
                    help="read every day since the first SIF NAV instead of the "
                         "recent window (slower; used for a bootstrap)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the review and publish nothing")
    ap.add_argument("--cache", default=None,
                    help="directory to keep the raw feed bodies in, so a rerun "
                         "does not refetch")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    def cached(name: str, fetch):
        path = os.path.join(args.cache, name) if args.cache else None
        if path and os.path.exists(path):
            log.info("using cached %s", path)
            return io.open(path, encoding="utf-8").read()
        text = fetch()
        if text is None:
            return None
        if path:
            os.makedirs(args.cache, exist_ok=True)
            io.open(path, "w", encoding="utf-8", newline="\n").write(text)
        return text

    navall = cached("SIF_NAVAll.txt", src.fetch_navall)
    if not navall:
        log.error("could not fetch the SIF snapshot - nothing published")
        return 2

    from scripts import sif_nav_store as store
    cap = store.cap_date()
    frm = (src.HISTORY_START if args.full_history else
           date.fromisoformat(cap) - timedelta(days=store.NAME_WINDOW_DAYS))
    history = cached("SIF_history.txt",
                     lambda: src.fetch_history(frm, date.fromisoformat(cap)))
    if not history:
        log.error("could not fetch the SIF history report - nothing published")
        return 2

    cat = build(navall, history, previous=load_previous())
    print(review(cat))
    if args.dry_run:
        log.info("--dry-run: nothing published")
        return 0
    return 0 if publish(cat) else 3


if __name__ == "__main__":
    raise SystemExit(main())
