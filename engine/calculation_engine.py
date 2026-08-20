"""
engine/calculation_engine.py
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE SINGLE SOURCE OF TRUTH FOR ALL MATH.

Every return, average, ranking, quartile, and chart value shown anywhere in
the platform is computed ONLY by the logic in this module.

NEVER re-implement, duplicate, or "optimise" any formula elsewhere (not in SQL,
not in JavaScript, not in a second Python file). When the owner wants a logic
change it is changed HERE and only here, and the whole platform updates.

Status: LOCKED — modify only when the owner explicitly instructs a logic change.
"""

from __future__ import annotations

import math
import sqlite3
import statistics
from datetime import date, datetime, timedelta
from typing import Optional

# ── E1. NAV Lookup Conventions ────────────────────────────────────────────────

SEARCH_WINDOW = 10   # calendar days cap for date resolution

def _resolve_nav(
    conn: sqlite3.Connection,
    scheme_code: str,
    target_date: date,
    direction: str,          # 'prev' | 'next'
    table: str = "nav_history",
    code_col: str = "scheme_code",
    date_col: str = "nav_date",
    val_col: str = "nav",
) -> tuple[Optional[date], Optional[float]]:
    """
    Resolve a NAV (or index close) for target_date using the specified direction.
    NEAREST-PREVIOUS: direction='prev'
    NEAREST-NEXT:     direction='next'
    Returns (resolved_date, value) or (None, None) if not found within SEARCH_WINDOW.
    """
    op = "<=" if direction == "prev" else ">="
    order = "DESC" if direction == "prev" else "ASC"
    
    row = conn.execute(
        f"SELECT {date_col}, {val_col} FROM {table} "
        f"WHERE {code_col}=? AND {date_col} {op} ? "
        f"ORDER BY {date_col} {order} LIMIT 1",
        (scheme_code, target_date.isoformat())
    ).fetchone()

    if row:
        resolved_date = datetime.fromisoformat(row[0]).date()
        if abs((resolved_date - target_date).days) <= SEARCH_WINDOW:
            return resolved_date, row[1]
            
    return None, None


def resolve_nearest_previous(
    conn: sqlite3.Connection,
    scheme_code: str,
    target_date: date,
    table: str = "nav_history",
    code_col: str = "scheme_code",
    date_col: str = "nav_date",
    val_col: str = "nav",
) -> tuple[Optional[date], Optional[float]]:
    return _resolve_nav(conn, scheme_code, target_date, "prev", table, code_col, date_col, val_col)


def resolve_nearest_next(
    conn: sqlite3.Connection,
    scheme_code: str,
    target_date: date,
    table: str = "nav_history",
    code_col: str = "scheme_code",
    date_col: str = "nav_date",
    val_col: str = "nav",
) -> tuple[Optional[date], Optional[float]]:
    return _resolve_nav(conn, scheme_code, target_date, "next", table, code_col, date_col, val_col)


def anchor_date(conn: sqlite3.Connection, scheme_code: str, as_of: Optional[date] = None) -> Optional[date]:
    """
    E1 ANCHOR (T): latest available NAV date ≤ as_of (default = today).
    """
    cutoff = (as_of or date.today()).isoformat()
    row = conn.execute(
        "SELECT MAX(nav_date) FROM nav_history WHERE scheme_code=? AND nav_date<=?",
        (scheme_code, cutoff),
    ).fetchone()
    if row and row[0]:
        return datetime.fromisoformat(row[0]).date()
    return None


def index_anchor_date(conn: sqlite3.Connection, index_id: int, as_of: Optional[date] = None) -> Optional[date]:
    """ANCHOR for index closing prices."""
    cutoff = (as_of or date.today()).isoformat()
    row = conn.execute(
        "SELECT MAX(date) FROM index_history WHERE index_id=? AND date<=?",
        (index_id, cutoff),
    ).fetchone()
    if row and row[0]:
        return datetime.fromisoformat(row[0]).date()
    return None


def _first_nav_date(conn: sqlite3.Connection, scheme_code: str) -> Optional[date]:
    row = conn.execute(
        "SELECT MIN(nav_date) FROM nav_history WHERE scheme_code=?", (scheme_code,)
    ).fetchone()
    return datetime.fromisoformat(row[0]).date() if row and row[0] else None


# ── E2. Trailing Returns (T-Anchored) ─────────────────────────────────────────

TRAILING_PERIODS = {
    "1M":  dict(months=1),
    "3M":  dict(months=3),
    "6M":  dict(months=6),
    "12M": dict(months=12),
    "3Y":  dict(years=3),
    "5Y":  dict(years=5),
    "10Y": dict(years=10),
}


def _subtract_period(base: date, months: int = 0, years: int = 0) -> date:
    """Calendar arithmetic: subtract months/years from base date."""
    total_months = years * 12 + months
    m = base.month - total_months
    y = base.year
    while m <= 0:
        m += 12
        y -= 1
    # Clamp to valid day
    import calendar
    last_day = calendar.monthrange(y, m)[1]
    return date(y, m, min(base.day, last_day))


def trailing_return(
    conn: sqlite3.Connection,
    scheme_code: str,
    period: str,           # '1M','3M','6M','12M','3Y','5Y','10Y'
    as_of: Optional[date] = None,
) -> Optional[float]:
    """
    E2: Trailing return for fund.
    Returns decimal (e.g. 0.1444 for 14.44%) or None = display '—'.
    """
    kwargs = TRAILING_PERIODS.get(period)
    if kwargs is None:
        raise ValueError(f"Unknown period: {period}")

    T = anchor_date(conn, scheme_code, as_of)
    if T is None:
        return None

    nav_T_row = conn.execute(
        "SELECT nav FROM nav_history WHERE scheme_code=? AND nav_date=?",
        (scheme_code, T.isoformat()),
    ).fetchone()
    if nav_T_row is None:
        return None
    nav_T = nav_T_row[0]

    start_target = _subtract_period(T, **kwargs)

    # E1: start uses NEAREST-PREVIOUS
    start_d, nav_start = resolve_nearest_previous(conn, scheme_code, start_target)
    if start_d is None or nav_start is None:
        return None

    # Eligibility: fund's first NAV must be ≤ resolved start date
    first = _first_nav_date(conn, scheme_code)
    if first is None or first > start_d:
        return None

    actual_days = (T - start_d).days
    if actual_days <= 0:
        return None

    # ≤12M: simple absolute; >12M: CAGR with exact day count
    if period in ("1M", "3M", "6M", "12M"):
        return (nav_T / nav_start) - 1
    else:
        return (nav_T / nav_start) ** (365 / actual_days) - 1


def trailing_return_index(
    conn: sqlite3.Connection,
    index_id: int,
    period: str,
    as_of: Optional[date] = None,
) -> Optional[float]:
    """E7: Same trailing return logic applied to index closing prices."""
    kwargs = TRAILING_PERIODS.get(period)
    if kwargs is None:
        raise ValueError(f"Unknown period: {period}")

    T = index_anchor_date(conn, index_id, as_of)
    if T is None:
        return None

    row = conn.execute(
        "SELECT close FROM index_history WHERE index_id=? AND date=?",
        (index_id, T.isoformat()),
    ).fetchone()
    if row is None:
        return None
    close_T = row[0]

    start_target = _subtract_period(T, **kwargs)
    start_d, close_start = resolve_nearest_previous(
        conn, str(index_id), start_target,
        table="index_history", code_col="index_id",
        date_col="date", val_col="close",
    )
    if start_d is None or close_start is None:
        return None

    actual_days = (T - start_d).days
    if actual_days <= 0:
        return None

    if period in ("1M", "3M", "6M", "12M"):
        return (close_T / close_start) - 1
    else:
        return (close_T / close_start) ** (365 / actual_days) - 1


# ── E3. Annual Returns (Calendar Year) ───────────────────────────────────────

def annual_return(
    conn: sqlite3.Connection,
    scheme_code: str,
    year: int,
    as_of: Optional[date] = None,
) -> Optional[float]:
    """
    E3: Annual return for a given calendar year.
    Current year = YTD (end = ANCHOR T).
    Returns decimal or None.
    """
    today = as_of or date.today()
    current_year = today.year

    # Start NAV: the previous year's close (31-Dec), not 01-Jan.
    start_d, nav_start = period_start_value(conn, scheme_code, date(year, 1, 1))
    if start_d is None or nav_start is None:
        return None

    # End NAV: 31-Dec → NEAREST-PREVIOUS; current year → ANCHOR
    if year == current_year:
        T = anchor_date(conn, scheme_code, today)
        if T is None:
            return None
        row = conn.execute(
            "SELECT nav FROM nav_history WHERE scheme_code=? AND nav_date=?",
            (scheme_code, T.isoformat()),
        ).fetchone()
        if row is None:
            return None
        nav_end = row[0]
    else:
        end_target = date(year, 12, 31)
        _, nav_end = resolve_nearest_previous(conn, scheme_code, end_target)
        if nav_end is None:
            return None

    return (nav_end / nav_start) - 1


def annual_return_index(
    conn: sqlite3.Connection,
    index_id: int,
    year: int,
    as_of: Optional[date] = None,
) -> Optional[float]:
    """E7: Annual return for index."""
    today = as_of or date.today()
    current_year = today.year

    # Previous year's close (31-Dec), matching annual_return for funds.
    start_d, close_start = index_period_start_value(conn, index_id, date(year, 1, 1))
    if start_d is None or close_start is None:
        return None

    if year == current_year:
        T = index_anchor_date(conn, index_id, today)
        if T is None:
            return None
        row = conn.execute(
            "SELECT close FROM index_history WHERE index_id=? AND date=?",
            (index_id, T.isoformat()),
        ).fetchone()
        close_end = row[0] if row else None
    else:
        _, close_end = resolve_nearest_previous(
            conn, str(index_id), date(year, 12, 31),
            table="index_history", code_col="index_id", date_col="date", val_col="close",
        )

    if close_end is None:
        return None
    return (close_end / close_start) - 1


# ── E4. Quarterly Returns ─────────────────────────────────────────────────────

QUARTER_STARTS = {1: (1, 1), 2: (4, 1), 3: (7, 1), 4: (10, 1)}
QUARTER_ENDS   = {1: (3, 31), 2: (6, 30), 3: (9, 30), 4: (12, 31)}


def quarter_return(
    conn: sqlite3.Connection,
    scheme_code: str,
    year: int,
    quarter: int,          # 1–4
    as_of: Optional[date] = None,
) -> Optional[float]:
    """
    E4: Quarterly point-to-point return. Current (incomplete) quarter = QTD.
    Returns decimal or None.
    """
    today = as_of or date.today()
    current_year    = today.year
    current_quarter = (today.month - 1) // 3 + 1

    qsm, qsd = QUARTER_STARTS[quarter]
    # Start: the previous quarter's close, not the quarter's first day.
    start_d, nav_start = period_start_value(conn, scheme_code, date(year, qsm, qsd))
    if start_d is None or nav_start is None:
        return None

    is_current = (year == current_year and quarter == current_quarter)

    if is_current:
        T = anchor_date(conn, scheme_code, today)
        if T is None:
            return None
        row = conn.execute(
            "SELECT nav FROM nav_history WHERE scheme_code=? AND nav_date=?",
            (scheme_code, T.isoformat()),
        ).fetchone()
        nav_end = row[0] if row else None
    else:
        qem, qed = QUARTER_ENDS[quarter]
        end_target = date(year, qem, qed)
        _, nav_end = resolve_nearest_previous(conn, scheme_code, end_target)

    if nav_end is None:
        return None
    return (nav_end / nav_start) - 1


def quarter_return_index(
    conn: sqlite3.Connection,
    index_id: int,
    year: int,
    quarter: int,
    as_of: Optional[date] = None,
) -> Optional[float]:
    """E7: Quarterly return for index."""
    today = as_of or date.today()
    current_year    = today.year
    current_quarter = (today.month - 1) // 3 + 1

    qsm, qsd = QUARTER_STARTS[quarter]
    # Previous quarter's close, matching quarter_return for funds.
    start_d, close_start = index_period_start_value(conn, index_id, date(year, qsm, qsd))
    if start_d is None or close_start is None:
        return None

    is_current = (year == current_year and quarter == current_quarter)

    if is_current:
        T = index_anchor_date(conn, index_id, today)
        row = conn.execute(
            "SELECT close FROM index_history WHERE index_id=? AND date=?",
            (index_id, T.isoformat()),
        ).fetchone() if T else None
        close_end = row[0] if row else None
    else:
        qem, qed = QUARTER_ENDS[quarter]
        _, close_end = resolve_nearest_previous(
            conn, str(index_id), date(year, qem, qed),
            table="index_history", code_col="index_id", date_col="date", val_col="close",
        )

    if close_end is None:
        return None
    return (close_end / close_start) - 1


# ── E5. Monthly Returns ───────────────────────────────────────────────────────

import calendar as _calendar


def month_return(
    conn: sqlite3.Connection,
    scheme_code: str,
    year: int,
    month: int,            # 1–12
    as_of: Optional[date] = None,
) -> Optional[float]:
    """
    E5: Monthly point-to-point return. Current month = MTD.
    Returns decimal or None.
    """
    today = as_of or date.today()

    # Start: the previous month's close, not the 1st.
    start_d, nav_start = period_start_value(conn, scheme_code, date(year, month, 1))
    if start_d is None or nav_start is None:
        return None

    is_current = (year == today.year and month == today.month)

    if is_current:
        T = anchor_date(conn, scheme_code, today)
        if T is None:
            return None
        row = conn.execute(
            "SELECT nav FROM nav_history WHERE scheme_code=? AND nav_date=?",
            (scheme_code, T.isoformat()),
        ).fetchone()
        nav_end = row[0] if row else None
    else:
        last_day = _calendar.monthrange(year, month)[1]
        _, nav_end = resolve_nearest_previous(conn, scheme_code, date(year, month, last_day))

    if nav_end is None:
        return None
    return (nav_end / nav_start) - 1


def month_return_index(
    conn: sqlite3.Connection,
    index_id: int,
    year: int,
    month: int,
    as_of: Optional[date] = None,
) -> Optional[float]:
    """E7: Monthly return for index."""
    today = as_of or date.today()

    # Previous month's close, matching month_return for funds.
    start_d, close_start = index_period_start_value(conn, index_id, date(year, month, 1))
    if start_d is None or close_start is None:
        return None

    is_current = (year == today.year and month == today.month)
    if is_current:
        T = index_anchor_date(conn, index_id, today)
        row = conn.execute(
            "SELECT close FROM index_history WHERE index_id=? AND date=?",
            (index_id, T.isoformat()),
        ).fetchone() if T else None
        close_end = row[0] if row else None
    else:
        last_day = _calendar.monthrange(year, month)[1]
        _, close_end = resolve_nearest_previous(
            conn, str(index_id), date(year, month, last_day),
            table="index_history", code_col="index_id", date_col="date", val_col="close",
        )

    if close_end is None:
        return None
    return (close_end / close_start) - 1


# ── E6. Category Average ──────────────────────────────────────────────────────

def category_average(returns: list[Optional[float]]) -> Optional[float]:
    """
    E6: Equal-weighted mean of all eligible (non-None) fund returns.
    Funds with None (—) are excluded — never counted as zero.
    Returns None if no eligible funds.
    """
    eligible = [r for r in returns if r is not None]
    if not eligible:
        return None
    return sum(eligible) / len(eligible)


# ── E8. Chart Normalization ───────────────────────────────────────────────────

def normalize_series(
    nav_series: list[tuple[str, float]],   # [(date_iso, nav), ...] sorted ascending
    start_date: Optional[date] = None,     # common start; resolved NEAREST-NEXT if None provided
) -> list[tuple[str, float]]:
    """
    E8: Rebase series to 0%.
    value_t = ((NAV_t / NAV_series_start) - 1) * 100
    Returns [(date_iso, pct_value), ...].
    """
    if not nav_series:
        return []

    # Find first nav on or after start_date
    if start_date:
        series = [(d, v) for d, v in nav_series if d >= start_date.isoformat()]
    else:
        series = nav_series

    if not series:
        return []

    base_nav = series[0][1]
    if base_nav == 0:
        return []

    return [(d, round(((v / base_nav) - 1) * 100, 4)) for d, v in series]


def common_start_date(series_list: list[list[tuple[str, float]]]) -> Optional[date]:
    """
    E8: Common start = latest first-available date across all series.
    """
    firsts = []
    for series in series_list:
        if series:
            firsts.append(datetime.fromisoformat(series[0][0]).date())
    if not firsts:
        return None
    return max(firsts)


# ── Period start: the previous close ─────────────────────────────────────────

def period_start_value(
    conn: sqlite3.Connection,
    code: str,
    period_first_day: date,
    table: str = "nav_history",
    code_col: str = "scheme_code",
    date_col: str = "nav_date",
    val_col: str = "nav",
) -> tuple[Optional[date], Optional[float]]:
    """
    The value a period starts FROM: the last one on or before the day BEFORE it
    opens — i.e. the previous period's close.

    January starts at 31 December, Q1 at 31 December, 2025 at 31 December 2024.

    This used to resolve NEAREST-NEXT from the period's first day, which meant
    every period silently dropped its opening day: twelve monthly returns came
    out 1.72 percentage points short of the year they covered, four quarters
    0.57 short, and the year itself 0.14 short — four different answers for the
    same stretch of time. trailing_return already used NEAREST-PREVIOUS, so the
    two conventions in this file contradicted each other.

    Returns (None, None) when nothing exists on or before that day, which is a
    fund that launched inside the period. The caller then reports nothing rather
    than a part-period figure dressed up as a full one.
    """
    day_before = period_first_day - timedelta(days=1)
    return _resolve_nav(conn, code, day_before, "prev",
                        table, code_col, date_col, val_col)


def index_period_start_value(
    conn: sqlite3.Connection, index_id: int, period_first_day: date,
) -> tuple[Optional[date], Optional[float]]:
    """period_start_value against index_history."""
    return period_start_value(conn, str(index_id), period_first_day,
                              table="index_history", code_col="index_id",
                              date_col="date", val_col="close")

# ── E9. Quartile Ranking ──────────────────────────────────────────────────────

# Pools smaller than this keep the old ROUNDUP behaviour — see quartile().
SMALL_POOL = 3

def quartile(rank: int, n: int) -> Optional[int]:
    """
    E9: equal brackets of n//4, with any remainder given to the BOTTOM
    quartiles — Q4 first, then Q3, then Q2. Q1 never takes a leftover.

        n = 40  ->  Q1 10  Q2 10  Q3 10  Q4 10     (divides evenly)
        n = 17  ->  Q1  4  Q2  4  Q3  4  Q4  5     (1 spare -> Q4)
        n = 18  ->  Q1  4  Q2  4  Q3  5  Q4  5     (2 spare -> Q4, Q3)
        n = 31  ->  Q1  7  Q2  8  Q3  8  Q4  8     (3 spare -> Q4, Q3, Q2)

    THIS REPLACES the previous ROUNDUP transcription:
        IF(rank <= ROUNDUP(N*0.25,0), 1, IF(rank <= ROUNDUP(N*0.50,0), 2, ...))
    which handed spare funds to Q1 instead, so it read Q1 5 / Q2 4 / Q3 4 / Q4 4
    at n = 17. The two agree only when n is a multiple of 4. Changed on the
    owner's instruction: a spare fund should not be promoted into the top
    bracket.

    FEWER THAN 3 FUNDS keeps the old ROUNDUP behaviour, on the owner's
    instruction. Bottom-loading a pool that small reads badly: the sole fund in a
    sector would be Q4, and with two funds neither could be Q1. The old formula
    puts them at the top instead (n = 1 -> Q1; n = 2 -> Q1 and Q3).

        Note n = 3 uses the NEW rule, so its best fund lands in Q2, not Q1 —
        "less than 3" as specified. Raise SMALL_POOL to 4 if a 3-fund sector
        (Conglomerate today) should also keep a Q1.

    Returns 1-4, or None when rank is None or n == 0 (displays '-').
    """
    if rank is None or n == 0:
        return None

    if n < SMALL_POOL:
        # Previous transcription of the owner's Excel: ROUNDUP boundaries, which
        # hand any spare fund to the TOP bracket.
        if rank <= math.ceil(n * 0.25):
            return 1
        if rank <= math.ceil(n * 0.50):
            return 2
        if rank <= math.ceil(n * 0.75):
            return 3
        return 4

    base, remainder = divmod(n, 4)
    # Index 0 is Q1. A remainder of r fills the last r brackets, bottom-up.
    sizes = [
        base,
        base + (1 if remainder >= 3 else 0),
        base + (1 if remainder >= 2 else 0),
        base + (1 if remainder >= 1 else 0),
    ]

    upper = 0
    for q, size in enumerate(sizes, start=1):
        upper += size
        if rank <= upper:
            return q
    # rank > n: out of range for this pool. Treated as the bottom bracket rather
    # than raising, matching the old formula's fall-through.
    return 4


def rank_and_quartile(
    returns: dict[str, Optional[float]]
) -> dict[str, tuple[Optional[int], Optional[int]]]:
    """
    E9: Given {scheme_code: return_decimal|None}, return
    {scheme_code: (rank, quartile)} where ineligible = (None, None).
    Ranks descending (rank 1 = best).
    """
    eligible = {k: v for k, v in returns.items() if v is not None}
    n = len(eligible)
    ranked = sorted(eligible.items(), key=lambda x: x[1], reverse=True)

    result = {}
    for rank_1idx, (code, _) in enumerate(ranked, start=1):
        q = quartile(rank_1idx, n)
        result[code] = (rank_1idx, q)

    for code in returns:
        if code not in result:
            result[code] = (None, None)

    return result


# ── E10. Consistency & Volatility Boxes ───────────────────────────────────────

TOP_HALF = frozenset({1, 2})
BOTTOM_HALF = frozenset({3, 4})

# What "mostly in Q1/Q2" means for the consistent list: two periods in three.
# Low enough that the box is populated in every category, high enough that a fund
# splitting its time evenly between the halves cannot qualify.
CONSISTENT_MIN_TOP_SHARE = 0.60


def quartile_journeys(
    quartile_grids: dict[str, list[Optional[int]]],
    min_periods: int = 6,
    limit: int = 5,
    extremes: int = 3,
) -> dict[str, list[dict]]:
    """
    Classify each fund by the PATH its quartile took, and split the results into
    lists that cannot overlap.

    WHY THIS REPLACED THE OLD PAIR
    consistency_top5 ranked on the mean quartile while volatility_top5 ranked on
    the standard deviation of RETURNS -- two different quantities measured off two
    different inputs. A fund that sits in Q1 every period while swinging hard in
    absolute terms scored well on the first and badly on the second, so the same
    name appeared in "Most Consistent" and "Most Volatile" at once. That is not a
    display bug; the two boxes were answering different questions and neither was
    the question the screen asks.

    Both are now read off the same quartile history, which is what makes them
    comparable and lets the overlap be ruled out by construction.

    THE RULE
      A CROSSING is a move between the top half (Q1/Q2) and the bottom half
      (Q3/Q4) from one period to the next, in either direction.

      volatile    the funds that cross most often. Ranked by crossings, then by
                  how evenly they split their time between the halves.
      consistent  spent at least CONSISTENT_MIN_TOP_SHARE of their periods in the
                  top half -- "mostly Q1/Q2" -- and are NOT in the volatile list.

    VOLATILE IS RESOLVED FIRST, and consistent is drawn from what is left. That is
    the owner's tie-break ("if a fund has both, it goes under volatile") applied
    where it belongs: between the two lists. Building it into the definition of
    consistent instead -- demanding zero crossings -- was tried and is far too
    strict to be useful: it left 40 of 54 category files with an empty consistent
    box, because over eight or more periods almost no fund stays in the top half
    without a single slip.

    The two lists cannot share a fund: `consistent` explicitly excludes every
    code already claimed by `volatile`.

    BEST AND WORST are a separate question -- level, not stability -- so they are
    share-based ("most of the time") and may overlap the two lists above. A fund
    can be both the strongest performer and a volatile one.

    Gaps are skipped rather than treated as a move: a fund with no rank for a
    period has not travelled anywhere, so crossings are counted along the periods
    it actually has.
    """
    scored = []
    for code, history in quartile_grids.items():
        valid = [q for q in history if q is not None]
        if len(valid) < min_periods:
            continue

        top = sum(1 for q in valid if q in TOP_HALF)
        bottom = len(valid) - top
        crossings = sum(
            1 for a, b in zip(valid, valid[1:])
            if (a in TOP_HALF) != (b in TOP_HALF)
        )
        scored.append({
            "scheme_code": code,
            "history": history,
            "periods": len(valid),
            "avg_quartile": round(sum(valid) / len(valid), 3),
            "pct_q1": round(valid.count(1) / len(valid), 4),
            "top_share": round(top / len(valid), 4),
            "bottom_share": round(bottom / len(valid), 4),
            "crossings": crossings,
            # How evenly the time splits between halves: 0 means it never left
            # one, 0.5 means a dead heat. Breaks ties between funds that cross
            # the same number of times.
            "balance": round(min(top, bottom) / len(valid), 4),
        })

    volatile = sorted(
        (s for s in scored if s["crossings"] >= 1),
        key=lambda s: (-s["crossings"], -s["balance"], s["avg_quartile"]),
    )[:limit]
    claimed = {s["scheme_code"] for s in volatile}

    consistent = sorted(
        (s for s in scored
         if s["scheme_code"] not in claimed
         and s["top_share"] >= CONSISTENT_MIN_TOP_SHARE),
        key=lambda s: (-s["top_share"], s["avg_quartile"], -s["pct_q1"]),
    )[:limit]

    best = sorted(
        scored, key=lambda s: (-s["top_share"], s["avg_quartile"], -s["pct_q1"]),
    )[:extremes]
    worst = sorted(
        scored, key=lambda s: (-s["bottom_share"], -s["avg_quartile"]),
    )[:extremes]

    return {"consistent": consistent, "volatile": volatile,
            "best": best, "worst": worst}


# ── E12. Risk Analytics ───────────────────────────────────────────────────────

def _monthly_returns_from_navs(nav_series: list[tuple[str, float]]) -> list[float]:
    """
    Derive monthly returns from month-end NAVs.
    r_m = (NAV_end_this_month / NAV_end_prev_month) - 1.
    Expects nav_series as [(date_iso, nav), ...] sorted ascending.
    """
    if len(nav_series) < 2:
        return []
    monthly = []
    for i in range(1, len(nav_series)):
        prev_nav = nav_series[i - 1][1]
        this_nav = nav_series[i][1]
        if prev_nav > 0:
            monthly.append((this_nav / prev_nav) - 1)
    return monthly


def risk_metrics(
    conn: sqlite3.Connection,
    scheme_code: str,
    benchmark_index_id: int,
    risk_free_rate: float = 0.065,   # annual, e.g. 0.065 = 6.5%
    as_of: Optional[date] = None,
) -> dict:
    """
    E12: Full risk metric set for a fund vs its category benchmark.
    Returns dict with all metrics (None = not enough data / display '—').
    Computation window: trailing 3 years of MONTHLY returns (36 obs, min 30).
    """
    today = as_of or date.today()
    three_yr_start = _subtract_period(today, years=3)

    # ── Load 3Y monthly fund NAVs (Optimised daily query + Python grouping) ──
    raw_fund = conn.execute(
        "SELECT nav_date, nav FROM nav_history WHERE scheme_code=? AND nav_date>=? AND nav_date<=? ORDER BY nav_date",
        (scheme_code, three_yr_start.isoformat(), today.isoformat())
    ).fetchall()
    
    fund_ym = {}
    for r in raw_fund:
        ym = r[0][:7]  # 'YYYY-MM'
        fund_ym[ym] = r
    fund_rows = [fund_ym[ym] for ym in sorted(fund_ym.keys())]

    # ── Load 3Y monthly Index Closes (Optimised daily query + Python grouping) ──
    raw_bench = conn.execute(
        "SELECT date, close FROM index_history WHERE index_id=? AND date>=? AND date<=? ORDER BY date",
        (benchmark_index_id, three_yr_start.isoformat(), today.isoformat())
    ).fetchall()

    bench_ym = {}
    for r in raw_bench:
        ym = r[0][:7]  # 'YYYY-MM'
        bench_ym[ym] = r
    bench_rows = [bench_ym[ym] for ym in sorted(bench_ym.keys())]

    fund_monthly  = _monthly_returns_from_navs(fund_rows)
    bench_monthly = _monthly_returns_from_navs(bench_rows)

    # Align to common dates (zip by position — both are monthly, same window)
    n_common = min(len(fund_monthly), len(bench_monthly))
    if n_common < 30:
        return {k: None for k in [
            "std_annual", "sharpe", "sortino", "beta", "alpha",
            "max_drawdown", "recovery_days", "upside_capture", "downside_capture",
            "composite_score", "fund_3y_cagr", "bench_3y_cagr",
        ]}

    f_monthly = fund_monthly[-n_common:]
    b_monthly = bench_monthly[-n_common:]

    Rf_annual  = risk_free_rate
    Rf_monthly = (1 + Rf_annual) ** (1 / 12) - 1

    # R1 — Standard Deviation (annualised, sample)
    std_annual = statistics.stdev(f_monthly) * math.sqrt(12)

    # Fund & benchmark 3Y CAGR (E2 logic)
    fund_3y_cagr  = trailing_return(conn, scheme_code, "3Y", today)
    bench_3y_cagr = trailing_return_index(conn, benchmark_index_id, "3Y", today)

    # R2 — Sharpe
    sharpe = (
        ((fund_3y_cagr - Rf_annual) / std_annual)
        if std_annual and fund_3y_cagr is not None
        else None
    )

    # R3 — Sortino
    excess_m = [r - Rf_monthly for r in f_monthly]
    downside  = [min(e, 0) for e in excess_m]
    sigma_d   = math.sqrt(sum(d ** 2 for d in downside) / len(downside)) * math.sqrt(12)
    sortino   = (
        ((fund_3y_cagr - Rf_annual) / sigma_d)
        if sigma_d and fund_3y_cagr is not None
        else None
    )

    # R4 — Beta & Alpha
    f_mean = sum(f_monthly) / len(f_monthly)
    b_mean = sum(b_monthly) / len(b_monthly)
    covar  = sum((f - f_mean) * (b - b_mean) for f, b in zip(f_monthly, b_monthly)) / len(f_monthly)
    b_var  = sum((b - b_mean) ** 2 for b in b_monthly) / len(b_monthly)
    beta   = covar / b_var if b_var else None
    alpha  = (
        (fund_3y_cagr - (Rf_annual + beta * (bench_3y_cagr - Rf_annual)))
        if beta is not None and fund_3y_cagr is not None and bench_3y_cagr is not None
        else None
    )

    # R5 — Maximum Drawdown + Recovery (full NAV history, daily)
    all_nav_rows = conn.execute(
        "SELECT nav_date, nav FROM nav_history WHERE scheme_code=? ORDER BY nav_date",
        (scheme_code,),
    ).fetchall()
    max_drawdown   = None
    recovery_days  = None
    trough_date    = None
    peak_date      = None
    recovery_date  = None

    if all_nav_rows:
        running_peak   = all_nav_rows[0][1]
        running_peak_d = datetime.fromisoformat(all_nav_rows[0][0]).date()
        min_drawdown   = 0.0
        trough_nav     = running_peak

        for d_str, nav in all_nav_rows:
            d = datetime.fromisoformat(d_str).date()
            if nav > running_peak:
                running_peak   = nav
                running_peak_d = d
            dd = nav / running_peak - 1
            if dd < min_drawdown:
                min_drawdown   = dd
                trough_date    = d
                trough_nav     = nav
                peak_date      = running_peak_d

        max_drawdown = min_drawdown

        # Recovery: first day after trough where NAV ≥ peak at trough date
        if trough_date and peak_date:
            peak_nav_at_trough = running_peak  # running peak AT trough
            # Re-scan for the peak NAV value at trough date
            for d_str, nav in all_nav_rows:
                if datetime.fromisoformat(d_str).date() == peak_date:
                    peak_nav_at_trough = nav
                    break

            for d_str, nav in all_nav_rows:
                d = datetime.fromisoformat(d_str).date()
                if d > trough_date and nav >= peak_nav_at_trough:
                    recovery_date = d
                    recovery_days = (recovery_date - trough_date).days
                    break

    # R6 — Upside / Downside Capture (36 monthly returns)
    up_months   = [(f, b) for f, b in zip(f_monthly, b_monthly) if b > 0]
    down_months = [(f, b) for f, b in zip(f_monthly, b_monthly) if b < 0]

    def geo_annualised(returns, n):
        if not returns or n == 0:
            return None
        product = 1.0
        for r in returns:
            product *= (1 + r)
        return product ** (12 / n) - 1

    upside_capture   = None
    downside_capture = None

    if up_months:
        f_up  = geo_annualised([f for f, _ in up_months], len(up_months))
        b_up  = geo_annualised([b for _, b in up_months], len(up_months))
        upside_capture = (f_up / b_up * 100) if b_up and b_up != 0 and f_up is not None else None

    if down_months:
        f_dn  = geo_annualised([f for f, _ in down_months], len(down_months))
        b_dn  = geo_annualised([b for _, b in down_months], len(down_months))
        downside_capture = (f_dn / b_dn * 100) if b_dn and b_dn != 0 and f_dn is not None else None

    return {
        "std_annual":       round(std_annual, 6)              if std_annual       else None,
        "sharpe":           round(sharpe, 4)                  if sharpe           else None,
        "sortino":          round(sortino, 4)                 if sortino          else None,
        "beta":             round(beta, 4)                    if beta             else None,
        "alpha":            round(alpha, 6)                   if alpha            else None,
        "max_drawdown":     round(max_drawdown, 6)            if max_drawdown is not None else None,
        "recovery_days":    recovery_days,
        "trough_date":      trough_date.isoformat()           if trough_date      else None,
        "peak_date":        peak_date.isoformat()             if peak_date        else None,
        "recovery_date":    recovery_date.isoformat()         if recovery_date    else None,
        "upside_capture":   round(upside_capture, 2)          if upside_capture   else None,
        "downside_capture": round(downside_capture, 2)        if downside_capture else None,
        "fund_3y_cagr":     fund_3y_cagr,
        "bench_3y_cagr":    bench_3y_cagr,
    }


def composite_risk_score(
    metrics_list: list[dict],
    weights: dict | None = None,
) -> list[dict]:
    """
    R7: Percentile-score each fund within its category on 5 metrics,
    then compute the weighted composite score (0–100).
    Returns metrics_list with 'composite_score' added.
    Weights default: Sharpe 30%, Sortino 20%, Alpha 20%, MaxDD 15%, Capture Spread 15%.
    """
    if weights is None:
        weights = {
            "sharpe": 0.30, "sortino": 0.20, "alpha": 0.20,
            "max_drawdown": 0.15, "capture_spread": 0.15,
        }

    # Build eligible lists per metric
    n = len(metrics_list)
    for m in metrics_list:
        m["capture_spread"] = (
            (m.get("upside_capture") or 0) - (m.get("downside_capture") or 0)
            if m.get("upside_capture") is not None and m.get("downside_capture") is not None
            else None
        )

    def percentile_rank(values: list[Optional[float]], ascending=True) -> list[Optional[float]]:
        """Percentile rank within eligible values. Higher = better (ascending=True means higher raw = better)."""
        eligible = [(i, v) for i, v in enumerate(values) if v is not None]
        if not eligible:
            return [None] * len(values)
        sorted_vals = sorted(eligible, key=lambda x: x[1], reverse=ascending)
        pct = {}
        for rank_0, (i, _) in enumerate(sorted_vals):
            pct[i] = (1 - rank_0 / len(eligible)) * 100
        return [pct.get(i) for i in range(len(values))]

    # For max_drawdown: shallower (closer to 0) = better → ascending=False
    sharpe_pct    = percentile_rank([m.get("sharpe") for m in metrics_list])
    sortino_pct   = percentile_rank([m.get("sortino") for m in metrics_list])
    alpha_pct     = percentile_rank([m.get("alpha") for m in metrics_list])
    maxdd_pct     = percentile_rank([m.get("max_drawdown") for m in metrics_list], ascending=False)
    capture_pct   = percentile_rank([m.get("capture_spread") for m in metrics_list])

    for i, m in enumerate(metrics_list):
        scores = [
            (sharpe_pct[i],  weights["sharpe"]),
            (sortino_pct[i], weights["sortino"]),
            (alpha_pct[i],   weights["alpha"]),
            (maxdd_pct[i],   weights["max_drawdown"]),
            (capture_pct[i], weights["capture_spread"]),
        ]
        valid_scores  = [(s, w) for s, w in scores if s is not None]
        if valid_scores:
            total_weight = sum(w for _, w in valid_scores)
            composite    = sum(s * w for s, w in valid_scores) / total_weight if total_weight else None
            m["composite_score"] = round(composite, 1) if composite is not None else None
        else:
            m["composite_score"] = None

    return metrics_list


# ── E14. Rolling & Point-to-Point Returns ─────────────────────────────────────

def point_to_point_return(
    conn: sqlite3.Connection,
    scheme_code: str,
    start: date,
    end: date,
) -> dict:
    """
    E14 Mode B: Point-to-point return between two dates.
    Returns {return, cagr} where cagr is also computed if >366 days.
    """
    start_d, nav_start = resolve_nearest_next(conn, scheme_code, start)
    end_d,   nav_end   = resolve_nearest_previous(conn, scheme_code, end)

    if nav_start is None or nav_end is None:
        return {"return": None, "cagr": None, "start_date": None, "end_date": None}

    ret = (nav_end / nav_start) - 1
    days = (end_d - start_d).days
    cagr = ((nav_end / nav_start) ** (365 / days) - 1) if days > 366 else None

    return {
        "return":     round(ret, 6),
        "cagr":       round(cagr, 6) if cagr is not None else None,
        "start_date": start_d.isoformat(),
        "end_date":   end_d.isoformat(),
        "days":       days,
    }


def rolling_statistics(
    conn: sqlite3.Connection,
    scheme_code: str,
    benchmark_index_id: int,
    window_label: str,       # '1M','3M','6M','1Y','3Y','5Y'
    as_of: Optional[date] = None,
) -> dict:
    """
    E14 Mode A: Rolling statistics for a given window across all historical windows.
    Returns: avg, min, max, pct_positive, pct_beats_benchmark.
    """
    today = as_of or date.today()

    # Map window label → months
    window_months = {"1M": 1, "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60}
    months = window_months.get(window_label)
    if months is None:
        return {}

    # Get all NAV dates and values in one query
    rows = conn.execute(
        "SELECT nav_date, nav FROM nav_history WHERE scheme_code=? AND nav_date<=? ORDER BY nav_date",
        (scheme_code, today.isoformat()),
    ).fetchall()

    if len(rows) < 2:
        return {"avg": None, "min": None, "max": None, "pct_positive": None, "pct_beats_benchmark": None}

    # Build memory map
    fund_map = {}
    nav_dates = []
    for r in rows:
        d = datetime.fromisoformat(r[0]).date()
        fund_map[d] = r[1]
        nav_dates.append(d)

    # Build benchmark memory map
    bench_map = {}
    if benchmark_index_id:
        brows = conn.execute(
            "SELECT date, close FROM index_history WHERE index_id=? AND date<=? ORDER BY date",
            (benchmark_index_id, today.isoformat()),
        ).fetchall()
        for br in brows:
            bd = datetime.fromisoformat(br[0]).date()
            bench_map[bd] = br[1]

    # Helper in-memory date resolver
    def resolve_mem_prev(date_map: dict, target: date) -> tuple[Optional[date], Optional[float]]:
        for delta in range(0, SEARCH_WINDOW + 1):
            curr = target - timedelta(days=delta)
            if curr in date_map:
                return curr, date_map[curr]
        return None, None

    fund_returns  = []
    bench_returns = []

    first = nav_dates[0]

    for end_d in nav_dates:
        start_target = _subtract_period(end_d, months=months)
        start_d, nav_s = resolve_mem_prev(fund_map, start_target)
        _, nav_e        = resolve_mem_prev(fund_map, end_d)

        if nav_s is None or nav_e is None:
            continue

        if first and first > start_d:
            continue

        actual_days = (end_d - start_d).days
        if actual_days <= 0:
            continue

        if months <= 12:
            fr = (nav_e / nav_s) - 1
        else:
            fr = (nav_e / nav_s) ** (365 / actual_days) - 1
        fund_returns.append(fr)

        # Benchmark return for same window
        if benchmark_index_id:
            _, close_s = resolve_mem_prev(bench_map, start_target)
            _, close_e = resolve_mem_prev(bench_map, end_d)
            if close_s and close_e:
                if months <= 12:
                    br = (close_e / close_s) - 1
                else:
                    br = (close_e / close_s) ** (365 / actual_days) - 1
                bench_returns.append(br)
            else:
                bench_returns.append(None)
        else:
            bench_returns.append(None)

    if not fund_returns:
        return {"avg": None, "min": None, "max": None, "pct_positive": None, "pct_beats_benchmark": None}

    n = len(fund_returns)
    pairs = [(f, b) for f, b in zip(fund_returns, bench_returns) if b is not None]

    return {
        "avg":               round(sum(fund_returns) / n, 6),
        "min":               round(min(fund_returns), 6),
        "max":               round(max(fund_returns), 6),
        "pct_positive":      round(sum(1 for f in fund_returns if f > 0) / n, 4),
        "pct_beats_benchmark": (
            round(sum(1 for f, b in pairs if f > b) / len(pairs), 4)
            if pairs else None
        ),
    }


# ── Drawdown series (for underwater chart, E12 R5) ────────────────────────────

def drawdown_series(
    conn: sqlite3.Connection,
    scheme_code: str,
    window: str = "full",    # '3Y'|'5Y'|'full'
    as_of: Optional[date] = None,
) -> list[dict]:
    """
    Build the daily underwater (drawdown) curve for the fund.
    Returns list of {date, drawdown_pct, is_trough, is_recovery}.
    """
    today = as_of or date.today()

    if window == "3Y":
        start = _subtract_period(today, years=3)
    elif window == "5Y":
        start = _subtract_period(today, years=5)
    else:
        start = date(2010, 1, 1)

    rows = conn.execute(
        "SELECT nav_date, nav FROM nav_history WHERE scheme_code=? AND nav_date>=? AND nav_date<=? ORDER BY nav_date",
        (scheme_code, start.isoformat(), today.isoformat()),
    ).fetchall()

    if not rows:
        return []

    running_peak   = rows[0][1]
    min_drawdown   = 0.0
    trough_date    = None
    result         = []

    for d_str, nav in rows:
        if nav > running_peak:
            running_peak = nav
        dd = nav / running_peak - 1
        if dd < min_drawdown:
            min_drawdown = dd
            trough_date  = d_str
        result.append({"date": d_str, "drawdown_pct": round(dd * 100, 4)})

    # Mark trough
    for r in result:
        r["is_trough"]   = (r["date"] == trough_date)
        r["is_recovery"] = False

    # Mark recovery (first date after trough where drawdown == 0)
    if trough_date:
        found_trough = False
        for r in result:
            if r["date"] == trough_date:
                found_trough = True
            if found_trough and r["drawdown_pct"] >= 0:
                r["is_recovery"] = True
                break

    return result
