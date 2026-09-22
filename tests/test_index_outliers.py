"""
A quoted level that jumps by orders of magnitude and comes straight back is a
source glitch. One that stays is a market.

WHY THIS FILE EXISTS
GOLD (GOLDBEES) sits around Rs 33 in December 2019 — except on the 19th and
20th, quoted at 0.3355 and 0.3365, the same price with the decimal shifted two
places. By the 23rd it is 33.65 again.

Two bad days in 4,119 is not a rounding matter. A NIFTY 50 / gilt / gold blend
rebalanced daily reads 447% annualised volatility off that series against a true
figure near 10%, because rebalancing re-buys at the corrupted price and books a
99% loss followed by a 9,900% gain. Multi Asset Blend, which is computed FROM
gold, jumped 990% on the same day. Every risk number downstream was wrong.

The hard half is what must NOT be touched. INDIA VIX really does rise 64% in a
day (24 Aug 2015), 42% (5 Aug 2024) and 66% (7 Apr 2025). Filtering on the size
of a move would delete all three. So the test is whether the level RETURNS, and
these tests pin both directions of that.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.index_store import drop_isolated_outliers


def series(*pairs):
    return dict(pairs)


# ── the glitch that started it ──────────────────────────────────────────────

GOLDBEES = series(
    ("2019-12-17", 33.503),
    ("2019-12-18", 33.596),
    ("2019-12-19", 0.3355),     # decimal shifted
    ("2019-12-20", 0.3365),     # still shifted
    ("2019-12-23", 33.65),      # and back
    ("2019-12-24", 33.75),
    ("2019-12-26", 34.00),
)


def test_the_goldbees_decimal_shift_is_dropped():
    clean, notes = drop_isolated_outliers(GOLDBEES, "GOLD")
    assert "2019-12-19" not in clean
    assert "2019-12-20" not in clean
    assert len(clean) == len(GOLDBEES) - 2
    assert any("round trip" in n for n in notes)


def test_the_surrounding_days_survive_untouched():
    clean, _ = drop_isolated_outliers(GOLDBEES, "GOLD")
    for d in ("2019-12-17", "2019-12-18", "2019-12-23", "2019-12-24", "2019-12-26"):
        assert clean[d] == GOLDBEES[d]


def test_no_move_over_the_threshold_remains():
    clean, _ = drop_isolated_outliers(GOLDBEES, "GOLD")
    dates = sorted(clean)
    for a, b in zip(dates, dates[1:]):
        assert 1 / 3 < clean[b] / clean[a] < 3


# ── what must survive ───────────────────────────────────────────────────────

def test_a_genuine_vix_spike_is_kept():
    """
    +64% is enormous and entirely real. Nothing here may remove it — which is
    why the filter tests for a round trip and not for the size of the move.
    """
    vix = series(
        ("2015-08-20", 15.10),
        ("2015-08-21", 17.115),
        ("2015-08-24", 28.13),      # the real spike
        ("2015-08-25", 26.40),
        ("2015-08-26", 24.10),
    )
    clean, notes = drop_isolated_outliers(vix, "INDIA VIX")
    assert clean == vix
    assert notes == []


def test_a_crash_that_does_not_recover_is_kept_and_reported():
    """
    A one-way move of this size is either real or a re-denomination, and the two
    cannot be told apart from the series alone. It is left in place and flagged
    for a human rather than rewritten on a guess.
    """
    s = series(
        ("2020-01-01", 100.0),
        ("2020-01-02", 101.0),
        ("2020-01-03", 10.0),       # ten-fold down, and it stays down
        ("2020-01-06", 10.2),
        ("2020-01-07", 10.1),
    )
    clean, notes = drop_isolated_outliers(s, "X")
    assert clean == s
    assert any("did NOT come back" in n for n in notes)


def test_an_ordinary_crash_is_untouched():
    """March 2020 was -13% in a day on NIFTY 50, nowhere near the threshold."""
    s = series(
        ("2020-03-20", 8745.45),
        ("2020-03-23", 7610.25),    # -13.0%
        ("2020-03-24", 7801.05),
        ("2020-03-25", 8317.85),
    )
    clean, notes = drop_isolated_outliers(s, "NIFTY 50")
    assert clean == s
    assert notes == []


# ── shape of the thing ──────────────────────────────────────────────────────

def test_a_single_bad_day_is_dropped():
    s = series(
        ("2021-01-01", 50.0),
        ("2021-01-04", 0.51),
        ("2021-01-05", 50.4),
    )
    clean, _ = drop_isolated_outliers(s, "X")
    assert sorted(clean) == ["2021-01-01", "2021-01-05"]


def test_a_run_longer_than_the_limit_is_left_alone():
    """
    Six bad days stops looking like a glitch. Better to report a long run than
    to delete a week of history on a rule that was written for two days.
    """
    s = {"2021-01-01": 50.0}
    for i in range(6):
        s[f"2021-01-{4 + i:02d}"] = 0.5
    s["2021-01-11"] = 50.4
    clean, notes = drop_isolated_outliers(s, "X")
    assert clean == s
    assert notes


def test_a_clean_series_is_returned_unchanged():
    s = series(*[(f"2022-01-{d:02d}", 100 + d) for d in range(1, 20)])
    clean, notes = drop_isolated_outliers(s, "X")
    assert clean == s
    assert notes == []


def test_too_short_to_judge():
    assert drop_isolated_outliers({}, "X") == ({}, [])
    one = {"2020-01-01": 10.0}
    assert drop_isolated_outliers(one, "X") == (one, [])


def test_a_zero_close_is_treated_as_a_break():
    """A zero is never a price, and dividing by it is how 447% volatility happens."""
    s = series(
        ("2020-01-01", 100.0),
        ("2020-01-02", 0.0),
        ("2020-01-03", 100.5),
    )
    clean, notes = drop_isolated_outliers(s, "X")
    assert "2020-01-02" not in clean
    assert notes
