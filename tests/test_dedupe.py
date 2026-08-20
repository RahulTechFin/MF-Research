"""
Locks the catalogue pruning rules.

These rules DELETE funds, so every case below is a real fund pair found in the
live data on 20 Aug 2026. The danger is not a rule that removes too little — it
is one that removes a fund a reader was relying on, or that collapses two
genuinely different funds into one because their names look alike.

THE RULES
  duplicate        two codes for one fund; the retired one goes and the priced
                   one stays.
  live-duplicate   BOTH codes are still priced and share AMC, category and
                   stripped name. One fund, two registrations. History cannot
                   break the tie (it is identical), so the name that states the
                   Regular plan wins.
  untracked        AMFI has not priced the fund recently — applied by --drop-untracked.

WHAT MUST NEVER HAPPEN
  - an ETF collapsing into its own Fund-of-Fund
  - "DSP Savings Fund" (Money Market) collapsing into "DSP Regular Savings
    Fund" (Conservative Hybrid)
  - every member of a group being dropped

Run:  python -m pytest tests/test_dedupe.py -q
"""

from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from scripts.dedupe_catalogue import LIVE_WINDOW_DAYS, base_name, plan_duplicates  # noqa: E402

TODAY = "2026-08-19"
OLD = "2016-10-21"          # far outside LIVE_WINDOW_DAYS


def scheme(code, name, amc, category=None):
    return {"scheme_code": code, "scheme_name": name, "amc_name": amc,
            "category_name": category, "is_active": 1}


def run(schemes, priced):
    """priced: {code: date}. Returns (dropped_codes, kept_codes)."""
    cat = {"schemes": schemes}
    drop, _review = plan_duplicates(cat, {c: (d, 10.0) for c, d in priced.items()})
    dropped = {str(d["scheme_code"]) for d in drop}
    return dropped, {str(s["scheme_code"]) for s in schemes} - dropped


# ── base_name: what counts as the same fund ─────────────────────────────────

def test_plan_wording_is_stripped():
    assert base_name("HSBC Liquid Fund - Regular Growth") == base_name(
        "HSBC Liquid Fund - Growth")


def test_an_etf_is_not_its_own_fund_of_fund():
    """
    Nineteen groups in the live data are an ETF beside its FoF. They are separate
    products in separate categories and must never be merged.
    """
    assert base_name("HDFC Gold ETF - Growth Option") != base_name(
        "HDFC Gold ETF Fund of Fund - Growth Option")


# ── the retired-code rule ───────────────────────────────────────────────────

def test_a_retired_code_is_dropped_for_the_priced_one():
    dropped, kept = run(
        [scheme("151084", "HSBC Dynamic Bond Fund - Regular Growth", "HSBC", "Dynamic Bond"),
         scheme("106736", "HSBC Dynamic Bond Fund - Growth", "HSBC", "Dynamic Bond")],
        {"151084": TODAY},
    )
    assert dropped == {"106736"} and kept == {"151084"}


def test_being_listed_is_not_being_alive():
    """
    AMFI keeps publishing wound-up schemes at the price they died at.
    "HDFC Liquid Fund-PREMIUM PLUS" carries 17-Dec-2012 and must not count as
    live just because it appears in the file.
    """
    dropped, kept = run(
        [scheme("100868", "HDFC Liquid Fund - Growth Plan", "HDFC", "Liquid Fund"),
         scheme("100872", "HDFC Liquid Fund-PREMIUM PLUS- Growth", "HDFC", "Liquid Fund")],
        {"100868": TODAY, "100872": OLD},
    )
    assert dropped == {"100872"}


# ── the live-duplicate rule ─────────────────────────────────────────────────

def test_two_live_codes_for_one_fund_keep_the_regular_named_one():
    """
    Invesco India Liquid Fund is 104486 "- Growth" and 104488 "- Regular -
    Growth", both priced today with identical history.
    """
    dropped, kept = run(
        [scheme("104486", "Invesco India Liquid Fund - Growth", "Invesco", "Liquid Fund"),
         scheme("104488", "Invesco India Liquid Fund - Regular - Growth", "Invesco", "Liquid Fund")],
        {"104486": TODAY, "104488": TODAY},
    )
    assert dropped == {"104486"}, "the bare '- Growth' code should go"
    assert kept == {"104488"}


def test_a_different_category_means_a_different_fund():
    """
    The guard that stops the name heuristic doing damage: "DSP Savings Fund" is a
    Money Market fund and "DSP Regular Savings Fund" is a Conservative Hybrid.
    Stripping "Regular" makes them look identical; the category says otherwise.
    """
    dropped, kept = run(
        [scheme("100087", "DSP Savings Fund - Regular Plan - Growth", "DSP", "Money Market"),
         scheme("102448", "DSP Regular Savings Fund- Regular Plan - Growth", "DSP", "Conservative Hybrid")],
        {"100087": TODAY, "102448": TODAY},
    )
    assert dropped == set(), "two different funds must both survive"
    assert kept == {"100087", "102448"}


def test_a_group_never_loses_every_member():
    for priced in ({"A": TODAY, "B": TODAY}, {"A": OLD, "B": OLD}, {"A": TODAY, "B": OLD}):
        dropped, kept = run(
            [scheme("A", "Some Fund - Regular - Growth", "AMC", "Liquid Fund"),
             scheme("B", "Some Fund - Growth", "AMC", "Liquid Fund")],
            priced,
        )
        assert kept, f"everything was dropped for {priced}"


def test_a_lone_fund_is_never_touched():
    dropped, _ = run(
        [scheme("100001", "Only Fund - Regular Plan - Growth", "AMC", "Large Cap")],
        {"100001": TODAY},
    )
    assert dropped == set()


def test_every_drop_is_tagged_and_explained():
    """The audit trail is the only record of a deletion, so it must be complete."""
    cat = {"schemes": [
        scheme("104486", "Invesco India Liquid Fund - Growth", "Invesco", "Liquid Fund"),
        scheme("104488", "Invesco India Liquid Fund - Regular - Growth", "Invesco", "Liquid Fund"),
    ]}
    drop, _ = plan_duplicates(cat, {"104486": (TODAY, 10.0), "104488": (TODAY, 10.0)})
    assert drop
    for d in drop:
        assert d["_rule"] == "live-duplicate"
        assert d["_reason"]
        assert d["_kept_instead"] == ["104488"]


def test_live_window_is_a_sane_length():
    assert 7 <= LIVE_WINDOW_DAYS <= 60


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
