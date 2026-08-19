"""
publish_data.py — put the dashboard's data in Supabase, organised by asset class.

WHY
Every nightly run rewrote 2,477 files inside the website, so Netlify rebuilt and
re-uploaded the whole site: ~15 minutes a deploy, ~450 minutes a month against a
300-minute allowance. The data does not belong in the build. Moving it out means
Netlify only builds when the code changes, and new data is live the moment this
finishes — no deploy at all.

LAYOUT
Flat names would have worked with a single redirect, but the bucket then holds
2,477 files in one heap. Grouping by asset class and category keeps it navigable
as it grows, and mirrors how the dashboard is actually used: every screen is
scoped to one category.

    meta.json  indices.json  glance_<view>.json  watchlist_<mode>.json
    index/<index_id>.json
    equity/<slug>/  category_<view>.json  quartiles_<mode>.json
                    rolling.json  risk.json  history.json
                    nav/<scheme_code>.json
    hybrid/<slug>/  ...
    debt/<slug>/    ...
    other/<slug>/   ...

The asset class of a slug comes from meta.json, and the category of a fund from
the category tables — both already published, so a new category or fund needs no
change here.

Usage:
  python scripts/publish_data.py --plan        # print the layout, upload nothing
  python scripts/publish_data.py               # publish
  python scripts/publish_data.py --only nav/   # just one kind
  python scripts/publish_data.py --verify      # read a sample back with no key
"""

from __future__ import annotations

import argparse
import collections
import json
import logging
import os
import re
import sys
import time
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger("publish_data")

DATA_DIR = os.environ.get("MF_OUTPUT_DIR") or os.path.join(
    ROOT_DIR, "site", "public", "data")

# Files that are not category-scoped and stay at the bucket root.
GLOBAL_FILES = re.compile(r"^(meta|indices|glance_[a-z]+|watchlist_[a-z]+)\.json$")

ASSET_FOLDER = {"Equity": "equity", "Hybrid": "hybrid",
                "Debt": "debt", "Other": "other"}


def load_maps() -> tuple[dict[str, str], dict[str, str]]:
    """
    (slug -> asset-class folder, scheme_code -> slug).

    Both derived from files the pipeline already writes, so adding a category or
    a fund needs no change here.
    """
    with open(os.path.join(DATA_DIR, "meta.json"), encoding="utf-8") as fh:
        meta = json.load(fh)
    slug_ac = {c["slug"]: ASSET_FOLDER.get(c["asset_class"], "other")
               for c in meta["categories"]}

    code_slug: dict[str, str] = {}
    for slug in slug_ac:
        p = os.path.join(DATA_DIR, "category_" + slug + "_trailing.json")
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf-8") as fh:
            for f in json.load(fh)["funds"]:
                code_slug[str(f["scheme_code"])] = slug
    return slug_ac, code_slug


def remote_path(rel: str, slug_ac: dict[str, str],
                code_slug: dict[str, str]) -> str | None:
    """
    Where a local file belongs, given its path relative to DATA_DIR.

    None means "leave it out" — in practice only files the build no longer
    produces but that linger in a working copy.
    """
    name = rel.rsplit("/", 1)[-1]
    stem = name[:-len(".json")]

    if "/" not in rel and GLOBAL_FILES.match(name):
        return rel
    if rel.startswith("index/"):
        return rel

    def scoped(slug: str | None, tail: str) -> str | None:
        ac = slug_ac.get(slug or "")
        return ac + "/" + slug + "/" + tail if ac else None

    if rel.startswith("nav/"):
        slug = code_slug.get(stem)
        # A fund with no category cannot be filed under one. Parked together so
        # it stays visible rather than being silently dropped.
        return scoped(slug, "nav/" + name) if slug else "unfiled/nav/" + name

    if rel.startswith("category_history/"):
        return scoped(stem, "history.json")

    for prefix, tail in (("category_", "category_{}.json"),
                         ("quartiles_", "quartiles_{}.json")):
        if name.startswith(prefix):
            body = stem[len(prefix):]
            slug, _, view = body.rpartition("_")
            if slug in slug_ac:
                return scoped(slug, tail.format(view))

    for prefix, tail in (("rolling_", "rolling.json"), ("risk_", "risk.json")):
        if name.startswith(prefix):
            slug = stem[len(prefix):]
            if slug in slug_ac:
                return scoped(slug, tail)

    return None


def build_plan(only: str | None = None) -> tuple[list[tuple[str, str]], list[str]]:
    slug_ac, code_slug = load_maps()
    items: list[tuple[str, str]] = []
    skipped: list[str] = []
    for root, _, files in os.walk(DATA_DIR):
        rel_dir = os.path.relpath(root, DATA_DIR).replace(os.sep, "/")
        for f in sorted(files):
            if not f.endswith(".json"):
                continue
            rel = f if rel_dir == "." else rel_dir + "/" + f
            if only and not rel.startswith(only):
                continue
            dest = remote_path(rel, slug_ac, code_slug)
            if dest is None:
                skipped.append(rel)
            else:
                items.append((os.path.join(root, f), dest))
    return items, skipped


def print_plan(items, skipped):
    total = sum(os.path.getsize(s) for s, _ in items)
    log.info("%s files, %.1f MB", format(len(items), ","), total / 1048576)
    tree: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for _, dest in items:
        parts = dest.split("/")
        top = parts[0] if len(parts) > 1 else "(root)"
        second = parts[1] if len(parts) > 2 else "-"
        tree[top][second] += 1
    for top in sorted(tree):
        n = sum(tree[top].values())
        folders = [k for k in tree[top] if k != "-"]
        log.info("  %-9s %5d file(s)  %d folder(s)", top, n, len(folders) or 1)
        for second in sorted(folders)[:3]:
            log.info("      %s/  %d", second, tree[top][second])
        if len(folders) > 3:
            log.info("      ... and %d more", len(folders) - 3)
    if skipped:
        log.warning("  %d file(s) not mapped (stale outputs): %s",
                    len(skipped), ", ".join(skipped[:6]))


def write_manifest(sb, slug_ac: dict[str, str], code_slug: dict[str, str]) -> bool:
    """
    Publish manifest.json: how to find anything in this bucket.

    Files now live under <asset-class>/<slug>/, so a caller needs the asset class
    of a category and the category of a fund to build a path. The dashboard knows
    neither in every place it needs them — TrendFinder, for instance, is handed
    fund codes with no category attached, and threading a slug through props from
    the screener would couple two screens that are otherwise independent.

    One small lookup, fetched once and cached, keeps path-building in one place.
    About 65 KB, ~20 KB on the wire after Supabase gzips it.
    """
    manifest = {
        "version": 1,
        "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
        # slug -> "equity" | "hybrid" | "debt" | "other"
        "categories": slug_ac,
        # scheme_code -> "<asset-class>/<slug>", the folder holding its nav file
        "funds": {code: slug_ac[slug] + "/" + slug
                  for code, slug in code_slug.items() if slug in slug_ac},
    }
    body = json.dumps(manifest, separators=(",", ":")).encode("utf-8")
    ok = sb.upload_bytes(body, "manifest.json", bucket=sb.DATA_BUCKET,
                         content_type="application/json",
                         cache_control="max-age=300")
    log.info("manifest.json: %d categories, %s funds, %.0f KB -> %s",
             len(manifest["categories"]), format(len(manifest["funds"]), ","),
             len(body) / 1024, "ok" if ok else "FAILED")
    return ok


def verify(sb) -> int:
    """Read a handful back with no credentials, the way a browser does."""
    import urllib.error
    import urllib.parse
    import urllib.request

    base = sb.URL + "/storage/v1/object/public/" + urllib.parse.quote(sb.DATA_BUCKET)
    slug_ac, code_slug = load_maps()
    a_code, a_slug = next(iter(code_slug.items()))
    samples = [
        "meta.json",
        slug_ac["large-cap"] + "/large-cap/category_trailing.json",
        slug_ac["large-cap"] + "/large-cap/quartiles_quarterly.json",
        slug_ac[a_slug] + "/" + a_slug + "/nav/" + a_code + ".json",
        "index/1.json",
    ]
    bad = 0
    for s in samples:
        url = base + "/" + "/".join(urllib.parse.quote(p) for p in s.split("/"))
        try:
            with urllib.request.urlopen(url, timeout=30) as r:
                body = r.read()
            log.info("  200  %-52s %7.1f KB", s, len(body) / 1024)
        except urllib.error.HTTPError as e:
            log.error("  %d  %s", e.code, s)
            bad += 1
    if bad:
        log.error("%d sample(s) not publicly readable — is the bucket public?", bad)
        return 1
    log.info("all samples readable with no key")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Publish dashboard data to Supabase")
    ap.add_argument("--plan", action="store_true", help="print the layout and exit")
    ap.add_argument("--only", help="restrict to a prefix, e.g. nav/ or category_")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--verify", action="store_true",
                    help="read a sample back anonymously and exit")
    args = ap.parse_args()

    from scripts import supabase_store as sb

    if args.verify:
        return verify(sb)

    items, skipped = build_plan(args.only)
    if not items:
        log.error("Nothing to publish from %s", DATA_DIR)
        return 1

    log.info("=" * 62)
    log.info("PUBLISH DATA -> Supabase  bucket=%r", sb.DATA_BUCKET)
    log.info("source: %s", DATA_DIR)
    log.info("=" * 62)
    print_plan(items, skipped)

    if args.plan:
        log.info("--plan: nothing uploaded.")
        return 0

    if not sb.enabled():
        log.error("Supabase not configured (%s)", sb.why_disabled())
        return 1

    t0 = time.time()

    def progress(done, total, ok, bad):
        rate = done / max(time.time() - t0, 0.001)
        log.info("  %5d/%d  ok=%d failed=%d  %.0f files/s  eta %.0fs",
                 done, total, ok, bad, rate, (total - done) / max(rate, 0.001))

    ok, failed = sb.upload_many(items, bucket=sb.DATA_BUCKET,
                                workers=args.workers, on_progress=progress)
    log.info("-" * 62)
    log.info("uploaded %s of %s in %.0fs", format(ok, ","), format(len(items), ","),
             time.time() - t0)
    if failed:
        log.error("%d failed, e.g. %s", len(failed), ", ".join(failed[:5]))
        return 1

    # Written last: it describes the layout, so it should only appear once the
    # layout it describes is actually in place.
    slug_ac, code_slug = load_maps()
    if not write_manifest(sb, slug_ac, code_slug):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
