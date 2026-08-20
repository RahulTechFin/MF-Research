"""
Close the one-day gap between api.mfapi.in and AMFI.

WHY THIS EXISTS
api.mfapi.in is the history source and reaches back to 2006, but it mirrors AMFI
with a one-day lag: measured 20 Aug 2026, AMFI had 19-Aug for 8,042 schemes while
mfapi's newest was 18-Aug for every one of 150 funds sampled. Value Research reads
AMFI directly, so comparing our dashboard against theirs was comparing our 18-Aug
against their 19-Aug -- which is most of the ~1% gap the owner spotted on 12M.

This adds AMFI's latest day on top of the mfapi history. It cannot do more than
that: NAVAll.txt is a snapshot of one day, so it can never backfill.

MATCHING IS BY SCHEME CODE, NOTHING ELSE
The instruction was Regular Plan + Growth only. The file's own Plan and Option
columns cannot deliver that -- 6,598 of 14,283 rows leave Plan blank, including
genuine Regular-Growth funds such as "Taurus Flexi Cap Fund - Regular Plan -
Growth", and ETFs have no plan at all. Filtering on those columns dropped 1,368
of our 2,910 funds in measurement.

Matching on scheme code gives the same outcome without the collateral damage: a
code identifies one scheme's one plan and one option, so a code already in our
universe can only return the share class that universe selected. The
Regular-Growth decision therefore stays where it was already made and tested --
amfi_catalogue.is_regular_growth, applied when the universe is built.

WHAT IT WILL NOT DO
  - never rewrites or deletes an existing NAV; it only inserts dates strictly
    newer than what a fund already has, so mfapi stays authoritative on history
  - never aborts the build; AMFI being unreachable or malformed costs one day of
    freshness, which is what we had before this file existed
  - the previous-day cap in build_db_from_api still governs. This runs before it.
"""
from __future__ import annotations

import logging
import sqlite3
import time
import urllib.error
import urllib.request

log = logging.getLogger("amfi_topup")

NAVALL_URL = "https://portal.amfiindia.com/spages/NAVAll.txt"

# Column layout of the portal file (8 fields, Plan and Option split out):
#   0 Scheme Code  1 ISIN Div Payout/Growth  2 ISIN Div Reinvestment
#   3 Scheme Name  4 Plan  5 Option  6 Net Asset Value  7 Date
COL_CODE, COL_NAME, COL_NAV, COL_DATE = 0, 3, 6, 7
MIN_FIELDS = 8

# The file carried 14,283 data rows when measured. Anything under this means a
# truncated download or a changed format, and topping up from it would be worse
# than not topping up at all.
MIN_ROWS = 5_000

# A tripwire for bad data, not a market judgement. The widest one-day move across
# 400 funds was 1.386% (Franklin Asian Equity), p99 was 0.815%, and the top movers
# were infrastructure funds falling together, i.e. real. 25% is ~18x the observed
# extreme, so it only catches things like the NAV re-denominations already known
# to sit in the history (Bandhan Short Duration Plan D restated 12.03 -> 22.16).
MAX_ONE_DAY_MOVE = 0.25

_MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def parse_nav_date(raw: str) -> str | None:
    """
    'dd-Mon-yyyy' or 'dd-mm-yyyy' to ISO.

    Both forms are needed and the difference is easy to miss: AMFI writes
    '19-Aug-2026' while api.mfapi.in writes '18-08-2026'. A parser that handled
    only the first turned every mfapi date into None during development and made
    the two sources look like they had no dates in common at all.
    """
    try:
        dd, mm, yy = raw.strip().split("-")
        month = int(mm) if mm.isdigit() else _MONTHS[mm[:3].title()]
        day, year = int(dd), int(yy)
    except (ValueError, KeyError):
        return None
    # Range-check every part rather than just reformatting. An already-ISO string
    # splits into three numbers too, and without this '2026-08-19' was read as day
    # 2026 of month 08 in year 19 and returned as '0019-08-2026' -- accepted, and
    # wrong. Neither upstream sends ISO today, but a caller that did would have
    # corrupted the date silently.
    if not (1 <= month <= 12 and 1 <= day <= 31 and 1900 <= year <= 2100):
        return None
    return f"{year:04d}-{month:02d}-{day:02d}"


def fetch_navall(url: str = NAVALL_URL, retries: int = 3,
                 timeout: int = 90) -> str | None:
    """The raw file, or None once the retries are spent. Never raises."""
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0 (MF-Research/1.0)"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8", "replace")
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            log.warning("AMFI NAVAll fetch attempt %d/%d failed: %s",
                        attempt, retries, exc)
            if attempt < retries:
                time.sleep(2 * attempt)
    return None


def parse_navall(text: str) -> dict[str, tuple[str, float]]:
    """
    {scheme_code: (iso_date, nav)}.

    Plan and Option are deliberately not read -- see the module docstring. Rows
    priced 'N.A.' (a fund between its launch and its first NAV) and non-numeric
    rows are dropped rather than treated as zero.
    """
    out: dict[str, tuple[str, float]] = {}
    unpriced = 0
    for line in text.splitlines():
        if ";" not in line:
            continue                      # AMC and scheme-type headers
        f = [c.strip() for c in line.split(";")]
        if len(f) < MIN_FIELDS or not f[COL_CODE].isdigit():
            continue                      # the column-title row
        date = parse_nav_date(f[COL_DATE])
        if date is None:
            continue
        try:
            nav = float(f[COL_NAV])
        except ValueError:
            unpriced += 1
            continue
        if nav <= 0:
            unpriced += 1
            continue
        out[f[COL_CODE]] = (date, nav)
    if unpriced:
        log.debug("AMFI: %d row(s) had no usable NAV", unpriced)
    return out


def top_up(conn: sqlite3.Connection, text: str | None = None) -> dict:
    """
    Insert AMFI's latest NAV for every scheme in our universe that AMFI prices
    later than we do. Returns a stats dict; commits nothing, because the caller
    owns the transaction.
    """
    stats = {"amfi_rows": 0, "matched": 0, "inserted": 0, "already_current": 0,
             "absent_from_amfi": 0, "rejected_move": 0, "no_baseline": 0,
             "newest": None, "ok": False}

    if text is None:
        text = fetch_navall()
    if not text:
        log.warning("AMFI top-up skipped: NAVAll.txt unavailable. Staying on "
                    "api.mfapi.in's latest day.")
        return stats

    amfi = parse_navall(text)
    stats["amfi_rows"] = len(amfi)
    if len(amfi) < MIN_ROWS:
        log.warning("AMFI top-up skipped: only %d usable rows (expected at least "
                    "%d) -- truncated download or changed format.",
                    len(amfi), MIN_ROWS)
        return stats

    # Each fund's own latest NAV, which is both the "do we gain a day?" test and
    # the baseline for the move check.
    baseline = {
        code: (date, nav) for code, date, nav in conn.execute(
            """
            SELECT h.scheme_code, h.nav_date, h.nav
              FROM nav_history h
              JOIN (SELECT scheme_code, MAX(nav_date) AS d
                      FROM nav_history GROUP BY scheme_code) m
                ON m.scheme_code = h.scheme_code AND m.d = h.nav_date
            """
        )
    }
    universe = [r[0] for r in conn.execute(
        "SELECT scheme_code FROM schemes WHERE is_active = 1")]

    pending, rejected = [], []
    for code in universe:
        row = amfi.get(str(code))
        if row is None:
            stats["absent_from_amfi"] += 1
            continue
        stats["matched"] += 1
        date, nav = row
        prev = baseline.get(code)
        if prev is None:
            stats["no_baseline"] += 1
        elif date <= prev[0]:
            # Nothing newer. History belongs to mfapi, so do not touch it.
            stats["already_current"] += 1
            continue
        elif prev[1] > 0 and abs(nav / prev[1] - 1) > MAX_ONE_DAY_MOVE:
            stats["rejected_move"] += 1
            rejected.append((code, prev, (date, nav), abs(nav / prev[1] - 1)))
            continue
        pending.append((code, date, nav))

    if rejected:
        log.warning("AMFI top-up rejected %d NAV(s) moving more than %.0f%% in a "
                    "day (kept the mfapi value):",
                    len(rejected), MAX_ONE_DAY_MOVE * 100)
        for code, prev, cur, move in sorted(rejected, key=lambda r: -r[3])[:10]:
            log.warning("   %s  %s %.4f -> %s %.4f  (%.1f%%)",
                        code, prev[0], prev[1], cur[0], cur[1], move * 100)

    if pending:
        conn.executemany(
            "INSERT OR IGNORE INTO nav_history(scheme_code, nav_date, nav) "
            "VALUES(?,?,?)", pending)
        stats["inserted"] = len(pending)
        stats["newest"] = max(d for _, d, _ in pending)

    stats["ok"] = True
    log.info("AMFI top-up: %s row(s) added up to %s "
             "(matched %s of %s by scheme code; %s already current, "
             "%s absent from AMFI, %s rejected)",
             f"{stats['inserted']:,}", stats["newest"] or "-",
             f"{stats['matched']:,}", f"{len(universe):,}",
             f"{stats['already_current']:,}", f"{stats['absent_from_amfi']:,}",
             f"{stats['rejected_move']:,}")
    return stats
