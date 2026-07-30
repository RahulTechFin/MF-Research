"""
yahoo_chart.py — daily index closes from Yahoo Finance's v8 chart API.

WHY THIS EXISTS
---------------
Both download paths in backfill_indices.fetch_yahoo are dead:

  1. yf.download()  (yfinance 0.2.54) -> YFRateLimitError on every ticker
  2. /v7/finance/download CSV fallback -> the endpoint Yahoo retired

The failure is silent in production. daily_run.py catches the top-up error as
non-fatal (correctly — good NAV data should still publish), so the run reports
success while Market Pulse quietly serves closes that are weeks stale. That is
how the committed history drifted 20 days behind.

The v8 chart endpoint newer yfinance releases use is NOT rate-limited from the
same IP that yf.download() is blocked on. It is one small JSON GET per ticker
and needs no pandas, so topping up 31 tickers costs a few hundred KB of peak
memory instead of a 31-column MultiIndex frame.

Returns plain (date, close) tuples — callers decide whether they want a frame.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta, timezone

import requests

log = logging.getLogger("yahoo_chart")

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"

# Yahoo serves the v8 endpoint to browsers; a default python-requests UA gets
# throttled far sooner.
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")

DEFAULT_TIMEOUT = 30
MAX_ATTEMPTS = 3

# A NOTE ON SPARSE SERIES, because it looks like a bug and is not.
#
# The thinner NSE symbols have real multi-day gaps in Yahoo's history. Measured
# on 2026-07-29, asking ^CNXAUTO for 2026-07-20..today returns a single bar
# (2026-07-29) whether you ask by period1/period2 or by range=6mo/1y/10y — the
# wide ranges return 115/238/2443 bars overall, but still only that one inside
# the window. So one row back from a ten-day top-up is the honest answer for
# that ticker, not a truncated response.
#
# ^NSEI and the other seven Market Pulse tickers have no such gaps (8 bars over
# the same window, matching the database exactly). Two tickers are worse than
# sparse and have no usable history at all — see KNOWN_NO_HISTORY.
#
# period1/period2 is used rather than range= so a daily top-up transfers only
# the days it needs.
KNOWN_NO_HISTORY = {
    # Return exactly one bar (today's quote) at every range up to max, so they
    # can never build a series. The tickers need replacing; neither is on
    # Market Pulse today.
    "NIFTY_MICROCAP250.NS": "NIFTY MICROCAP 250 (index_id 19)",
    "NIFTY_CPSE.NS": "NIFTY CPSE (index_id 34)",
}


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": _UA,
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
    })
    return s


def _epoch(d: str | date) -> int:
    if isinstance(d, str):
        d = datetime.strptime(d, "%Y-%m-%d").date()
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def fetch_daily_closes(
    ticker: str,
    start: str | date,
    end: str | date | None = None,
    session: requests.Session | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    pause: float = 0.4,
) -> list[tuple[str, float]] | None:
    """
    Daily closes for `ticker` between start and end, inclusive of both ends.

    Returns [(YYYY-MM-DD, close), ...] oldest first, or None if every attempt
    failed. An empty list means "the request worked and there are no rows in
    that window" — a young index, or a range covering only holidays. Callers
    must distinguish the two: None is an error, [] is not.
    """
    sess = session or make_session()
    start_d = datetime.strptime(start, "%Y-%m-%d").date() if isinstance(start, str) else start
    end_d = end if end is not None else date.today()
    if isinstance(end_d, str):
        end_d = datetime.strptime(end_d, "%Y-%m-%d").date()

    params = {
        "period1": _epoch(start_d),
        # +1 day so today's bar is included once it is published; the response is
        # clipped to end_d below regardless.
        "period2": _epoch(end_d + timedelta(days=1)),
        "interval": "1d",
        # Adjusted closes, so an ETF like GOLDBEES.NS is dividend-adjusted the
        # way the old auto_adjust=True call was. Indices are unaffected.
        "events": "div,splits",
        "includeAdjustedClose": "true",
    }

    last_err = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            if pause:
                time.sleep(pause)
            r = sess.get(CHART_URL.format(ticker=ticker), params=params, timeout=timeout)

            # 404 = the symbol does not exist. Retrying cannot help, and the
            # caller needs to see it as a real failure to fix the ticker.
            if r.status_code == 404:
                log.warning("  %s: HTTP 404 — ticker does not exist on Yahoo", ticker)
                return None
            if r.status_code == 429:
                last_err = "HTTP 429 rate limited"
                log.warning("  %s: rate limited (attempt %d/%d)", ticker, attempt, MAX_ATTEMPTS)
                time.sleep(5 * attempt)
                continue
            if r.status_code != 200:
                last_err = f"HTTP {r.status_code}"
                time.sleep(2 * attempt)
                continue

            payload = r.json()
            chart = payload.get("chart") or {}
            if chart.get("error"):
                log.warning("  %s: Yahoo error %s", ticker, chart["error"])
                return None
            results = chart.get("result") or []
            if not results:
                return []

            res = results[0]
            stamps = res.get("timestamp") or []
            if not stamps:
                return []          # valid symbol, no bars in this window

            quote = (res.get("indicators", {}).get("quote") or [{}])[0]
            closes = quote.get("close") or []
            # adjclose is only present when includeAdjustedClose is honoured.
            adj_block = res.get("indicators", {}).get("adjclose") or []
            adj = (adj_block[0].get("adjclose") if adj_block else None) or []

            # A daily bar's timestamp is the session open in UTC. Shifting by the
            # exchange offset before taking the date keeps an NSE bar on its IST
            # calendar day rather than sliding it a day earlier.
            offset = res.get("meta", {}).get("gmtoffset") or 0

            out: list[tuple[str, float]] = []
            for i, ts in enumerate(stamps):
                px = None
                if i < len(adj) and adj[i] is not None:
                    px = adj[i]
                elif i < len(closes) and closes[i] is not None:
                    px = closes[i]
                if px is None:
                    continue       # Yahoo pads holidays/halts with nulls
                d = datetime.fromtimestamp(ts + offset, tz=timezone.utc).date()
                out.append((d.isoformat(), round(float(px), 4)))

            # The range is deliberately wider than asked for, so clip here.
            # Same date twice would violate the (index_id, date) primary key.
            lo, hi = start_d.isoformat(), end_d.isoformat()
            deduped: dict[str, float] = {}
            for d, px in out:
                if lo <= d <= hi:
                    deduped[d] = px
            return sorted(deduped.items())

        except Exception as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            log.warning("  %s: %s (attempt %d/%d)", ticker, last_err, attempt, MAX_ATTEMPTS)
            time.sleep(2 * attempt)

    log.error("  %s: all %d attempts failed (%s)", ticker, MAX_ATTEMPTS, last_err)
    return None
