"""
Ingest index history from 'Weekly Market Data.xlsx' into mf_research.db.

Steps:
  1. Read all columns from the Excel 'Data' sheet.
  2. Map Excel column names → existing DB index_name (for backfill) or new index entries.
  3. For new indices, insert into `benchmarks` table with best-guess Yahoo Finance ticker.
  4. Insert all date/close rows into `index_history`, skipping duplicates.
  5. Print a summary of what was imported.
"""

import sqlite3
import datetime
import openpyxl
import os
import sys

DB_PATH = os.path.join("data", "mf_research.db")
EXCEL_PATH = "Weekly Market Data.xlsx"

# ── Mapping: Excel column name → (DB index_name, yahoo_ticker, index_type)
# index_type: 'main' for broad market, 'sectoral' for sectoral/thematic
# yahoo_ticker: best-guess Yahoo Finance ticker for future daily updates (None = unknown)

EXCEL_TO_DB = {
    # ═══ MAIN / BROAD MARKET INDICES (already in DB — backfill) ═══
    "Nifty 100":             {"db_name": "NIFTY 100",            "ticker": "^CNX100",            "type": "main",     "existing": True},
    "Nifty 200":             {"db_name": "NIFTY 200",            "ticker": "^CNX200",            "type": "main",     "existing": False},
    "Nifty 500":             {"db_name": "NIFTY 500",            "ticker": "^CRSLDX",            "type": "main",     "existing": True},
    "Nifty500 Multicap 50:25:25": {"db_name": "NIFTY500 MULTICAP 50:25:25", "ticker": "NIFTY500_MULTICAP.NS", "type": "main", "existing": False},
    "Nifty MidCap 150":      {"db_name": "NIFTY MIDCAP 150",    "ticker": "NIFTYMIDCAP150.NS",  "type": "main",     "existing": True},
    "Nifty smallCap 250":    {"db_name": "NIFTY SMALLCAP 250",  "ticker": "NIFTYSMLCAP250.NS",  "type": "main",     "existing": True},
    "Nifty Microcap 250":    {"db_name": "NIFTY MICROCAP 250",  "ticker": "NIFTY_MICROCAP250.NS","type": "main",    "existing": False},
    "Nifty LargeMidcap 250": {"db_name": "NIFTY LARGEMIDCAP 250","ticker": "NIFTY_LARGEMID250.NS","type": "main",   "existing": True},

    # ═══ SECTORAL / THEMATIC INDICES (new) ═══
    "Nifty Auto":                       {"db_name": "NIFTY AUTO",                       "ticker": "^CNXAUTO",                 "type": "sectoral", "existing": False},
    "Nifty Bank":                       {"db_name": "NIFTY BANK",                       "ticker": "^NSEBANK",                 "type": "sectoral", "existing": True},
    "Nifty Financial Services":         {"db_name": "NIFTY FINANCIAL SERVICES",         "ticker": "NIFTY_FIN_SERVICE.NS",     "type": "sectoral", "existing": False},
    "Nifty Financial Services Ex-Bank": {"db_name": "NIFTY FINANCIAL SERVICES EX-BANK", "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty FMCG":                       {"db_name": "NIFTY FMCG",                       "ticker": "^CNXFMCG",                "type": "sectoral", "existing": False},
    "Nifty Healthcare Index":           {"db_name": "NIFTY HEALTHCARE",                 "ticker": "NIFTY_HEALTHCARE.NS",      "type": "sectoral", "existing": False},
    "Nifty IT":                         {"db_name": "NIFTY IT",                         "ticker": "^CNXIT",                   "type": "sectoral", "existing": True},
    "Nifty Metal":                      {"db_name": "NIFTY METAL",                      "ticker": "^CNXMETAL",                "type": "sectoral", "existing": False},
    "Nifty Pharma":                     {"db_name": "NIFTY PHARMA",                     "ticker": "^CNXPHARMA",               "type": "sectoral", "existing": False},
    "Nifty Private Bank":               {"db_name": "NIFTY PRIVATE BANK",               "ticker": "NIFTY_PVT_BANK.NS",       "type": "sectoral", "existing": False},
    "Nifty PSU Bank":                   {"db_name": "NIFTY PSU BANK",                   "ticker": "NIFTYPSE.NS",              "type": "sectoral", "existing": False},
    "Nifty Realty":                     {"db_name": "NIFTY REALTY",                     "ticker": "NIFTY_REALTY.NS",           "type": "sectoral", "existing": False},
    "Nifty Consumer Durables":          {"db_name": "NIFTY CONSUMER DURABLES",          "ticker": "NIFTY_CONSR_DURBL.NS",     "type": "sectoral", "existing": False},
    "Nifty Oil & Gas":                  {"db_name": "NIFTY OIL & GAS",                  "ticker": "NIFTY_OIL_AND_GAS.NS",     "type": "sectoral", "existing": False},
    "Nifty Commodities":                {"db_name": "NIFTY COMMODITIES",                "ticker": "NIFTY_COMMODITIES.NS",     "type": "sectoral", "existing": False},
    "Nifty Core Housing":               {"db_name": "NIFTY CORE HOUSING",               "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty CPSE":                       {"db_name": "NIFTY CPSE",                       "ticker": "NIFTY_CPSE.NS",            "type": "sectoral", "existing": False},
    "Nifty Energy":                     {"db_name": "NIFTY ENERGY",                     "ticker": "^CNXENERGY",               "type": "sectoral", "existing": False},
    "Nifty EV & New Age Automotive":    {"db_name": "NIFTY EV & NEW AGE AUTOMOTIVE",    "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty Housing":                    {"db_name": "NIFTY HOUSING",                    "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty India Consumption":          {"db_name": "NIFTY INDIA CONSUMPTION",          "ticker": "NIFTY_CONSUMPTION.NS",     "type": "sectoral", "existing": False},
    "Nifty India Defence":              {"db_name": "NIFTY INDIA DEFENCE",              "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty India Digital":              {"db_name": "NIFTY INDIA DIGITAL",              "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty India Manufacturing":        {"db_name": "NIFTY INDIA MANUFACTURING",        "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty India New Age Consumption":  {"db_name": "NIFTY INDIA NEW AGE CONSUMPTION",  "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty India Railways PSU":         {"db_name": "NIFTY INDIA RAILWAYS PSU",         "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty India Tourism":              {"db_name": "NIFTY INDIA TOURISM",              "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty Infrastructure":             {"db_name": "NIFTY INFRASTRUCTURE",             "ticker": "^CNXINFRA",                "type": "sectoral", "existing": False},
    "Nifty IPO":                        {"db_name": "NIFTY IPO",                        "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty Mobility":                   {"db_name": "NIFTY MOBILITY",                   "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty PSE":                        {"db_name": "NIFTY PSE",                        "ticker": "NIFTYPSE.NS",              "type": "sectoral", "existing": False},
    "Nifty REITs & InvITs":             {"db_name": "NIFTY REITS & INVITS",             "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty Rural":                      {"db_name": "NIFTY RURAL",                      "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty Services Sector":            {"db_name": "NIFTY SERVICES SECTOR",            "ticker": "NIFTY_SERV_SECTOR.NS",     "type": "sectoral", "existing": False},
    "NIFTY MNC":                        {"db_name": "NIFTY MNC",                        "ticker": "NIFTY_MNC.NS",             "type": "sectoral", "existing": False},
    "Nifty Transportation & Logistics": {"db_name": "NIFTY TRANSPORTATION & LOGISTICS", "ticker": None,                       "type": "sectoral", "existing": False},
    "NIFTY MEDIA":                      {"db_name": "NIFTY MEDIA",                      "ticker": "^CNXMEDIA",                "type": "sectoral", "existing": False},
    "Nifty MidSmall Financial Services":{"db_name": "NIFTY MIDSMALL FINANCIAL SERVICES","ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty MidSmall Healthcare":        {"db_name": "NIFTY MIDSMALL HEALTHCARE",        "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty MidSmall IT & Telecom":      {"db_name": "NIFTY MIDSMALL IT & TELECOM",      "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty MidSmall India Consumption": {"db_name": "NIFTY MIDSMALL INDIA CONSUMPTION", "ticker": None,                       "type": "sectoral", "existing": False},
    "Nifty500 Multicap Infrastructure 50:30:20": {"db_name": "NIFTY500 MULTICAP INFRA 50:30:20", "ticker": None,              "type": "sectoral", "existing": False},
    "Nifty Capital Markets":            {"db_name": "NIFTY CAPITAL MARKETS",            "ticker": None,                       "type": "sectoral", "existing": False},
    "India VIX":                        {"db_name": "INDIA VIX",                        "ticker": "^INDIAVIX",                "type": "volatility","existing": False},
}

# DB name → existing index_id cache (populated at runtime)
NAME_TO_ID = {}


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def ensure_benchmarks(conn):
    """Create any missing benchmark rows and populate NAME_TO_ID cache."""
    cur = conn.cursor()

    # Load existing
    for row in cur.execute("SELECT index_id, index_name FROM benchmarks"):
        NAME_TO_ID[row[1]] = row[0]

    created = 0
    for excel_col, info in EXCEL_TO_DB.items():
        db_name = info["db_name"]
        if db_name in NAME_TO_ID:
            # Update ticker if we have a better one and existing is NULL
            if info["ticker"]:
                cur.execute(
                    "UPDATE benchmarks SET yahoo_ticker = ? WHERE index_name = ? AND (yahoo_ticker IS NULL OR yahoo_ticker = '')",
                    (info["ticker"], db_name),
                )
            continue

        # Insert new benchmark
        cur.execute(
            "INSERT INTO benchmarks(index_name, yahoo_ticker, is_synthetic, is_active) VALUES(?,?,0,1)",
            (db_name, info["ticker"]),
        )
        NAME_TO_ID[db_name] = cur.lastrowid
        created += 1
        print(f"  + Created benchmark: {db_name} (ID={cur.lastrowid}, ticker={info['ticker']})")

    conn.commit()
    print(f"  Benchmarks: {created} new, {len(NAME_TO_ID)} total")


def ingest_excel(conn):
    """Read Excel and insert rows into index_history."""
    print(f"\nReading {EXCEL_PATH} ...")
    wb = openpyxl.load_workbook(EXCEL_PATH, read_only=True, data_only=True)
    ws = wb["Data"]

    headers = None
    col_to_index_id = {}  # Excel column index → DB index_id

    total_inserted = 0
    total_skipped = 0
    total_errors = 0
    per_index_counts = {}

    cur = conn.cursor()

    for row_num, row in enumerate(ws.iter_rows(min_row=1, values_only=True)):
        if row_num == 0:
            headers = list(row)
            # Map Excel columns to DB index_ids
            for col_idx, col_name in enumerate(headers):
                if col_name and col_name in EXCEL_TO_DB:
                    db_name = EXCEL_TO_DB[col_name]["db_name"]
                    if db_name in NAME_TO_ID:
                        col_to_index_id[col_idx] = NAME_TO_ID[db_name]
                        per_index_counts[db_name] = 0
            print(f"  Mapped {len(col_to_index_id)} Excel columns to DB indices")
            continue

        # Parse date from column 0
        dt = row[0]
        if dt is None:
            continue
        if isinstance(dt, datetime.datetime):
            dt = dt.date()
        elif isinstance(dt, str):
            try:
                dt = datetime.date.fromisoformat(dt[:10])
            except ValueError:
                continue

        # Only ingest data from 2010-01-01 onwards
        if dt < datetime.date(2010, 1, 1):
            continue

        date_str = dt.isoformat()

        # Insert close values for each mapped column
        for col_idx, index_id in col_to_index_id.items():
            val = row[col_idx] if col_idx < len(row) else None
            if val is None:
                continue
            try:
                close_val = float(val)
                if close_val <= 0:
                    continue
            except (ValueError, TypeError):
                continue

            try:
                cur.execute(
                    "INSERT OR IGNORE INTO index_history(index_id, date, close) VALUES(?,?,?)",
                    (index_id, date_str, close_val),
                )
                if cur.rowcount > 0:
                    total_inserted += 1
                    # Find db_name for this index_id
                    for dbn, iid in NAME_TO_ID.items():
                        if iid == index_id:
                            per_index_counts[dbn] = per_index_counts.get(dbn, 0) + 1
                            break
                else:
                    total_skipped += 1
            except sqlite3.Error as e:
                total_errors += 1
                if total_errors <= 5:
                    print(f"  ERROR: index_id={index_id}, date={date_str}, close={close_val}: {e}")

        # Progress
        if row_num % 1000 == 0:
            conn.commit()
            print(f"  ... processed {row_num} rows, {total_inserted} inserted, {total_skipped} skipped")

    conn.commit()
    wb.close()

    print(f"\n{'='*70}")
    print(f"IMPORT COMPLETE")
    print(f"  Total rows inserted: {total_inserted:,}")
    print(f"  Total rows skipped (duplicates): {total_skipped:,}")
    print(f"  Total errors: {total_errors}")
    print(f"\nPer-index breakdown:")
    for db_name, count in sorted(per_index_counts.items(), key=lambda x: -x[1]):
        if count > 0:
            print(f"  {db_name:50s}  {count:6,} rows inserted")


def verify_db(conn):
    """Print final DB state."""
    print(f"\n{'='*70}")
    print("FINAL DATABASE STATE:")
    rows = conn.execute("""
        SELECT b.index_id, b.index_name, b.yahoo_ticker,
               MIN(h.date), MAX(h.date), COUNT(h.date)
        FROM benchmarks b
        LEFT JOIN index_history h ON b.index_id = h.index_id
        WHERE b.is_synthetic = 0
        GROUP BY b.index_id
        ORDER BY b.index_id
    """).fetchall()
    for r in rows:
        ticker = r[2] if r[2] else "NO TICKER"
        mn = r[3] if r[3] else "N/A"
        mx = r[4] if r[4] else "N/A"
        cnt = r[5] if r[5] else 0
        print(f"  ID={r[0]:3d}  {r[1]:50s}  {ticker:30s}  {mn} to {mx}  {cnt:6d} rows")


def main():
    if not os.path.exists(EXCEL_PATH):
        print(f"ERROR: Excel file not found: {EXCEL_PATH}")
        sys.exit(1)
    if not os.path.exists(DB_PATH):
        print(f"ERROR: Database not found: {DB_PATH}")
        sys.exit(1)

    conn = get_conn()

    print("Step 1: Ensuring all benchmark entries exist...")
    ensure_benchmarks(conn)

    print("\nStep 2: Ingesting Excel data...")
    ingest_excel(conn)

    print("\nStep 3: Verifying database...")
    verify_db(conn)

    conn.close()
    print(f"\n✅ Done! Database updated at: {os.path.abspath(DB_PATH)}")


if __name__ == "__main__":
    main()
