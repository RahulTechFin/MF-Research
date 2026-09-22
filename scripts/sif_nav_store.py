"""
sif_nav_store.py — SIF NAV history, held as one Parquet file in Supabase.

    Supabase nav/history.parquet ──pull──► add the missing days from AMFI
                                 ──gate──► push back

THE SAME SHAPE AS THE MF DESK, ONE IMPROVEMENT
scripts/nav_store does this for mutual funds and scripts/index_store for the
eight indices: read what was published, extend it by the days that are missing,
gate the result, keep it. Nothing is ever re-downloaded from the beginning.

The improvement is what AMFI will serve. SIF_NAVAll.txt is a one-day snapshot,
exactly like the MF feed, so on its own it could only ever add today — miss a
run and that day is lost for good. But the SIF history report takes a DATE
RANGE, so this asks for everything between the last published day and the cap.
A missed run, a long weekend, a week of downtime: the next run fills the gap.

WHY ONE FILE AND NOT ONE PER FUND
The MF desk keeps nav/<code>.json per fund because there are ~2,050 of them and
the dashboard fetches one at a time. There are 30 SIF funds and 3,034 rows. One
Parquet file is 17 KB, reads in a single request, and compresses far better than
30 fragments would — most of a 100-row Parquet file is footer.

STORAGE, MEASURED NOT GUESSED
    raw AMFI text          1,425,752 bytes   (what the range endpoint returns)
    JSON, MF style            ~68,700 bytes
    Parquet + zstd-19          16,821 bytes

Explicitly dictionary-encoding the scheme_code column gains nothing — Parquet
already dictionary-encodes a string column on write, so the Arrow-level
encoding just moves the same bytes. int16 codes came out within 1% too. At this
size the file is mostly footer, so the schema is chosen to be readable rather
than to shave bytes.

WHY A GATE
Overwriting a good history with a short one is the failure that matters, and it
is silent — returns simply start reading None. Since this file IS the history
now, and AMFI cannot rewrite a day it has already given us, a bad value would be
permanent. So: a NAV may only be ADDED, never changed; a day moving more than
MAX_ONE_DAY_MOVE from the last known value is refused outright; and the merged
result has to keep at least MAX_SHRINK of the rows it started with.
"""
from __future__ import annotations

import io
import logging
from datetime import date, datetime, timedelta

import pyarrow as pa
import pyarrow.parquet as pq

log = logging.getLogger("sif_nav_store")

# {scheme_code: {iso_date: nav}}. Dicts merge by date, which is the whole point:
# the same day arriving twice cannot duplicate a row.
Series = dict[str, float]

REMOTE_NAV = "nav/history.parquet"

# zstd at 19. Level 9 gives 17,302 bytes and 22 gives 16,834, so the whole range
# is within 3% -- the data is small enough that the extra CPU is free, and this
# is written once a day.
COMPRESSION = "zstd"
COMPRESSION_LEVEL = 19

# Gates, mirroring nav_store.validate.
MIN_POINTS_FLOOR = 1      # a fund that listed this week legitimately has one NAV
MAX_SHRINK = 0.90         # may not fall below 90% of what is already published

# Bad-data tripwire, imported rather than restated so the two desks cannot
# disagree about what counts as impossible in one day.
from scripts.amfi_topup import MAX_ONE_DAY_MOVE  # noqa: E402

# How far back to look for scheme NAMES when the NAV top-up itself needs a
# shorter window. The catalogue reads plan and option out of the history
# report's NAV Name, so the window has to be wide enough to contain every fund
# that is still reporting. A fund absent for a whole quarter is not trading.
NAME_WINDOW_DAYS = 90


def cap_date(now: datetime | None = None) -> str:
    """
    The newest day this desk may publish — the same rule the MF desk uses,
    imported from it rather than restated, so the two as-of dates cannot drift
    apart. That alignment is the whole point of running them together.
    """
    from scripts.build_db_from_api import previous_business_close
    return previous_business_close(now)


# ── reading and writing the file ────────────────────────────────────────────

def to_parquet(series_by_code: dict[str, Series]) -> bytes:
    """
    Sorted by (scheme_code, nav_date) so runs of the same code sit together,
    which is what lets the column encode down to almost nothing.
    """
    recs = sorted((c, d, v)
                  for c, s in series_by_code.items()
                  for d, v in s.items())
    table = pa.table({
        "scheme_code": pa.array([r[0] for r in recs], pa.string()),
        "nav_date": pa.array([date.fromisoformat(r[1]) for r in recs], pa.date32()),
        "nav": pa.array([r[2] for r in recs], pa.float64()),
    })
    buf = io.BytesIO()
    pq.write_table(table, buf, compression=COMPRESSION,
                   compression_level=COMPRESSION_LEVEL,
                   write_statistics=True, data_page_version="2.0")
    return buf.getvalue()


def from_parquet(raw: bytes) -> dict[str, Series]:
    """
    Parse a published file. Unreadable is treated as ABSENT, not fatal: the run
    then bootstraps from AMFI rather than dying, and the gate below is what stops
    a bootstrap from quietly replacing a good history with a short one.
    """
    if not raw:
        return {}
    try:
        table = pq.read_table(io.BytesIO(raw))
    except Exception as exc:
        log.warning("published NAV file is unreadable (%s) — treating as absent", exc)
        return {}
    out: dict[str, Series] = {}
    codes = table.column("scheme_code").to_pylist()
    dates = table.column("nav_date").to_pylist()
    navs = table.column("nav").to_pylist()
    for code, d, v in zip(codes, dates, navs):
        if not code or d is None or v is None or v <= 0:
            continue
        out.setdefault(code, {})[d.isoformat() if hasattr(d, "isoformat") else str(d)] = float(v)
    return out


def read_published() -> dict[str, Series]:
    from scripts import supabase_store as sb
    if not sb.enabled():
        log.warning("Supabase not configured (%s) — no published history to read",
                    sb.why_disabled())
        return {}
    raw = sb.download_bytes(REMOTE_NAV, bucket=sb.SIF_BUCKET)
    series = from_parquet(raw or b"")
    log.info("Supabase: read %s row(s) over %d fund(s)",
             f"{sum(len(s) for s in series.values()):,}", len(series))
    return series


def write_published(series_by_code: dict[str, Series]) -> bool:
    from scripts import supabase_store as sb
    body = to_parquet(series_by_code)
    ok = sb.upload_bytes(body, REMOTE_NAV, bucket=sb.SIF_BUCKET,
                         content_type="application/vnd.apache.parquet")
    log.info("wrote %s (%.1f KB, %s rows): %s", REMOTE_NAV, len(body) / 1024,
             f"{sum(len(s) for s in series_by_code.values()):,}",
             "ok" if ok else "FAILED")
    return ok


# ── deciding what to ask AMFI for ───────────────────────────────────────────

def fetch_window(series_by_code: dict[str, Series], cap: str,
                 start_floor: date) -> tuple[date, date]:
    """
    The range to request: from the last published day to the cap, widened to at
    least NAME_WINDOW_DAYS so the catalogue can still read every active fund's
    plan and option out of the NAV Names in the same response.

    Starting AT the last published day rather than the day after is deliberate.
    It costs one duplicated day and means a partially-written final day is
    completed rather than half-missing, because merging is keyed on the date.
    """
    end = date.fromisoformat(cap)
    newest = max((max(s) for s in series_by_code.values() if s), default=None)
    resume = date.fromisoformat(newest) if newest else start_floor
    start = min(resume, end - timedelta(days=NAME_WINDOW_DAYS))
    # Never ask for a day before the first one AMFI has; it would return nothing
    # and only make the window look wider than it is.
    return max(start, start_floor), end


# ── merging ─────────────────────────────────────────────────────────────────

def merge(series_by_code: dict[str, Series],
          incoming: list[tuple[str, str, float]],
          keep_codes: set[str] | None = None,
          cap: str | None = None) -> dict:
    """
    Fold AMFI rows into the published series. Returns what happened, per reason.

    Rules, in order of how much they matter:
      * a day the fund already has is IGNORED, never overwritten. The published
        value came from this same source, and rewriting history is exactly what
        this design exists to avoid.
      * a NAV more than MAX_ONE_DAY_MOVE from the fund's last known value is
        REFUSED. This is the guard that catches a re-denomination. On the old
        MF path a bad value landed in a throwaway database and the next run
        washed it out; here the file IS the history, so one bad value would be
        carried forward for ever.
      * anything past `cap` is dropped, so the as-of rule lives in one place.
      * a code outside `keep_codes` is skipped: only the Regular Growth funds
        are stored, so Direct and IDCW share classes never enter the file.
    """
    stats = {"added": 0, "already_held": 0, "not_tracked": 0, "capped": 0,
             "rejected_move": 0, "bad_value": 0}
    rejected: list[tuple] = []

    # Oldest first, so a multi-day gap is filled in order and each day is
    # checked against the one before it rather than against a later value.
    for code, d, nav in sorted(incoming, key=lambda r: (r[0], r[1])):
        if keep_codes is not None and code not in keep_codes:
            stats["not_tracked"] += 1
            continue
        if nav is None or nav <= 0:
            stats["bad_value"] += 1
            continue
        if cap and d > cap:
            stats["capped"] += 1
            continue
        series = series_by_code.setdefault(code, {})
        if d in series:
            stats["already_held"] += 1
            continue
        if series:
            earlier = [k for k in series if k < d]
            if earlier:
                prev_date = max(earlier)
                prev = series[prev_date]
                if prev > 0 and abs(nav / prev - 1) > MAX_ONE_DAY_MOVE:
                    stats["rejected_move"] += 1
                    rejected.append((code, prev_date, prev, d, nav,
                                     abs(nav / prev - 1)))
                    continue
        series[d] = nav
        stats["added"] += 1

    if rejected:
        log.warning("refused %d NAV(s) moving more than %.0f%% in a day — the "
                    "series keeps its last published value:",
                    len(rejected), MAX_ONE_DAY_MOVE * 100)
        for code, pd_, prev, d, nav, move in sorted(rejected, key=lambda r: -r[5])[:10]:
            log.warning("   %s  %s %.4f -> %s %.4f  (%.1f%%)",
                        code, pd_, prev, d, nav, move * 100)
    stats["refused"] = rejected
    return stats


def validate(new: dict[str, Series], published: dict[str, Series]) -> list[str]:
    """Reasons not to publish `new`. An empty list means it is safe."""
    problems = []
    total_new = sum(len(s) for s in new.values())
    total_old = sum(len(s) for s in published.values())
    if not new:
        problems.append("no funds at all")
    if total_new < MIN_POINTS_FLOOR:
        problems.append(f"only {total_new} row(s) in total")
    if published:
        if total_new < total_old * MAX_SHRINK:
            problems.append(f"shrank to {total_new:,} rows from {total_old:,} "
                            f"({total_new / total_old:.0%})")
        for code, old in published.items():
            if not old:
                continue
            fresh = new.get(code)
            if not fresh:
                problems.append(f"{code} lost its entire series ({len(old)} rows)")
            elif max(fresh) < max(old):
                problems.append(f"{code} newest date went backwards: "
                                f"{max(old)} -> {max(fresh)}")
    return problems


def summarise(series_by_code: dict[str, Series]) -> dict:
    days = {d for s in series_by_code.values() for d in s}
    return {
        "funds": len(series_by_code),
        "rows": sum(len(s) for s in series_by_code.values()),
        "days": len(days),
        "first": min(days) if days else None,
        "last": max(days) if days else None,
    }
