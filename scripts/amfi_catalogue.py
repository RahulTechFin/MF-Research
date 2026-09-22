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

from scripts.init_db import CATEGORY_NORM_MAP, resolve_category

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
# "income distribution" is IDCW written out in full -- AMFI uses both, and 653
# rows carry the long form. Without it an "Income Distribution Cum Capital
# Withdrawal Option" row reads as neither growth nor income.
EXCLUDE_WORDS_OPTION = {"idcw", "dividend", "payout", "reinvest", "bonus",
                        "income distribution"}
# ICICI Prudential calls its growth option "Cumulative", and for many of its
# funds there is NO row called Growth at all -- India Opportunities,
# Manufacturing and Pharma Healthcare (P.H.D) each publish only a Cumulative
# option and an IDCW option. Requiring the literal word "growth" dropped every
# one of them from the universe.
GROWTH_WORDS = {"growth", "cumulative"}

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
            # AMFI's Content-Type declares ISO-8859-1 while the body is really
            # UTF-8, and requests honours the declaration. That turned the
            # apostrophe in "Children's Fund" into "a<80><99>", so the section
            # header stopped matching its own mapping key and 11 children's funds
            # lost their category. Decode as UTF-8 and only fall back to the
            # declared encoding if the bytes genuinely are not UTF-8.
            try:
                text = r.content.decode("utf-8")
            except UnicodeDecodeError:
                text = r.text
            if not text.strip():
                log.warning("Empty response on attempt %d → retry", attempt)
                continue
            return text
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
    r"|discipline\s+advantage"
    r")\b",
    re.I,
)


# AMFI writes a REGULATORY DISCLOSURE into the parent scheme's own name, and it
# contains the word "segregated":
#     Nippon India Credit Risk Fund (Existing Number of Segregated Portfolios - 1)
#     Franklin India Low Duration Fund (No. of Segregated Portfolios-2)
#     Baroda BNP Paribas Short Term Fund (the scheme has 2 segregated portfolios)
# It states how many side-pockets the scheme has created. All 378 rows
# mentioning "segregated" in today's file carry it in this parenthesised form,
# and — the trap — the side-pockets carry the very same text, so on its own it
# identifies nothing. See states_share_class for what follows from that.
_SEGREGATED_DISCLOSURE_RE = re.compile(r"\((?=[^)]*\bsegregated\b)[^)]*\)", re.I)


def is_legacy_plan_variant(name: str) -> bool:
    """True for duplicate/non-investable share classes — see LEGACY_PLAN_VARIANT."""
    return bool(LEGACY_PLAN_VARIANT.search(name or ""))


def states_share_class(name: str, plan: str = "", option: str = "") -> bool:
    """
    True when AMFI itself said which share class a row is.

    This is the licence to DELETE a catalogue entry, so it is deliberately
    strict. Its opposite is not "this row qualifies" but "AMFI did not say",
    and an entry AMFI has not spoken about must be left alone.

    A segregated-portfolio count does not count as saying. AMFI appends the
    parent scheme's disclosure to BOTH the parent and its side-pockets:

        112938  Nippon India Credit Risk Fund (Existing Number of Segregated
                Portfolios - 1)   Regular Plan   Growth option   NAV 38.1663
        148094  Nippon India Credit Risk Fund (Existing Number of Segregated
                Portfolios - 1)   Regular Plan   Growth Option   NAV  0.5036

    Name, Plan and Option are identical; only the ISIN series (INF204KB1* for
    the side-pockets) and the residual NAV betray which is which. Five Nippon
    funds publish such a pair. LEGACY_PLAN_VARIANT matches the word
    "segregated" and rejects both, which is the right call — there is no sound
    way to choose between them and admitting both puts one fund on screen
    twice. But it is not a verdict on the parent, which is a live fund the
    catalogue already holds. So the disclosure is stripped before a legacy
    marker is looked for here, while the rejection itself stands.
    """
    n = _SEGREGATED_DISCLOSURE_RE.sub(" ", name or "")
    return (bool(_OPTION_STATED_RE.search(n))
            or bool(_OPTION_STATED_RE.search(option or ""))
            or is_legacy_plan_variant(n)
            or is_legacy_plan_variant(plan)
            or is_legacy_plan_variant(option))


# Option wording, in either the name or AMFI's Option column.
_OPTION_STATED_RE = re.compile(
    r"\b(growth|cumulative|idcw|dividend|payout|reinvestment|reinvest|bonus)\b"
    r"|income distribution", re.I,
)
# The plan marker is where a fund's name ends and its share class begins.
_PLAN_MARKER_RE = re.compile(r"\b(regular|direct)\b", re.I)


def _fund_identity(name: str) -> str:
    """
    The fund's name, cut at the plan marker.

    Deliberately crude, because it is used to ask "does this fund state an option
    ANYWHERE?" and cutting early groups more rows together, which makes the
    answer more conservative rather than less. Trying to strip option words
    instead left residue -- "Income Distribution Cum Capital Withdrawal" reduced
    to "cum capital withdrawal", which matched nothing and made an IDCW row look
    like a fund of its own.
    """
    n = (name or "").lower()
    m = _PLAN_MARKER_RE.search(n)
    if m:
        n = n[:m.start()]
    n = re.sub(r"[^a-z0-9 ]+", " ", n)
    return re.sub(r"\s+", " ", n).strip()


def silent_growth_codes(text: str) -> set[str]:
    """
    Codes to accept even though nothing says "growth".

    A few AMCs state the option neither in the name nor in the Option column:
        150641  Motilal Oswal Gold and Silver Passive Fund of Funds(Regular Plan)
        154238  Motilal Oswal Multi Factor Passive Fund of Funds - Regular
    Each publishes exactly two rows, a Regular and a Direct, with no income option
    anywhere -- so the Regular row IS the growth option, and dropping it loses a
    real fund.

    Silence only means growth when there is nothing to confuse it with. A code is
    returned only when:
      - its own name states no option and its Option column is empty,
      - it is not the Direct row,
      - NO row of the same fund states an option either, and
      - it is the ONLY silent non-Direct row that fund has.

    The third condition keeps SBI's "Income Distribution Cum Capital Withdrawal"
    rows out: their fund also publishes an explicit Growth row, so a silent
    sibling there is some other share class, not the growth option.

    The fourth is what stops legacy share classes being admitted wholesale.
    "SBI BANKING & PSU FUND" publishes SEVEN rows, every one of them with a blank
    Plan and a blank Option and an identical name -- they are the retired
    Retail/Institutional classes, told apart only by ISIN. With no signal to
    choose between them, picking one would be a guess and admitting all seven
    would put the same fund on screen seven times, so none is taken.
    """
    stated: dict[str, bool] = {}
    silent_per_fund: dict[str, int] = {}
    rows: list[tuple[str, str, bool, bool]] = []
    for line in text.splitlines():
        line = line.strip()
        if ";" not in line or line.lower().startswith("scheme code"):
            continue
        f = [c.strip() for c in line.split(";")]
        if len(f) < 8 or not f[0].isdigit():
            continue
        code, name, plan, option = f[0], f[3], f[4], f[5]
        ident = _fund_identity(name)
        if not ident:
            continue
        says = bool(_OPTION_STATED_RE.search(name)) or bool(option.strip())
        stated[ident] = stated.get(ident, False) or says
        is_direct = "direct" in name.lower() or "direct" in plan.lower()
        if not says and not is_direct:
            silent_per_fund[ident] = silent_per_fund.get(ident, 0) + 1
        rows.append((code, ident, says, is_direct))

    return {code for code, ident, says, is_direct in rows
            if not says and not is_direct
            and not stated.get(ident)
            and silent_per_fund.get(ident) == 1}


def is_regular_growth(name: str, plan: str = "", option: str = "") -> bool:
    """
    Return True if this row is the Regular plan's growth option.

    `plan` and `option` are AMFI's own columns, and they work in BOTH directions:
    they name the option when the fund name does not ("Samco Mid Cap Fund -
    Regular Plan", Option=Growth), and they rule a row out when the name cannot.

    WHY THE COLUMNS MUST BE ABLE TO EXCLUDE
    This used to accept any row whose NAME contained "growth", and only consult
    the Option column when the name was silent. That works until a fund has the
    word in its TITLE. "Nippon India Growth Mid Cap Fund" publishes four rows —
    Growth Option, IDCW Option, Bonus Option and INSTITUTIONAL Plan IDCW Option —
    all under that identical name. Every one matched "growth", so all four were
    admitted as separate Regular Growth funds: one fund counted four times in the
    Mid Cap average and ranked four times in the quartiles, with 12-month returns
    of 0.8%, 8.9%, 8.9% and 3.0% pulling the category average apart.

    The Option column said exactly what each row was the whole time.

    ORDER MATTERS, and the name still excludes first. AMFI stamps Option="Growth"
    on some rows plainly named "Bonus Option", so a name-based rejection has to
    win over a column that claims Growth. What is new is the reverse: a column
    saying IDCW, Bonus or Institutional now rejects a row whose name is silent
    about it. Measured over the full 14,353-row file this removes 27 rows and
    admits none: Institutional, Super Institutional, Retail, Discontinued,
    Unclaimed, IDCW and Bonus share classes whose qualifier lives only in the
    column. Every one is a duplicate of a fund already in the universe.

    Callers in ETF sections must pass plan="": ETFs are single-plan instruments
    and AMFI still marks several liquid ETFs "Direct Plan" while their names say
    nothing of the kind, so trusting the column there drops live funds.
    """
    n = (name or "").lower()
    p = (plan or "").lower()
    o = (option or "").lower()

    # Duplicate share classes never belong, ETF exemption or not. Checked against
    # the columns as well: AMFI writes "INSTITUTIONAL Plan - IDCW Option" in the
    # Option column of a scheme whose name mentions neither, which is how
    # Nippon's institutional class reached Mid Cap.
    if (is_legacy_plan_variant(name) or is_legacy_plan_variant(plan)
            or is_legacy_plan_variant(option)):
        return False
    # Exclude Direct plans, by name and by column (see the docstring on why the
    # column is only safe outside ETF sections).
    if any(w in n for w in EXCLUDE_WORDS_PLAN):
        return False
    if any(w in p for w in EXCLUDE_WORDS_PLAN):
        return False

    # Must NOT be an income/bonus share class. The NAME decides this first, so a
    # row named "Bonus Option" stays out even when the column claims Growth.
    if any(w in n for w in ("idcw", "payout", "reinvest", "bonus",
                            "income distribution")):
        return False
    # Then the Option column, which is the only place many of these say so.
    if any(w in o for w in EXCLUDE_WORDS_OPTION):
        return False

    # Normally exclude dividend, except if it is part of "dividend yield" category
    if "dividend" in n:
        if "dividend yield" not in n:
            return False
        # For "dividend yield", check standard payout/reinvestment options
        if any(w in n for w in ["payout", "reinvestment", "reinvest"]):
            return False

    # Growth stated in the column wins, then the name. Both are only reached
    # once every exclusion above has passed, so "growth" appearing in a fund's
    # title can no longer drag its other share classes in with it.
    if any(w in o for w in GROWTH_WORDS):
        return True
    if any(w in n for w in GROWTH_WORDS):
        return True
    return False


def is_etf_type(type_header: str) -> bool:
    """ETF / Other schemes: skip the 'direct' test (ETFs are single-plan)."""
    return "other scheme" in type_header.lower()


# ── AMFI file parser ──────────────────────────────────────────────────────────

def parse_amfi_text(text: str, is_etf_context=False,
                    rejected_share_class: "set | None" = None):
    """
    Parse AMFI semicolon-delimited NAV history text.
    Returns list of dicts: {scheme_code, scheme_name, amc_name, category_name, nav, nav_date, isin}
    """
    records = []
    # Funds that state their option nowhere; see silent_growth_codes.
    silent_ok = silent_growth_codes(text)
    current_amc      = None
    current_type     = None      # e.g. 'open ended schemes(equity scheme - large cap fund)'
    current_category_raw = None  # raw text inside parentheses after ' - '
    is_etf           = is_etf_context
    skip_section     = False     # True inside Close Ended / Interval sections
    header_fields    = None      # column positions for variable-width chunks
    unnamed          = 0         # rows whose name column could not be found

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        # Detect column header line (semicolon present, first field = 'Scheme Code')
        if ";" in line and line.lower().startswith("scheme code"):
            header_fields = [f.strip().lower() for f in line.split(";")]
            continue

        # Scheme-type header: no semicolon, names a scheme type in parentheses.
        #
        # EVERY such header must be recognised, including the ones we do not want.
        # This used to accept only headers starting with "open ended", so
        # "Close Ended Schemes(Income)" fell through to the AMC branch below and
        # was stored as an AMC NAME -- while current_category_raw silently kept
        # its previous value. The last open-ended section in the file is
        # "Solution Oriented Scheme - Retirement Fund", so all 4,752 close-ended
        # and interval rows inherited "Retirement Fund". That was harmless only
        # because Retirement was unmapped and resolved to None; the moment it was
        # mapped, ~707 fixed-maturity and interval plans would have been filed as
        # Retirement funds. Skipping the section explicitly is what makes adding
        # those mappings safe.
        low = line.lower()
        is_type_header = ("schemes" in low and "(" in line and ")" in line) or next(
            (True for kw in INCLUDE_TYPE_KEYWORDS if low.startswith(kw)), False
        )
        if is_type_header:
            current_type = low
            # Only open-ended schemes belong on the platform. Closed-ended FMPs
            # and interval plans are not continuously investable and cannot be
            # ranked against open-ended peers.
            skip_section = not low.startswith("open ended")
            # Keep the WHOLE text inside the parentheses. Taking only the part
            # after " - " threw away the qualifier that identifies the category:
            # "Index Funds - Equity Funds" became a bare "Equity Funds", which
            # matched nothing, leaving 56 index funds uncategorised.
            try:
                current_category_raw = line[line.index("(") + 1: line.rindex(")")].strip()
            except ValueError:
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

        # Inside a section we do not collect, ignore data rows entirely.
        if skip_section:
            if ";" not in line:
                current_amc = line
            continue

        # AMC line: no semicolon, not a type header, not blank
        if ";" not in line:
            current_amc = line
            continue

        # Data row: has semicolons
        fields = [f.strip() for f in line.split(";")]

        # Older 6-column files carry no Plan/Option columns; default them so the
        # Regular-Growth test can be called the same way for both layouts.
        plan_col = option_col = ""

        # Map fields by header if available, else positional.
        #
        # AMFI CALLS THE NAME COLUMN "NAV Name", NOT "Scheme Name".
        # Both NAVOpen.txt and NAVAll.txt ship this header:
        #   Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;
        #   NAV Name;Plan;Option;Net Asset Value;Date
        # A lookup for "scheme name" therefore matched nothing and returned "",
        # so is_regular_growth("") was False and every non-ETF row was discarded.
        # The parse fell from ~2,800 records to 353 (ETFs only, which take a
        # different filter branch), the caller's "fewer than 2000" guard aborted
        # the refresh, and the workflow step runs with continue-on-error, so the
        # catalogue simply stopped being updated without anything going red.
        #
        # Each field now has a list of accepted spellings and a positional
        # fallback, and a name that still comes back empty is fatal rather than
        # quietly unmatched -- see the check below.
        if header_fields and len(header_fields) >= 5:
            def fget(names, default="", pos=None):
                for col_name in names:
                    for i, h in enumerate(header_fields):
                        if col_name in h and i < len(fields) and fields[i]:
                            return fields[i]
                if pos is not None and pos < len(fields):
                    return fields[pos]
                return default
            scheme_code = fget(("scheme code",), pos=0)
            isin        = fget(("isin div payout", "isin"), pos=1)
            scheme_name = fget(("nav name", "scheme name"), pos=3)
            plan_col    = fget(("plan",))
            option_col  = fget(("option",))
            nav_str     = fget(("net asset value", "nav"), pos=len(fields) - 2)
            date_str    = fget(("date",), pos=len(fields) - 1)
        elif len(fields) >= 6:
            scheme_code, isin, _, scheme_name, nav_str, date_str = fields[:6]
        elif len(fields) == 5:
            scheme_code, isin, scheme_name, nav_str, date_str = fields[:5]
        else:
            continue

        # Validate scheme code
        if not scheme_code or not scheme_code.isdigit():
            continue

        # An unresolvable name is a format change, not a bad row. Counting them
        # lets the caller abort instead of silently returning a short parse.
        if not scheme_name:
            unnamed += 1
            continue

        # Filter Regular-Growth
        # Applies to both branches: an "Unclaimed" or "Institutional" variant is
        # a duplicate whether or not it sits under an ETF header.
        #
        # Each rejection here is recorded in `rejected_share_class` when the
        # caller asks for it, and ONLY when AMFI actually said what the row is.
        # That set is the only sound basis for pruning the catalogue, and getting
        # it wrong is expensive, so both halves of that sentence are load-bearing:
        #
        #  - Not every skip is a share-class verdict. This function drops rows
        #    for a dozen unrelated reasons — an unmapped or closed-end section, a
        #    missing NAV, an unparseable date. Treating those as "not Regular
        #    Growth" once deleted 31 perfectly good funds. Only the three tests
        #    below are share-class verdicts, and only the ELSE branch knows that
        #    an ETF is exempt from is_regular_growth.
        #
        #  - A verdict needs evidence, so the recording follows the REASON and
        #    not merely the fact of a rejection. AMFI leaves Plan and Option
        #    BLANK for many funds and publishes several such rows under one
        #    identical name: "Motilal Oswal Midcap Fund" ships four rows today
        #    (127039/127040/127042/127044), indistinguishable. silent_growth_codes
        #    rightly refuses to guess, so all four are skipped — but 127039 is
        #    the real Regular Growth row, catalogued under the fuller name AMFI
        #    used to publish and has since dropped. Pruning on that skip deletes
        #    the fund. Silence is not a verdict.
        def _note_share_class_rejection(name="", plan="", option=""):
            if rejected_share_class is not None and states_share_class(
                    name, plan, option):
                rejected_share_class.add(scheme_code)

        if is_legacy_plan_variant(scheme_name):
            # A segregated-portfolio disclosure reaches this branch too, and it
            # marks a live parent as readily as its side-pocket. Refusing the
            # row is right; condemning the catalogue entry is not.
            _note_share_class_rejection(scheme_name)
            continue

        if is_etf:
            # ETFs: only IDCW/dividend exclusion
            if any(w in scheme_name.lower() for w in EXCLUDE_WORDS_OPTION):
                _note_share_class_rejection(scheme_name)
                continue
        else:
            # plan_col is only defined on the header-mapped path; older 6-column
            # files have no Plan/Option columns at all.
            if not (is_regular_growth(scheme_name, plan=plan_col,
                                      option=option_col)
                    or scheme_code in silent_ok):
                _note_share_class_rejection(scheme_name, plan_col, option_col)
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

        # Normalise category. resolve_category lives beside CATEGORY_NORM_MAP in
        # init_db and applies longest-key-first matching, so the most specific
        # spelling wins rather than whichever key was inserted first.
        cat_name = resolve_category(current_category_raw)

        records.append({
            "scheme_code":   scheme_code,
            "scheme_name":   scheme_name.strip(),
            "amc_name":      current_amc,
            "category_name": cat_name,
            "isin":          isin,
            "nav":           nav,
            "nav_date":      nav_date,
        })

    if unnamed:
        # Loud on purpose: this is the signature of AMFI renaming a column, which
        # is exactly how the "NAV Name" break went unnoticed.
        log.error("%d row(s) had no resolvable scheme name -- the AMFI column "
                  "layout has probably changed. Header seen: %s",
                  unnamed, header_fields)

    return records
