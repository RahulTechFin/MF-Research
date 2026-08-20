"""
Locks the AMFI latest-day top-up.

THE RULES
  1. Matching is by SCHEME CODE ONLY. The Plan and Option columns are never read
     for filtering. They are blank on 6,598 of the file's 14,283 rows, including
     genuine Regular-Growth funds, and filtering on them dropped 1,368 of 2,910
     funds in measurement. A scheme code already identifies one plan and one
     option, so the Regular-Growth decision stays in amfi_catalogue where it is
     made when the universe is built.

  2. History is never rewritten. Only dates strictly newer than a fund's own
     latest NAV are inserted, so api.mfapi.in stays authoritative on history and
     the top-up can only ever add the one day AMFI is ahead by.

  3. A NAV moving more than MAX_ONE_DAY_MOVE in a day is refused, and the mfapi
     value kept. The widest real one-day move measured across 400 funds was
     1.386%; this catches NAV re-denominations, not market moves.

  4. The top-up never aborts a build. An unreachable, empty or truncated file
     costs one day of freshness and nothing else.

  5. Two date formats are in play and they are easy to confuse: AMFI writes
     '19-Aug-2026', api.mfapi.in writes '18-08-2026'. Both must parse.

Run:  python -m pytest tests/test_amfi_topup.py -q
      python tests/test_amfi_topup.py
"""

from __future__ import annotations

import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from scripts.amfi_topup import (  # noqa: E402
    MAX_ONE_DAY_MOVE, MIN_ROWS, parse_nav_date, parse_navall, top_up,
)

HEADER = ("Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;"
          "Scheme Name;Plan;Option;Net Asset Value;Date")


def row(code, name, plan, option, nav, date):
    return f"{code};INF000A;INF000B;{name};{plan};{option};{nav};{date}"


def make_db(navs):
    """In-memory DB holding just enough schema for the top-up. navs: {code: [(date, nav)]}"""
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE schemes (scheme_code TEXT PRIMARY KEY, "
                 "scheme_name TEXT, is_active INTEGER DEFAULT 1)")
    conn.execute("CREATE TABLE nav_history (scheme_code TEXT, nav_date TEXT, "
                 "nav REAL, PRIMARY KEY (scheme_code, nav_date))")
    for code, series in navs.items():
        conn.execute("INSERT INTO schemes(scheme_code, scheme_name, is_active) "
                     "VALUES(?,?,1)", (code, f"Fund {code}"))
        conn.executemany("INSERT INTO nav_history VALUES(?,?,?)",
                         [(code, d, v) for d, v in series])
    return conn


def navs_of(conn, code):
    return dict(conn.execute("SELECT nav_date, nav FROM nav_history "
                             "WHERE scheme_code=? ORDER BY nav_date", (code,)))


# ── rule 5: both upstream date formats ───────────────────────────────────────

def test_parses_amfi_month_name():
    assert parse_nav_date("19-Aug-2026") == "2026-08-19"
    assert parse_nav_date("01-Jan-2010") == "2010-01-01"
    assert parse_nav_date(" 25-DEC-2019 ") == "2019-12-25"


def test_parses_mfapi_numeric_month():
    assert parse_nav_date("18-08-2026") == "2026-08-18"
    assert parse_nav_date("01-01-2010") == "2010-01-01"


def test_rejects_unparseable_dates():
    for bad in ("", "N.A.", "2026-08-19", "19/08/2026", "19-Xyz-2026",
                "19-13-2026", "19-00-2026", "not-a-date"):
        assert parse_nav_date(bad) is None, bad


# ── the 8-column file ────────────────────────────────────────────────────────

def test_reads_the_eight_column_layout():
    text = "\n".join([
        "Open Ended Schemes ( Equity Scheme - Large Cap Fund )",
        "Some AMC Mutual Fund",
        HEADER,
        row("100033", "ABSL Large & Mid Cap", "Regular Plan", "Growth",
            "968.4600", "19-Aug-2026"),
    ])
    assert parse_navall(text) == {"100033": ("2026-08-19", 968.46)}


def test_drops_unpriced_and_malformed_rows():
    text = "\n".join([
        HEADER,
        row("1", "Priced", "Regular Plan", "Growth", "10.5", "19-Aug-2026"),
        row("2", "Awaiting first NAV", "Regular Plan", "Growth", "N.A.", "19-Aug-2026"),
        row("3", "Zero", "Regular Plan", "Growth", "0", "19-Aug-2026"),
        row("4", "Negative", "Regular Plan", "Growth", "-3.2", "19-Aug-2026"),
        row("5", "Bad date", "Regular Plan", "Growth", "10.0", "rubbish"),
        "6;INF;INF;Too few columns;19-Aug-2026",
        "A section header with no semicolon at all",
    ])
    assert set(parse_navall(text)) == {"1"}


# ── rule 1: scheme code only, Plan/Option ignored ────────────────────────────

def test_blank_plan_and_option_are_still_taken():
    """
    The single largest group in the real file. 'Taurus Flexi Cap Fund - Regular
    Plan - Growth' is genuinely Regular-Growth but leaves both columns blank, so
    a column filter would wrongly drop it.
    """
    conn = make_db({"113177": [("2026-08-18", 100.0)]})
    text = HEADER + "\n" + row(
        "113177", "Taurus Flexi Cap Fund - Regular Plan - Growth", "", "",
        "101.0", "19-Aug-2026") + "\n" + filler(MIN_ROWS)
    stats = top_up(conn, text)
    assert stats["inserted"] == 1
    assert navs_of(conn, "113177")["2026-08-19"] == 101.0


def test_an_etf_with_no_plan_is_still_taken():
    """ETFs are single-plan, so Plan is blank for all of them by nature."""
    conn = make_db({"120716": [("2026-08-18", 55.0)]})
    text = HEADER + "\n" + row("120716", "Nippon India ETF Nifty 50 BeES", "", "",
                               "55.4", "19-Aug-2026") + "\n" + filler(MIN_ROWS)
    assert top_up(conn, text)["inserted"] == 1


def test_a_code_outside_our_universe_is_ignored():
    """
    The universe already encodes the Regular-Growth choice, so a Direct or IDCW
    code simply is not in it and never gets looked up.
    """
    conn = make_db({"100033": [("2026-08-18", 100.0)]})
    text = "\n".join([
        HEADER,
        row("100033", "Ours", "Regular Plan", "Growth", "101.0", "19-Aug-2026"),
        row("120503", "Axis ELSS - Direct Plan - Growth", "Direct Plan", "Growth",
            "112.0", "19-Aug-2026"),
        row("100034", "Some Fund - IDCW", "Regular Plan", "IDCW", "50.0", "19-Aug-2026"),
        filler(MIN_ROWS),
    ])
    stats = top_up(conn, text)
    assert stats["inserted"] == 1
    assert stats["matched"] == 1
    assert list(navs_of(conn, "100033")) == ["2026-08-18", "2026-08-19"]
    assert conn.execute("SELECT COUNT(*) FROM nav_history WHERE scheme_code IN "
                        "('120503','100034')").fetchone()[0] == 0


def test_inactive_schemes_are_skipped():
    conn = make_db({"100033": [("2026-08-18", 100.0)]})
    conn.execute("UPDATE schemes SET is_active=0 WHERE scheme_code='100033'")
    text = HEADER + "\n" + row("100033", "Ours", "Regular Plan", "Growth",
                               "101.0", "19-Aug-2026") + "\n" + filler(MIN_ROWS)
    assert top_up(conn, text)["inserted"] == 0


# ── rule 2: history is never rewritten ───────────────────────────────────────

def test_only_strictly_newer_dates_are_inserted():
    conn = make_db({"1": [("2026-08-17", 90.0), ("2026-08-18", 100.0)]})
    text = HEADER + "\n" + row("1", "F", "Regular Plan", "Growth",
                               "101.0", "19-Aug-2026") + "\n" + filler(MIN_ROWS)
    top_up(conn, text)
    assert navs_of(conn, "1") == {"2026-08-17": 90.0, "2026-08-18": 100.0,
                                  "2026-08-19": 101.0}


def test_an_equal_date_is_left_alone():
    """AMFI and mfapi agreed on 71 of 72 shared dates; where they disagree, the
    existing value stands rather than being silently replaced."""
    conn = make_db({"1": [("2026-08-19", 100.0)]})
    text = HEADER + "\n" + row("1", "F", "Regular Plan", "Growth",
                               "999.0", "19-Aug-2026") + "\n" + filler(MIN_ROWS)
    stats = top_up(conn, text)
    assert stats["inserted"] == 0
    assert stats["already_current"] == 1
    assert navs_of(conn, "1") == {"2026-08-19": 100.0}


def test_a_stale_amfi_row_never_backdates_history():
    """Wound-up funds still sit in the file with years-old dates -- one of ours
    was last priced 2012-12-17. Those must not be injected as history."""
    conn = make_db({"1": [("2026-08-18", 100.0)]})
    text = HEADER + "\n" + row("1", "F", "Regular Plan", "Growth",
                               "12.0", "17-Dec-2012") + "\n" + filler(MIN_ROWS)
    stats = top_up(conn, text)
    assert stats["inserted"] == 0
    assert navs_of(conn, "1") == {"2026-08-18": 100.0}


def test_a_fund_with_no_history_yet_is_seeded():
    conn = make_db({"1": []})
    text = HEADER + "\n" + row("1", "Newly launched", "Regular Plan", "Growth",
                               "10.0", "19-Aug-2026") + "\n" + filler(MIN_ROWS)
    stats = top_up(conn, text)
    assert stats["inserted"] == 1
    assert stats["no_baseline"] == 1


# ── rule 3: the bad-data tripwire ────────────────────────────────────────────

def test_a_redenomination_is_refused():
    """Bandhan Short Duration Plan D: 12.03 restated as 22.16, a 45.7% jump."""
    conn = make_db({"108719": [("2026-08-18", 12.0338)]})
    text = HEADER + "\n" + row("108719", "Bandhan Short Duration - Plan D - Growth",
                               "Regular Plan", "Growth", "22.1639",
                               "19-Aug-2026") + "\n" + filler(MIN_ROWS)
    stats = top_up(conn, text)
    assert stats["inserted"] == 0
    assert stats["rejected_move"] == 1
    assert navs_of(conn, "108719") == {"2026-08-18": 12.0338}


def test_the_widest_real_move_is_accepted():
    """Franklin Asian Equity fell 1.386% on 19-Aug -- the extreme of 400 funds."""
    conn = make_db({"1": [("2026-08-18", 45.6071)]})
    text = HEADER + "\n" + row("1", "Franklin Asian Equity - Growth", "", "",
                               "44.9748", "19-Aug-2026") + "\n" + filler(MIN_ROWS)
    assert top_up(conn, text)["inserted"] == 1


def test_the_tripwire_sits_far_above_any_market_move():
    assert MAX_ONE_DAY_MOVE >= 0.20, "too tight to be a bad-data check"
    assert MAX_ONE_DAY_MOVE <= 0.50, "too loose to catch a re-denomination"


# ── rule 4: never abort the build ────────────────────────────────────────────

def test_an_unreachable_file_is_survived():
    conn = make_db({"1": [("2026-08-18", 100.0)]})
    stats = top_up(conn, "")
    assert stats["ok"] is False and stats["inserted"] == 0
    assert navs_of(conn, "1") == {"2026-08-18": 100.0}


def test_a_truncated_file_is_refused_wholesale():
    """A short file means a broken download, not a shrunken market. Taking the
    rows it does have would top up a fraction of the universe and leave the
    published as_of meaning different things for different funds."""
    conn = make_db({"1": [("2026-08-18", 100.0)]})
    text = HEADER + "\n" + row("1", "F", "Regular Plan", "Growth",
                               "101.0", "19-Aug-2026")
    stats = top_up(conn, text)
    assert stats["ok"] is False and stats["inserted"] == 0


def test_garbage_is_survived():
    conn = make_db({"1": [("2026-08-18", 100.0)]})
    assert top_up(conn, "<html>502 Bad Gateway</html>")["inserted"] == 0


def filler(n):
    """Rows for codes we do not hold, purely to clear the MIN_ROWS sanity gate."""
    return "\n".join(row(900000 + i, f"Filler {i}", "Regular Plan", "Growth",
                         "10.0", "19-Aug-2026") for i in range(n))


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
