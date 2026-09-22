"""
Tests for the SIF fund list and its category mapping.

Every fixture string below is a real line from one of AMFI's two SIF feeds,
including the malformed ones — "RegularPlan" with no space, "Direct  Plan" with
two, a fund whose plan is stated nowhere at all. Those are the cases that decide
whether a fund reaches the dashboard or silently disappears, so they are pinned
here rather than left to a manual read of the output.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts import sif_categories as cats
from scripts import sif_catalogue as cat
from scripts import sif_source as src


# ── dates ───────────────────────────────────────────────────────────────────

def test_amfi_date_becomes_iso():
    assert src.parse_date("20-Aug-2026") == "2026-08-20"
    assert src.parse_date("08-Oct-2025") == "2025-10-08"


def test_an_iso_string_is_not_read_as_a_date():
    # It splits into three numbers too. On the MF side this exact shape came back
    # as '0019-08-2026' before the parts were range-checked.
    assert src.parse_date("2026-08-19") is None


def test_nonsense_dates_are_refused():
    assert src.parse_date("") is None
    assert src.parse_date("20-Xyz-2026") is None
    assert src.parse_date("32-Aug-2026") is None
    assert src.parse_date("20-Aug-1799") is None


# ── column layout ───────────────────────────────────────────────────────────

NAVALL_HEADER = ("Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;"
                 "Scheme Name;Plan;Option;Net Asset Value;Date")
HISTORY_HEADER = ("Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;"
                  "ISIN Div Reinvestment;Net Asset Value;Date")


def test_the_two_feeds_order_their_columns_differently():
    """The name and the ISINs swap places, which is why nothing reads by index."""
    a = src._index_map(NAVALL_HEADER)
    b = src._index_map(HISTORY_HEADER)
    assert (a["name"], a["isin"]) == (3, 1)
    assert (b["name"], b["isin"]) == (1, 4)
    for m in (a, b):
        assert m["code"] == 0
        assert m["nav"] == 6 and m["date"] == 7


# ── option ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("column", ["Growth", "Growth Option", "GROWTH OPTION",
                                    "GROWTH"])
def test_every_spelling_of_growth_is_growth(column):
    assert src.classify_option(column, "") == "growth"


@pytest.mark.parametrize("column", ["IDCW", "IDCW Option", "IDCW Payout Option",
                                    "IDCW Reinvestment Option", "Monthly IDCW",
                                    "Half Yearly IDCW", "Annual IDCW"])
def test_every_spelling_of_idcw_is_idcw(column):
    assert src.classify_option(column, "") == "idcw"


def test_idcw_written_out_in_full_is_still_idcw():
    # Magnum publishes the option spelled out; nothing in it says "IDCW".
    name = ("Magnum Hybrid Long Short Fund - Regular Plan - "
            "Income Distribution Cum Capital Withdrawal")
    assert src.classify_option("", name) == "idcw"


def test_a_payout_reinvestment_suffix_does_not_turn_into_growth():
    name = "Summit Equity Long-Short Fund - Regular Plan - IDCW (Payout / Reinvestment)"
    assert src.classify_option("", name) == "idcw"


def test_the_column_is_believed_over_the_name():
    assert src.classify_option("Growth", "Something IDCW shaped") == "growth"


def test_a_row_claiming_both_is_flagged_not_guessed():
    assert src.classify_option("Growth and IDCW", "") == "ambiguous"


def test_no_option_anywhere_is_unknown():
    assert src.classify_option("", "iSIF Equity Long-Short Fund") == "unknown"


# ── plan ────────────────────────────────────────────────────────────────────

def test_regular_plan_with_no_space_is_still_regular():
    # SIF-117, real: "...Growth Option - RegularPlan". A word boundary after
    # "regular" matches nothing here, which is why the test is a substring.
    name = "qsif Sector Rotation Long-Short Fund - Growth Option - RegularPlan"
    assert src.classify_plan("", name) == "regular"


def test_direct_plan_with_two_spaces_is_still_direct():
    assert src.classify_plan("", "Magnum Hybrid Long Short Fund - Direct  Plan - Growth") == "direct"


def test_the_word_plan_is_not_required():
    # SIF-80 and SIF-128 say only "Regular"; SIF-79 and SIF-129 only "Direct".
    assert src.classify_plan("", "Apex Hybrid Long-Short Fund - Regular - Growth") == "regular"
    assert src.classify_plan("", "RedHex Hybrid Long-Short Fund - Direct - Growth") == "direct"


def test_a_plan_stated_nowhere_is_silent_not_assumed():
    assert src.classify_plan("", "iSIF Equity Long-Short Fund - Growth") == "silent"


def test_a_row_naming_both_plans_is_flagged():
    assert src.classify_plan("Regular Plan", "... Direct ...") == "regular"
    assert src.classify_plan("", "Regular and Direct") == "ambiguous"


# ── collapsing a fund's share classes onto one name ─────────────────────────

def test_a_direct_row_and_its_silent_twin_reduce_to_the_same_fund():
    a = src.fund_base("iSIF Equity Ex-Top 100 Long-Short Fund - Direct Plan - Growth")
    b = src.fund_base("iSIF Equity Ex-Top 100 Long-Short Fund - Growth")
    assert a == b == "isif equity ex top 100 long short fund"


def test_punctuation_differences_between_amcs_collapse_too():
    assert (src.fund_base("Altiva Equity Ex- Top 100 Long - Short Fund")
            == src.fund_base("Altiva Equity Ex-Top 100 Long-Short Fund"))


def test_two_different_funds_do_not_collapse():
    assert (src.fund_base("iSIF Equity Long-Short Fund - Growth")
            != src.fund_base("iSIF Equity Ex-Top 100 Long-Short Fund - Growth"))


# ── categories ──────────────────────────────────────────────────────────────

def test_all_seven_sebi_strategies_are_seeded():
    names = {c["name"] for c in cats.all_categories()}
    assert len(names) == 7
    # The two nobody has launched yet must already exist, or the first debt SIF
    # to appear lands in a category that is not there.
    assert "Debt Long-Short Fund" in names
    assert "Sectoral Debt Long-Short Fund" in names


def test_a_section_header_maps_to_its_strategy():
    c = cats.resolve("Equity Oriented Investment Strategies - Equity Ex-Top 100 Long-Short Fund")
    assert (c["slug"], c["asset_class"]) == ("equity-ex-top-100-long-short", "Equity")


def test_both_feeds_spacings_map_the_same():
    a = cats.resolve("Hybrid Investment Strategies - Hybrid Long-Short Fund")
    b = cats.resolve("Hybrid Investment Strategies  -  Hybrid  Long-Short  Fund")
    assert a["slug"] == b["slug"] == "hybrid-long-short"


def test_the_shorter_strategy_does_not_steal_the_longer_one():
    # "Debt Long-Short Fund" is a substring of "Sectoral Debt Long-Short Fund".
    c = cats.resolve("Debt Oriented Investment Strategies - Sectoral Debt Long-Short Fund")
    assert c["slug"] == "sectoral-debt-long-short"


def test_equity_long_short_is_not_confused_with_ex_top_100():
    assert cats.resolve("Equity Oriented Investment Strategies - Equity Long-Short Fund")["slug"] \
        == "equity-long-short"


def test_an_unknown_strategy_returns_nothing_rather_than_the_closest():
    assert cats.resolve("Open Ended Schemes(Some New Strategy)") is None
    assert cats.resolve("") is None


def test_the_family_is_cross_checked():
    assert cats.family_matches("Equity Oriented Investment Strategies - "
                               "Equity Long-Short Fund", "Equity")
    assert not cats.family_matches("Equity Oriented Investment Strategies - "
                                   "Equity Long-Short Fund", "Debt")


# ── the feed, end to end ────────────────────────────────────────────────────

# Two AMCs. qsif states everything; iSIF states nothing at all and has to be
# resolved by elimination. Both hybrid strategies arrive as "Interval Fund
# Schemes", which is how AMFI really publishes them.
NAVALL = "\n".join([
    NAVALL_HEADER,
    " ",
    "Open Ended Schemes(Equity Oriented Investment Strategies - Equity Long-Short Fund)",
    " ",
    "qsif SIF",
    " ",
    "SIF-1;INF966L30019;-;qsif Equity Long Short Fund;Direct Plan;Growth Option;9.9441;20-Aug-2026",
    "SIF-3;INF966L30027;-;qsif Equity Long Short Fund;Regular Plan;Growth Option;9.8928;20-Aug-2026",
    "SIF-4;INF966L30050;INF966L30068;qsif Equity Long Short Fund;Regular Plan;IDCW Option;9.8928;20-Aug-2026",
    " ",
    "iSIF SIF",
    " ",
    "SIF-33;INF109K30042;-;iSIF Equity Long-Short Fund;;;10.50;20-Aug-2026",
    "SIF-34;INF109K30034;-;iSIF Equity Long-Short Fund;;;10.42;20-Aug-2026",
    " ",
    "Interval Fund Schemes(Hybrid Investment Strategies - Hybrid Long-Short Fund)",
    " ",
    "Arudha SIF",
    " ",
    "SIF-40;INF194K30010;-;Arudha Hybrid Long-Short Fund;;;10.351;20-Aug-2026",
])

HISTORY = "\n".join([
    HISTORY_HEADER,
    "",
    "Open Ended Schemes ( Equity Oriented Investment Strategies - Equity Long-Short Fund )",
    "",
    "qsif SIF",
    "SIF-1;qsif Equity Long Short Fund - Growth Option - Direct Plan;Direct Plan;Growth Option;INF966L30019;;9.9000;19-Aug-2026",
    "SIF-3;qsif Equity Long Short Fund - Growth Option - Regular Plan;Regular Plan;Growth Option;INF966L30027;;9.8500;19-Aug-2026",
    "SIF-4;qsif Equity Long Short Fund - IDCW Option - Regular Plan;Regular Plan;IDCW Option;INF966L30050;INF966L30068;9.8500;19-Aug-2026",
    "",
    "iSIF SIF",
    "SIF-33;iSIF Equity Long-Short Fund - Direct Plan - Growth;;;INF109K30042;;10.49;19-Aug-2026",
    "SIF-34;iSIF Equity Long-Short Fund - Growth;;;INF109K30034;;10.41;19-Aug-2026",
    "",
    "Interval Fund Schemes ( Hybrid Investment Strategies - Hybrid Long-Short Fund )",
    "",
    "Arudha SIF",
    "SIF-40;Arudha Hybrid Long-Short Fund-Regular Plan-Growth;Regular Plan;Growth;INF194K30010;;10.34;19-Aug-2026",
])


@pytest.fixture(scope="module")
def built():
    return cat.build(NAVALL, HISTORY)


def test_only_regular_growth_survives(built):
    assert {f["scheme_code"] for f in built["funds"]} == {"SIF-3", "SIF-34", "SIF-40"}


def test_funds_come_out_grouped_by_asset_class_then_named(built):
    """Equity before Hybrid, and alphabetical within a strategy — iSIF before qsif."""
    assert [f["scheme_code"] for f in built["funds"]] == ["SIF-34", "SIF-3", "SIF-40"]


def test_nothing_is_lost_between_kept_and_excluded(built):
    assert (len(built["funds"]) + len(built["excluded"])
            == built["universe"]["schemes_seen"] == 6)


def test_each_exclusion_says_why(built):
    why = {e["scheme_code"]: e["reason"] for e in built["excluded"]}
    assert why == {"SIF-1": "plan is direct",
                   "SIF-4": "option is idcw",
                   "SIF-33": "plan is direct"}


def test_interval_funds_are_kept():
    """
    The MF catalogue skips every section that is not open-ended, because there
    those are FMPs. Both SIF hybrid strategies are published as Interval Fund
    Schemes, so the same rule here would delete half the universe.
    """
    built = cat.build(NAVALL, HISTORY)
    hybrid = [f for f in built["funds"] if f["asset_class"] == "Hybrid"]
    assert [f["scheme_code"] for f in hybrid] == ["SIF-40"]
    assert hybrid[0]["structure"] == "Interval Fund"


def test_the_snapshot_supplies_the_clean_name_and_the_latest_nav(built):
    f = next(f for f in built["funds"] if f["scheme_code"] == "SIF-3")
    assert f["scheme_name"] == "qsif Equity Long Short Fund"   # no plan/option
    assert (f["latest_nav"], f["latest_nav_date"]) == (9.8928, "2026-08-20")


def test_the_history_report_rescues_a_plan_the_snapshot_left_blank(built):
    """SIF-40 is blank in the snapshot and populated in the history report."""
    f = next(f for f in built["funds"] if f["scheme_code"] == "SIF-40")
    assert (f["plan"], f["plan_source"]) == ("Regular", "column")


def test_a_silent_scheme_is_inferred_from_its_direct_sibling(built):
    f = next(f for f in built["funds"] if f["scheme_code"] == "SIF-34")
    assert (f["plan"], f["plan_source"]) == ("Regular", "inferred")
    note = next(n for n in built["plan_inferences"] if n["scheme_code"] == "SIF-34")
    assert note["outcome"] == "Regular"


def test_the_inference_is_refused_when_the_navs_are_the_wrong_way_round():
    """
    A Regular plan pays the distributor from the same pool, so it cannot trade
    above its Direct twin. If it does, the elimination has found the wrong row
    and the scheme is left unresolved rather than mislabelled.
    """
    bad = NAVALL.replace("SIF-34;INF109K30034;-;iSIF Equity Long-Short Fund;;;10.42;",
                         "SIF-34;INF109K30034;-;iSIF Equity Long-Short Fund;;;99.00;")
    built = cat.build(bad, HISTORY)
    assert "SIF-34" not in [f["scheme_code"] for f in built["funds"]]
    note = next(n for n in built["plan_inferences"] if n["scheme_code"] == "SIF-34")
    assert note["outcome"] == "left unresolved"


def test_two_silent_siblings_are_not_guessed_between():
    ambiguous = NAVALL.replace(
        "SIF-33;INF109K30042;-;iSIF Equity Long-Short Fund;;;10.50;20-Aug-2026",
        "SIF-33;INF109K30042;-;iSIF Equity Long-Short Fund;;;10.50;20-Aug-2026\n"
        "SIF-99;INF109K30099;-;iSIF Equity Long-Short Fund;;;10.40;20-Aug-2026")
    hist = HISTORY.replace(
        "SIF-34;iSIF Equity Long-Short Fund - Growth;;;INF109K30034;;10.41;19-Aug-2026",
        "SIF-34;iSIF Equity Long-Short Fund - Growth;;;INF109K30034;;10.41;19-Aug-2026\n"
        "SIF-99;iSIF Equity Long-Short Fund - Growth;;;INF109K30099;;10.39;19-Aug-2026")
    built = cat.build(ambiguous, hist)
    codes = [f["scheme_code"] for f in built["funds"]]
    assert "SIF-34" not in codes and "SIF-99" not in codes
    reasons = {n["scheme_code"]: n["outcome"] for n in built["plan_inferences"]}
    assert reasons["SIF-34"] == reasons["SIF-99"] == "left unresolved"


def test_a_renumbered_isin_raises_a_warning():
    """Two ISINs on one scheme code means two funds are about to be blended."""
    hist = HISTORY.replace("INF966L30027;;9.8500", "INF966L99999;;9.8500")
    built = cat.build(NAVALL, hist)
    assert any("SIF-3" in w and "different ISIN" in w for w in built["warnings"])


def test_every_seeded_category_appears_with_its_count(built):
    by_slug = {c["slug"]: c for c in built["categories"]}
    assert len(by_slug) == 7
    assert by_slug["equity-long-short"]["fund_count"] == 2
    assert by_slug["hybrid-long-short"]["fund_count"] == 1
    assert by_slug["debt-long-short"]["fund_count"] == 0


def test_the_bucket_folder_matches_the_mf_layout(built):
    f = next(f for f in built["funds"] if f["scheme_code"] == "SIF-3")
    assert f["folder"] == "equity/equity-long-short"


def test_history_coverage_is_recorded_per_fund(built):
    f = next(f for f in built["funds"] if f["scheme_code"] == "SIF-3")
    assert (f["history_first"], f["history_last"]) == ("2026-08-19", "2026-08-19")
    assert f["history_points"] == 1


def test_a_repeated_day_does_not_inflate_the_history_count():
    """Days, not rows — a duplicated day must not look like extra history."""
    dup = HISTORY + "\n" + (
        "SIF-3;qsif Equity Long Short Fund - Growth Option - Regular Plan;"
        "Regular Plan;Growth Option;INF966L30027;;9.8500;19-Aug-2026")
    built = cat.build(NAVALL, dup)
    f = next(f for f in built["funds"] if f["scheme_code"] == "SIF-3")
    assert f["history_points"] == 1


def test_the_key_is_the_scheme_code(built):
    assert built["key"] == "scheme_code"
    assert all(f["scheme_code"].startswith("SIF-") for f in built["funds"])


def test_a_clean_feed_produces_no_warnings(built):
    assert built["warnings"] == []

# -- carry-forward, and why the short daily window needs it -----------------

# The daily run asks for ~90 days. This is what iSIF looks like when it has not
# reported inside that window: present in the snapshot, so still a live fund,
# but with no NAV Name anywhere to read its plan out of.
NAVALL_SILENT_ONLY = "\n".join([
    NAVALL_HEADER,
    " ",
    "Open Ended Schemes(Equity Oriented Investment Strategies - Equity Long-Short Fund)",
    " ",
    "iSIF SIF",
    " ",
    "SIF-34;INF109K30034;-;iSIF Equity Long-Short Fund;;;10.42;20-Aug-2026",
])

HISTORY_EMPTY = HISTORY_HEADER


def test_without_carry_forward_a_silent_fund_is_lost():
    """
    Establishes the failure first, so the fix below is not testing nothing. With
    no NAV Name and no Plan column there is genuinely nothing to read, and the
    fund correctly falls out rather than being guessed at.
    """
    built = cat.build(NAVALL_SILENT_ONLY, HISTORY_EMPTY)
    assert built["funds"] == []
    assert built["excluded"][0]["reason"] == "plan is silent"


def test_carry_forward_keeps_a_fund_the_window_cannot_read():
    """
    The published data sheet is the authority for a scheme this run cannot
    classify. Otherwise iSIF's four funds would drop off the list on the first
    day they stopped reporting inside the window, and reappear later — the list
    would flicker.
    """
    previous = {"SIF-34": {"scheme_code": "SIF-34", "plan": "Regular",
                           "option": "Growth"}}
    built = cat.build(NAVALL_SILENT_ONLY, HISTORY_EMPTY, previous=previous)
    assert [f["scheme_code"] for f in built["funds"]] == ["SIF-34"]
    f = built["funds"][0]
    assert (f["plan"], f["plan_source"]) == ("Regular", "carried forward")


def test_carry_forward_only_fills_a_gap_and_never_overrides():
    """
    A scheme the current feeds CAN read is classified from the current feeds, so
    a genuine reclassification is picked up instead of being pinned to whatever
    was decided first.
    """
    previous = {"SIF-1": {"scheme_code": "SIF-1", "plan": "Regular",
                          "option": "Growth"}}
    built = cat.build(NAVALL, HISTORY, previous=previous)
    # SIF-1 says "Direct Plan" in both feeds; the stale Regular must not win.
    assert "SIF-1" not in [f["scheme_code"] for f in built["funds"]]
    assert {"scheme_code": "SIF-1", "reason": "plan is direct"} in [
        {"scheme_code": e["scheme_code"], "reason": e["reason"]}
        for e in built["excluded"]]


def test_a_carried_forward_decision_is_recorded_not_hidden(built_cf=None):
    previous = {"SIF-34": {"scheme_code": "SIF-34", "plan": "Regular",
                           "option": "Growth"}}
    built = cat.build(NAVALL_SILENT_ONLY, HISTORY_EMPTY, previous=previous)
    note = next(n for n in built["plan_inferences"] if n["scheme_code"] == "SIF-34")
    assert "already published" in note["why"]


# -- coverage comes from the store, not from the window ---------------------

def test_coverage_is_restated_from_the_merged_series(built):
    """
    build() can only report the window it was given. The published Parquet is the
    whole record, so after merging the figures are corrected from it — otherwise
    the data sheet would claim every fund had only 90 days of history.
    """
    merged = {"SIF-3": {"2025-10-08": 10.0, "2026-08-20": 10.9},
              "SIF-34": {"2026-02-05": 10.0},
              "SIF-40": {"2026-02-04": 10.0}}
    out = cat.apply_coverage(dict(built, funds=[dict(f) for f in built["funds"]]),
                             merged)
    by_code = {f["scheme_code"]: f for f in out["funds"]}
    assert by_code["SIF-3"]["history_first"] == "2025-10-08"
    assert by_code["SIF-3"]["history_points"] == 2
    assert out["history"] == {"first": "2025-10-08", "last": "2026-08-20",
                              "days": 4, "rows": 4}


def test_a_fund_with_no_stored_navs_reports_zero_rather_than_stale(built):
    out = cat.apply_coverage(dict(built, funds=[dict(f) for f in built["funds"]]),
                             {})
    for f in out["funds"]:
        assert f["history_points"] == 0
        assert f["history_first"] is None


# -- the published shape ---------------------------------------------------

def test_the_data_sheet_round_trips_through_parquet(built):
    import io as _io
    import pyarrow.parquet as _pq
    raw = cat._table(built["funds"], cat.FUND_COLUMNS)
    back = _pq.read_table(_io.BytesIO(raw)).to_pylist()
    assert [r["scheme_code"] for r in back] == \
        [f["scheme_code"] for f in built["funds"]]
    assert back[0]["plan"] == "Regular" and back[0]["option"] == "Growth"


def test_the_categories_table_carries_all_seven(built):
    import io as _io
    import pyarrow.parquet as _pq
    raw = cat._table(built["categories"], cat.CATEGORY_COLUMNS)
    back = _pq.read_table(_io.BytesIO(raw)).to_pylist()
    assert len(back) == 7
    assert {r["slug"] for r in back} >= {"debt-long-short",
                                         "sectoral-debt-long-short"}


def test_the_manifest_carries_the_diagnostics_and_not_the_tables(built):
    manifest = {k: v for k, v in built.items()
                if k not in ("funds", "categories")}
    assert "excluded" in manifest and "warnings" in manifest
    assert "plan_inferences" in manifest
    assert "funds" not in manifest
