"""
Locks the shape of manifest.json.

The site builds every fund path by concatenating manifest.funds[code] with
"/nav/<code>.json". If that value is wrong the failure is SILENT: the fetch 404s,
the calling screen catches it and renders an empty chart or table. Trend Finder
and Rolling & Point-to-Point both went blank this way, while the category screens
kept working because they resolve through manifest.categories instead.

The cause was two builders for one file -- the uploader wrote
"<asset-class>/<slug>" and the local writer wrote a bare "<slug>". There is one
builder now, and these tests pin what it must produce.

Run:  python -m pytest tests/test_manifest.py -q
"""

from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from scripts.publish_data import build_manifest  # noqa: E402

SLUG_AC = {"large-cap": "equity", "arbitrage": "hybrid",
           "liquid": "debt", "etf": "other"}
CODE_SLUG = {"103174": "large-cap", "100835": "liquid",
             "119551": "arbitrage", "115284": "etf"}


def test_a_fund_maps_to_asset_class_and_slug():
    """Not a bare slug. This exact mistake blanked two whole screens."""
    m = build_manifest(SLUG_AC, CODE_SLUG)
    assert m["funds"]["103174"] == "equity/large-cap"
    assert m["funds"]["100835"] == "debt/liquid"
    assert m["funds"]["115284"] == "other/etf"


def test_every_fund_value_has_exactly_one_slash():
    m = build_manifest(SLUG_AC, CODE_SLUG)
    for code, dir_ in m["funds"].items():
        assert dir_.count("/") == 1, f"{code} -> {dir_!r}"
        asset, slug = dir_.split("/")
        assert asset in {"equity", "hybrid", "debt", "other"}, dir_
        assert SLUG_AC[slug] == asset


def test_the_path_the_site_builds_is_well_formed():
    """Mirrors navPath() in site/src/config/dataPaths.ts."""
    m = build_manifest(SLUG_AC, CODE_SLUG)
    assert (f"{m['funds']['103174']}/nav/103174.json"
            == "equity/large-cap/nav/103174.json")


def test_a_category_maps_to_its_asset_class():
    m = build_manifest(SLUG_AC, CODE_SLUG)
    assert m["categories"]["large-cap"] == "equity"
    assert m["categories"] == SLUG_AC


def test_a_fund_whose_category_is_unknown_is_left_out():
    """
    Better absent than pointing at a folder that does not exist: navPath throws a
    clear "not in the manifest" error, instead of the caller silently 404ing.
    """
    m = build_manifest(SLUG_AC, {**CODE_SLUG, "999999": "no-such-slug"})
    assert "999999" not in m["funds"]
    assert len(m["funds"]) == len(CODE_SLUG)


def test_both_lookups_are_present():
    m = build_manifest(SLUG_AC, CODE_SLUG)
    assert set(m) >= {"categories", "funds", "version"}


if __name__ == "__main__":
    import pytest
    sys.exit(pytest.main([__file__, "-v"]))
