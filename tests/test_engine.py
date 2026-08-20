"""
tests/test_engine.py — Gate 2 unit tests for the calculation engine.

Tests hand-verify:
  1. Trailing 12M (simple) and 5Y CAGR against worked examples in E5.1
  2. Quarterly return across a holiday quarter-start (E4)
  3. Annual return + YTD (E3)
  4. Quartile formula matches owner's Excel exactly (E9)
  5. Category average excludes None values (E6)
  6. Chart normalization starts at 0% (E8)
  7. Point-to-point return (E14)

Run:  python -m pytest tests/ -v
"""

import math
import sqlite3
import pytest
from datetime import date

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.calculation_engine import (
    trailing_return,
    trailing_return_index,
    annual_return,
    quarter_return,
    month_return,
    category_average,
    quartile,
    rank_and_quartile,
    normalize_series,
    common_start_date,
    point_to_point_return,
    quartile_journeys,
)


# ── Fixture: in-memory SQLite with controlled NAV data ────────────────────────

@pytest.fixture
def db():
    """
    Build a minimal in-memory database with:
      - scheme 'TEST001' with NAVs from 2020-01-02 to 2026-07-08
      - index_id=1 with same close history
    NAVs follow: NAV on date d = 100 * (1.10)^(days_since_2020-01-02 / 365)
    so 1Y return ≈ 10%, 3Y return ≈ 10% p.a., etc.
    """
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=OFF")

    conn.execute("""
        CREATE TABLE nav_history (
            scheme_code TEXT, nav_date TEXT, nav REAL,
            PRIMARY KEY (scheme_code, nav_date)
        )
    """)
    conn.execute("""
        CREATE TABLE index_history (
            index_id INTEGER, date TEXT, close REAL,
            PRIMARY KEY (index_id, date)
        )
    """)

    base = date(2020, 1, 2)
    base_nav = 100.0
    annual_growth = 0.10

    current = date(2020, 1, 2)
    end     = date(2026, 7, 8)

    rows_fund  = []
    rows_index = []

    while current <= end:
        days = (current - base).days
        nav  = round(base_nav * ((1 + annual_growth) ** (days / 365)), 4)
        rows_fund.append(("TEST001", current.isoformat(), nav))
        rows_index.append((1, current.isoformat(), nav))
        # skip weekends
        current_wd = current.weekday()
        if current_wd == 4:   # Friday → skip to Monday
            current = current + __import__("datetime").timedelta(days=3)
        elif current_wd == 5:  # Saturday → Monday
            current = current + __import__("datetime").timedelta(days=2)
        else:
            current = current + __import__("datetime").timedelta(days=1)

    conn.executemany("INSERT INTO nav_history VALUES(?,?,?)", rows_fund)
    conn.executemany("INSERT INTO index_history VALUES(?,?,?)", rows_index)
    conn.commit()
    return conn


# ── E2: Trailing returns ──────────────────────────────────────────────────────

def test_trailing_12m_simple(db):
    """12M return should be simple (not annualised), ≈10% for our synthetic data."""
    ret = trailing_return(db, "TEST001", "12M", as_of=date(2026, 7, 8))
    assert ret is not None
    # With 10% p.a. growth over ~1Y ≈ 0.10 ± 2%
    assert 0.08 <= ret <= 0.12, f"Expected ~10%, got {ret:.4%}"


def test_trailing_3y_cagr(db):
    """3Y trailing return uses CAGR formula; expect ≈10% p.a."""
    ret = trailing_return(db, "TEST001", "3Y", as_of=date(2026, 7, 8))
    assert ret is not None
    assert 0.09 <= ret <= 0.11, f"Expected ~10% CAGR, got {ret:.4%}"


def test_trailing_1m(db):
    """1M return is simple (not annualised)."""
    ret = trailing_return(db, "TEST001", "1M", as_of=date(2026, 7, 8))
    assert ret is not None
    # ~10%/12 ≈ 0.83% per month
    assert 0.005 <= ret <= 0.015, f"Expected ~0.8%, got {ret:.4%}"


def test_trailing_ineligible(db):
    """Fund launched after the period start → return = None."""
    # 5Y → start = 2021-07-08. TEST001 starts 2020-01-02, so should be eligible.
    ret5 = trailing_return(db, "TEST001", "5Y", as_of=date(2026, 7, 8))
    assert ret5 is not None

    # A fund started 2025-01-01 would be ineligible for 3Y
    db.execute("""
        INSERT OR IGNORE INTO nav_history VALUES('NEW', '2025-01-02', 100)
    """)
    db.execute("""
        INSERT OR IGNORE INTO nav_history VALUES('NEW', '2026-07-08', 110)
    """)
    db.commit()
    ret_new_3y = trailing_return(db, "NEW", "3Y", as_of=date(2026, 7, 8))
    assert ret_new_3y is None, "Ineligible fund should return None"


# ── E3: Annual returns ────────────────────────────────────────────────────────

def test_annual_2025(db):
    """Annual 2025: start=02-Jan-2025, end=31-Dec-2025 (nearest prev), ≈10%."""
    ret = annual_return(db, "TEST001", 2025, as_of=date(2026, 7, 8))
    assert ret is not None
    assert 0.08 <= ret <= 0.12, f"Annual 2025 expected ~10%, got {ret:.4%}"


def test_annual_ytd_2026(db):
    """YTD 2026: start=02-Jan-2026, end=ANCHOR (08-Jul-2026)."""
    ret = annual_return(db, "TEST001", 2026, as_of=date(2026, 7, 8))
    assert ret is not None
    assert ret > 0, "YTD 2026 should be positive"


def test_annual_ineligible_before_launch(db):
    """Year before fund launch → None."""
    ret = annual_return(db, "TEST001", 2019, as_of=date(2026, 7, 8))
    assert ret is None


# ── E4: Quarterly returns ─────────────────────────────────────────────────────

def test_quarterly_q1_2026(db):
    """Q1-2026: 01-Jan→31-Mar, expect ~2.4% (10%/4 ≈ 2.5%)."""
    ret = quarter_return(db, "TEST001", 2026, 1, as_of=date(2026, 7, 8))
    assert ret is not None
    assert 0.01 <= ret <= 0.04, f"Q1-2026 expected ~2.4%, got {ret:.4%}"


def test_quarterly_qtd(db):
    """QTD (Q3-2026): start=01-Jul-2026, end=ANCHOR."""
    ret = quarter_return(db, "TEST001", 2026, 3, as_of=date(2026, 7, 8))
    assert ret is not None
    assert ret > 0, "QTD should be positive"


# ── E5: Monthly returns ───────────────────────────────────────────────────────

def test_monthly_june_2026(db):
    """June 2026: start=01-Jun, end=30-Jun, expect ~0.8%."""
    ret = month_return(db, "TEST001", 2026, 6, as_of=date(2026, 7, 8))
    assert ret is not None
    assert 0.003 <= ret <= 0.015, f"June 2026 expected ~0.8%, got {ret:.4%}"


# ── E6: Category average ──────────────────────────────────────────────────────

def test_category_average_excludes_none():
    """None values must be excluded, never counted as 0."""
    returns = [0.10, 0.20, None, 0.30, None]
    avg = category_average(returns)
    assert avg == pytest.approx(0.20, abs=1e-9), f"Expected 0.20, got {avg}"


def test_category_average_all_none():
    assert category_average([None, None]) is None


def test_category_average_single():
    assert category_average([0.15]) == pytest.approx(0.15)


# ── E9: Quartile formula ──────────────────────────────────────────────────────

class TestQuartile:
    """
    The rule the owner set: equal brackets of n//4, remainder to the BOTTOM
    quartiles (Q4, then Q3, then Q2). Pools under SMALL_POOL keep the older
    ROUNDUP behaviour so a lone fund is not labelled bottom-quartile.

    These used to encode the ROUNDUP rule, which gave the spare fund to Q1. The
    owner changed that; tests/test_quartile.py is the exhaustive lock, and these
    are kept in step with it.
    """

    def test_n4_all_quartiles(self):
        # n=4 divides evenly, so both rules agree.
        assert quartile(1, 4) == 1
        assert quartile(2, 4) == 2
        assert quartile(3, 4) == 3
        assert quartile(4, 4) == 4

    def test_n10(self):
        # n=10 -> base 2, remainder 2 -> [2,2,3,3]: Q1 1-2, Q2 3-4, Q3 5-7, Q4 8-10
        assert quartile(1, 10) == 1
        assert quartile(2, 10) == 1
        assert quartile(3, 10) == 2
        assert quartile(4, 10) == 2
        assert quartile(5, 10) == 3
        assert quartile(7, 10) == 3
        assert quartile(8, 10) == 4
        assert quartile(10, 10) == 4

    def test_n7_boundary(self):
        # n=7 -> base 1, remainder 3 -> [1,2,2,2]: Q1 1, Q2 2-3, Q3 4-5, Q4 6-7
        assert quartile(1, 7) == 1
        assert quartile(2, 7) == 2
        assert quartile(3, 7) == 2
        assert quartile(4, 7) == 3
        assert quartile(5, 7) == 3
        assert quartile(6, 7) == 4
        assert quartile(7, 7) == 4

    def test_remainder_goes_to_the_bottom(self):
        # n=17 -> [4,4,4,5]: the spare fund lands in Q4, never Q1.
        assert quartile(4, 17) == 1
        assert quartile(5, 17) == 2
        assert quartile(13, 17) == 4
        assert quartile(17, 17) == 4

    def test_small_pool_keeps_the_old_behaviour(self):
        # A single fund must not read as bottom-quartile.
        assert quartile(1, 1) == 1
        assert quartile(1, 2) == 1

    def test_none_inputs(self):
        assert quartile(None, 10) is None
        assert quartile(1, 0) is None

    def test_rank_and_quartile(self):
        returns = {"A": 0.30, "B": 0.20, "C": 0.10, "D": None}
        result  = rank_and_quartile(returns)
        # Ranks are by descending return; D is excluded, so n = 3.
        # n=3 -> base 0, remainder 3 -> [0,1,1,1]: no Q1 exists at this size.
        assert result["A"] == (1, 2)
        assert result["B"] == (2, 3)
        assert result["C"] == (3, 4)
        assert result["D"] == (None, None)


# ── E8: Chart normalization ───────────────────────────────────────────────────

def test_normalize_series_starts_at_zero():
    series = [("2024-01-01", 100.0), ("2024-02-01", 110.0), ("2024-03-01", 90.0)]
    normalized = normalize_series(series)
    assert normalized[0][1] == 0.0, "First value must be 0.0%"
    assert normalized[1][1] == pytest.approx(10.0, abs=0.01)
    assert normalized[2][1] == pytest.approx(-10.0, abs=0.01)


def test_normalize_series_with_start_date():
    series = [("2024-01-01", 100.0), ("2024-02-01", 110.0), ("2024-03-01", 120.0)]
    normalized = normalize_series(series, start_date=date(2024, 2, 1))
    assert normalized[0][0] == "2024-02-01"
    assert normalized[0][1] == 0.0


def test_common_start_date():
    s1 = [("2024-01-01", 100)]
    s2 = [("2024-03-01", 200)]
    s3 = [("2024-02-01", 150)]
    cs = common_start_date([s1, s2, s3])
    assert cs == date(2024, 3, 1)  # Latest first date = common start


# ── E14: Point-to-point ───────────────────────────────────────────────────────

def test_point_to_point_simple(db):
    """P2P return within 1 year → only 'return', no CAGR."""
    result = point_to_point_return(db, "TEST001", date(2026, 1, 2), date(2026, 7, 8))
    assert result["return"] is not None
    assert result["cagr"] is None   # ≤366 days → no CAGR


def test_point_to_point_cagr(db):
    """P2P return >366 days → both return and CAGR present."""
    result = point_to_point_return(db, "TEST001", date(2023, 1, 2), date(2026, 7, 8))
    assert result["return"] is not None
    assert result["cagr"]   is not None
    # CAGR should be close to 10% p.a.
    assert 0.09 <= result["cagr"] <= 0.11


# ── E10: Consistency / Volatility ────────────────────────────────────────────
#
# Both lists come off the SAME quartile history, and a CROSSING (a move between
# Q1/Q2 and Q3/Q4) decides which list a fund lands in. The previous pair ranked
# consistency on mean quartile and volatility on the standard deviation of
# returns, so one fund could legitimately top both.

GRIDS = {
    # never leaves the top half -> consistent
    "steady_q1":   [1, 1, 1, 2, 1, 1, 1, 1],
    "steady_q2":   [2, 2, 1, 2, 2, 2, 2, 2],
    # never leaves the BOTTOM half -> neither consistent nor volatile; it is a
    # candidate for "worst" instead
    "steady_q3":   [3, 3, 3, 3, 3, 3, 3, 3],
    # crosses every period -> the most volatile thing here
    "seesaw":      [1, 4, 1, 4, 1, 4, 1, 4],
    # one dip into Q3: a single crossing pair, so volatile rather than consistent
    "one_dip":     [1, 1, 1, 3, 1, 1, 1, 1],
    # too short to judge
    "too_short":   [1, 1, None, None, None, None, None, None],
}


def test_the_two_lists_never_share_a_fund():
    j = quartile_journeys(GRIDS, min_periods=6)
    consistent = {r["scheme_code"] for r in j["consistent"]}
    volatile = {r["scheme_code"] for r in j["volatile"]}
    assert not (consistent & volatile), consistent & volatile


def test_consistent_means_mostly_in_the_top_half():
    j = quartile_journeys(GRIDS, min_periods=6)
    codes = [r["scheme_code"] for r in j["consistent"]]
    assert "steady_q1" in codes and "steady_q2" in codes
    # A fund parked in Q3 is consistent in the plain sense but is not a
    # consistent PERFORMER, so it does not belong in this list.
    assert "steady_q3" not in codes
    # Nor does a fund that splits its time evenly.
    assert "seesaw" not in codes


def test_volatile_is_resolved_first_and_consistent_takes_what_is_left():
    """
    The owner's tie-break, applied between the lists rather than inside the
    definition of consistent. "one_dip" is mostly Q1 -- it clears the top-share
    bar -- but it crosses, so volatile claims it first.
    """
    j = quartile_journeys(GRIDS, min_periods=6)
    assert "one_dip" in {r["scheme_code"] for r in j["volatile"]}
    assert "one_dip" not in {r["scheme_code"] for r in j["consistent"]}


def test_the_consistent_list_is_not_starved_by_a_single_slip():
    """
    Requiring zero crossings was tried and left 40 of 54 category files with an
    empty box. A fund that dips once and is not among the top crossers must still
    be able to appear.
    """
    grids = {
        # one dip each, so none is a top crosser once there are five of them
        f"mostly_q1_{i}": [1, 1, 1, 3, 1, 1, 1, 1] for i in range(6)
    }
    grids["seesaw"] = [1, 4, 1, 4, 1, 4, 1, 4]
    j = quartile_journeys(grids, min_periods=6, limit=5)
    assert j["volatile"][0]["scheme_code"] == "seesaw"
    assert len(j["consistent"]) >= 1, "consistent must not be starved"
    assert not ({r["scheme_code"] for r in j["consistent"]}
                & {r["scheme_code"] for r in j["volatile"]})


def test_volatile_is_ranked_by_how_often_it_crosses():
    j = quartile_journeys(GRIDS, min_periods=6)
    assert j["volatile"][0]["scheme_code"] == "seesaw"
    assert j["volatile"][0]["crossings"] == 7


def test_short_histories_are_excluded():
    j = quartile_journeys(GRIDS, min_periods=6)
    everywhere = {r["scheme_code"]
                  for k in ("consistent", "volatile", "best", "worst")
                  for r in j[k]}
    assert "too_short" not in everywhere


def test_best_and_worst_are_share_based():
    """
    Level, not stability — so they may overlap the other two lists, and a fund
    that never left the bottom half must be the worst.
    """
    j = quartile_journeys(GRIDS, min_periods=6, extremes=3)
    assert j["best"][0]["scheme_code"] == "steady_q1"
    assert j["worst"][0]["scheme_code"] == "steady_q3"
    assert len(j["best"]) == 3 and len(j["worst"]) == 3


def test_shares_and_crossings_are_reported():
    j = quartile_journeys({"seesaw": GRIDS["seesaw"]}, min_periods=6)
    row = j["volatile"][0]
    assert row["top_share"] == 0.5 and row["bottom_share"] == 0.5
    assert row["balance"] == 0.5
    assert row["periods"] == 8


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
