"""
Populate historical NAVs specifically for the "Dividend Yield" category.
Loops monthly from 2010-01-01 to today, downloads AMFI files,
and filters/upserts only Dividend Yield growth funds.
"""
import sqlite3
import datetime
import requests
import time
import sys
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR   = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

DB_PATH = os.path.join(ROOT_DIR, "data", "mf_research.db")

from scripts.backfill_amfi import parse_amfi_text, upsert_records, date_range_monthly

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def main():
    conn = get_conn()
    
    start_date = datetime.date(2010, 1, 1)
    end_date = datetime.date.today()
    
    monthly_ranges = list(date_range_monthly(start_date, end_date))
    print(f"Starting historical backfill for Dividend Yield funds: {len(monthly_ranges)} months...")
    
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    })
    
    total_ins = 0
    total_skp = 0
    
    for i, (m_start, m_end) in enumerate(monthly_ranges, 1):
        fmt_start = m_start.strftime("%d-%b-%Y")
        fmt_end = m_end.strftime("%d-%b-%Y")
        url = f"https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?tp=1&frmdt={fmt_start}&todt={fmt_end}"
        
        print(f"[{i}/{len(monthly_ranges)}] Fetching {fmt_start} -> {fmt_end}...", end="", flush=True)
        
        # Fetch data with retry
        text = None
        for attempt in range(3):
            try:
                time.sleep(1.0) # polite scraping delay
                r = session.get(url, timeout=45)
                if r.status_code == 200 and r.text.strip():
                    text = r.text
                    break
            except Exception as e:
                print(f" (attempt {attempt+1} failed: {e})", end="", flush=True)
                time.sleep(3.0)
                
        if not text:
            print(" FAILED")
            continue
            
        # Parse records
        records = parse_amfi_text(text)
        # Filter ONLY for Dividend Yield category
        div_records = [r for r in records if r["category_name"] == "Dividend Yield"]
        
        if div_records:
            ins, skp = upsert_records(conn, div_records)
            total_ins += ins
            total_skp += skp
            print(f" OK (parsed {len(records)}, found {len(div_records)} Dividend Yield, inserted={ins}, skipped={skp})")
        else:
            print(" OK (0 Dividend Yield)")
            
    # Update scheme start/end dates
    print("\nUpdating schemes table metadata...")
    cur = conn.cursor()
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
    
    # Check count of Dividend Yield schemes
    schemes_count = cur.execute("""
        SELECT COUNT(*), (SELECT COUNT(*) FROM nav_history WHERE scheme_code IN (SELECT scheme_code FROM schemes WHERE category_id = c.category_id))
        FROM categories c
        WHERE slug = 'dividend-yield'
    """).fetchone()
    print(f"\nFinal State: category 'Dividend Yield' now has {schemes_count[0]} schemes with {schemes_count[1]:,} historical NAV rows.")
    
    conn.close()
    print("Done!")

if __name__ == "__main__":
    main()
