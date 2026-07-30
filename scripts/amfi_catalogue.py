"""
amfi_catalogue.py — Classify AMFI's published schemes into the platform's universe.

api.mfapi.in supplies NAVs but not category or fund house, and its scheme list
cannot be filtered reliably by name alone: of its 37,693 schemes, 9,659 pass a
Regular-Growth name test, but 6,986 of those are FMPs and closed-ended series
that do not belong, while 949 ETFs that do belong are wrongly rejected.

AMFI's own NAV file solves this, because its section headers carry the SEBI
scheme type and category. This module parses that file and applies the
platform's inclusion rules; scripts/export_catalogue.py turns the result into
data/scheme_catalogue.json.

Extracted from the former backfill_amfi.py — the backfill, gap-repair and
database-upsert machinery around it was deleted along with the persistent
database it wrote to.
"""

import logging
import os
import re
import sys
import time
from datetime import datetime

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

from scripts.init_db import CATEGORY_NORM_MAP

log = logging.getLogger("amfi_catalogue")

# ── constants ─────────────────────────────────────────────────────────────────
AMFI_HIST_URL = (
    "https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx"
    "?tp=1&frmdt={from_dt}&todt={to_dt}"
)
AMFI_DAILY_URL = "https://portal.amfiindia.com/spages/NAVOpen.txt"

REQUEST_TIMEOUT    = 90
RETRY_DELAYS       = [2, 8, 30]
SLEEP_BETWEEN_REQS = 2     # seconds (polite scraping)
MAX_GAP_DAYS       = 5     # consecutive missing trading days triggers repair

EXCLUDE_WORDS_PLAN   = {"direct"}
EXCLUDE_WORDS_OPTION = {"idcw", "dividend", "payout", "reinvest", "bonus"}

# Scheme types we collect — must appear as substring of the type header line
INCLUDE_TYPE_KEYWORDS = {
    "open ended schemes(equity scheme",
    "open ended schemes(hybrid scheme",
    "open ended schemes(debt scheme",
    "open ended schemes(other scheme",
}

# ── helpers ───────────────────────────────────────────────────────────────────

def fetch_with_retry(url: str, retries=3) -> str | None:
    """GET url with retries; returns text or None on persistent failure."""
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0 Safari/537.36"
        )
    }
    for attempt, delay in enumerate([0] + RETRY_DELAYS[:retries - 1], 1):
        if delay:
            time.sleep(delay)
        try:
            r = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            if not r.text.strip():
                log.warning("Empty response on attempt %d → retry", attempt)
                continue
            return r.text
        except Exception as exc:
            log.warning("Attempt %d failed: %s", attempt, exc)
    return None


# Legacy share classes of a scheme that also exists as a plain Regular plan.
# SEBI's 2012–13 single-plan rule retired Institutional / Super Institutional /
# Retail and the old Plan A/B/C split, but AMFI still publishes many of them —
# they duplicate the parent fund in every table. "Unclaimed", "Discontinued" and
# "Segregated" are not investable schemes at all.
LEGACY_PLAN_VARIANT = re.compile(
    r"\b("
    r"plan\s*[-–]?\s*[abc]"
    r"|super\s+institutional"
    r"|institutional"
    r"|retail"
    r"|discontinued"
    r"|unclaimed"
    r"|segregated"
    r")\b",
    re.I,
)


def is_legacy_plan_variant(name: str) -> bool:
    """True for duplicate/non-investable share classes — see LEGACY_PLAN_VARIANT."""
    return bool(LEGACY_PLAN_VARIANT.search(name or ""))


def is_regular_growth(name: str) -> bool:
    """Return True if scheme name qualifies as Regular-Growth."""
    n = name.lower()

    # Duplicate share classes never belong, ETF exemption or not.
    if is_legacy_plan_variant(name):
        return False
    # Exclude Direct plans (unless it is an ETF — checked by caller)
    if any(w in n for w in EXCLUDE_WORDS_PLAN):
        return False
    
    # Must NOT contain IDCW / payout / reinvest / bonus
    option_words = {"idcw", "payout", "reinvest", "bonus"}
    if any(w in n for w in option_words):
        return False
    
    # Normally exclude dividend, except if it is part of "dividend yield" category
    if "dividend" in n:
        if "dividend yield" not in n:
            return False
        # For "dividend yield", check standard payout/reinvestment options
        if any(w in n for w in ["payout", "reinvestment", "reinvest"]):
            return False

    # Must contain 'growth'
    if "growth" not in n:
        return False
    return True


def is_etf_type(type_header: str) -> bool:
    """ETF / Other schemes: skip the 'direct' test (ETFs are single-plan)."""
    return "other scheme" in type_header.lower()


# ── AMFI file parser ──────────────────────────────────────────────────────────

def parse_amfi_text(text: str, is_etf_context=False):
    """
    Parse AMFI semicolon-delimited NAV history text.
    Returns list of dicts: {scheme_code, scheme_name, amc_name, category_name, nav, nav_date, isin}
    """
    records = []
    current_amc      = None
    current_type     = None      # e.g. 'open ended schemes(equity scheme - large cap fund)'
    current_category_raw = None  # raw text inside parentheses after ' - '
    is_etf           = is_etf_context
    header_fields    = None      # column positions for variable-width chunks

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        # Detect column header line (semicolon present, first field = 'Scheme Code')
        if ";" in line and line.lower().startswith("scheme code"):
            header_fields = [f.strip().lower() for f in line.split(";")]
            continue

        # Scheme-type header: no semicolon, matches known type keywords
        low = line.lower()
        matched_type = next(
            (kw for kw in INCLUDE_TYPE_KEYWORDS if low.startswith(kw)), None
        )
        if matched_type or (
            low.startswith("open ended") and ";" not in line
        ):
            current_type = low
            # Extract category raw text: content after ' - ' inside parens
            try:
                inside = line[line.index("(") + 1: line.rindex(")")]
                parts  = inside.split(" - ", 1)
                current_category_raw = parts[1].strip() if len(parts) > 1 else inside.strip()
            except Exception:
                current_category_raw = None

            # The Direct-plan exclusion is skipped only for genuine ETFs, which
            # are single-plan instruments with no Regular/Direct split.
            #
            # This used to test `"other scheme" in low`, but AMFI files Index
            # Funds and both FoF buckets under "Other Scheme" as well — so every
            # index fund and overseas FoF was admitted twice, once per plan.
            # Measured: Index Fund held 394 Direct against 387 Regular.
            # Deciding on the *category* rather than the scheme type keeps real
            # ETFs (which showed 0 duplicates) while excluding the rest.
            is_etf = bool(current_category_raw) and "etf" in current_category_raw.lower()
            continue

        # AMC line: no semicolon, not a type header, not blank
        if ";" not in line:
            current_amc = line
            continue

        # Data row: has semicolons
        fields = [f.strip() for f in line.split(";")]

        # Map fields by header if available, else positional
        if header_fields and len(header_fields) >= 5:
            def fget(col_name, default=""):
                try:
                    idx = next(
                        i for i, h in enumerate(header_fields) if col_name in h
                    )
                    return fields[idx] if idx < len(fields) else default
                except StopIteration:
                    return default
            scheme_code = fget("scheme code")
            isin        = fget("isin div payout") or fget("isin")
            scheme_name = fget("scheme name")
            nav_str     = fget("net asset value") or fget("nav")
            date_str    = fget("date")
        elif len(fields) >= 6:
            scheme_code, isin, _, scheme_name, nav_str, date_str = fields[:6]
        elif len(fields) == 5:
            scheme_code, isin, scheme_name, nav_str, date_str = fields[:5]
        else:
            continue

        # Validate scheme code
        if not scheme_code or not scheme_code.isdigit():
            continue

        # Filter Regular-Growth
        # Applies to both branches: an "Unclaimed" or "Institutional" variant is
        # a duplicate whether or not it sits under an ETF header.
        if is_legacy_plan_variant(scheme_name):
            continue

        if is_etf:
            # ETFs: only IDCW/dividend exclusion
            if any(w in scheme_name.lower() for w in EXCLUDE_WORDS_OPTION):
                continue
        else:
            if not is_regular_growth(scheme_name):
                continue

        # Validate NAV
        try:
            nav = float(nav_str)
            if nav <= 0:
                continue
        except (ValueError, TypeError):
            continue

        # Parse date
        try:
            nav_date = datetime.strptime(date_str, "%d-%b-%Y").date().isoformat()
        except ValueError:
            try:
                nav_date = datetime.strptime(date_str, "%d-%m-%Y").date().isoformat()
            except ValueError:
                continue

        # Normalise category
        cat_name = CATEGORY_NORM_MAP.get(current_category_raw)
        if cat_name is None and current_category_raw:
            # Try partial match
            for key, val in CATEGORY_NORM_MAP.items():
                if key.lower() in (current_category_raw or "").lower():
                    cat_name = val
                    break

        records.append({
            "scheme_code":   scheme_code,
            "scheme_name":   scheme_name.strip(),
            "amc_name":      current_amc,
            "category_name": cat_name,
            "isin":          isin,
            "nav":           nav,
            "nav_date":      nav_date,
        })

    return records
