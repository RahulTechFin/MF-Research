"""
index_store.py — the 8 Market Pulse indices, one file each, in Supabase Storage.

    Supabase <slug>.json  ──pull──►  top up from Yahoo v8  ──gate──►  push back

BUCKET LAYOUT — eight files, no folders:

    nifty-50.json  sensex.json  nifty-100.json  nifty-midcap-150.json
    nifty-smallcap-250.json  nifty-bank.json  nifty-500.json  gold-goldbees.json

Each file is self-contained: the index's identity, its latest close and 1-day
move, a 30-point sparkline, and its full daily history. So one request serves
both the Market Pulse tile and the chart behind it — the chart used to need a
second fetch.

WHY ONE FILE PER INDEX
An earlier version wrote 38 objects across index/ and indices/ folders: a
combined strip file, a rolling history archive, and a series file for all 36
benchmarks even though only these 8 are ever displayed. Eight files is the whole
requirement.

WHAT THIS IS NOT
It is not the calculation pipeline's index source. That still reads the
committed data/index_history.json.gz (2010 onward, all 36 benchmarks) and tops
it up through scripts/backfill_indices, because category benchmarks need the
other 28 indices and a 10Y benchmark return needs closes from 10 years back.
These 8 files exist purely so the deployed site can show today's closes without
a rebuild. Keeping them separate is what lets this window be 6 years without
costing the 10Y column anything.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import sys
from datetime import date, datetime, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

log = logging.getLogger("index_store")

RETENTION_YEARS = 6
SPARKLINE_POINTS = 30

# Read-only 2010-onward history for all 36 benchmarks, used to seed an index the
# bucket does not hold yet. Never written to.
SEED_PATH = os.path.join(ROOT_DIR, "data", "index_history.json.gz")

# The eight, in the order Market Pulse renders them. Must stay in step with
# build_json.STRIP_INDICES; test_strip_matches_build_json() below enforces that.
# Adding a ninth means one entry here, one in STRIP_INDICES, and one slug in
# site/src/config/indices.ts.
STRIP: list[tuple[int, str, str]] = [
    (1, "NIFTY 50",           "nifty-50"),
    (2, "SENSEX",             "sensex"),
    (3, "NIFTY 100",          "nifty-100"),
    (6, "NIFTY MIDCAP 150",   "nifty-midcap-150"),
    (7, "NIFTY SMALLCAP 250", "nifty-smallcap-250"),
    (4, "NIFTY BANK",         "nifty-bank"),
    (5, "NIFTY 500",          "nifty-500"),
    (9, "GOLD (GOLDBEES)",    "gold-goldbees"),
]

# ── Safety gates, per index ──────────────────────────────────────────────────
# The ETF dashboard's lesson, scaled down: a rate-limited fetch once wrote an
# empty cache, and every later run re-read it and cold-started into the same
# rate limit. A file is only replaced if the new version clears all of these.
MIN_POINTS = 200           # 6y of trading days is ~1,480; 200 is a wide floor
MAX_SHRINK = 0.90          # may not fall below 90% of what is already published

Points = dict[str, float]


def strip_slugs() -> list[str]:
    return [s for _, _, s in STRIP]


# ── payload ──────────────────────────────────────────────────────────────────

def build_payload(index_id: int, name: str, slug: str, points: Points) -> dict:
    dates = sorted(points)
    latest = dates[-1]
    prev = dates[-2] if len(dates) > 1 else None
    close = points[latest]
    change_1d = (close / points[prev] - 1) if prev else None
    return {
        "version": 1,
        "index_id": index_id,
        "index_name": name,
        "slug": slug,
        "as_of": latest,
        "date": latest,
        "latest_close": close,
        "change_1d": round(change_1d, 6) if change_1d is not None else None,
        "change_1d_abs": round(close - points[prev], 4) if prev else None,
        "retention_years": RETENTION_YEARS,
        "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
        # Oldest first, matching what the chart and the sparkline both expect.
        "sparkline": [[d, points[d]] for d in dates[-SPARKLINE_POINTS:]],
        "history": [[d, points[d]] for d in dates],
    }


def payload_points(payload: dict) -> Points:
    return {d: c for d, c in (payload.get("history") or [])}


# ── load ─────────────────────────────────────────────────────────────────────

def pull_one(slug: str) -> Points:
    """Current published history for one index, or {} if not in the bucket."""
    from scripts import supabase_store as sb

    if not sb.enabled():
        return {}
    raw = sb.download_bytes(f"{slug}.json")
    if raw is None:
        return {}
    try:
        return payload_points(json.loads(raw))
    except Exception as exc:
        log.error("  %s.json in the bucket is unreadable (%s) — rebuilding it",
                  slug, exc)
        return {}


def seed_from_committed() -> dict[int, Points]:
    """The 2010-onward committed history, keyed by index_id. {} if absent."""
    if not os.path.exists(SEED_PATH):
        return {}
    try:
        with gzip.open(SEED_PATH, "rt", encoding="utf-8") as fh:
            payload = json.load(fh)
        return {int(iid): dict(zip(s["dates"], s["closes"]))
                for iid, s in (payload.get("series") or {}).items()}
    except Exception as exc:
        log.warning("Could not read the committed seed %s (%s)", SEED_PATH, exc)
        return {}


# ── top up ───────────────────────────────────────────────────────────────────

def prune(points: Points, retention_years: int = RETENTION_YEARS) -> Points:
    cutoff = (date.today() - timedelta(days=365 * retention_years)).isoformat()
    return {d: c for d, c in points.items() if d >= cutoff}


def cap_date() -> str:
    """
    The newest date an index file may carry: yesterday, IST.

    THE SAME RULE THE NAVs USE, imported from build_db_from_api rather than
    restated, so a benchmark and a fund can never be compared across different
    days. That is the whole reason this cap exists in one place.
    """
    from scripts.build_db_from_api import previous_business_close
    return previous_business_close()


def drop_after(points: Points, cap: str) -> Points:
    """
    Discard anything dated past the cap.

    WHY THIS IS NEEDED AND WHAT IT COST TO LEARN
    Yahoo answers a request made during market hours with a LIVE, PARTIAL bar
    dated today. Nothing here refused it, so a refresh run at 13:08 IST stored
    the running price of an open market as though it were 09 September's close —
    and every 1-day change computed from it was wrong.
    Until now the only thing preventing that was the cron firing at 23:45 IST,
    long after the 15:30 close. A schedule is not a safeguard: any manual run, a
    re-run of a failed job, or a retry at the wrong hour reintroduces it. Capping
    the DATA is the safeguard.

    Applied to the published points as well as to the incoming rows, so a bad
    value already in the bucket is corrected rather than carried forward.
    """
    return {d: c for d, c in points.items() if d <= cap}


# A one-day move this large is not a market move. The worst genuine daily moves
# in six years of this data are NIFTY 50 at -13.0% (23 Mar 2020) and the gilt ETF
# at +19.4% (16 Mar 2020), so a 3x threshold has two orders of magnitude of
# headroom and cannot catch a real one.
OUTLIER_RATIO = 3.0
# How many consecutive bad days a glitch may span before it stops looking like a
# glitch. GOLDBEES took two.
OUTLIER_MAX_RUN = 5
# How exactly the level must return to where it was for the run to count as a
# round trip. A genuine crash and rebound does not land within 15% of its own
# starting level after two days, and a decimal-shift glitch lands within 1%.
OUTLIER_ROUND_TRIP = 0.15


def drop_isolated_outliers(points: Points, name: str = "") -> tuple[Points, list[str]]:
    """
    Remove short runs where the quoted level jumps by orders of magnitude and
    then comes straight back. Returns (cleaned, notes).

    WHY THIS EXISTS
    GOLD (GOLDBEES) is quoted around Rs 33 in December 2019, except on the 19th
    and 20th, where the source reported 0.3355 and 0.3365 — the same price with
    the decimal point moved two places. On the 23rd it is back to 33.65.

    Two bad days out of 4,119 sounds harmless. It is not. A blend of NIFTY 50,
    gilt and gold rebalanced daily reads 447% annualised volatility off that
    series, against a true figure near 10%, because rebalancing re-buys at the
    corrupted price and books a 99% loss followed by a 9,900% gain. It also
    poisoned Multi Asset Blend, which is computed FROM gold and jumped 990% on
    the same day. Every risk figure downstream of either was wrong.

    WHAT IT WILL NOT TOUCH, WHICH MATTERS AS MUCH
    INDIA VIX genuinely rises 64% in a day (24 Aug 2015), 42% (5 Aug 2024) and
    66% (7 Apr 2025). Those are real and must survive, so this does not filter
    on the size of a move alone. A run qualifies only when the level RETURNS:
    the product of the ratios across it comes back to within OUTLIER_ROUND_TRIP
    of 1. A sustained move never round-trips, so a genuine spike, a crash, or a
    real re-denomination is left exactly as it is — and reported in the notes so
    a human can look rather than having it silently rewritten.

    Points are DROPPED, not rescaled. Dropping two days from a daily series
    loses nothing that matters and cannot invent a price; guessing the factor
    would put a number nobody quoted into the history.
    """
    if len(points) < 3:
        return points, []

    dates = sorted(points)
    closes = [points[d] for d in dates]
    notes: list[str] = []

    # Every point where the level moves by more than the threshold, either way.
    breaks: list[int] = []
    for i in range(1, len(closes)):
        prev, cur = closes[i - 1], closes[i]
        if prev <= 0 or cur <= 0:
            breaks.append(i)
            continue
        ratio = cur / prev
        if ratio >= OUTLIER_RATIO or ratio <= 1 / OUTLIER_RATIO:
            breaks.append(i)

    if not breaks:
        return points, []

    bad: set[int] = set()
    used: set[int] = set()
    for a_pos, a in enumerate(breaks):
        if a in used:
            continue
        for b in breaks[a_pos + 1:]:
            if b - a > OUTLIER_MAX_RUN:
                break
            # Does the level come back to where it started?
            start = closes[a - 1]
            end = closes[b]
            if start <= 0 or end <= 0:
                continue
            if abs(end / start - 1) <= OUTLIER_ROUND_TRIP:
                bad.update(range(a, b))
                used.update({a, b})
                notes.append(
                    f"{name or 'index'}: dropped {b - a} day(s) "
                    f"{dates[a]}..{dates[b - 1]} — level {start:.4f} -> "
                    f"{closes[a]:.4f} -> {end:.4f} is a round trip, not a move"
                )
                break

    unexplained = [i for i in breaks if i not in used and i not in bad]
    for i in unexplained:
        notes.append(
            f"{name or 'index'}: {dates[i]} moved "
            f"{(closes[i] / closes[i - 1] - 1) * 100:+.0f}% and did NOT come back "
            f"— left in place, check whether it is real"
        )

    if not bad:
        return points, notes
    return {d: c for k, (d, c) in enumerate(zip(dates, closes)) if k not in bad}, notes


def validate_one(new: Points, old: Points) -> list[str]:
    """Reasons not to replace the published file. Empty list means safe."""
    problems = []
    if len(new) < MIN_POINTS:
        problems.append(f"only {len(new)} points (floor {MIN_POINTS})")
    if old:
        in_window = len(prune(old))
        if in_window and len(new) < in_window * MAX_SHRINK:
            problems.append(f"shrank to {len(new)} from {in_window} "
                            f"({len(new) / in_window:.0%}, floor {MAX_SHRINK:.0%})")
        if new and max(new) < max(old):
            problems.append(f"newest date went backwards: {max(old)} -> {max(new)}")
    return problems


def refresh_one(index_id: int, name: str, slug: str, ticker: str,
                session=None, seed: dict[int, Points] | None = None,
                force_seed: bool = False) -> tuple[dict | None, list[str]]:
    """
    Bring one index up to date. Returns (payload_to_upload, problems).

    payload is None when nothing needs uploading or the result was rejected;
    problems is empty when it was simply already current.
    """
    from scripts.yahoo_chart import fetch_daily_closes

    floor = (date.today() - timedelta(days=365 * RETENTION_YEARS + 7)).isoformat()
    cap = cap_date()
    # The published file is capped BEFORE anything else looks at it. It is what
    # validate_one compares against, and comparing a capped result against an
    # uncapped baseline would make the "newest date went backwards" gate reject
    # the very correction that removes a bad intraday point.
    # TWO VIEWS OF THE PUBLISHED FILE, and the difference matters.
    #   on_disk  exactly what the bucket holds, including any point past the cap
    #   published the capped baseline that validate_one compares against
    # Capping the baseline is what stops the "newest date went backwards" gate
    # from rejecting the correction that REMOVES a bad intraday point. Keeping
    # on_disk is what makes that correction get uploaded at all: the decision to
    # skip an upload has to be "does the FILE already say this", not "does the
    # capped view match" — those differ precisely when a trim is needed, which is
    # the one case that must not be skipped.
    on_disk = {} if force_seed else pull_one(slug)
    published = drop_after(on_disk, cap)
    points = dict(published)

    if not points and seed:
        # Nothing published yet: start from the committed history rather than
        # asking Yahoo for six years of one ticker at a time.
        seeded = {d: c for d, c in (seed.get(index_id) or {}).items() if d >= floor}
        if seeded:
            points = seeded
            log.info("  %-22s seeded %d points from the committed history",
                     name, len(seeded))

    start = max(max(points), floor) if points else floor
    rows = fetch_daily_closes(ticker, start, session=session)
    if rows is None:
        return None, [f"Yahoo fetch failed for {ticker}"]

    for d, close in rows:
        points[d] = close
    points = drop_after(prune(points), cap)

    # Strip source glitches before anything measures this series. Done here
    # rather than at read time so the bucket holds clean history: a corrupted
    # close that reaches the file is read by every consumer forever.
    points, outlier_notes = drop_isolated_outliers(points, name)
    for note in outlier_notes:
        log.warning("   %s", note)

    problems = validate_one(points, published)
    if problems:
        return None, problems

    gained = len(points) - len(prune(published)) if published else len(points)
    if on_disk and points == prune(on_disk):
        log.info("  %-22s already current (%s)", name, max(points))
        return None, []

    trimmed = len(prune(on_disk)) - len(published) if on_disk else 0
    if trimmed > 0:
        log.warning("  %-22s dropping %d point(s) dated past the %s cap — a "
                    "refresh had stored an open market's running price as a "
                    "close", name, trimmed, cap)

    log.info("  %-22s %+d points, newest %s (cap %s)", name, gained,
             max(points), cap)
    return build_payload(index_id, name, slug, points), []


# ── publish ──────────────────────────────────────────────────────────────────

def push_one(slug: str, payload: dict) -> bool:
    from scripts import supabase_store as sb

    if not sb.enabled():
        log.warning("Supabase not configured (%s) — %s.json not published",
                    sb.why_disabled(), slug)
        return False
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    # 5 minutes: long enough to absorb a burst, short enough that a daily
    # refresh is visible almost immediately.
    return sb.upload_bytes(body, f"{slug}.json",
                           content_type="application/json",
                           cache_control="max-age=300")


def test_strip_matches_build_json() -> list[str]:
    """
    The strip list is duplicated in build_json.STRIP_INDICES. Report any drift
    rather than letting the site and the pipeline disagree about the eight.
    """
    from scripts.build_json import STRIP_INDICES
    mine = [n for _, n, _ in STRIP]
    if sorted(mine) != sorted(STRIP_INDICES):
        only_here = sorted(set(mine) - set(STRIP_INDICES))
        only_there = sorted(set(STRIP_INDICES) - set(mine))
        return [f"index_store.STRIP vs build_json.STRIP_INDICES disagree: "
                f"only in index_store={only_here}, only in build_json={only_there}"]
    return []
