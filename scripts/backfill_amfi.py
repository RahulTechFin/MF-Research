"""
backfill_amfi.py — Historical NAV backfill from AMFI (2010-01-01 → today).

Strategy (P2.3):
  - PRIMARY: Mode 2 monthly batches (all-AMC, up to 90 days per request)
  - REPAIR:  Mode 3 single-date fetch for any remaining gaps
  - Filters to Regular-Growth schemes only (P2.1)
  - Upserts by (scheme_code, nav_date) — idempotent, safe to re-run

Usage:
  python scripts/backfill_amfi.py              # full backfill
  python scripts/backfill_amfi.py --repair     # gap-repair only
  python scripts/backfill_amfi.py --from 2023-01-01 --to 2023-12-31
"""

import os
import sys
import time
import sqlite3
import logging
import argparse
import requests
from datetime import date, timedelta, datetime, timezone
from dateutil.relativedelta import relativedelta

# ── path setup ────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

DB_PATH = os.path.join(ROOT_DIR, "data", "mf_research.db")

from scripts.init_db import (
    CATEGORY_NORM_MAP,
    get_conn as _get_conn,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("backfill_amfi")

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

def date_range_monthly(start: date, end: date):
    """Yield (month_start, month_end) pairs, each ≤ 31 days."""
    cur = date(start.year, start.month, 1)
    while cur <= end:
        next_month = cur + relativedelta(months=1)
        yield cur, min(next_month - timedelta(days=1), end)
        cur = next_month


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


def is_regular_growth(name: str) -> bool:
    """Return True if scheme name qualifies as Regular-Growth."""
    n = name.lower()
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
            is_etf = "other scheme" in low
            # Extract category raw text: content after ' - ' inside parens
            try:
                inside = line[line.index("(") + 1: line.rindex(")")]
                parts  = inside.split(" - ", 1)
                current_category_raw = parts[1].strip() if len(parts) > 1 else inside.strip()
            except Exception:
                current_category_raw = None
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


# ── DB upsert helpers ─────────────────────────────────────────────────────────

def upsert_records(conn: sqlite3.Connection, records: list[dict]) -> tuple[int, int]:
    """Upsert parsed records into DB. Returns (inserted, skipped)."""
    cur = conn.cursor()
    inserted = skipped = 0

    # Cache lookups
    amc_cache  = {}
    cat_cache  = {}

    for r in records:
        # AMC
        amc_name = r["amc_name"]
        if amc_name not in amc_cache:
            row = cur.execute("SELECT amc_id FROM amcs WHERE amc_name=?", (amc_name,)).fetchone()
            if row:
                amc_cache[amc_name] = row[0]
            else:
                cur.execute("INSERT OR IGNORE INTO amcs(amc_name) VALUES(?)", (amc_name,))
                amc_cache[amc_name] = cur.lastrowid or cur.execute(
                    "SELECT amc_id FROM amcs WHERE amc_name=?", (amc_name,)
                ).fetchone()[0]

        amc_id = amc_cache[amc_name]

        # Category
        cat_name = r["category_name"]
        if cat_name not in cat_cache:
            row = cur.execute(
                "SELECT category_id FROM categories WHERE category_name=?", (cat_name,)
            ).fetchone() if cat_name else None
            cat_cache[cat_name] = row[0] if row else None

        cat_id = cat_cache.get(cat_name)

        # Scheme upsert (INSERT OR IGNORE — scheme_code is PK)
        cur.execute("""
            INSERT OR IGNORE INTO schemes
                (scheme_code, scheme_name, amc_id, category_id, isin, is_active)
            VALUES (?, ?, ?, ?, ?, 1)
        """, (r["scheme_code"], r["scheme_name"], amc_id, cat_id, r["isin"]))

        # NAV upsert
        res = cur.execute("""
            INSERT OR IGNORE INTO nav_history(scheme_code, nav_date, nav)
            VALUES(?, ?, ?)
        """, (r["scheme_code"], r["nav_date"], r["nav"]))
        if res.rowcount:
            inserted += 1
        else:
            skipped += 1

    # Update first/last NAV dates on schemes
    cur.execute("""
        UPDATE schemes SET
            first_nav_date = (
                SELECT MIN(nav_date) FROM nav_history WHERE nav_history.scheme_code = schemes.scheme_code
            ),
            last_nav_date  = (
                SELECT MAX(nav_date) FROM nav_history WHERE nav_history.scheme_code = schemes.scheme_code
            )
        WHERE scheme_code IN (
            SELECT DISTINCT scheme_code FROM nav_history
        )
    """)

    conn.commit()
    return inserted, skipped


# ── log helper ────────────────────────────────────────────────────────────────

def log_run(conn, run_type, date_from, date_to, inserted, skipped, status):
    ts = datetime.now(timezone.utc).isoformat()
    conn.execute("""
        INSERT INTO ingestion_log(run_type, date_from, date_to, rows_inserted, rows_skipped, status, ts)
        VALUES(?,?,?,?,?,?,?)
    """, (run_type, str(date_from), str(date_to), inserted, skipped, status, ts))
    conn.commit()


# ── backfill ──────────────────────────────────────────────────────────────────

def run_backfill(start: date, end: date, conn: sqlite3.Connection):
    total_inserted = total_skipped = failed_batches = 0
    monthly_ranges = list(date_range_monthly(start, end))
    log.info("Starting backfill: %s → %s (%d monthly batches)", start, end, len(monthly_ranges))

    for i, (m_start, m_end) in enumerate(monthly_ranges, 1):
        fmt_from = m_start.strftime("%d-%b-%Y")
        fmt_to   = m_end.strftime("%d-%b-%Y")
        url = AMFI_HIST_URL.format(from_dt=fmt_from, to_dt=fmt_to)

        log.info("[%d/%d] Fetching %s → %s", i, len(monthly_ranges), fmt_from, fmt_to)
        text = fetch_with_retry(url)

        if text is None:
            log.error("FAILED batch %s → %s — will need --repair", fmt_from, fmt_to)
            log_run(conn, "backfill", m_start, m_end, 0, 0, "failed")
            failed_batches += 1
            time.sleep(SLEEP_BETWEEN_REQS)
            continue

        records = parse_amfi_text(text)
        ins, skp = upsert_records(conn, records)
        log_run(conn, "backfill", m_start, m_end, ins, skp, "success")

        total_inserted += ins
        total_skipped  += skp
        log.info("  ✓ parsed %d rows → inserted=%d skipped=%d", len(records), ins, skp)

        time.sleep(SLEEP_BETWEEN_REQS)

    log.info(
        "Backfill done. inserted=%d  skipped=%d  failed_batches=%d",
        total_inserted, total_skipped, failed_batches
    )
    if failed_batches:
        log.warning("Run with --repair to fix %d failed batches.", failed_batches)


# ── gap repair ────────────────────────────────────────────────────────────────

def get_trading_days(conn: sqlite3.Connection, start: date, end: date) -> list[str]:
    """Return all distinct nav_dates in the DB within [start, end]."""
    rows = conn.execute("""
        SELECT DISTINCT nav_date FROM nav_history
        WHERE nav_date >= ? AND nav_date <= ?
        ORDER BY nav_date
    """, (start.isoformat(), end.isoformat())).fetchall()
    return [r[0] for r in rows]


def run_repair(conn: sqlite3.Connection):
    """Find dates with >5 consecutive gaps and re-fetch single-date Mode 3."""
    log.info("Repair mode: scanning for gaps in nav_history …")
    trading_days = get_trading_days(conn, date(2010, 1, 1), date.today())
    if not trading_days:
        log.warning("No trading days found in DB. Run backfill first.")
        return

    gaps = []
    prev = datetime.fromisoformat(trading_days[0]).date()
    for d_str in trading_days[1:]:
        d = datetime.fromisoformat(d_str).date()
        delta = (d - prev).days
        if delta > MAX_GAP_DAYS:
            # potential gap: fetch each missing calendar day
            cur_d = prev + timedelta(days=1)
            while cur_d < d:
                gaps.append(cur_d)
                cur_d += timedelta(days=1)
        prev = d

    if not gaps:
        log.info("No gaps found — database is continuous.")
        return

    log.info("Found %d potentially missing dates — attempting repair …", len(gaps))
    total_ins = total_skp = 0

    for gap_date in gaps:
        fmt = gap_date.strftime("%d-%b-%Y")
        url = f"https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?tp=1&frmdt={fmt}&todt={fmt}"
        text = fetch_with_retry(url)
        if text is None:
            log.error("Repair FAILED for %s", gap_date)
            log_run(conn, "repair", gap_date, gap_date, 0, 0, "failed")
        else:
            records = parse_amfi_text(text)
            if not records:
                log.info("  %s → 0 records (likely holiday/weekend)", gap_date)
                log_run(conn, "repair", gap_date, gap_date, 0, 0, "success")
            else:
                ins, skp = upsert_records(conn, records)
                total_ins += ins
                total_skp += skp
                log_run(conn, "repair", gap_date, gap_date, ins, skp, "success")
                log.info("  %s → inserted=%d skipped=%d", gap_date, ins, skp)
        time.sleep(SLEEP_BETWEEN_REQS)

    log.info("Repair done. inserted=%d  skipped=%d", total_ins, total_skp)


# ── daily update ──────────────────────────────────────────────────────────────

def run_daily(conn: sqlite3.Connection):
    """Fetch today's NAVOpen.txt and upsert."""
    log.info("Daily update: fetching NAVOpen.txt …")
    text = fetch_with_retry(AMFI_DAILY_URL)
    if text is None:
        log.error("Failed to fetch NAVOpen.txt — no update today.")
        log_run(conn, "daily", date.today(), date.today(), 0, 0, "failed")
        return

    records = parse_amfi_text(text)
    ins, skp = upsert_records(conn, records)
    log_run(conn, "daily", date.today(), date.today(), ins, skp, "success")
    log.info("Daily update done. inserted=%d  skipped=%d", ins, skp)


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="AMFI NAV backfill / daily update")
    parser.add_argument("--repair",     action="store_true",     help="Gap-repair mode")
    parser.add_argument("--daily",      action="store_true",     help="Daily update (NAVOpen.txt)")
    parser.add_argument("--from",       dest="from_date", default="2010-01-01")
    parser.add_argument("--to",         dest="to_date",   default=date.today().isoformat())
    args = parser.parse_args()

    conn = _get_conn()

    if args.daily:
        run_daily(conn)
    elif args.repair:
        run_repair(conn)
    else:
        start = datetime.fromisoformat(args.from_date).date()
        end   = datetime.fromisoformat(args.to_date).date()
        run_backfill(start, end, conn)

    conn.close()


if __name__ == "__main__":
    main()
