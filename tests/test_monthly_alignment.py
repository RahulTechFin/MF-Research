"""
A fund's month must be measured against the benchmark's SAME month.

WHY THIS FILE EXISTS
risk_metrics paired the two return series by list position: take the last n of
each and zip. That is right only while both cover the same months, and nothing
made them. NIFTY LARGEMIDCAP 250 is missing July and August 2026 outright, so
its list ran two short and every Large & Mid Cap fund had its September return
measured against the benchmark's June.

Nothing errored. The category simply published beta 0.11 for equity funds,
upside capture 36% and downside capture 2% — numbers that are arithmetically
fine and completely meaningless. Every other category read 0.78 to 1.14,
which is what made it visible at all.

These tests pin the two halves of the fix: months are labelled, and a span
across a gap is not a monthly return.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.calculation_engine import (
    _monthly_returns_by_month, _monthly_returns_from_navs,
)


def month_ends(*pairs):
    return list(pairs)


# ── labelling ───────────────────────────────────────────────────────────────

def test_each_return_is_labelled_with_its_own_month():
    s = month_ends(("2026-01-31", 100.0), ("2026-02-28", 110.0), ("2026-03-31", 121.0))
    out = _monthly_returns_by_month(s)
    assert [m for m, _ in out] == ["2026-02", "2026-03"]
    assert abs(out[0][1] - 0.10) < 1e-12
    assert abs(out[1][1] - 0.10) < 1e-12


def test_the_unlabelled_helper_still_agrees():
    """The old signature is kept; it must return exactly the same numbers."""
    s = month_ends(("2026-01-31", 100.0), ("2026-02-28", 110.0), ("2026-03-31", 99.0))
    assert _monthly_returns_from_navs(s) == [r for _, r in _monthly_returns_by_month(s)]


# ── the gap ─────────────────────────────────────────────────────────────────

def test_a_span_across_missing_months_is_not_a_monthly_return():
    """
    June to September is a quarter's move. Booking it as September's return
    would hand the category one huge outlier month and inflate its volatility.
    """
    s = month_ends(
        ("2026-05-29", 100.0),
        ("2026-06-30", 102.0),
        ("2026-09-30", 130.0),   # July and August absent
        ("2026-10-30", 133.0),
    )
    out = _monthly_returns_by_month(s)
    assert [m for m, _ in out] == ["2026-06", "2026-10"]
    assert all(abs(r) < 0.10 for _, r in out), "the quarter's move leaked in"


def test_a_year_boundary_is_still_one_month():
    s = month_ends(("2025-12-31", 100.0), ("2026-01-30", 105.0))
    assert [m for m, _ in _monthly_returns_by_month(s)] == ["2026-01"]


def test_a_repeated_month_is_not_a_return():
    """Two observations in one month is a zero-month span, not a monthly move."""
    s = month_ends(("2026-03-30", 100.0), ("2026-03-31", 101.0), ("2026-04-30", 105.0))
    assert [m for m, _ in _monthly_returns_by_month(s)] == ["2026-04"]


# ── the pairing this protects ───────────────────────────────────────────────

def test_a_short_benchmark_pairs_on_months_not_positions():
    """
    The Large & Mid Cap shape: the fund has every month, the benchmark is
    missing two in the middle. Pairing by position would slide the fund's later
    months against the benchmark's earlier ones; pairing by month drops the
    unmatched ones and leaves the rest correctly opposite each other.
    """
    fund = month_ends(*[(f"2026-{m:02d}-28", 100.0 * (1.01 ** m)) for m in range(1, 11)])
    bench = month_ends(*[(f"2026-{m:02d}-28", 100.0 * (1.01 ** m))
                         for m in range(1, 11) if m not in (7, 8)])

    f = dict(_monthly_returns_by_month(fund))
    b = dict(_monthly_returns_by_month(bench))
    common = sorted(set(f) & set(b))

    # July and August cannot pair; September is dropped from the benchmark too,
    # because its span crosses the hole.
    assert "2026-07" not in common
    assert "2026-08" not in common
    assert "2026-09" not in common
    # Everything that does pair is the same month on both sides, and identical
    # here because the two series were built from the same growth rate.
    for m in common:
        assert abs(f[m] - b[m]) < 1e-12, f"{m} paired with the wrong month"


def test_no_overlap_yields_nothing_to_pair():
    a = month_ends(("2024-01-31", 100.0), ("2024-02-29", 101.0))
    b = month_ends(("2026-01-31", 100.0), ("2026-02-28", 101.0))
    common = set(dict(_monthly_returns_by_month(a))) & set(dict(_monthly_returns_by_month(b)))
    assert common == set()


def test_too_short_to_measure():
    assert _monthly_returns_by_month([]) == []
    assert _monthly_returns_by_month([("2026-01-31", 100.0)]) == []


def test_a_nonpositive_nav_is_skipped():
    s = month_ends(("2026-01-31", 0.0), ("2026-02-28", 100.0), ("2026-03-31", 105.0))
    assert [m for m, _ in _monthly_returns_by_month(s)] == ["2026-03"]
