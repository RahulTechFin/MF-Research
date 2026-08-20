"""
Locks the AMFI scheme-type -> category mapping.

This is the map that decides which peer group every fund is ranked against, so a
silent change here moves quartiles for hundreds of funds. Each test below pins a
mistake that was actually found in the live data on 20 Aug 2026.

THE RULES
  1. Only OPEN-ENDED sections are collected. AMFI's file ends with
     "Close Ended Schemes(...)" sections that the old parser did not recognise as
     headers at all -- they fell through to the AMC branch, so the previous
     category stayed in force and 4,752 closed-end rows inherited it. The last
     open-ended section is Retirement Fund, so mapping Retirement (as this change
     does) would have filed ~707 fixed-maturity and interval plans as retirement
     funds.

  2. Matching uses the WHOLE text inside the parentheses. Keeping only the part
     after " - " reduced "Index Funds - Equity Funds" to "Equity Funds", which
     matched nothing and left index funds uncategorised.

  3. LONGEST KEY WINS. Several keys are substrings of others and dict-insertion
     order let the shorter one win by accident:
        10-year Constant Maturity Gilt Fund -> Gilt          (should be Gilt 10Y)
        Medium to Long Term Fund            -> Long Duration (should be Med-Long)

  4. Apostrophes are folded. AMFI writes "Children's Fund" with U+2019, and its
     server declares ISO-8859-1 while sending UTF-8, so the character could also
     arrive mojibaked.

  5. Legacy headers that AMFI REUSES for closed-end schemes -- the bare "Income"
     and "Growth" -- are deliberately left unmapped.

Run:  python -m pytest tests/test_category_mapping.py -q
"""

from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from scripts.amfi_catalogue import parse_amfi_text  # noqa: E402
from scripts.init_db import CATEGORY_SEED, resolve_category  # noqa: E402

SEED_NAMES = {name for _ac, name, _slug, _o in CATEGORY_SEED}
HEADER = ("Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;"
          "NAV Name;Plan;Option;Net Asset Value;Date")


def row(code, name, nav="10.5", date="19-Aug-2026", plan="Regular Plan",
        option="Growth"):
    return f"{code};INF001;INF002;{name};{plan};{option};{nav};{date}"


# ── rule 3: longest key wins ────────────────────────────────────────────────

def test_ten_year_constant_maturity_gilt_is_not_plain_gilt():
    assert resolve_category(
        "Income/Debt Oriented Schemes - 10-year Constant Maturity Gilt Fund"
    ) == "Gilt 10 Year Constant Duration"
    assert resolve_category("Debt Scheme - Gilt Fund") == "Gilt"
    assert resolve_category(
        "Debt Scheme - Gilt Fund with 10 year constant duration"
    ) == "Gilt 10 Year Constant Duration"


def test_medium_to_long_beats_long():
    assert resolve_category(
        "Income/Debt Oriented Schemes - Medium to Long Term Fund"
    ) == "Medium to Long Duration"
    assert resolve_category(
        "Income/Debt Oriented Schemes - Long Term Fund") == "Long Duration"


def test_ultra_short_variants():
    assert resolve_category(
        "Income/Debt Oriented Schemes - Ultra Short Term Fund"
    ) == "Ultra Short Duration"
    assert resolve_category(
        "Debt Scheme - Ultra Short Duration Fund") == "Ultra Short Duration"
    # Every fund AMFI files under this legacy section is named "Low Duration
    # Fund" (HSBC, Invesco India, Mirae Asset, UTI), so the SEBI-era fund name
    # decides it rather than the stale section title.
    assert resolve_category(
        "Income/Debt Oriented Schemes - Ultra Short to Short Term Fund"
    ) == "Low Duration"


# ── rule 2: the full parenthesised text is matched ──────────────────────────

def test_index_funds_by_asset_resolve():
    for tail in ("Equity Funds", "Debt Funds", "Hybrid Fund"):
        assert resolve_category(f"Index Funds - {tail}") == "Index Fund", tail
    assert resolve_category("Other Scheme - Index Funds") == "Index Fund"


def test_double_space_in_other_etfs():
    """AMFI ships "Other  ETFs" with two spaces; no single-spaced key matches it."""
    assert resolve_category("Other Scheme - Other  ETFs") == "ETF"


# ── rule 4: apostrophe folding ──────────────────────────────────────────────

def test_childrens_fund_apostrophe_variants():
    for apostrophe in ("’", "'", "‘"):
        raw = f"Solution Oriented Scheme - Children{apostrophe}s Fund"
        assert resolve_category(raw) == "Children's", repr(apostrophe)


# ── the newly mapped categories ─────────────────────────────────────────────

def test_previously_unmapped_categories_now_resolve():
    cases = {
        "Solution Oriented Scheme - Retirement Fund": "Retirement",
        "Hybrid Scheme - Balanced Hybrid Fund": "Balanced Hybrid",
        "Other Scheme - FoF Domestic": "FoF Domestic",
        "Fund of Funds Scheme (Domestic) - Fund of Funds Scheme (Domestic)":
            "FoF Domestic",
        "Income/Debt Oriented Schemes - Dynamic Term Fund": "Dynamic Bond",
        "Income/Debt Oriented Schemes - Medium Term Fund": "Medium Duration",
        "Income/Debt Oriented Schemes - Floating Interest Rates Fund":
            "Floater Fund",
    }
    for raw, want in cases.items():
        assert resolve_category(raw) == want, raw


def test_every_mapping_target_exists_as_a_category():
    """A mapping to a name absent from CATEGORY_SEED silently drops the fund."""
    from scripts.init_db import CATEGORY_NORM_MAP
    missing = {v for v in CATEGORY_NORM_MAP.values() if v not in SEED_NAMES}
    assert not missing, f"mapped to non-existent categories: {missing}"


# ── rule 5: legacy headers AMFI reuses stay unmapped ───────────────────────

def test_bare_legacy_headers_stay_unmapped():
    assert resolve_category("Income") is None
    assert resolve_category("Growth") is None


def test_specific_debt_sections_still_resolve_despite_the_income_prefix():
    """Every "Income/Debt Oriented Schemes - X" must resolve on X, not stall on
    the unmapped "Income"."""
    for tail, want in (("Liquid Fund", "Liquid Fund"),
                       ("Overnight Fund", "Overnight Fund"),
                       ("Money Market Fund", "Money Market"),
                       ("Corporate Bond Fund", "Corporate Bond"),
                       ("Credit Risk Fund", "Credit Risk"),
                       ("Banking and PSU Debt Fund", "Banking & PSU")):
        assert resolve_category(f"Income/Debt Oriented Schemes - {tail}") == want


# ── rule 1: closed-ended sections are skipped ──────────────────────────────

def test_closed_end_sections_are_not_collected():
    """
    The exact shape that made this dangerous: a Close Ended section positioned
    AFTER the Retirement section, so a leak inherits "Retirement".
    """
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Solution Oriented Scheme - Retirement Fund)",
        "Some AMC Mutual Fund",
        row("100001", "Some Retirement Fund - Regular Plan - Growth"),
        "Close Ended Schemes(Income)",
        "Another AMC Mutual Fund",
        row("200001", "Some FMP Series 42 - Regular Plan - Growth"),
        row("200002", "Another Fixed Term Plan - Regular Plan - Growth"),
        "Interval Fund Schemes(Income)",
        row("300001", "Some Quarterly Interval Plan - Regular Plan - Growth"),
    ])
    recs = {r["scheme_code"]: r for r in parse_amfi_text(text)}
    assert "100001" in recs
    assert recs["100001"]["category_name"] == "Retirement"
    for closed in ("200001", "200002", "300001"):
        assert closed not in recs, f"{closed} leaked out of a closed-end section"


def test_open_ended_after_closed_ended_is_collected_again():
    """skip_section must reset, not latch."""
    text = "\n".join([
        HEADER,
        "Close Ended Schemes(Income)",
        row("200001", "Some FMP - Regular Plan - Growth"),
        "Open Ended Schemes(Equity Scheme - Large Cap Fund)",
        row("100002", "Some Large Cap Fund - Regular Plan - Growth"),
    ])
    recs = {r["scheme_code"]: r for r in parse_amfi_text(text)}
    assert "200001" not in recs
    assert recs["100002"]["category_name"] == "Large Cap"


# ── the column-name break that stopped the catalogue updating ──────────────

def test_nav_name_column_is_read():
    """
    AMFI calls the name column "NAV Name". A lookup for "scheme name" returned
    "", is_regular_growth("") was False, and the parse collapsed from ~2,800
    records to 353 -- below the caller's abort threshold, in a workflow step that
    runs with continue-on-error, so the catalogue quietly stopped updating.
    """
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Equity Scheme - Large Cap Fund)",
        row("100003", "Test Large Cap Fund - Regular Plan - Growth"),
    ])
    recs = parse_amfi_text(text)
    assert len(recs) == 1
    assert recs[0]["scheme_name"] == "Test Large Cap Fund - Regular Plan - Growth"
    assert recs[0]["category_name"] == "Large Cap"


def test_legacy_scheme_name_column_still_works():
    """Older AMFI files headed the column "Scheme Name"; both must parse."""
    legacy = HEADER.replace("NAV Name", "Scheme Name")
    text = "\n".join([
        legacy,
        "Open Ended Schemes(Equity Scheme - Mid Cap Fund)",
        row("100004", "Test Mid Cap Fund - Regular Plan - Growth"),
    ])
    recs = parse_amfi_text(text)
    assert len(recs) == 1 and recs[0]["category_name"] == "Mid Cap"


def test_direct_and_idcw_are_still_excluded():
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Equity Scheme - Large Cap Fund)",
        row("100005", "X Large Cap Fund - Regular Plan - Growth"),
        row("100006", "X Large Cap Fund - Direct Plan - Growth"),
        row("100007", "X Large Cap Fund - Regular Plan - IDCW"),
    ])
    codes = {r["scheme_code"] for r in parse_amfi_text(text)}
    assert codes == {"100005"}


def test_zero_nav_row_is_rejected():
    """AMFI prices a terminated scheme at 0.0000 (e.g. Tata Quant Fund)."""
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Equity Scheme - Sectoral/ Thematic)",
        row("100008", "Dead Fund - Regular Plan - Growth", nav="0.0000"),
    ])
    assert parse_amfi_text(text) == []


# ── which share class counts as Regular-Growth ──────────────────────────────
#
# The option is decided from the NAME first and AMFI's Option column only as a
# fallback. Each case below is a real row that the name-only rule got wrong.

def test_cumulative_is_a_growth_option():
    """
    ICICI Prudential calls its growth option "Cumulative" and publishes NO row
    called Growth -- India Opportunities, Manufacturing and Pharma Healthcare
    each ship only a Cumulative option and an IDCW option. Requiring the literal
    word "growth" dropped all of them from the universe.
    """
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Equity Scheme - Sectoral/ Thematic)",
        row("145077", "ICICI Prudential Manufacturing Fund - Cumulative Option",
            option="Cumulative"),
        row("145078", "ICICI Prudential Manufacturing Fund - IDCW Option",
            option="IDCW"),
    ])
    recs = {r["scheme_code"]: r for r in parse_amfi_text(text)}
    assert set(recs) == {"145077"}
    assert recs["145077"]["category_name"] == "Sectoral/Thematic"


def test_option_column_is_used_when_the_name_is_silent():
    """"Samco Mid Cap Fund - Regular Plan" says nothing about the option."""
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Equity Scheme - Mid Cap Fund)",
        row("154115", "Samco Mid Cap Fund - Regular Plan", option="Growth"),
    ])
    recs = parse_amfi_text(text)
    assert len(recs) == 1 and recs[0]["category_name"] == "Mid Cap"


def test_the_name_beats_the_option_column_for_exclusion():
    """
    AMFI stamps Option="Growth Option" on rows plainly named "Bonus Option" and
    "IDCW Plan". Those are separate share classes whatever the column says, so
    the name has the last word on exclusion.
    """
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Debt Scheme - Gilt Fund)",
        row("133264", "Nippon India Gilt Fund- Growth Plan- Bonus Option",
            option="Growth Option"),
        row("101084", "HDFC Gilt Fund - IDCW Plan", option="Growth Option"),
        row("100001", "Some Gilt Fund - Regular Plan - Growth", option="Growth"),
    ])
    codes = {r["scheme_code"] for r in parse_amfi_text(text)}
    assert codes == {"100001"}


def test_income_distribution_is_idcw_written_out():
    """653 rows use the long form; without it they read as neither growth nor income."""
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Other Scheme - FoF Domestic)",
        row("153500", "SBI Income Plus Arbitrage Active FOF- Regular Plan- Growth",
            plan="", option=""),
        row("153499", "SBI Income Plus Arbitrage Active FOF- Regular Plan- "
                      "Income Distribution Cum Capital Withdrawal Option",
            plan="", option=""),
    ])
    codes = {r["scheme_code"] for r in parse_amfi_text(text)}
    assert codes == {"153500"}


def test_direct_is_caught_by_the_plan_column_outside_etf_sections():
    """A name that omits "Direct" while the Plan column says so."""
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Equity Scheme - Large Cap Fund)",
        row("100002", "Some Large Cap Fund", plan="Direct Plan", option="Growth"),
        row("100003", "Some Large Cap Fund", plan="Regular Plan", option="Growth"),
    ])
    codes = {r["scheme_code"] for r in parse_amfi_text(text)}
    assert codes == {"100003"}


def test_etfs_ignore_the_plan_column():
    """
    ETFs are single-plan instruments, yet AMFI marks several liquid ETFs
    "Direct Plan" while their names say nothing of the kind. Trusting the column
    there dropped five live ETFs.
    """
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Other Scheme - Other  ETFs)",
        row("154466", "UTI Nifty 1D Rate Liquid ETF - Growth",
            plan="Direct Plan", option="Growth"),
    ])
    recs = parse_amfi_text(text)
    assert len(recs) == 1 and recs[0]["category_name"] == "ETF"


# ── the silent-option rule ─────────────────────────────────────────────────

def test_a_fund_that_states_no_option_anywhere_is_growth():
    """
    Motilal Oswal publishes exactly two rows for these funds, a Regular and a
    Direct, with no option named in either the name or the column. The Regular
    row IS the growth option, and dropping it loses a real fund.
    """
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Other Scheme - FoF Domestic)",
        row("150641", "Motilal Oswal Gold and Silver Passive Fund of Funds(Regular Plan)",
            plan="", option=""),
        row("150642", "Motilal Oswal Gold and Silver Passive Fund of Funds(Direct Plan)",
            plan="", option=""),
    ])
    codes = {r["scheme_code"] for r in parse_amfi_text(text)}
    assert codes == {"150641"}, "the Regular row, and only it, should survive"


def test_silence_is_not_growth_when_the_fund_names_options_elsewhere():
    """
    The guard that keeps SBI's IDCW rows out. If any row of the fund states an
    option, a silent sibling is some other share class and guessing would invent
    a duplicate.
    """
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Other Scheme - FoF Domestic)",
        row("200001", "Some FoF - Regular Plan - Growth", plan="", option=""),
        row("200002", "Some FoF - Regular Plan", plan="", option=""),
    ])
    codes = {r["scheme_code"] for r in parse_amfi_text(text)}
    assert codes == {"200001"}


def test_discipline_advantage_is_a_duplicate_share_class():
    """
    111777 "Aditya Birla Sun Life Income Fund (Discipline Advantage Plan)" sits
    beside 100038 "... - Growth - Regular Plan". It states no option, so the
    silent rule would otherwise admit it as a second copy of the fund.
    """
    text = "\n".join([
        HEADER,
        "Open Ended Schemes(Debt Scheme - Medium to Long Duration Fund)",
        row("100038", "Aditya Birla Sun Life Income Fund - Growth - Regular Plan",
            option="GROWTH"),
        row("111777", "Aditya Birla Sun Life Income Fund (Discipline Advantage Plan)",
            plan="", option=""),
    ])
    codes = {r["scheme_code"] for r in parse_amfi_text(text)}
    assert codes == {"100038"}


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  ok   {name}")
            except AssertionError as exc:
                fails += 1
                print(f"  FAIL {name}: {exc}")
    print(f"\n{'FAILED' if fails else 'all passed'} ({fails} failure(s))")
    sys.exit(1 if fails else 0)
