"""
Locks the incremental NAV history path.

The daily run no longer re-downloads every fund's whole history from
api.mfapi.in. It reads back what was published to Supabase and lets AMFI add the
one day it knows about — the same shape scripts/index_store has always used for
the 8 Market Pulse indices.

    Supabase nav/<code>.json  ──pull──►  add today from AMFI  ──gate──►  DB

WHAT THESE TESTS PROTECT
The failure that matters is silent: overwrite a good history with a short one and
returns simply start reading None. Nothing errors, nothing looks broken, the
numbers are just wrong. So the gate is the point of this module, and these tests
pin it.

AMFI IS ONLY EVER ALLOWED TO ADD A DATE. It may not rewrite a day the fund
already has: the published value came from the same source a day earlier, and
rewriting history is what this design exists to avoid.

Run:  python -m pytest tests/test_nav_store.py -q
"""

from __future__ import annotations

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from scripts.nav_store import (  # noqa: E402
    MAX_SHRINK, folders_for, merge_amfi, nav_remote_path, parse_published,
    summarise, validate,
)


def published(series):
    """A nav/<code>.json body as the pipeline writes it."""
    return json.dumps({"scheme_code": "1", "scheme_name": "X",
                       "series": [[d, v] for d, v in sorted(series.items())]}
                      ).encode()


# ── reading a published file ────────────────────────────────────────────────

def test_a_published_file_round_trips():
    s = {"2026-08-18": 100.0, "2026-08-19": 101.5}
    assert parse_published(published(s)) == s


def test_junk_rows_are_dropped_not_fatal():
    body = json.dumps({"series": [["2026-08-18", 100.0], ["2026-08-19", 0],
                                  ["2026-08-20", "abc"], ["bad"], None]}).encode()
    assert parse_published(body) == {"2026-08-18": 100.0}


def test_an_unreadable_file_reads_as_absent():
    """Absent means "bootstrap this fund", which is survivable. Raising is not."""
    assert parse_published(b"<html>502</html>") == {}
    assert parse_published(b"") == {}


def test_the_remote_path_matches_the_published_layout():
    assert nav_remote_path("103174", "equity/large-cap") == \
        "equity/large-cap/nav/103174.json"


# ── locating a fund without a previous build ────────────────────────────────

def test_folders_come_from_the_catalogue_not_a_previous_build():
    """
    This runs BEFORE the build, so it cannot read the flat category files
    publish_data.load_maps uses — they do not exist yet on a clean machine.
    """
    folders, unplaced = folders_for([
        {"scheme_code": "103174", "category_name": "Large Cap"},
        {"scheme_code": "100835", "category_name": "Liquid Fund"},
        {"scheme_code": "999999", "category_name": "Retirement"},
        {"scheme_code": "888888", "category_name": None},
    ])
    assert folders["103174"] == "equity/large-cap"
    assert folders["100835"] == "debt/liquid"
    assert folders["999999"] == "other/retirement"
    assert unplaced == ["888888"]


# ── AMFI may only extend ───────────────────────────────────────────────────

def test_amfi_adds_the_new_day():
    series = {"1": {"2026-08-18": 100.0}}
    stats = merge_amfi(series, {"1": ("2026-08-19", 101.0)})
    assert series["1"] == {"2026-08-18": 100.0, "2026-08-19": 101.0}
    assert stats["extended"] == 1


def test_amfi_never_rewrites_a_day_we_already_have():
    series = {"1": {"2026-08-19": 100.0}}
    stats = merge_amfi(series, {"1": ("2026-08-19", 999.0)})
    assert series["1"] == {"2026-08-19": 100.0}, "history must not be rewritten"
    assert stats["already_current"] == 1


def test_a_stale_amfi_row_cannot_backdate_a_series():
    """AMFI keeps listing wound-up schemes at the price they died at."""
    series = {"1": {"2026-08-18": 100.0, "2026-08-19": 101.0}}
    stats = merge_amfi(series, {"1": ("2012-12-17", 12.0)})
    assert "2012-12-17" not in series["1"]
    assert stats["already_current"] == 1


def test_the_previous_day_cap_still_applies():
    series = {"1": {"2026-08-18": 100.0}}
    stats = merge_amfi(series, {"1": ("2026-08-20", 102.0)}, cap="2026-08-19")
    assert series["1"] == {"2026-08-18": 100.0}
    assert stats["capped"] == 1


def test_a_fund_absent_from_amfi_is_left_alone():
    series = {"1": {"2026-08-18": 100.0}}
    stats = merge_amfi(series, {})
    assert series["1"] == {"2026-08-18": 100.0}
    assert stats["absent_from_amfi"] == 1


# ── the gate ───────────────────────────────────────────────────────────────

def test_a_series_that_grew_by_a_day_is_accepted():
    pub = {f"2026-0{m}-01": 100.0 for m in range(1, 9)}
    new = {**pub, "2026-08-19": 101.0}
    assert validate(new, pub) == []


def test_a_shrunken_series_is_refused():
    pub = {f"2020-01-{d:02d}": 100.0 for d in range(1, 21)}
    new = dict(list(pub.items())[:5])          # 25% of what was published
    problems = validate(new, pub)
    assert problems and "shrank" in problems[0]


def test_a_series_going_backwards_in_time_is_refused():
    pub = {"2026-08-01": 100.0, "2026-08-19": 101.0}
    new = {"2026-08-01": 100.0, "2026-08-02": 100.5}
    assert any("backwards" in p for p in validate(new, pub))


def test_an_almost_complete_series_is_still_accepted():
    """
    The shrink floor is a tolerance, not a demand for exactness. An INTERIOR day
    is dropped here on purpose: removing the last one would move the newest date
    backwards and trip a different gate, which is correct but not what this test
    is about.
    """
    pub = {f"2020-01-{d:02d}": 100.0 for d in range(1, 21)}
    new = {d: v for d, v in pub.items() if d != "2020-01-05"}   # 95%
    assert validate(new, pub) == []
    assert MAX_SHRINK <= 0.95


def test_a_brand_new_fund_has_nothing_to_shrink_from():
    assert validate({"2026-08-19": 10.0, "2026-08-18": 9.9}, {}) == []


def test_an_empty_result_is_always_refused():
    """An empty series is the only length that is invalid on its own."""
    assert validate({}, {"2026-08-18": 100.0})
    assert validate({}, {})


def test_a_fund_launched_this_week_is_accepted_with_one_point():
    """
    The three JioBlackRock funds each had a single NAV on their first days. A
    floor of 2 rejected them for no benefit — the published series was that same
    single point, so there was nothing to protect.
    """
    assert validate({"2026-08-19": 10.0}, {}) == []
    assert validate({"2026-08-19": 10.0}, {"2026-08-19": 10.0}) == []


def test_summarise_reports_the_span():
    info = summarise({"1": {"2010-01-01": 1.0, "2026-08-19": 2.0},
                      "2": {"2015-06-01": 3.0}})
    assert info == {"funds": 2, "rows": 3,
                    "oldest": "2010-01-01", "newest": "2026-08-19"}


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
