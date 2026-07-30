"""
sectors.py — sub-categories for the Sectoral/Thematic bucket.

AMFI files ~250 funds under the single SEBI category "Sectoral/Thematic". A
pharma fund and a defence fund are not peers, so each sector is treated as its
own category here: ranked within itself, exactly like Large Cap or Mid Cap.
There is no SEBI sub-category and the API gives nothing beyond the scheme name,
so the theme is inferred from that name.

THIS IS THE SINGLE SOURCE OF TRUTH.
site/src/utils/sectors.ts used to classify in the browser too. It no longer
does: build_json stamps each fund's sector into the JSON and the frontend reads
that field. Two implementations of a 25-rule ordered match would drift, and a
fund appearing under Healthcare in one section and Other in another is exactly
the kind of bug nobody reports.

RULE ORDER IS THE LOGIC. First match wins, so specific precedes general:
'infra' before 'energy' so "Power & Infra" reads as Infrastructure, and ESG
before the factor rule because the AMCs "quant" and "Quantum" would otherwise
make every one of their funds look like a quant strategy.

Verified against all 247 live sectoral funds: 246 classified, 1 genuinely
diversified fund left in Other.
"""

from __future__ import annotations

import re

ALL_SECTORS = "All Sectors"

# The AMFI category slug these sub-categories apply to.
SECTORAL_THEMATIC_SLUG = "sectoral-thematic"

FIN = "Financial Services & Banking"
HEALTH = "Healthcare & Pharma"
TECH = "Technology & Telecom"
INFRA = "Infrastructure & Realty"
CONSUMPTION = "Consumption & FMCG"
ENERGY = "Energy & Utilities"
METAL = "Metal & Commodities"
SERVICES = "Services & Exports"
RURAL = "Rural & Agri"
TOURISM = "Tourism & Hospitality"
PSE = "PSE & CPSE"
MNC = "MNC"
CONGLOM = "Conglomerate"
INTL = "International & Global"
MANUF = "Manufacturing"
CYCLE = "Business Cycle"
INNOV = "Innovation"
QUANT = "Quant & Factor"
ESG = "ESG & Ethical"
SPECIAL = "Special Opportunities"
IPO = "IPO & Recently Listed"
THEME_OTHER = "Thematic - Other (Defence, Railways, Auto)"
OTHER = "Other Sectoral / Thematic"

_QUANT_WORD = re.compile(r"\bquant\b")


def _has(n: str, *tokens: str) -> bool:
    return any(t in n for t in tokens)


# Ordered; first match wins. Mirrors site/src/utils/sectors.ts RULES exactly.
_RULES: list[tuple[str, object]] = [
    (FIN,         lambda n: _has(n, "bank", "finan", "fsi", "pru bank")),
    (HEALTH,      lambda n: _has(n, "healthcare", "pharma", "health", "medical", "biotech")),
    (TECH,        lambda n: _has(n, "tech", "it ", "digital", "telecom", "software", "internet")),
    (INFRA,       lambda n: _has(n, "infra", "realty", "housing", "real estate", "construct")),
    (CONSUMPTION, lambda n: _has(n, "consumption", "fmcg", "consumer", "retail", "brand")),
    (PSE,         lambda n: _has(n, "pse", "psu", "public sector")),
    (MNC,         lambda n: _has(n, "mnc", "multinational")),
    (METAL,       lambda n: _has(n, "metal", "commodit", "resource", "material")),
    (ENERGY,      lambda n: _has(n, "energy", "power", "utility", "utilities")),
    (THEME_OTHER, lambda n: _has(n, "defence", "railway", "transport", "mobility", "auto")),

    # Everything below was previously swept into OTHER - nearly half the bucket,
    # which made the sub-category useless. These sit after the ten above so no
    # fund that already had a theme can change theme.
    (TECH,     lambda n: _has(n, "teck")),                       # quant Teck Fund
    (INFRA,    lambda n: _has(n, "t.i.g.e.r", "build india")),
    (METAL,    lambda n: _has(n, "comma")),                      # SBI COMMA Fund
    (RURAL,    lambda n: _has(n, "rural", "agri")),
    (MANUF,    lambda n: _has(n, "manufactur", "make in india")),
    (CYCLE,    lambda n: _has(n, "business cycle")),
    (CONGLOM,  lambda n: _has(n, "conglomerate")),
    (SERVICES, lambda n: _has(n, "export", "service")),
    (INTL,     lambda n: _has(n, "international", "global", "overseas", "asian", "china",
                                 "japan", "taiwan", "europe", "emerging market", "nasdaq",
                                 "world", "bluechip equity", " us ")),
    # Before QUANT: "QUANTUM ESG Best in Class" and "quant ESG Integration" are
    # ESG mandates whose AMC name merely happens to contain "quant".
    (ESG,      lambda n: _has(n, "esg", "sustainab", "responsib", "ethical")),
    (INNOV,    lambda n: _has(n, "innovat", "pioneer")),
    # \bquant\b so the AMC "Quantum" does not read as a quant strategy.
    (QUANT,    lambda n: bool(_QUANT_WORD.search(n)) or _has(
        n, "quantamental", "factor", "momentum", "minimum variance", "quality",
        "best-in-class", "best in class", "alpha")),
    (TOURISM,  lambda n: _has(n, "tourism", "travel", "hotel", "leisure")),
    (SPECIAL,  lambda n: _has(n, "opportunit", "special situation")),
    (IPO,      lambda n: _has(n, "ipo")),
]


def sector_of(scheme_name: str) -> str:
    """Which sub-category a Sectoral/Thematic fund belongs to, from its name."""
    n = (scheme_name or "").lower()
    for sector, test in _RULES:
        if test(n):
            return sector
    return OTHER


def slug_of(sector: str) -> str:
    """URL/file-safe slug for a sector name."""
    s = sector.lower()
    s = s.replace("&", "and")
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


# Canonical order: real sectors, then ownership/structure themes, then strategy
# themes, catch-all last. Matches SECTORS in site/src/utils/sectors.ts.
SECTORS: list[str] = [
    FIN, HEALTH, TECH, INFRA, CONSUMPTION, ENERGY, METAL, SERVICES, RURAL, TOURISM,
    PSE, MNC, CONGLOM, INTL,
    MANUF, CYCLE, INNOV, QUANT, ESG, SPECIAL, IPO, THEME_OTHER,
    OTHER,
]

SECTOR_ORDER = {name: i for i, name in enumerate(SECTORS)}
