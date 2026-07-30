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
    published = {} if force_seed else pull_one(slug)
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
    points = prune(points)

    problems = validate_one(points, published)
    if problems:
        return None, problems

    gained = len(points) - len(prune(published)) if published else len(points)
    if published and points == prune(published):
        log.info("  %-22s already current (%s)", name, max(points))
        return None, []

    log.info("  %-22s %+d points, newest %s", name, gained, max(points))
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
