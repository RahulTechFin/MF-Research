"""
nav_store.py — NAV history read back from Supabase, topped up from AMFI.

    Supabase nav/<code>.json  ──pull──►  add today from AMFI  ──gate──►  DB

WHY
The daily run used to re-download every fund's ENTIRE history from api.mfapi.in
on every single run: ~3.5 million rows, ~2,050 HTTP requests, to rebuild files
that already existed and had not changed below their last day. The history was
already sitting in Supabase, published by yesterday's run.

This is the same shape as scripts/index_store, which has done it this way for the
8 Market Pulse indices all along: pull what is published, extend it by the days
that are missing, gate the result, keep it.

    index_store   Supabase <slug>.json  + Yahoo v8   -> gate -> push
    nav_store     Supabase nav/<code>.json + AMFI     -> gate -> DB

WHAT SUPPLIES WHAT
    Supabase   every NAV up to and including the last published day. Authority
               for history.
    AMFI       the newest day only. NAVAll.txt is a snapshot -- one row per fund,
               today -- and there is no history endpoint, so it can never do more
               than extend the series by its own date.
    mfapi      BOOTSTRAP ONLY, and only for a fund with no published file at all
               (a newly launched scheme, or a first run against an empty bucket).
               Nothing else reads it. Pass allow_bootstrap=False to forbid even
               that, at the cost of a new fund starting from one day.

WHY A GATE
Overwriting a good history with a short one is the failure that matters, and it
is silent -- returns simply start reading None. So a fund's series is only
accepted if it still has at least MIN_POINTS_FLOOR points, has not shrunk past
MAX_SHRINK of what was published, and its newest date has not gone backwards.
A fund that fails is kept at its PUBLISHED series rather than the new one.
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import logging
import threading
from datetime import datetime

log = logging.getLogger("nav_store")

# A series is a plain {iso_date: nav}; dicts merge by date, which is the whole
# point -- the same day arriving twice cannot duplicate a row.
Series = dict[str, float]

# Gates, mirroring index_store.validate_one.
#
# The floor is 1, not some comfortable minimum: a fund launched this week
# legitimately has a single NAV. Setting it to 2 rejected the three JioBlackRock
# funds on their first days, which was pure noise -- there was nothing to protect,
# because the published series was that same single point. Only an EMPTY series is
# invalid. The shrink and date-regression checks below do the real work.
MIN_POINTS_FLOOR = 1
MAX_SHRINK = 0.90         # may not fall below 90% of what is already published

# Bad-data tripwire on the day AMFI adds, imported rather than restated so the
# two AMFI paths cannot disagree about what counts as impossible. Measured across
# 400 funds the widest real one-day move was 1.386%; this catches NAV
# re-denominations, not market moves.
from scripts.amfi_topup import MAX_ONE_DAY_MOVE  # noqa: E402

# Parallel downloads. Supabase serves these from object storage and the limit is
# the round trip, not our CPU; 16 keeps ~2,000 files under a minute without
# tripping rate limits.
WORKERS = 16


def nav_remote_path(code: str, folder: str) -> str:
    """Where a fund's series lives, e.g. "equity/large-cap/nav/103174.json"."""
    return f"{folder}/nav/{code}.json"


def folders_for(schemes: list[dict]) -> tuple[dict[str, str], list[str]]:
    """
    {scheme_code: "<asset-class>/<slug>"} plus the codes that could not be placed.

    Derived from the CATALOGUE and CATEGORY_SEED, not from a previous build's
    output. publish_data.load_maps reads the flat category_<slug>_trailing.json
    files to get the same mapping, which is fine when it runs (after a build) but
    useless here: this runs BEFORE the build, and those files no longer sit in
    site/public/data at all now that the published tree lives there. Using the
    seed means the mapping exists on a machine that has never built anything.
    """
    from scripts.init_db import ASSET_FOLDER, CATEGORY_SEED

    by_name = {name: (ASSET_FOLDER.get(ac, "other"), slug)
               for ac, name, slug, _order in CATEGORY_SEED}

    folders: dict[str, str] = {}
    unplaced: list[str] = []
    for s in schemes:
        code = str(s["scheme_code"])
        hit = by_name.get(s.get("category_name") or "")
        if hit:
            folders[code] = f"{hit[0]}/{hit[1]}"
        else:
            unplaced.append(code)
    return folders, unplaced


def parse_published(raw: bytes) -> Series:
    """
    {date: nav} from a published nav file, or {} if it is unusable.

    Unreadable is treated as absent rather than fatal: the fund falls through to
    bootstrap and the run continues.
    """
    try:
        payload = json.loads(raw)
    except Exception:
        return {}
    out: Series = {}
    for row in payload.get("series") or []:
        try:
            d, v = row[0], float(row[1])
        except (TypeError, ValueError, IndexError):
            continue
        if v > 0:
            out[d] = v
    return out


def published_paths() -> dict[str, str]:
    """
    {scheme_code: remote path} read from the BUCKET LISTING, not from a fund's
    current category.

    WHY THIS EXISTS
    A fund's file lives under its category, so recategorising one moves its path.
    AMFI does move funds — several changed header between snapshots while this was
    being built. If the history were only ever looked for under the CURRENT
    category, a recategorised fund would appear to have none, and the run would
    bootstrap it from api.mfapi.in. That works, until the day mfapi is also
    unavailable: the fund would then publish with nothing but AMFI's single day,
    and the next run's gate would compare against that one-point file and accept
    it. Sixteen years of history, gone quietly, with every later run faithfully
    carrying the loss forward.

    Listing the bucket costs one request and makes the lookup independent of
    categorisation entirely.
    """
    from scripts import supabase_store as sb

    if not sb.enabled():
        return {}
    out: dict[str, str] = {}
    for obj in sb.list_objects("", bucket=sb.DATA_BUCKET):
        name = obj.get("name") or ""
        if "/nav/" not in name or not name.endswith(".json"):
            continue
        code = name.rsplit("/", 1)[-1][:-len(".json")]
        if code.isdigit():
            out[code] = name
    return out


def pull_many(codes_folders: dict[str, str], workers: int = WORKERS,
              on_progress=None) -> dict[str, Series]:
    """
    Published series for many funds. Absent or unreadable files are simply
    missing from the result, which is what marks a fund as needing a bootstrap.
    """
    from scripts import supabase_store as sb

    if not sb.enabled():
        log.warning("Supabase not configured (%s) — no published history to read",
                    sb.why_disabled())
        return {}

    out: dict[str, Series] = {}
    lock = threading.Lock()
    done = 0

    # Where each fund's file actually is, whatever category it sits in today.
    # Falls back to the category-derived path for a fund the bucket has never
    # held — which is exactly the set that needs bootstrapping anyway.
    actual = published_paths()
    moved = sum(1 for c, f in codes_folders.items()
                if c in actual and actual[c] != nav_remote_path(c, f))
    if moved:
        log.info("%d fund(s) are published under a different category than they "
                 "now belong to; reading their history from where it is", moved)

    def one(item):
        nonlocal done
        code, folder = item
        raw = sb.download_bytes(actual.get(code) or nav_remote_path(code, folder),
                                bucket=sb.DATA_BUCKET)
        series = parse_published(raw) if raw else {}
        with lock:
            done += 1
            if series:
                out[code] = series
            if on_progress and done % 250 == 0:
                on_progress(done, len(codes_folders), len(out))
        return None

    with cf.ThreadPoolExecutor(workers) as ex:
        list(ex.map(one, codes_folders.items()))

    log.info("Supabase: read history for %s of %s fund(s)",
             f"{len(out):,}", f"{len(codes_folders):,}")
    return out


def validate(new: Series, published: Series) -> list[str]:
    """Reasons not to trust `new`. Empty list means it is safe to use."""
    problems = []
    if len(new) < MIN_POINTS_FLOOR:
        problems.append(f"only {len(new)} point(s)")
    if published:
        if len(new) < len(published) * MAX_SHRINK:
            problems.append(f"shrank to {len(new)} from {len(published)} "
                            f"({len(new) / len(published):.0%})")
        if new and max(new) < max(published):
            problems.append(f"newest date went backwards: "
                            f"{max(published)} -> {max(new)}")
    return problems


def merge_amfi(series_by_code: dict[str, Series],
               amfi: dict[str, tuple[str, float]],
               cap: str | None = None) -> dict:
    """
    Extend each fund's series with AMFI's latest row.

    AMFI is only ever allowed to ADD a date. A row for a day the fund already has
    is ignored rather than overwritten: the published value came from the same
    source a day earlier and rewriting history is exactly what this design is
    meant to avoid. `cap` (an ISO date) drops anything newer, so the previous-day
    rule stays in one place.

    A NAV moving more than MAX_ONE_DAY_MOVE from the fund's last known value is
    REFUSED. This guard matters far more here than it did on the old path.
    Previously a bad AMFI value landed in a throwaway database and the next run
    rebuilt the whole history from api.mfapi.in, washing it out. Now the history
    IS what we published, and AMFI cannot rewrite a day it has already given us —
    so one bad value would be baked in permanently and every future run would
    faithfully carry it forward.
    """
    stats = {"extended": 0, "already_current": 0, "absent_from_amfi": 0,
             "capped": 0, "rejected_move": 0}
    rejected: list[tuple[str, float, str, float, float]] = []
    for code, series in series_by_code.items():
        row = amfi.get(str(code))
        if row is None:
            stats["absent_from_amfi"] += 1
            continue
        d, nav = row
        if cap and d > cap:
            stats["capped"] += 1
            continue
        if d in series:
            stats["already_current"] += 1
            continue
        if series and d < max(series):
            # Older than what we hold: a wound-up fund AMFI still lists at the
            # price it died at. Nothing to add.
            stats["already_current"] += 1
            continue
        if series:
            prev_date = max(series)
            prev = series[prev_date]
            if prev > 0 and abs(nav / prev - 1) > MAX_ONE_DAY_MOVE:
                stats["rejected_move"] += 1
                rejected.append((code, prev, d, nav, abs(nav / prev - 1)))
                continue
        series[d] = nav
        stats["extended"] += 1

    if rejected:
        log.warning("AMFI: refused %d NAV(s) moving more than %.0f%% in a day — "
                    "the series keeps its last published value:",
                    len(rejected), MAX_ONE_DAY_MOVE * 100)
        for code, prev, d, nav, move in sorted(rejected, key=lambda r: -r[4])[:10]:
            log.warning("   %s  %.4f -> %s %.4f  (%.1f%%)",
                        code, prev, d, nav, move * 100)
    return stats


def previous_day_cap(now: datetime | None = None) -> str:
    """
    Same rule as build_db_from_api.previous_business_close, imported from there
    so there is one definition.
    """
    from scripts.build_db_from_api import previous_business_close
    return previous_business_close(now)


def summarise(series_by_code: dict[str, Series]) -> dict:
    total = sum(len(s) for s in series_by_code.values())
    newest = max((max(s) for s in series_by_code.values() if s), default=None)
    oldest = min((min(s) for s in series_by_code.values() if s), default=None)
    return {"funds": len(series_by_code), "rows": total,
            "newest": newest, "oldest": oldest}
