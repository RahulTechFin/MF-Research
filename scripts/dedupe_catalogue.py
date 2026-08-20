"""
Remove duplicate share classes of the same fund from the catalogue.

WHY
AMCs re-register a scheme under a NEW code after a merger or a plan
consolidation, and AMFI keeps publishing the old code until it goes quiet. The
catalogue is additive, so both codes survive and the same fund appears two, three
or four times in every table -- once with live numbers and the rest frozen at
whatever they were when the code was retired. Measured before this ran:

    HSBC Dynamic Bond Fund    4 codes, 1 still priced (151084)
    BNP Paribas Liquid Fund   4 codes, none still priced
    HDFC Liquid Fund          3 codes, 1 still priced (100868); one last
                              priced 17-Dec-2012 and still on screen

WHAT COUNTS AS A DUPLICATE
Same AMC, and the same fund name once plan/option wording is stripped. That is
deliberately narrower than it sounds: "Regular", "Direct", "Growth", "Plan",
"Option", "Premium", "Institutional" and similar are share-class words, not fund
identity, so removing them collapses share classes of one fund and nothing else.
Two genuinely different funds from one AMC keep different names after stripping.

WHICH ONE SURVIVES
The one AMFI still prices today. If none is still priced the whole fund is gone
from the market, and the code with the most recent NAV is kept as its record --
one row of history rather than four.

WHAT IS NEVER DELETED
  - a code AMFI still prices (never, under any circumstance)
  - the only member of its group
  - a group where no member is priced and dates cannot be compared
Nothing is removed for "has no data": every one of the 644 codes absent from
AMFI was checked against api.mfapi.in and all 644 had real history, so no fund
here is dataless. Being a stale duplicate of a live fund is the reason, not
being empty.

Deletions are written to data/removed_duplicates.json before the catalogue is
touched, the same way removed_legacy_plans.json records the legacy sweep.

DROPPING FUNDS AMFI NO LONGER TRACKS  (--drop-untracked)
A second, blunter rule, and the one that actually cleans the universe: remove any
fund AMFI does not currently price. It subsumes most of the duplicate logic above
and catches the case that logic cannot -- a fund whose AMC was RENAMED in a
merger. "BNP Paribas Mid Cap Fund-Growth Option" (113566, AMC "BNP Paribas Mutual
Fund") is the same fund as "BARODA BNP PARIBAS Mid Cap Fund" (150209, AMC "Baroda
BNP Paribas Mutual Fund"), but neither the AMC nor the stripped name matches, so
grouping will never pair them. Only one of the two is still priced.

The cost is explicit: a fund that wound up keeps its history in api.mfapi.in but
leaves the dashboard. That is the intended trade -- every row on screen is then a
fund someone can actually buy today, and no row is frozen at a price from 2016.

Usage:
    python scripts/dedupe_catalogue.py                    # dry run, duplicates
    python scripts/dedupe_catalogue.py --apply            # remove duplicates
    python scripts/dedupe_catalogue.py --drop-untracked   # dry run, both rules
    python scripts/dedupe_catalogue.py --drop-untracked --apply
"""
from __future__ import annotations

import argparse
import collections
import json
import logging
import os
import re
import sys

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from scripts.amfi_topup import NAVALL_URL, fetch_navall, parse_navall  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("dedupe")

CATALOGUE_PATH = os.path.join(ROOT_DIR, "data", "scheme_catalogue.json")
REPORT_PATH = os.path.join(ROOT_DIR, "data", "removed_duplicates.json")

# Words that describe a share class rather than the fund. Stripping them is what
# makes two codes for one fund collide; keeping any of them would hide the
# duplicate we are looking for.
PLAN_WORDS = [
    "regular plan", "regular", "direct plan", "direct",
    "growth option", "growth plan", "growth", "cumulative",
    "super institutional", "institutional", "retail",
    "premium plus", "premium", "plan", "option", "opt",
    "payout", "reinvestment", "reinvest", "idcw", "dividend",
    "fund", "scheme", "the", "of", "and", "a",
]


def base_name(name: str) -> str:
    """
    Fund identity with share-class wording removed.

    "Fund of Fund" is collapsed to the token "fof" FIRST, because it names a
    different product rather than a different share class of the same one.
    Without that step, stripping the ordinary words "fund" and "of" reduced both
    "HDFC Gold ETF" and "HDFC Gold ETF Fund of Fund" to "hdfc gold etf" -- an ETF
    and the feeder that invests in it, treated as one fund. Nineteen such pairs
    exist in the live data. The category check in plan_duplicates separates them
    too, but identity should not depend on a second test to be correct.
    """
    n = (name or "").lower()
    n = re.sub(r"\bfund\s+of\s+funds?\b", " fof ", n)
    n = re.sub(r"\bfofs?\b", " fof ", n)
    n = re.sub(r"[^a-z0-9 ]+", " ", n)
    for w in PLAN_WORDS:
        n = re.sub(rf"\b{re.escape(w)}\b", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def load_catalogue(path: str = CATALOGUE_PATH) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# Being listed by AMFI is not the same as being alive. AMFI keeps publishing
# wound-up schemes with the date they were last priced -- 72 of our codes carry
# AMFI dates between 2012 and 2025, "HDFC Liquid Fund-PREMIUM PLUS" among them at
# 17-Dec-2012. Treating mere presence as alive kept that row on screen next to
# the real HDFC Liquid Fund. A code counts as live only if it is priced within
# this many days of the newest date in the file.
LIVE_WINDOW_DAYS = 30


def plan_duplicates(catalogue: dict, priced: dict[str, tuple[str, float]]):
    """
    Returns (drop, review) where drop is the list of scheme dicts to remove and
    review is the reviewable breakdown.
    """
    import datetime

    newest = max((d for d, _ in priced.values()), default=None)
    cutoff = ""
    if newest:
        cutoff = (datetime.date.fromisoformat(newest)
                  - datetime.timedelta(days=LIVE_WINDOW_DAYS)).isoformat()

    def priced_date(code):
        row = priced.get(str(code))
        return row[0] if row else None

    def is_live(code):
        d = priced_date(code)
        return bool(d) and d >= cutoff
    groups: dict[tuple, list[dict]] = collections.defaultdict(list)
    for s in catalogue["schemes"]:
        groups[(s.get("amc_name"), base_name(s.get("scheme_name")))].append(s)

    drop, review = [], []
    for (amc, bn), members in groups.items():
        if len(members) < 2 or not bn:
            continue
        live = [m for m in members if is_live(m["scheme_code"])]
        dead = [m for m in members if not is_live(m["scheme_code"])]

        if len(live) > 1:
            # TWO LIVE CODES FOR ONE FUND.
            # AMFI prices both, with identical history: HSBC Liquid Fund is
            # published as 118902 "- Regular Growth" and 118907 "- Growth", each
            # with the same 4,020 points over the same dates. Three Invesco funds
            # do the same. They are one fund under two registrations.
            #
            # Same CATEGORY is required as well as same AMC and name, because the
            # name-stripping alone is not safe here: it collapses "DSP Savings
            # Fund" (Money Market) into "DSP Regular Savings Fund" (Conservative
            # Hybrid), and those are genuinely different funds. Nineteen further
            # groups are an ETF beside its own Fund-of-Fund, which the category
            # test also separates.
            cats = {m.get("category_name") for m in live}
            if len(cats) > 1:
                continue                  # different funds that merely look alike
            # History cannot break the tie -- it is identical -- so keep the name
            # that states its plan. On a Regular-Growth platform "- Regular
            # Growth" is unambiguous and a bare "- Growth" is not.
            def explicit(m):
                return "regular" in (m.get("scheme_name") or "").lower()
            # Scheme codes are numeric in practice, but the sort must not crash
            # if one ever is not: fall back to the string form.
            def code_key(m):
                c = str(m["scheme_code"])
                return (0, int(c), "") if c.isdigit() else (1, 0, c)
            ranked = sorted(live, key=lambda m: (not explicit(m), code_key(m)))
            survivors, losers = [ranked[0]], ranked[1:] + dead
            rule = "live-duplicate"
            reason = ("duplicate live registration of one fund; kept the code "
                      "whose name states the Regular plan")
        elif live:
            # The fund is still trading. Every retired code for it goes.
            survivors, losers = live, dead
            rule = "duplicate"
            reason = "stale code; AMFI still prices another code for this fund"
        else:
            # Fund is gone from the market. Keep one record of it -- the code
            # with the most recent price, whether that date comes from AMFI's
            # own stale row or from the catalogue.
            def recency(m):
                return (priced_date(m["scheme_code"])
                        or m.get("last_nav_date") or "")
            if not any(recency(m) for m in members):
                continue          # nothing to rank them by; leave them all
            best = max(members, key=recency)
            survivors, losers = [best], [m for m in members if m is not best]
            rule = "duplicate"
            reason = "fund no longer priced anywhere; kept the most recent code"

        if not losers:
            continue
        for m in losers:
            drop.append({**m, "_rule": rule, "_reason": reason,
                         "_kept_instead": [str(x["scheme_code"]) for x in survivors]})
        review.append((amc, bn, survivors, losers, reason))

    return drop, review


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="write the catalogue (default is a dry run)")
    ap.add_argument("--limit-report", type=int, default=25,
                    help="how many groups to print (default 25)")
    ap.add_argument("--drop-untracked", action="store_true",
                    help="also remove every fund AMFI does not currently price "
                         "(see the module docstring)")
    ap.add_argument("--live-window", type=int, default=LIVE_WINDOW_DAYS,
                    help=f"days from the file's newest date that still counts as "
                         f"priced (default {LIVE_WINDOW_DAYS})")
    args = ap.parse_args()

    catalogue = load_catalogue()
    log.info("catalogue: %d schemes", len(catalogue["schemes"]))

    log.info("fetching %s to see which codes are still priced ...", NAVALL_URL)
    text = fetch_navall()
    if not text:
        log.error("Could not download NAVAll.txt. Refusing to delete anything "
                  "without knowing which funds are live.")
        return 1
    priced = parse_navall(text)
    log.info("AMFI prices %d scheme codes today", len(priced))

    drop, review = plan_duplicates(catalogue, priced)

    if args.drop_untracked:
        import datetime
        newest = max(d for d, _ in priced.values())
        cutoff = (datetime.date.fromisoformat(newest)
                  - datetime.timedelta(days=args.live_window)).isoformat()
        already = {str(d["scheme_code"]) for d in drop}
        untracked = [
            {**s, "_rule": "untracked",
             "_reason": f"AMFI has not priced this fund since {cutoff}",
             "_kept_instead": []}
            for s in catalogue["schemes"]
            if str(s["scheme_code"]) not in already
            and (priced.get(str(s["scheme_code"])) or ("",))[0] < cutoff
        ]
        log.info("untracked rule: %d fund(s) not priced since %s",
                 len(untracked), cutoff)
        drop.extend(untracked)
        already |= {str(d["scheme_code"]) for d in untracked}

        # A fund AMFI still prices but does NOT publish as Regular-Growth is a
        # live share class of the wrong kind -- an IDCW or Direct row that entered
        # the catalogue historically. The untracked rule cannot see it (it IS
        # priced) and the duplicate rule cannot either (its name differs from the
        # growth row's). Example: SBI's "Income Distribution Cum Capital
        # Withdrawal" FoF rows, whose Growth siblings we already carry.
        from scripts import amfi_catalogue as amfi
        text_open = amfi.fetch_with_retry(amfi.AMFI_DAILY_URL)
        if text_open:
            rg = {r["scheme_code"] for r in amfi.parse_amfi_text(text_open)}
            wrong_class = [
                {**s, "_rule": "wrong-share-class",
                 "_reason": "AMFI prices this code but not as Regular-Growth",
                 "_kept_instead": []}
                for s in catalogue["schemes"]
                if str(s["scheme_code"]) not in already
                and str(s["scheme_code"]) not in rg
            ]
            log.info("wrong-share-class rule: %d fund(s) AMFI does not publish "
                     "as Regular-Growth", len(wrong_class))
            drop.extend(wrong_class)
        else:
            log.warning("could not fetch NAVOpen.txt; skipping the "
                        "wrong-share-class rule rather than guessing")

    print()
    print("=" * 100)
    print(f"{len(review)} duplicate group(s) -> {len(drop)} scheme(s) to remove")
    print("=" * 100)
    for amc, bn, survivors, losers, reason in sorted(
            review, key=lambda r: -len(r[3]))[:args.limit_report]:
        print(f"\n{amc}  ::  '{bn}'")
        print(f"   {reason}")
        for m in survivors:
            c = str(m["scheme_code"])
            d = priced[c][0] if c in priced else (m.get("last_nav_date") or "-")
            print(f"   KEEP  {c}  {(m['scheme_name'] or '')[:54]:<54} "
                  f"[{m.get('category_name')}] {d}")
        for m in losers:
            c = str(m["scheme_code"])
            d = priced[c][0] if c in priced else (m.get("last_nav_date") or "-")
            print(f"   drop  {c}  {(m['scheme_name'] or '')[:54]:<54} "
                  f"[{m.get('category_name')}] {d}")
    if len(review) > args.limit_report:
        print(f"\n... {len(review) - args.limit_report} more group(s) not shown "
              f"(raise --limit-report to see them)")

    # A code AMFI still prices must never be in the drop list. Cheap to check,
    # fatal if wrong.
    import datetime
    newest = max((d for d, _ in priced.values()), default=None)
    cutoff = ((datetime.date.fromisoformat(newest)
               - datetime.timedelta(days=args.live_window)).isoformat()
              if newest else "")
    # A fund AMFI prices TODAY must never be dropped for being stale or
    # duplicated -- that would mean the rule misfired. The wrong-share-class rule
    # is exempt by design: it exists precisely to remove live rows that are the
    # wrong share class (an IDCW index fund, a Direct row), which are priced today
    # and still do not belong on a Regular-Growth platform.
    # Two rules drop funds AMFI prices today, both on purpose:
    #   wrong-share-class  an IDCW or Direct row that should never have been here
    #   live-duplicate     one of two registrations of the same fund
    # Everything else dropping a live fund means a rule misfired.
    DELIBERATE_LIVE_DROPS = {"wrong-share-class", "live-duplicate"}
    leaked = [d for d in drop
              if d.get("_rule") not in DELIBERATE_LIVE_DROPS
              and (priced.get(str(d["scheme_code"])) or ("",))[0] >= cutoff]
    if leaked:
        log.error("ABORT: %d live scheme(s) reached the drop list, e.g. %s",
                  len(leaked), leaked[0]["scheme_code"])
        return 1

    by_cat = collections.Counter(d.get("category_name") for d in drop)
    print("\nremovals by category:")
    for k, v in by_cat.most_common():
        print(f"   {v:>5}  {k}")

    if not args.apply:
        print(f"\nDRY RUN — nothing written. Re-run with --apply to remove "
              f"{len(drop)} scheme(s).")
        return 0

    with open(REPORT_PATH, "w", encoding="utf-8") as fh:
        json.dump(sorted(drop, key=lambda d: int(d["scheme_code"])), fh,
                  ensure_ascii=False, indent=2)
    log.info("audit trail written to %s", REPORT_PATH)

    gone = {str(d["scheme_code"]) for d in drop}
    catalogue["schemes"] = [s for s in catalogue["schemes"]
                            if str(s["scheme_code"]) not in gone]
    catalogue["scheme_count"] = len(catalogue["schemes"])
    with open(CATALOGUE_PATH, "w", encoding="utf-8") as fh:
        json.dump(catalogue, fh, ensure_ascii=False, indent=2)
    log.info("catalogue rewritten: %d schemes remain", len(catalogue["schemes"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
