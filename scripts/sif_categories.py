"""
sif_categories.py — the SIF investment strategies, and the mapping into them.

SEBI's Specialised Investment Fund framework defines SEVEN investment
strategies, three equity-oriented, two debt-oriented and two hybrid. All seven
are seeded here, including the two debt strategies that no AMC has launched yet:
the mapping has to exist before the fund does, or the first debt SIF to appear
lands in a category that is not there and gets dropped.

    Equity   Equity Long-Short Fund
             Equity Ex-Top 100 Long-Short Fund
             Sector Rotation Long-Short Fund
    Debt     Debt Long-Short Fund                    <- none launched yet
             Sectoral Debt Long-Short Fund           <- none launched yet
    Hybrid   Active Asset Allocator Long-Short Fund
             Hybrid Long-Short Fund

HOW A FUND REACHES ITS CATEGORY
AMFI prints the strategy in the section header above each block of schemes:

    Open Ended Schemes(Equity Oriented Investment Strategies - Equity Ex-Top 100 Long-Short Fund)
    Interval Fund Schemes ( Hybrid Investment Strategies - Hybrid Long-Short Fund )

The strategy is matched by SEARCHING the header for a seeded name rather than by
splitting on " - ", because the separator is not dependable — the two feeds space
the parentheses differently, and AMCs write "Long - Short" and "Long-Short" for
the same thing. Everything is normalised to lowercase alphanumeric words first,
and the longest name is tried first so "Debt Long-Short Fund" cannot claim a
"Sectoral Debt Long-Short Fund" header out from under it.

THE ASSET CLASS IS CHECKED TWICE
The header also names the family ("Equity Oriented Investment Strategies"). That
is compared against the seeded asset class, so if AMFI ever files a strategy
under a different family we hear about it instead of inheriting a stale one. The
MF pipeline learned this the hard way: 4,752 rows once inherited the previous
section's category because a header stopped being recognised.
"""
from __future__ import annotations

import re

# (asset_class, name, slug, display_order)
#
# display_order is the ONLY thing that orders the category list on screen —
# build_json selects `ORDER BY c.display_order` and nothing groups by asset
# class — so this sequence is exactly what a reader sees in every tab's picker.
# It is a house sequence rather than an alphabetical or by-asset-class one, which
# is why Hybrid Long-Short sits between two equity strategies.
CATEGORY_SEED: list[tuple[str, str, str, int]] = [
    ("Equity", "Equity Long-Short Fund",                 "equity-long-short",                1),
    ("Equity", "Equity Ex-Top 100 Long-Short Fund",      "equity-ex-top-100-long-short",     2),
    ("Hybrid", "Hybrid Long-Short Fund",                 "hybrid-long-short",                3),
    ("Equity", "Sector Rotation Long-Short Fund",        "sector-rotation-long-short",       4),
    ("Hybrid", "Active Asset Allocator Long-Short Fund", "active-asset-allocator-long-short", 5),
    # The two debt strategies have no launched fund yet, so they sit at the end
    # where their "Coming Funds" state does not push the live ones down.
    ("Debt",   "Debt Long-Short Fund",                   "debt-long-short",                  6),
    ("Debt",   "Sectoral Debt Long-Short Fund",          "sectoral-debt-long-short",         7),
]

# Same folder names the MF desk uses, so a SIF bucket path reads the same way.
ASSET_FOLDER = {"Equity": "equity", "Debt": "debt", "Hybrid": "hybrid"}

ASSET_ORDER = ["Equity", "Hybrid", "Debt"]


def normalise(text: str) -> str:
    """Lowercase, punctuation flattened to single spaces."""
    return " ".join(re.sub(r"[^0-9a-z]+", " ", (text or "").lower()).split())


# Longest first: a shorter name that is a substring of a longer one must not win.
_BY_LENGTH = sorted(CATEGORY_SEED, key=lambda c: -len(normalise(c[1])))

# Which family AMFI files each asset class under, for the cross-check.
_FAMILY = {"Equity": "equity oriented", "Debt": "debt oriented", "Hybrid": "hybrid"}


class Category(dict):
    """A seeded strategy. A dict so it serialises straight to JSON."""

    @property
    def slug(self) -> str:
        return self["slug"]

    @property
    def asset_class(self) -> str:
        return self["asset_class"]


def all_categories() -> list[Category]:
    return [Category(name=n, slug=s, asset_class=ac, order=o)
            for ac, n, s, o in CATEGORY_SEED]


def resolve(section: str) -> Category | None:
    """
    The strategy named in an AMFI section header, or None.

    `section` is the text inside the parentheses, e.g.
    "Equity Oriented Investment Strategies - Equity Ex-Top 100 Long-Short Fund".
    """
    hay = normalise(section)
    if not hay:
        return None
    for ac, name, slug, order in _BY_LENGTH:
        if normalise(name) in hay:
            return Category(name=name, slug=slug, asset_class=ac, order=order)
    return None


def family_matches(section: str, asset_class: str) -> bool:
    """
    Does the header's family agree with the strategy's seeded asset class?

    False is not fatal on its own — it means look at it, because either AMFI
    moved a strategy or the seed is wrong.
    """
    return _FAMILY.get(asset_class, "\0") in normalise(section)


def folder(asset_class: str, slug: str) -> str:
    """Bucket folder for a category, e.g. "equity/equity-long-short"."""
    return f"{ASSET_FOLDER.get(asset_class, 'other')}/{slug}"
