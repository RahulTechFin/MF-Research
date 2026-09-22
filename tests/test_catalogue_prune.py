"""
A catalogue entry may only be removed when AMFI said what share class it is.

WHY THIS FILE EXISTS
Pruning duplicate share classes out of the catalogue is unusually dangerous,
because the merge that fills the catalogue is additive on purpose: AMFI's daily
file is a snapshot, so ~900 catalogued funds are absent from it on any given day
and must not be touched. Three attempts at the prune each deleted real funds:

  1. Removing anything parse_amfi_text did not return killed 31 funds — the
     parser also skips unmapped and closed-end sections, missing NAVs and bad
     dates, none of which is a statement about share class.
  2. Re-running is_regular_growth over the raw file rejected 377 — ETFs are
     exempt from that test and only the parser knows the section header.
  3. Letting the parser report its own share-class rejections killed 32, because
     AMFI leaves Plan and Option blank for many schemes and ships several such
     rows under one identical name. Nothing distinguishes them, so the parser
     rightly skips them all — but one of them is the fund.

These tests pin the rule that survived: silence is not a verdict.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts.amfi_catalogue import (is_legacy_plan_variant, parse_amfi_text,
                                    states_share_class)

HEADER = ("Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;"
          "NAV Name;Plan;Option;Net Asset Value;Date")
SECTION = "Open Ended Schemes(Equity Scheme - Mid Cap Fund)"


def _file(rows):
    out = [SECTION, HEADER]
    for code, name, plan, option in rows:
        out.append(f"{code};INF000000001;-;{name};{plan};{option};100.0000;09-Sep-2026")
    return "\n".join(out)


# ── silence is not a verdict ────────────────────────────────────────────────

def test_indistinguishable_silent_rows_are_skipped_but_not_condemned():
    """
    The real shape of "Motilal Oswal Midcap Fund" in AMFI's file today: four
    rows, one name, no Plan, no Option. There is no way to tell which is the
    Regular Growth row, so none is admitted — but none may be pruned either,
    because the catalogue holds the answer from when AMFI still published the
    fuller name and the fund is live.
    """
    text = _file([
        ("127039", "Motilal Oswal Midcap Fund", "", ""),
        ("127040", "Motilal Oswal Midcap Fund", "", ""),
        ("127042", "Motilal Oswal Midcap Fund", "", ""),
        ("127044", "Motilal Oswal Midcap Fund", "", ""),
    ])
    rejected = set()
    records = parse_amfi_text(text, rejected_share_class=rejected)
    assert records == []
    assert rejected == set(), "a silent row must never be condemned"


def test_a_stated_share_class_is_condemned():
    """The Nippon Mid Cap case: only the Option column tells them apart."""
    text = _file([
        ("100377", "Nippon India Growth Mid Cap Fund", "Regular Plan", "Growth Option"),
        ("100375", "Nippon India Growth Mid Cap Fund", "Regular Plan", "IDCW Option"),
        ("100376", "Nippon India Growth Mid Cap Fund", "Regular Plan", "Bonus Option"),
        ("106260", "Nippon India Growth Mid Cap Fund", "Regular Plan",
         "INSTITUTIONAL Plan - IDCW Option"),
    ])
    rejected = set()
    records = parse_amfi_text(text, rejected_share_class=rejected)
    assert [r["scheme_code"] for r in records] == ["100377"]
    assert rejected == {"100375", "100376", "106260"}


def test_a_skip_for_an_unrelated_reason_is_not_a_share_class_verdict():
    """A bad NAV and a bad date are not statements about share class."""
    rows = [("100375", "X Fund", "Regular Plan", "IDCW Option")]
    text = _file(rows).replace("100.0000;09-Sep-2026", "N.A.;09-Sep-2026")
    rejected = set()
    parse_amfi_text(text, rejected_share_class=rejected)
    # It IS still an IDCW row, so the share-class test fires before the NAV test.
    assert rejected == {"100375"}

    # But a row that says nothing and merely has no NAV must stay unjudged.
    text = _file([("152352", "Motilal Oswal Large Cap Fund", "", "")]).replace(
        "100.0000;09-Sep-2026", "N.A.;09-Sep-2026")
    rejected = set()
    parse_amfi_text(text, rejected_share_class=rejected)
    assert rejected == set()


def test_rejections_are_only_collected_when_the_caller_asks():
    text = _file([("100375", "X Fund", "Regular Plan", "IDCW Option")])
    assert parse_amfi_text(text) == []          # no set passed, no crash


# ── the segregated-portfolio disclosure ─────────────────────────────────────
#
# AMFI appends a regulatory count to the PARENT scheme's name — and to its
# side-pockets, in identical words. It therefore refuses the row (nothing can
# tell the two apart) but must never condemn the catalogue entry.

DISCLOSED = [
    "Nippon India Credit Risk Fund (Existing Number of Segregated Portfolios - 1)",
    "Franklin India Low Duration Fund (No. of Segregated Portfolios-2)",
    "Baroda BNP Paribas Short Term Fund (the scheme has 2 segregated portfolios)",
    "Franklin India Ultra Short Bond Fund (no. of segregated portfolio-1)",
]


def test_a_disclosed_fund_is_still_refused_admission():
    """
    Refusing is correct. The parent and its side-pocket are byte-identical in
    name, Plan and Option — Nippon India Credit Risk publishes 112938 at NAV
    38.1663 and 148094 at NAV 0.5036 — so admitting on this evidence would put
    one fund on screen twice, which is the whole defect being fixed.
    """
    for name in DISCLOSED:
        assert is_legacy_plan_variant(name), name


def test_but_the_disclosure_is_not_a_share_class_verdict():
    """
    The licence to delete needs more than this. Reading the disclosure as a
    verdict marked five live Nippon funds for removal from the catalogue.

    The name is asked on its own here because that is how the caller asks: the
    rejection came from the NAME, so only the name is put forward as evidence
    for it. The Option column of these rows reads "Growth Option" and would be
    a statement in its own right — but it is not the reason this row was
    refused, and evidence for one verdict cannot be borrowed for another.
    """
    for name in DISCLOSED:
        assert not states_share_class(name), name


def test_a_disclosed_fund_is_skipped_without_being_condemned():
    text = _file([
        ("112938", DISCLOSED[0], "Regular Plan", "Growth option"),
        ("148094", DISCLOSED[0], "Regular Plan", "Growth Option"),
    ])
    rejected = set()
    records = parse_amfi_text(text, rejected_share_class=rejected)
    assert records == []
    assert rejected == set()


def test_a_real_side_pocket_share_class_is_both_refused_and_condemned():
    """Written unparenthesised, it is a genuine statement of share class."""
    name = "Nippon India Credit Risk Fund - Segregated Portfolio 1 - Growth Option"
    assert is_legacy_plan_variant(name)
    assert states_share_class(name, "Regular Plan", "Growth Option")


def test_the_disclosure_does_not_shield_a_legacy_marker_elsewhere():
    for name in ("Some Fund (Institutional) (No. of Segregated Portfolios-2)",
                 "Some Fund - Retail Plan (No. of Segregated Portfolios-2)"):
        assert is_legacy_plan_variant(name), name
        assert states_share_class(name), name


# ── the licence to delete, directly ─────────────────────────────────────────

def test_silence_is_not_a_statement():
    assert not states_share_class("Motilal Oswal Midcap Fund", "", "")
    assert not states_share_class("HSBC Small Cap Fund", "", "")
    # A plan without an option says nothing about the option.
    assert not states_share_class("Motilal Oswal Gold and Silver Passive Fund "
                                  "of Funds(Regular Plan)", "Regular Plan", "")


def test_an_option_named_anywhere_is_a_statement():
    assert states_share_class("Nippon India Growth Mid Cap Fund",
                              "Regular Plan", "IDCW Option")
    assert states_share_class("X Fund - Bonus Option", "Regular Plan", "")
    assert states_share_class("X Fund", "Regular Plan", "Cumulative")


def test_a_legacy_marker_in_any_column_is_a_statement():
    assert states_share_class("X Fund", "Regular Plan",
                              "INSTITUTIONAL Plan - IDCW Option")
    assert states_share_class("X Fund", "Retail Plan", "")
    assert states_share_class("X Fund", "", "Discontinued Growth")
