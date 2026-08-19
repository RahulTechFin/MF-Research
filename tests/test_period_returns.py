"""
Locks the month / quarter / year boundary rule.

THE RULE
  A period's START is the last NAV on or before the day BEFORE the period opens,
  i.e. the previous period's closing NAV. Its END is the last NAV on or before
  the period's final day. So:

      January 2025   31-Dec-2024  ->  31-Jan-2025
      Q1 2025        31-Dec-2024  ->  31-Mar-2025
      year 2025      31-Dec-2024  ->  31-Dec-2025

  This is what makes the figures consistent: twelve monthly returns compound to
  the annual return, four quarters compound to the annual return, and each
  matches a point-to-point calculation over the same dates.

  It also matches trailing_return, which already resolved its start with
  NEAREST-PREVIOUS. The periodic functions used NEAREST-NEXT on the period's
  first day, so every period silently dropped its opening day -- monthly chains
  came out 1.72 percentage points short of the year they covered.

  An incomplete period still ends at the fund's own latest NAV (MTD/QTD/YTD).

  A fund with no NAV on or before the day the period opens returns None and shows
  as a dash, rather than a part-period figure dressed up as a full one. That is
  option (a), chosen by the owner, and it is consistent with the pre-existing
  eligibility rule that already refused a period starting before the fund's first
  NAV.

Run:  python -m pytest tests/test_period_returns.py -q
      python tests/test_period_returns.py
"""

from __future__ import annotations

import datetime
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

RATE = 1.001            # +0.1% every calendar day, so the answer is arithmetic
AS_OF = datetime.date(2026, 6, 30)
FIRST = datetime.date(2010, 1, 1)


def _build(first: datetime.date = FIRST, last: datetime.date = AS_OF):
    """A fund and an index with a NAV every calendar day, +0.1% a day."""
    path = os.path.join(tempfile.mkdtemp(), 'p.db')
    os.environ['MF_DB_PATH'] = path
    from scripts.init_db import create_schema
    conn = sqlite3.connect(path)
    create_schema(conn)
    conn.execute("INSERT INTO amcs(amc_id,amc_name) VALUES(1,'A')")
    conn.execute("INSERT INTO categories(category_id,asset_class,category_name,slug,"
                 "display_order) VALUES(1,'Equity','C','c',1)")
    conn.execute("INSERT INTO schemes(scheme_code,scheme_name,amc_id,category_id,"
                 "is_active) VALUES('1','F',1,1,1)")
    conn.execute("INSERT INTO benchmarks(index_id,index_name,yahoo_ticker,is_synthetic,"
                 "is_active) VALUES(1,'IDX','^X',0,1)")
    d, v = first, 100.0
    while d <= last:
        conn.execute('INSERT INTO nav_history(scheme_code,nav_date,nav) VALUES(?,?,?)',
                     ('1', d.isoformat(), v))
        conn.execute('INSERT INTO index_history(index_id,date,close) VALUES(?,?,?)',
                     (1, d.isoformat(), v))
        v *= RATE
        d += datetime.timedelta(days=1)
    conn.commit()
    return conn


def _span(start_excl: datetime.date, end: datetime.date) -> int:
    """Days from the close BEFORE the period to the period's last day."""
    return (end - (start_excl - datetime.timedelta(days=1))).days


def test_month_starts_at_the_previous_close():
    from engine.calculation_engine import month_return
    conn = _build()
    for y, m in ((2025, 1), (2025, 2), (2025, 6), (2024, 2)):   # incl. a leap Feb
        first = datetime.date(y, m, 1)
        last = (datetime.date(y + (m == 12), (m % 12) + 1, 1)
                - datetime.timedelta(days=1))
        want = RATE ** _span(first, last) - 1
        got = month_return(conn, '1', y, m, as_of=AS_OF)
        assert got is not None and abs(got - want) < 1e-9, \
            f'{y}-{m:02d}: got {got}, want {want}'
    conn.close()


def test_quarter_starts_at_the_previous_close():
    from engine.calculation_engine import quarter_return
    conn = _build()
    bounds = {1: ((1, 1), (3, 31)), 2: ((4, 1), (6, 30)),
              3: ((7, 1), (9, 30)), 4: ((10, 1), (12, 31))}
    for q, ((sm, sd), (em, ed)) in bounds.items():
        want = RATE ** _span(datetime.date(2025, sm, sd),
                             datetime.date(2025, em, ed)) - 1
        got = quarter_return(conn, '1', 2025, q, as_of=AS_OF)
        assert got is not None and abs(got - want) < 1e-9, f'Q{q}: {got} != {want}'
    conn.close()


def test_year_starts_at_the_previous_close():
    from engine.calculation_engine import annual_return
    conn = _build()
    got = annual_return(conn, '1', 2025, as_of=AS_OF)
    want = RATE ** 365 - 1                     # 31-Dec-24 -> 31-Dec-25
    assert got is not None and abs(got - want) < 1e-9, f'{got} != {want}'
    conn.close()


def test_the_pieces_compound_to_the_year():
    """The whole point: months, quarters and the year must agree."""
    from engine.calculation_engine import month_return, quarter_return, annual_return
    conn = _build()
    year = RATE ** 365 - 1

    months = 1.0
    for m in range(1, 13):
        months *= 1 + month_return(conn, '1', 2025, m, as_of=AS_OF)
    quarters = 1.0
    for q in range(1, 5):
        quarters *= 1 + quarter_return(conn, '1', 2025, q, as_of=AS_OF)

    assert abs((months - 1) - year) < 1e-9, f'12 months = {months-1}, year = {year}'
    assert abs((quarters - 1) - year) < 1e-9, f'4 quarters = {quarters-1}, year = {year}'
    assert abs(annual_return(conn, '1', 2025, as_of=AS_OF) - year) < 1e-9
    conn.close()


def test_index_matches_fund():
    from engine.calculation_engine import (
        month_return, quarter_return, annual_return,
        month_return_index, quarter_return_index, annual_return_index,
    )
    conn = _build()
    assert abs(month_return(conn, '1', 2025, 6, as_of=AS_OF)
               - month_return_index(conn, 1, 2025, 6, as_of=AS_OF)) < 1e-12
    assert abs(quarter_return(conn, '1', 2025, 2, as_of=AS_OF)
               - quarter_return_index(conn, 1, 2025, 2, as_of=AS_OF)) < 1e-12
    assert abs(annual_return(conn, '1', 2025, as_of=AS_OF)
               - annual_return_index(conn, 1, 2025, as_of=AS_OF)) < 1e-12
    conn.close()


def test_option_a_no_previous_close_means_no_return():
    """
    A fund that launched inside the period has no previous close, so the period
    is not reported at all. Option (a): a dash, never a part-period figure.
    """
    from engine.calculation_engine import month_return, quarter_return, annual_return
    launch = datetime.date(2025, 2, 10)
    conn = _build(first=launch)

    # February 2025 opens before the fund existed -> nothing to report.
    assert month_return(conn, '1', 2025, 2, as_of=AS_OF) is None
    assert quarter_return(conn, '1', 2025, 1, as_of=AS_OF) is None
    assert annual_return(conn, '1', 2025, as_of=AS_OF) is None

    # March 2025 has 28-Feb available as its previous close -> reported.
    got = month_return(conn, '1', 2025, 3, as_of=AS_OF)
    want = RATE ** _span(datetime.date(2025, 3, 1), datetime.date(2025, 3, 31)) - 1
    assert got is not None and abs(got - want) < 1e-9, f'{got} != {want}'

    # And a whole year the fund lived through is fine.
    assert annual_return(conn, '1', 2026, as_of=AS_OF) is not None
    conn.close()


def test_current_period_is_still_to_date():
    """An incomplete period ends at the fund's latest NAV, not the period end."""
    from engine.calculation_engine import month_return, quarter_return, annual_return
    conn = _build()
    # AS_OF is 30 Jun 2026: June, Q2 and 2026 are all in progress.
    mtd = month_return(conn, '1', 2026, 6, as_of=AS_OF)
    want_mtd = RATE ** _span(datetime.date(2026, 6, 1), AS_OF) - 1
    assert mtd is not None and abs(mtd - want_mtd) < 1e-9, f'{mtd} != {want_mtd}'

    qtd = quarter_return(conn, '1', 2026, 2, as_of=AS_OF)
    want_qtd = RATE ** _span(datetime.date(2026, 4, 1), AS_OF) - 1
    assert qtd is not None and abs(qtd - want_qtd) < 1e-9, f'{qtd} != {want_qtd}'

    ytd = annual_return(conn, '1', 2026, as_of=AS_OF)
    want_ytd = RATE ** _span(datetime.date(2026, 1, 1), AS_OF) - 1
    assert ytd is not None and abs(ytd - want_ytd) < 1e-9, f'{ytd} != {want_ytd}'
    conn.close()


def test_trailing_returns_unchanged():
    """Trailing was already correct and must stay exact."""
    from engine.calculation_engine import (
        trailing_return, TRAILING_PERIODS, _subtract_period,
    )
    conn = _build()
    for p in ('1M', '3M', '6M', '12M'):
        span = (AS_OF - _subtract_period(AS_OF, **TRAILING_PERIODS[p])).days
        got = trailing_return(conn, '1', p, as_of=AS_OF)
        assert abs(got - (RATE ** span - 1)) < 1e-9, p
    for p in ('3Y', '5Y', '10Y'):
        got = trailing_return(conn, '1', p, as_of=AS_OF)
        assert abs(got - (RATE ** 365 - 1)) < 1e-9, f'{p} CAGR drifted'
    conn.close()


if __name__ == '__main__':
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            try:
                fn()
                print(f'  PASS  {name}')
            except AssertionError as exc:
                fails += 1
                print(f'  FAIL  {name}: {exc}')
    print()
    print('period boundaries are locked' if not fails else f'{fails} test(s) FAILED')
    sys.exit(1 if fails else 0)
