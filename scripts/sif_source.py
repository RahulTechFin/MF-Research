"""
sif_source.py — AMFI's two SIF feeds, fetched and parsed.

    SIF_NAVAll.txt                  today's snapshot, one row per scheme
    SIF_DownloadNAVHistoryReport    any date range, one row per scheme per day

BOTH ARE NEEDED, and not for the reason you would guess. The history report is
not merely the older data — it is the BETTER DESCRIBED data. Its second column
is a NAV Name that spells the plan and option out in full:

    SIF-40  Arudha Hybrid Long-Short Fund-Regular Plan-Growth

whereas the same scheme in SIF_NAVAll.txt arrives with both columns empty:

    SIF-40;INF194K30010;-;Arudha Hybrid Long-Short Fund;;;10.351;20-Aug-2026

22 of today's 112 rows are blank in the snapshot that way. The history report
fills in 11 of them from its columns outright, and its NAV Name settles the rest
bar four. So the snapshot supplies the current universe and the latest NAV, and
the history report supplies the description. Neither alone is enough.

WHAT DIFFERS FROM THE MUTUAL FUND FEEDS
  * Scheme codes are strings — "SIF-40", not 119551. Anything that assumed
    isdigit() on the MF side needs to be told otherwise here.
  * Column ORDER differs between the two SIF feeds (the ISINs and the name swap
    places), so both are read through the header row rather than by position.
  * Hybrid strategies are published under "Interval Fund Schemes(...)". The MF
    catalogue skips every section that is not open-ended, because there they are
    FMPs. Doing that here would silently delete both hybrid strategies — half the
    SIF universe. Structure is recorded, never used to exclude.

FIRST AVAILABLE DAY
Asking for a range starting 01-Apr-2025 returns nothing before 2025-10-08, so
that is where SIF history begins. Probed, not assumed.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from datetime import date, datetime

import requests

log = logging.getLogger("sif_source")

NAVALL_URL = "https://portal.amfiindia.com/spages/SIF_NAVAll.txt"
HISTORY_URL = "https://portal.amfiindia.com/SIF_DownloadNAVHistoryReport.aspx"

# The oldest day AMFI will serve. See the module docstring.
HISTORY_START = date(2025, 10, 8)

REQUEST_TIMEOUT = 240
RETRY_DELAYS = [2, 5, 15]

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/125.0 Safari/537.36")


@dataclass
class Row:
    """One feed line, normalised. `nav_date` is ISO; None means unparseable."""
    scheme_code: str
    name: str
    plan_col: str
    option_col: str
    isin: str
    isin_reinvest: str
    nav: float | None
    nav_date: str | None
    structure: str      # "Open Ended" | "Interval Fund" | ...
    section: str        # the text inside the parentheses
    amc: str
    source: str         # "navall" | "history"


# ── fetching ────────────────────────────────────────────────────────────────

def fetch(url: str, params: dict | None = None, retries: int = 3) -> str | None:
    """GET with retries. Returns text, or None once the retries are spent."""
    for attempt, delay in enumerate([0] + RETRY_DELAYS[:retries - 1], 1):
        if delay:
            time.sleep(delay)
        try:
            r = requests.get(url, params=params, headers={"User-Agent": _UA},
                             timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            # AMFI declares ISO-8859-1 and sends UTF-8. Decoding by the
            # declaration mangled an apostrophe on the MF side and silently
            # broke a section header match; decode UTF-8 first here too.
            try:
                text = r.content.decode("utf-8")
            except UnicodeDecodeError:
                text = r.text
            if text.strip():
                return text
            log.warning("Empty body on attempt %d — retrying", attempt)
        except Exception as exc:
            log.warning("Attempt %d failed: %s", attempt, exc)
    return None


def _amfi_date(d: date) -> str:
    return d.strftime("%d-%b-%Y")


def fetch_navall() -> str | None:
    """Today's snapshot."""
    return fetch(NAVALL_URL)


def fetch_history(frm: date, to: date) -> str | None:
    """
    Every NAV between two dates, inclusive.

    The endpoint honours a range and does not appear to cap one: a single
    2025-09-01..2026-08-21 request returned the same 11,297 (code, date) pairs as
    eleven month-by-month requests, with nothing in either set that was missing
    from the other. Callers still chunk (see fetch_history_chunked) because that
    was measured on 112 schemes, and a cap we cannot see would show up as
    quietly missing days rather than an error.
    """
    return fetch(HISTORY_URL, {"frmdt": _amfi_date(frm), "todt": _amfi_date(to)})


def fetch_history_chunked(frm: date, to: date, months: int = 6):
    """
    Yield (window_start, window_end, text) over the range, in windows.

    Deliberately overlapping-safe: every row is keyed by (scheme_code, date)
    downstream, so a day appearing in two windows merges rather than duplicates.
    """
    cur = frm
    while cur <= to:
        y, m = cur.year, cur.month + months
        y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
        end = min(to, date(y, m, 1))
        text = fetch_history(cur, end)
        yield cur, end, text
        if end >= to:
            break
        cur = end


# ── parsing ─────────────────────────────────────────────────────────────────

# "Open Ended Schemes(Equity Oriented ... )" and, with spaces inside the
# parentheses, "Interval Fund Schemes ( Hybrid ... )". Both feeds, both spacings.
_SECTION = re.compile(r"^(.*?)\s*Schemes?\s*\(\s*(.*?)\s*\)\s*$", re.I)

_MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def parse_date(raw: str) -> str | None:
    """
    "20-Aug-2026" -> "2026-08-20". None if it is not a date.

    Range-checked rather than reformatted. On the MF side an already-ISO string
    also split into three parts and came back as '0019-08-2026'; the same shape
    of bug would be invisible here.
    """
    parts = (raw or "").strip().split("-")
    if len(parts) != 3:
        return None
    try:
        day = int(parts[0])
        month = int(parts[1]) if parts[1].isdigit() else _MONTHS[parts[1][:3].title()]
        year = int(parts[2])
    except (ValueError, KeyError):
        return None
    if not (1 <= day <= 31 and 1 <= month <= 12 and 2000 <= year <= 2100):
        return None
    return f"{year:04d}-{month:02d}-{day:02d}"


def _index_map(header: str) -> dict[str, int | None]:
    """
    Column positions read from the header, because the two feeds order them
    differently:

        navall   code ; isin ; isin_reinvest ; name ; plan ; option ; nav ; date
        history  code ; name ; plan ; option  ; isin ; isin_reinvest ; nav ; date

    Naming the columns instead of counting them also means a future reordering,
    or the rename that once collapsed the MF parse to 353 records, cannot pass
    unnoticed: a required column simply comes back None.
    """
    cols = [h.strip().lower() for h in header.split(";")]

    def find(*needles: str) -> int | None:
        for i, h in enumerate(cols):
            if any(n in h for n in needles):
                return i
        return None

    return {
        "code": find("scheme code"),
        "name": find("nav name", "scheme name"),
        "plan": find("plan"),
        "option": find("option"),
        "isin": find("isin div payout", "isin growth"),
        "isin_reinvest": find("isin div reinvestment"),
        "nav": find("net asset value"),
        "date": find("date"),
    }


def parse(text: str, source: str) -> tuple[list[Row], dict]:
    """
    Feed text -> (rows, stats).

    stats carries what was skipped and why, so a feed that changes shape shows up
    as a number rather than as a shorter list nobody looks at.
    """
    stats = {"lines": 0, "rows": 0, "no_header": 0, "short": 0,
             "bad_date": 0, "bad_nav": 0, "no_section": 0, "unnamed": 0}
    rows: list[Row] = []
    idx: dict[str, int | None] | None = None
    structure = section = amc = ""

    for line in text.splitlines():
        s = line.strip()
        stats["lines"] += 1
        if not s:
            continue

        if "scheme code" in s.lower() and ";" in s:
            idx = _index_map(s)
            continue

        m = _SECTION.match(s)
        if m and ";" not in s:
            structure = " ".join(m.group(1).split())
            section = " ".join(m.group(2).split())
            continue

        if ";" not in s:
            # Neither a header nor a section: AMFI prints the AMC name bare.
            amc = s
            continue

        if idx is None:
            stats["no_header"] += 1
            continue

        f = [c.strip() for c in s.split(";")]
        need = [idx["code"], idx["name"], idx["nav"], idx["date"]]
        if any(i is None for i in need) or len(f) <= max(i for i in need if i is not None):
            stats["short"] += 1
            continue

        def get(key: str) -> str:
            i = idx[key]
            return f[i] if i is not None and i < len(f) else ""

        code = get("code")
        if not code:
            stats["short"] += 1
            continue

        iso = parse_date(get("date"))
        if iso is None:
            stats["bad_date"] += 1
            continue
        try:
            nav = float(get("nav"))
        except ValueError:
            nav = None
            stats["bad_nav"] += 1
        if not section:
            stats["no_section"] += 1
        if not get("name"):
            stats["unnamed"] += 1

        rows.append(Row(
            scheme_code=code,
            name=get("name"),
            plan_col=get("plan"),
            option_col=get("option"),
            isin=get("isin"),
            isin_reinvest=get("isin_reinvest"),
            nav=nav,
            nav_date=iso,
            structure=structure,
            section=section,
            amc=amc,
            source=source,
        ))
        stats["rows"] += 1

    return rows, stats


# ── plan and option ─────────────────────────────────────────────────────────
#
# Two independent readings of the same fact: the Plan / Option COLUMNS, and the
# words in the NAV Name. The column wins when it says anything at all; the name
# is the fallback for the 22 rows where it does not.

_IDCW = re.compile(r"idcw|dividend|income\s*distribution|payout|reinvest", re.I)
_GROWTH = re.compile(r"growth|cumulative", re.I)
_REGULAR = re.compile(r"regular", re.I)
# Substring, not \b: AMFI publishes "RegularPlan" with no space (SIF-117) and
# "Direct  Plan" with two (SIF-14). A word boundary matches neither.
_DIRECT = re.compile(r"direct", re.I)


def classify_option(option_col: str, name: str) -> str:
    """'growth' | 'idcw' | 'ambiguous' | 'unknown'."""
    for text in (option_col, name):
        if not (text or "").strip():
            continue
        g, d = bool(_GROWTH.search(text)), bool(_IDCW.search(text))
        if g and d:
            return "ambiguous"
        if g:
            return "growth"
        if d:
            return "idcw"
    return "unknown"


def classify_plan(plan_col: str, name: str) -> str:
    """'regular' | 'direct' | 'ambiguous' | 'silent'."""
    for text in (plan_col, name):
        if not (text or "").strip():
            continue
        r, d = bool(_REGULAR.search(text)), bool(_DIRECT.search(text))
        if r and d:
            return "ambiguous"
        if r:
            return "regular"
        if d:
            return "direct"
    return "silent"


# Everything that describes a share class rather than the fund itself. Stripped
# to leave a name that a Direct row and its Regular sibling both reduce to, so
# the two can be recognised as one fund.
_SHARE_CLASS_WORDS = re.compile(
    r"regular\s*plan|direct\s*plan|regular|direct|plan"
    r"|income\s*distribution\s*cum\s*capital\s*withdrawal"
    r"|growth\s*option|growth|cumulative"
    r"|idcw|dividend|payout|reinvestment|reinvest|option"
    r"|fortnightly|monthly|quarterly|half\s*yearly|annual|daily|weekly",
    re.I)


def fund_base(name: str) -> str:
    """
    A name with every share-class word removed and punctuation flattened.

    "iSIF Equity Ex-Top 100 Long-Short Fund - Direct Plan - Growth"
    "iSIF Equity Ex-Top 100 Long-Short Fund - Growth"
        both -> "isif equity ex top 100 long short fund"

    Flattening punctuation matters as much as the words: the same fund is spelt
    "Equity Ex- Top 100 Long - Short" by one AMC and "Equity Ex-Top 100
    Long-Short" by another.
    """
    s = _SHARE_CLASS_WORDS.sub(" ", name or "")
    s = re.sub(r"[^0-9a-z]+", " ", s.lower())
    return " ".join(s.split())
