"""
Tests for the SIF NAV store: the Parquet round trip, what AMFI is allowed to
change, and the gates that stop a bad day becoming permanent.

The store IS the history now. AMFI cannot rewrite a day it has already served,
so a wrong value would be carried forward by every run after it — which is why
most of what follows is about refusing things rather than accepting them.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from datetime import date

from scripts import sif_nav_store as store


# ── the file itself ─────────────────────────────────────────────────────────

def test_a_series_survives_the_parquet_round_trip():
    series = {
        "SIF-3":  {"2025-10-08": 10.0, "2025-10-09": 10.0512},
        "SIF-21": {"2026-08-20": 934.726},
    }
    assert store.from_parquet(store.to_parquet(series)) == series


def test_the_file_is_smaller_than_the_json_it_replaces():
    """Not a micro-benchmark — the reason this is Parquet at all."""
    import json
    series = {f"SIF-{i}": {f"2026-0{1 + d // 28}-{1 + d % 28:02d}": 10 + d * 0.01
                           for d in range(200)}
              for i in range(30)}
    parquet = len(store.to_parquet(series))
    as_json = len(json.dumps(series))
    assert parquet < as_json / 2


def test_an_unreadable_file_reads_as_absent_not_as_an_error():
    """
    A corrupt object must not kill the run. It reads as empty, and the gate in
    validate() is what stops "empty" from replacing a good history.
    """
    assert store.from_parquet(b"this is not parquet") == {}
    assert store.from_parquet(b"") == {}


def test_nonpositive_navs_are_dropped_on_read():
    series = {"SIF-3": {"2026-08-19": 10.0, "2026-08-20": 11.0}}
    raw = store.to_parquet({"SIF-3": {"2026-08-19": 10.0, "2026-08-20": 11.0}})
    assert store.from_parquet(raw) == series


# ── what AMFI may change ────────────────────────────────────────────────────

def test_a_new_day_is_added():
    series = {"SIF-3": {"2026-08-19": 10.0}}
    stats = store.merge(series, [("SIF-3", "2026-08-20", 10.05)],
                        keep_codes={"SIF-3"}, cap="2026-08-20")
    assert stats["added"] == 1
    assert series["SIF-3"]["2026-08-20"] == 10.05


def test_a_day_already_held_is_never_overwritten():
    """
    The published value came from this same feed. Rewriting history is exactly
    what this design exists to prevent, so a restated NAV is ignored.
    """
    series = {"SIF-3": {"2026-08-20": 10.0}}
    stats = store.merge(series, [("SIF-3", "2026-08-20", 99.0)],
                        keep_codes={"SIF-3"}, cap="2026-08-20")
    assert stats["already_held"] == 1 and stats["added"] == 0
    assert series["SIF-3"]["2026-08-20"] == 10.0


def test_a_gap_of_several_days_is_filled_in_order():
    """
    The whole reason the range endpoint is used instead of the daily snapshot:
    a missed run is recoverable.
    """
    series = {"SIF-3": {"2026-08-14": 10.0}}
    incoming = [("SIF-3", "2026-08-17", 10.1), ("SIF-3", "2026-08-18", 10.2),
                ("SIF-3", "2026-08-19", 10.3), ("SIF-3", "2026-08-20", 10.4)]
    stats = store.merge(series, incoming, keep_codes={"SIF-3"}, cap="2026-08-20")
    assert stats["added"] == 4
    assert sorted(series["SIF-3"]) == ["2026-08-14", "2026-08-17", "2026-08-18",
                                       "2026-08-19", "2026-08-20"]


def test_anything_past_the_cap_is_dropped():
    series = {"SIF-3": {"2026-08-19": 10.0}}
    stats = store.merge(series, [("SIF-3", "2026-08-21", 10.1)],
                        keep_codes={"SIF-3"}, cap="2026-08-20")
    assert stats["capped"] == 1 and "2026-08-21" not in series["SIF-3"]


def test_a_fund_off_the_data_sheet_never_enters_the_file():
    """Only the Regular Growth funds are stored — Direct and IDCW stay out."""
    series = {}
    stats = store.merge(series, [("SIF-1", "2026-08-20", 9.94)],
                        keep_codes={"SIF-3"}, cap="2026-08-20")
    assert stats["not_tracked"] == 1 and series == {}


def test_a_zero_or_negative_nav_is_refused():
    series = {"SIF-3": {"2026-08-19": 10.0}}
    stats = store.merge(series, [("SIF-3", "2026-08-20", 0.0),
                                 ("SIF-3", "2026-08-20", -1.0)],
                        keep_codes={"SIF-3"}, cap="2026-08-20")
    assert stats["bad_value"] == 2 and "2026-08-20" not in series["SIF-3"]


# ── the one-day-move tripwire ───────────────────────────────────────────────

def test_a_redenomination_is_refused():
    """
    A NAV restated onto a different base moves by an impossible amount in a
    day. On the MF desk this washed out on the next rebuild; here the file is
    the history, so it has to be caught at the door.
    """
    series = {"SIF-3": {"2026-08-19": 10.0}}
    stats = store.merge(series, [("SIF-3", "2026-08-20", 1000.0)],
                        keep_codes={"SIF-3"}, cap="2026-08-20")
    assert stats["rejected_move"] == 1
    assert "2026-08-20" not in series["SIF-3"]


def test_a_real_market_move_is_accepted():
    """The widest one-day move measured across the MF universe was 1.4%."""
    series = {"SIF-3": {"2026-08-19": 10.0}}
    stats = store.merge(series, [("SIF-3", "2026-08-20", 9.86)],
                        keep_codes={"SIF-3"}, cap="2026-08-20")
    assert stats["added"] == 1


def test_the_tripwire_sits_far_above_any_plausible_move():
    assert 0.10 <= store.MAX_ONE_DAY_MOVE <= 0.50


def test_a_brand_new_fund_has_nothing_to_compare_against():
    """A first NAV cannot be checked for a jump, and must not be refused for it."""
    series = {}
    stats = store.merge(series, [("SIF-150", "2026-08-20", 10.55)],
                        keep_codes={"SIF-150"}, cap="2026-08-20")
    assert stats["added"] == 1


def test_the_move_is_measured_against_the_previous_day_not_the_latest():
    """
    Backfilling into a gap has to compare against the day BEFORE the one being
    added, not against the newest value in the series — otherwise filling an old
    gap in a fund that has since risen would look like a jump.
    """
    series = {"SIF-3": {"2026-08-14": 10.0, "2026-08-20": 12.0}}
    stats = store.merge(series, [("SIF-3", "2026-08-17", 10.1)],
                        keep_codes={"SIF-3"}, cap="2026-08-20")
    assert stats["added"] == 1 and series["SIF-3"]["2026-08-17"] == 10.1


# ── the gates ───────────────────────────────────────────────────────────────

def test_an_empty_result_is_refused():
    assert store.validate({}, {"SIF-3": {"2026-08-20": 10.0}})


def test_a_collapse_is_refused():
    published = {"SIF-3": {f"2026-01-{d:02d}": 10.0 for d in range(1, 21)}}
    shrunk = {"SIF-3": {"2026-01-01": 10.0}}
    assert any("shrank" in p for p in store.validate(shrunk, published))


def test_losing_a_fund_entirely_is_refused():
    published = {"SIF-3": {"2026-08-20": 10.0}, "SIF-7": {"2026-08-20": 10.9}}
    assert any("lost its entire series" in p
               for p in store.validate({"SIF-3": {"2026-08-20": 10.0}}, published))


def test_the_newest_date_may_not_go_backwards():
    published = {"SIF-3": {"2026-08-19": 10.0, "2026-08-20": 10.1}}
    older = {"SIF-3": {"2026-08-19": 10.0}}
    assert any("backwards" in p for p in store.validate(older, published))


def test_growing_is_fine():
    published = {"SIF-3": {"2026-08-19": 10.0}}
    grown = {"SIF-3": {"2026-08-19": 10.0, "2026-08-20": 10.1}}
    assert store.validate(grown, published) == []


def test_a_first_run_has_nothing_to_compare_against():
    assert store.validate({"SIF-3": {"2026-08-20": 10.0}}, {}) == []


# ── what to ask AMFI for ────────────────────────────────────────────────────

FLOOR = date(2025, 10, 8)


def test_an_empty_store_asks_from_the_very_first_day():
    frm, to = store.fetch_window({}, "2026-08-20", FLOOR)
    assert (frm, to) == (FLOOR, date(2026, 8, 20))


def test_a_current_store_still_asks_for_the_name_window():
    """
    Even with nothing to backfill, the window has to be wide enough for the
    catalogue to read every active fund's plan out of the NAV Names in the same
    response.
    """
    series = {"SIF-3": {"2026-08-20": 10.0}}
    frm, to = store.fetch_window(series, "2026-08-20", FLOOR)
    assert (to - frm).days == store.NAME_WINDOW_DAYS


def test_a_long_outage_widens_the_window_to_cover_it():
    series = {"SIF-3": {"2025-11-03": 10.0}}
    frm, to = store.fetch_window(series, "2026-08-20", FLOOR)
    assert frm == date(2025, 11, 3)


def test_the_window_never_starts_before_amfi_has_data():
    frm, _to = store.fetch_window({}, "2025-10-20", FLOOR)
    assert frm == FLOOR


def test_the_window_never_starts_after_the_last_published_day():
    """
    Whatever else widens it, the window may never BEGIN after the last day held,
    or those days are skipped for good. Re-asking for the last day itself costs
    one duplicated row, which merges away, and completes a day that was only
    half-written when a run was interrupted.
    """
    for last, cap in [("2026-06-01", "2026-06-30"),
                      ("2026-08-19", "2026-08-20"),
                      ("2025-11-03", "2026-08-20")]:
        frm, to = store.fetch_window({"SIF-3": {last: 10.0}}, cap, FLOOR)
        assert frm <= date.fromisoformat(last), (last, cap, frm)
        assert (to - frm).days >= store.NAME_WINDOW_DAYS


# ── alignment with the mutual fund desk ─────────────────────────────────────

def test_the_cap_is_the_same_function_the_mf_desk_uses():
    """
    Not a copy of the rule — the rule itself. If these ever diverge the two
    dashboards would publish different as-of dates from the same run.
    """
    from scripts.build_db_from_api import previous_business_close
    assert store.cap_date() == previous_business_close()


def test_the_move_tripwire_is_shared_with_the_mf_desk():
    from scripts.amfi_topup import MAX_ONE_DAY_MOVE
    assert store.MAX_ONE_DAY_MOVE is MAX_ONE_DAY_MOVE


def test_summarise_reports_the_whole_record():
    series = {"SIF-3": {"2025-10-08": 10.0, "2026-08-20": 11.0},
              "SIF-7": {"2026-08-20": 10.9}}
    assert store.summarise(series) == {
        "funds": 2, "rows": 3, "days": 2,
        "first": "2025-10-08", "last": "2026-08-20"}
