"""
init_db.py — Create the SQLite database schema and seed reference data.
Run once before any backfill. Safe to re-run (CREATE IF NOT EXISTS).
"""

import os
import re
import sqlite3
import sys

_DEFAULT_DB_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "mf_research.db")

# MF_DB_PATH lets the pipeline point every consumer (engine, build_json) at a
# throwaway database — e.g. one built from the API inside a CI runner and
# deleted afterwards. Unset, behaviour is unchanged.
DB_PATH = os.environ.get("MF_DB_PATH") or _DEFAULT_DB_PATH


def get_conn(db_path: str | None = None):
    path = db_path or os.environ.get("MF_DB_PATH") or _DEFAULT_DB_PATH
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def create_schema(conn):
    cur = conn.cursor()

    # ── categories ──────────────────────────────────────────────────────────
    cur.execute("""
    CREATE TABLE IF NOT EXISTS categories (
        category_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_class    TEXT    NOT NULL,          -- Equity|Hybrid|Debt|Other
        category_name  TEXT    NOT NULL UNIQUE,   -- e.g. 'Large Cap'
        slug           TEXT    NOT NULL UNIQUE,   -- e.g. 'large-cap'
        benchmark_id   INTEGER REFERENCES benchmarks(index_id),
        display_order  INTEGER NOT NULL DEFAULT 999
    )""")

    # ── amcs ─────────────────────────────────────────────────────────────────
    cur.execute("""
    CREATE TABLE IF NOT EXISTS amcs (
        amc_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        amc_name  TEXT    NOT NULL UNIQUE
    )""")

    # ── schemes ───────────────────────────────────────────────────────────────
    cur.execute("""
    CREATE TABLE IF NOT EXISTS schemes (
        scheme_code    TEXT    PRIMARY KEY,       -- AMFI scheme code (permanent key)
        scheme_name    TEXT    NOT NULL,
        amc_id         INTEGER REFERENCES amcs(amc_id),
        category_id    INTEGER REFERENCES categories(category_id),
        isin           TEXT,
        launch_date    TEXT,                      -- ISO date string
        first_nav_date TEXT,                      -- ISO date string (auto-populated)
        last_nav_date  TEXT,                      -- ISO date string (auto-populated)
        is_active      INTEGER NOT NULL DEFAULT 1
    )""")

    # ── nav_history ───────────────────────────────────────────────────────────
    cur.execute("""
    CREATE TABLE IF NOT EXISTS nav_history (
        scheme_code  TEXT    NOT NULL REFERENCES schemes(scheme_code),
        nav_date     TEXT    NOT NULL,            -- ISO date string YYYY-MM-DD
        nav          REAL    NOT NULL CHECK(nav > 0),
        PRIMARY KEY (scheme_code, nav_date)
    )""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_nav_date ON nav_history(nav_date)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_nav_scheme ON nav_history(scheme_code)")

    # ── benchmarks ────────────────────────────────────────────────────────────
    cur.execute("""
    CREATE TABLE IF NOT EXISTS benchmarks (
        index_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        index_name    TEXT    NOT NULL UNIQUE,
        yahoo_ticker  TEXT,                       -- NULL for synthetic blends
        is_synthetic  INTEGER NOT NULL DEFAULT 0,
        is_active     INTEGER NOT NULL DEFAULT 1
    )""")

    # ── benchmark_components (for synthetic blended benchmarks E7.1) ─────────
    cur.execute("""
    CREATE TABLE IF NOT EXISTS benchmark_components (
        index_id           INTEGER NOT NULL REFERENCES benchmarks(index_id),
        component_index_id INTEGER NOT NULL REFERENCES benchmarks(index_id),
        weight             REAL    NOT NULL CHECK(weight > 0 AND weight <= 1),
        PRIMARY KEY (index_id, component_index_id)
    )""")

    # ── index_history (real + synthetic blend series) ─────────────────────────
    cur.execute("""
    CREATE TABLE IF NOT EXISTS index_history (
        index_id  INTEGER NOT NULL REFERENCES benchmarks(index_id),
        date      TEXT    NOT NULL,               -- ISO date YYYY-MM-DD
        close     REAL    NOT NULL,
        PRIMARY KEY (index_id, date)
    )""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_index_date ON index_history(date)")

    # ── ingestion_log ─────────────────────────────────────────────────────────
    cur.execute("""
    CREATE TABLE IF NOT EXISTS ingestion_log (
        run_id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_type       TEXT    NOT NULL,          -- backfill|daily|repair|index
        date_from      TEXT,
        date_to        TEXT,
        rows_inserted  INTEGER DEFAULT 0,
        rows_skipped   INTEGER DEFAULT 0,
        status         TEXT    NOT NULL,          -- success|failed|partial
        ts             TEXT    NOT NULL           -- ISO datetime
    )""")

    # ── config (key-value store for risk-free rate etc.) ─────────────────────
    cur.execute("""
    CREATE TABLE IF NOT EXISTS config (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL,
        note   TEXT
    )""")

    conn.commit()
    print("✅  Schema created / verified.")


# ── Seed data ─────────────────────────────────────────────────────────────────

# Asset class -> the folder it is published under. Lives here, beside the asset
# classes themselves, because more than one script needs it: publish_data to
# place a file and nav_store to find one again before any build has run.
ASSET_FOLDER = {"Equity": "equity", "Hybrid": "hybrid",
                "Debt": "debt", "Other": "other"}

CATEGORY_SEED = [
    # (asset_class, category_name, slug, display_order)
    # Equity
    ("Equity", "Large Cap",        "large-cap",        1),
    ("Equity", "Mid Cap",          "mid-cap",          2),
    ("Equity", "Small Cap",        "small-cap",        3),
    ("Equity", "Large & Mid Cap",  "large-mid-cap",    4),
    ("Equity", "Flexi Cap",        "flexi-cap",        5),
    ("Equity", "Multi Cap",        "multi-cap",        6),
    ("Equity", "ELSS",             "elss",             7),
    ("Equity", "Focused",          "focused",          8),
    ("Equity", "Value/Contra",     "value-contra",     9),
    ("Equity", "Dividend Yield",   "dividend-yield",   10),
    ("Equity", "Sectoral/Thematic","sectoral-thematic",11),
    # Hybrid
    ("Hybrid", "Aggressive Hybrid",    "aggressive-hybrid",    20),
    ("Hybrid", "Balanced Advantage",   "balanced-advantage",   21),
    ("Hybrid", "Conservative Hybrid",  "conservative-hybrid",  22),
    ("Hybrid", "Equity Savings",       "equity-savings",       23),
    ("Hybrid", "Multi Asset Allocation","multi-asset",         24),
    ("Hybrid", "Arbitrage",            "arbitrage",            25),
    # SEBI's seventh hybrid category. Small (3 Regular-Growth funds) but real,
    # and previously unmapped, so those funds carried no category at all.
    ("Hybrid", "Balanced Hybrid",      "balanced-hybrid",      26),
    # Debt
    ("Debt", "Overnight Fund",          "overnight",        30),
    ("Debt", "Liquid Fund",             "liquid",           31),
    ("Debt", "Ultra Short Duration",    "ultra-short",      32),
    ("Debt", "Low Duration",            "low-duration",     33),
    ("Debt", "Money Market",            "money-market",     34),
    ("Debt", "Short Duration",          "short-duration",   35),
    ("Debt", "Medium Duration",         "medium-duration",  36),
    ("Debt", "Medium to Long Duration", "medium-long",      37),
    ("Debt", "Long Duration",           "long-duration",    38),
    ("Debt", "Dynamic Bond",            "dynamic-bond",     39),
    ("Debt", "Corporate Bond",          "corporate-bond",   40),
    ("Debt", "Credit Risk",             "credit-risk",      41),
    ("Debt", "Banking & PSU",           "banking-psu",      42),
    ("Debt", "Gilt",                    "gilt",             43),
    ("Debt", "Gilt 10 Year Constant Duration", "gilt-10yr", 44),
    ("Debt", "Floater Fund",            "floater",          45),
    # Other
    ("Other", "Index Fund",     "index-fund",   50),
    ("Other", "ETF",            "etf",          51),
    ("Other", "Gold ETF",       "gold-etf",     52),
    ("Other", "FoF Overseas",   "fof-overseas", 53),
    # SEBI files Retirement and Children's funds as their own group, "Solution
    # Oriented". The dashboard has four asset classes and the site types them as
    # a closed union, so they sit under Other rather than becoming a fifth class.
    # What matters for the maths is that each gets its OWN peer group: a
    # retirement fund is now ranked against retirement funds, which is why they
    # are separate categories here instead of being folded into Equity.
    ("Other", "Retirement",     "retirement",   54),
    ("Other", "Children's",     "childrens",    55),
    # 298 Regular-Growth domestic fund-of-funds had no category. FoF Overseas
    # already existed; its domestic counterpart simply had never been mapped.
    ("Other", "FoF Domestic",   "fof-domestic", 56),
]

# AMFI category name → normalised category_name mapping
CATEGORY_NORM_MAP = {
    "Large Cap Fund":               "Large Cap",
    "Mid Cap Fund":                 "Mid Cap",
    "Small Cap Fund":               "Small Cap",
    "Flexi Cap Fund":               "Flexi Cap",
    "Multi Cap Fund":               "Multi Cap",
    "Large & Mid Cap Fund":         "Large & Mid Cap",
    "ELSS":                         "ELSS",
    "Focused Fund":                 "Focused",
    "Value Fund":                   "Value/Contra",
    "Contra Fund":                  "Value/Contra",
    "Dividend Yield Fund":          "Dividend Yield",
    # AMFI publishes "Sectoral/ Thematic" — WITHOUT a "Funds" suffix. The
    # fallback in parse_amfi_text tests `map_key in raw_text`, so a key longer
    # than what AMFI emits can never match: these three left 1,000 rows
    # unmapped and Sectoral/Thematic completely empty in the dashboard.
    "Sectoral/ Thematic":           "Sectoral/Thematic",
    "Sectoral/Thematic":            "Sectoral/Thematic",
    "Sectoral Fund":                "Sectoral/Thematic",
    "Thematic Fund":                "Sectoral/Thematic",
    "Sectoral/ Thematic Funds":     "Sectoral/Thematic",
    "Sectoral/Thematic Funds":      "Sectoral/Thematic",
    # Hybrid
    "Aggressive Hybrid Fund":           "Aggressive Hybrid",
    "Balanced Advantage Fund":          "Balanced Advantage",
    "Dynamic Asset Allocation or Balanced Advantage": "Balanced Advantage",
    "Conservative Hybrid Fund":         "Conservative Hybrid",
    "Equity Savings":                   "Equity Savings",
    "Equity Savings Fund":              "Equity Savings",
    "Multi Asset Allocation":           "Multi Asset Allocation",
    "Multi Asset Allocation Fund":      "Multi Asset Allocation",
    "Arbitrage Fund":                   "Arbitrage",
    "Balanced Hybrid Fund":             "Balanced Hybrid",
    # Solution Oriented. AMFI writes Children's with a CURLY apostrophe (U+2019);
    # the straight-quote spelling below never matches the live file but costs
    # nothing and guards against AMFI normalising it later.
    "Solution Oriented Scheme - Retirement Fund":  "Retirement",
    "Retirement Fund":                             "Retirement",
    "Solution Oriented Scheme - Children’s Fund": "Children's",
    "Children’s Fund":                        "Children's",
    "Children's Fund":                             "Children's",
    # Debt
    "Overnight Fund":                   "Overnight Fund",
    "Liquid Fund":                      "Liquid Fund",
    "Ultra Short Duration Fund":        "Ultra Short Duration",
    # Pre-2018 AMFI names, still attached to older schemes in the archive.
    "Ultra Short Term Fund":            "Ultra Short Duration",
    "Short Term Fund":                  "Short Duration",
    "Low Duration Fund":                "Low Duration",
    "Money Market Fund":                "Money Market",
    "Money Market":                     "Money Market",
    "Short Duration Fund":              "Short Duration",
    "Medium Duration Fund":             "Medium Duration",
    "Medium to Long Duration Fund":     "Medium to Long Duration",
    "Long Duration Fund":               "Long Duration",
    "Dynamic Bond":                     "Dynamic Bond",
    "Dynamic Bond Fund":                "Dynamic Bond",
    "Corporate Bond Fund":              "Corporate Bond",
    "Credit Risk Fund":                 "Credit Risk",
    "Banking and PSU Fund":             "Banking & PSU",
    "Banking and PSU Debt Fund":        "Banking & PSU",
    "Banking & PSU Debt Fund":          "Banking & PSU",
    "Gilt Fund":                        "Gilt",
    "Gilt":                             "Gilt",
    "Gilt Fund with 10 year constant duration": "Gilt 10 Year Constant Duration",
    # The pre-2018 spelling of the same category. Without it the substring rule
    # fell through to the shorter "Gilt Fund" and filed these as plain Gilt.
    "10-year Constant Maturity Gilt Fund": "Gilt 10 Year Constant Duration",
    "Floater Fund":                     "Floater Fund",
    "Floating Interest Rates Fund":      "Floater Fund",
    # More pre-2018 debt spellings. Longest-match ordering is what keeps these
    # apart: "Medium to Long Term Fund" must beat "Long Term Fund", and
    # "Ultra Short to Short Term Fund" must beat "Short Term Fund".
    "Dynamic Term Fund":                "Dynamic Bond",
    "Long Term Fund":                   "Long Duration",
    "Medium Term Fund":                 "Medium Duration",
    "Medium to Long Term Fund":         "Medium to Long Duration",
    # Not Ultra Short, despite the name of the section. Every one of the 57 rows
    # AMFI files here belongs to a fund called "<AMC> Low Duration Fund" (HSBC,
    # Invesco India, Mirae Asset, UTI) -- this is a pre-2018 bucket those funds
    # never got moved out of. The SEBI-era fund name is the better authority, and
    # it agrees for all five Regular-Growth schemes in the section.
    "Ultra Short to Short Term Fund":   "Low Duration",
    # Other
    "Index Funds":                      "Index Fund",
    "Index Fund":                       "Index Fund",
    # AMFI also files index funds under "Index Funds - <asset>". The old parser
    # kept only the text AFTER " - ", so the key became a bare "Equity Funds" /
    # "Debt Funds" / "Hybrid Fund" and matched nothing. Matching now runs against
    # the FULL text inside the parentheses, so these resolve.
    "Index Funds - Equity Funds":       "Index Fund",
    "Index Funds - Debt Funds":         "Index Fund",
    "Index Funds - Hybrid Fund":        "Index Fund",
    "Other ETFs":                       "ETF",
    "ETF":                              "ETF",
    "Gold ETF":                         "Gold ETF",
    # AMFI's actual section header is the short "FoF Overseas" (185 rows);
    # the two long-form spellings below never appear in the live file.
    "FoF Overseas":                     "FoF Overseas",
    "Fund of Funds investing overseas": "FoF Overseas",
    "Fund of Funds (Overseas)":         "FoF Overseas",
    "Fund of Fund - Overseas":          "FoF Overseas",
    "FoF Domestic":                     "FoF Domestic",
    "Fund of Funds Scheme (Domestic)":  "FoF Domestic",
    # DELIBERATELY ABSENT: the bare legacy headers "Income" and "Growth".
    # AMFI reuses them for Close Ended Schemes(Income) and (Growth) -- 4,617 rows
    # of fixed-maturity and interval plans. Mapping either one would sweep ~676
    # closed-end FMPs into an open-ended category. Those sections are skipped by
    # scheme type instead; see parse_amfi_text.
}


def resolve_category(raw: str | None) -> str | None:
    """
    AMFI's scheme-type text -> our category name, or None if we do not carry it.

    `raw` is the WHOLE string inside the parentheses of a scheme-type header,
    e.g. "Equity Scheme - Large Cap Fund" or "Index Funds - Equity Funds".

    LONGEST KEY WINS. The map holds keys that are substrings of other keys, and
    with dict-insertion order the shorter one won by accident:
        "10-year Constant Maturity Gilt Fund" matched "Gilt Fund"       -> Gilt
        "Medium to Long Term Fund"            matched "Long Term Fund"  -> Long Duration
        "Ultra Short to Short Term Fund"      matched "Short Term Fund" -> Short Duration
    Sorting candidates by length makes the most specific spelling win instead,
    which is the only ordering that is stable as keys are added.

    Whitespace is collapsed first: AMFI ships "Other Scheme - Other  ETFs" with a
    double space, which no single-spaced key could match.
    """
    if not raw:
        return None
    txt = re.sub(r"\s+", " ", raw).strip()
    # Apostrophes are the one character AMFI is inconsistent about: the live file
    # uses U+2019 in "Children's Fund", and a mis-declared charset can deliver it
    # mojibaked. Fold every variant onto the straight quote before matching so a
    # category never hinges on which one arrived.
    txt = txt.replace("’", "'").replace("‘", "'").replace("â", "'")
    # Exact hit on the full text, then on the part after " - ", so precise keys
    # never depend on the substring pass at all.
    folded = {k.replace("’", "'").replace("‘", "'"): v
              for k, v in CATEGORY_NORM_MAP.items()}
    if txt in folded:
        return folded[txt]
    if " - " in txt:
        tail = txt.split(" - ", 1)[1].strip()
        if tail in folded:
            return folded[tail]
    low = txt.lower()
    for key in sorted(folded, key=len, reverse=True):
        if key.lower() in low:
            return folded[key]
    return None

# Real index benchmarks seed (yahoo_ticker, index_name)
BENCHMARK_SEED = [
    # (index_name, yahoo_ticker, is_synthetic)
    ("NIFTY 50",            "^NSEI",                 0),
    ("SENSEX",              "^BSESN",                0),
    ("NIFTY 100",           "^CNX100",               0),
    ("NIFTY BANK",          "^NSEBANK",              0),
    ("NIFTY 500",           "^CRSLDX",               0),
    ("NIFTY MIDCAP 150",    "NIFTYMIDCAP150.NS",     0),
    ("NIFTY SMALLCAP 250",  "NIFTYSMLCAP250.NS",     0),
    ("NIFTY LARGEMIDCAP 250","NIFTY_LARGEMID250.NS", 0),
    ("GOLD (GOLDBEES)",     "GOLDBEES.NS",           0),
    ("NIFTY IT",            "^CNXIT",                0),
    ("GILT ETF (LTGILTBEES)","LTGILTBEES.NS",        0),
    # Synthetic blends (no yahoo_ticker)
    ("Aggressive Hybrid Blend",     None, 1),
    ("Balanced Advantage Blend",    None, 1),
    ("Conservative Hybrid Blend",   None, 1),
    ("Equity Savings Blend",        None, 1),
    ("Multi Asset Blend",           None, 1),
]

# Category → benchmark mapping  (category_name → benchmark index_name)
CATEGORY_BENCHMARK_MAP = {
    "Large Cap":            "NIFTY 100",
    "Mid Cap":              "NIFTY MIDCAP 150",
    "Small Cap":            "NIFTY SMALLCAP 250",
    "Large & Mid Cap":      "NIFTY LARGEMIDCAP 250",
    "Flexi Cap":            "NIFTY 500",
    "Multi Cap":            "NIFTY 500",
    "ELSS":                 "NIFTY 500",
    "Focused":              "NIFTY 500",
    "Value/Contra":         "NIFTY 500",
    "Dividend Yield":       "NIFTY 500",
    "Sectoral/Thematic":    "NIFTY 500",
    "Aggressive Hybrid":    "Aggressive Hybrid Blend",
    "Balanced Advantage":   "Balanced Advantage Blend",
    "Conservative Hybrid":  "Conservative Hybrid Blend",
    "Equity Savings":       "Equity Savings Blend",
    "Multi Asset Allocation":"Multi Asset Blend",
}

# Synthetic blend components: blend_name → [(component_name, weight), ...]
BLEND_COMPONENTS = {
    "Aggressive Hybrid Blend":  [("NIFTY 50", 0.65), ("GILT ETF (LTGILTBEES)", 0.35)],
    "Balanced Advantage Blend": [("NIFTY 50", 0.50), ("GILT ETF (LTGILTBEES)", 0.50)],
    "Conservative Hybrid Blend":[("NIFTY 50", 0.25), ("GILT ETF (LTGILTBEES)", 0.75)],
    "Equity Savings Blend":     [("NIFTY 50", 0.35), ("GILT ETF (LTGILTBEES)", 0.65)],
    "Multi Asset Blend":        [("NIFTY 50", 0.65), ("GILT ETF (LTGILTBEES)", 0.25), ("GOLD (GOLDBEES)", 0.10)],
}

CONFIG_SEED = [
    ("risk_free_rate", "0.065", "Annual risk-free rate (91-day T-Bill proxy). Change as data, not code."),
    ("composite_weights_sharpe",     "0.30", "Risk composite: Sharpe weight"),
    ("composite_weights_sortino",    "0.20", "Risk composite: Sortino weight"),
    ("composite_weights_alpha",      "0.20", "Risk composite: Alpha weight"),
    ("composite_weights_maxdd",      "0.15", "Risk composite: Max Drawdown weight"),
    ("composite_weights_capture",    "0.15", "Risk composite: Capture Spread weight"),
]


def seed_data(conn):
    cur = conn.cursor()

    # Config
    for key, value, note in CONFIG_SEED:
        cur.execute(
            "INSERT OR IGNORE INTO config(key, value, note) VALUES(?,?,?)",
            (key, value, note)
        )

    # Benchmarks (real + synthetic)
    for idx_name, ticker, is_synth in BENCHMARK_SEED:
        cur.execute(
            "INSERT OR IGNORE INTO benchmarks(index_name, yahoo_ticker, is_synthetic) VALUES(?,?,?)",
            (idx_name, ticker, is_synth)
        )

    # Blend components
    def get_idx(name):
        row = cur.execute("SELECT index_id FROM benchmarks WHERE index_name=?", (name,)).fetchone()
        return row[0] if row else None

    for blend_name, components in BLEND_COMPONENTS.items():
        blend_id = get_idx(blend_name)
        if blend_id is None:
            continue
        for comp_name, weight in components:
            comp_id = get_idx(comp_name)
            if comp_id is None:
                continue
            cur.execute(
                "INSERT OR IGNORE INTO benchmark_components(index_id, component_index_id, weight) VALUES(?,?,?)",
                (blend_id, comp_id, weight)
            )

    # Categories
    for order, (asset_class, cat_name, slug, disp_order) in enumerate(CATEGORY_SEED):
        cur.execute(
            "INSERT OR IGNORE INTO categories(asset_class, category_name, slug, display_order) VALUES(?,?,?,?)",
            (asset_class, cat_name, slug, disp_order)
        )

    # Wire category → benchmark
    for cat_name, bm_name in CATEGORY_BENCHMARK_MAP.items():
        bm_id = get_idx(bm_name)
        if bm_id:
            cur.execute(
                "UPDATE categories SET benchmark_id=? WHERE category_name=?",
                (bm_id, cat_name)
            )

    conn.commit()
    print("✅  Seed data inserted / verified.")


def main():
    conn = get_conn()
    create_schema(conn)
    seed_data(conn)
    conn.close()
    print(f"\n✅  Database ready at: {os.path.abspath(DB_PATH)}")


if __name__ == "__main__":
    main()
