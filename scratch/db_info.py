# scratch/db_info.py
import sqlite3

conn = sqlite3.connect('data/mf_research.db')
cursor = conn.cursor()

# Get list of tables
cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cursor.fetchall()]

print("=== SQLite Database Info ===")
for t in tables:
    try:
        cursor.execute(f"SELECT count(*) FROM {t}")
        cnt = cursor.fetchone()[0]
        print(f"Table '{t}': {cnt} rows")
    except Exception as e:
        print(f"Table '{t}': Error: {e}")

# Check size of nav_history in details
try:
    cursor.execute("SELECT MIN(nav_date), MAX(nav_date) FROM nav_history")
    min_d, max_d = cursor.fetchone()
    print(f"nav_history date range: {min_d} to {max_d}")
except Exception:
    pass

conn.close()
