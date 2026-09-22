"""
Only the Regular plan's Growth option may enter the universe.

WHY THIS FILE EXISTS
"Nippon India Growth Mid Cap Fund" has the word Growth in its TITLE. AMFI
publishes four rows under that identical name, distinguished only by the Option
column — Growth Option, IDCW Option, Bonus Option, and INSTITUTIONAL Plan IDCW
Option. is_regular_growth accepted any row whose name contained "growth", and
consulted the Option column only when the name was silent, so all four were
admitted.

The cost was not cosmetic. One fund appeared four times in Mid Cap, so it
counted four times in the equal-weighted category average and was ranked four
times in the quartiles, with 12-month returns of 0.8%, 8.9%, 8.9% and 3.0%
pulling the average apart. Every fund in the category had its quartile computed
against a peer group containing three phantoms.

These tests pin both directions: the columns must be able to exclude, and the
name must still win when it contradicts a column claiming Growth.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.amfi_catalogue import is_regular_growth


# ── the case that was wrong ─────────────────────────────────────────────────
#
# Real rows from NAVAll.txt. The name is byte-identical across all four; only
# the Option column differs.
NIPPON = "Nippon India Growth Mid Cap Fund"


def test_the_growth_option_is_kept():
    assert is_regular_growth(NIPPON, "Regular Plan", "Growth Option")


@pytest.mark.parametrize("option", [
    "IDCW Option",
    "Bonus Option",
    "INSTITUTIONAL Plan - IDCW Option",
])
def test_the_other_share_classes_of_the_same_fund_are_refused(option):
    """
    All three carry "growth" in the fund's title and nothing disqualifying in
    the name. Only the Option column can tell them apart.
    """
    assert not is_regular_growth(NIPPON, "Regular Plan", option)


def test_exactly_one_of_the_four_survives():
    """The whole point: one fund contributes one row to its category."""
    rows = [
        ("100377", "Growth Option"),
        ("100375", "IDCW Option"),
        ("100376", "Bonus Option"),
        ("106260", "INSTITUTIONAL Plan - IDCW Option"),
    ]
    kept = [c for c, o in rows if is_regular_growth(NIPPON, "Regular Plan", o)]
    assert kept == ["100377"]


# ── the column may now exclude ──────────────────────────────────────────────
#
# One real example of each family the fix removes. In every case the name says
# nothing disqualifying and the qualifier lives only in the Option column.

@pytest.mark.parametrize("name,option", [
    ("JM Liquid Fund",                    "Super Institutional Plan - Growth Option"),
    ("Franklin India Liquid Fund",        "Super Institutional Growth"),
    ("Nippon India Multi Cap Fund",       "Institutional Plan Growth Plan"),
    ("Nippon India Liquid Fund",          "Retail Plan - Growth Option"),
    ("UTI - Money Market Fund",           "Discontinued Growth"),
    ("UTI - Gilt Fund",                   "Discontinued PF Plan Growth"),
    ("Franklin India Liquid Fund",        "Unclaimed Redemption Plan - Growth"),
    ("Franklin India Liquid Fund",        "Unclaimed IDCW Investor Education Plan - Growth"),
    ("HSBC Aggressive Hybrid Active FOF", "IDCW"),
    ("Some Fund",                         "IDCW (Income Distribution CUM Capital Withdrawal)"),
])
def test_a_duplicate_share_class_named_only_in_the_column_is_refused(name, option):
    assert not is_regular_growth(name, "Regular Plan", option)


# ── what must not regress ───────────────────────────────────────────────────

def test_the_name_still_overrules_a_column_claiming_growth():
    """
    AMFI stamps Option="Growth" on rows plainly named "Bonus Option". The
    name-based rejection has to run FIRST or the fix would readmit them.
    """
    assert not is_regular_growth("X Fund - Bonus Option", "Regular Plan", "Growth")
    assert not is_regular_growth("X Fund - IDCW Plan", "Regular Plan", "Growth")


def test_the_column_still_names_the_option_when_the_fund_does_not():
    """The reason the columns were consulted in the first place."""
    assert is_regular_growth("Samco Mid Cap Fund", "Regular Plan", "Growth")
    assert is_regular_growth("BANK OF INDIA Credit Risk Fund", "Regular Plan", "Growth")


def test_growth_in_the_name_alone_is_still_enough():
    assert is_regular_growth("HDFC Mid Cap Fund - Growth", "Regular Plan", "")


def test_icici_calls_its_growth_option_cumulative():
    assert is_regular_growth("ICICI Prudential X Fund", "Regular Plan", "Cumulative")


def test_direct_is_refused_by_name_or_by_column():
    assert not is_regular_growth("X Fund - Direct - Growth", "", "Growth")
    assert not is_regular_growth("X Fund - Growth", "Direct Plan", "Growth")


def test_dividend_yield_is_a_category_not_an_option():
    """
    "Dividend" normally disqualifies, but Dividend Yield is a SEBI category and
    its Growth option must survive.
    """
    assert is_regular_growth("Templeton India Dividend Yield Fund",
                             "Regular Plan", "Growth")
    assert not is_regular_growth("Templeton India Dividend Yield Fund - Payout",
                                 "Regular Plan", "Growth")


def test_an_etf_row_passes_no_plan_and_is_judged_on_its_option():
    """
    ETF callers pass plan="" because AMFI marks several liquid ETFs "Direct
    Plan" while their names say nothing of the kind. With no option stated
    either, there is nothing to admit on.
    """
    assert not is_regular_growth("Nippon India ETF Nifty 50", "", "")
    assert is_regular_growth("Nippon India ETF Nifty 50", "", "Growth")
