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
import shutil
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
GLOBAL_FILES = re.compile(
    r"^(meta|indices|funds_index|glance_[a-z]+|watchlist_[a-z]+)\.json$")

# Defined in init_db, beside the asset classes it maps, so the publisher and
# nav_store cannot disagree about where a file lives.
from scripts.init_db import ASSET_FOLDER  # noqa: E402


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


def build_manifest(slug_ac: dict[str, str], code_slug: dict[str, str]) -> dict:
    """
    The manifest object, built in ONE place.

    This used to be inlined in write_manifest while write_local_tree assembled its
    own copy, and the two disagreed: the local file mapped a fund code to a bare
    slug ("large-cap") where the uploaded one mapped it to "<asset>/<slug>"
    ("equity/large-cap"). navPath() concatenates that value straight into a URL, so
    on a locally served build every nav fetch resolved to a path that does not
    exist -- Trend Finder drew no fund lines and Rolling & Point-to-Point showed an
    empty table, while the category screens kept working because they resolve
    through `categories` instead. Two builders for one file was the bug.
    """
    return {
        "version": 1,
        "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
        # slug -> "equity" | "hybrid" | "debt" | "other"
        "categories": slug_ac,
        # scheme_code -> "<asset-class>/<slug>", the folder holding its nav file
        "funds": {code: slug_ac[slug] + "/" + slug
                  for code, slug in code_slug.items() if slug in slug_ac},
    }


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
    manifest = build_manifest(slug_ac, code_slug)
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


def write_local_tree(out_dir: str, only: str | None) -> int:
    """
    Materialise the published layout on disk.

    The engine writes flat names (category_large-cap_trailing.json); the site
    asks for equity/large-cap/category_trailing.json and resolves the asset class
    through manifest.json. Uploading was the only thing that ever performed that
    rearrangement, so a locally built dataset was unreadable by the local site --
    which is why `npm run dev` kept showing whatever was last published.

    Stale files are removed, so the result is exactly what an upload would leave.
    """
    out_dir = os.path.abspath(out_dir)
    # Writing the tree into the directory it reads from is destructive and not
    # idempotent: remote_path() does not recognise tree paths, so on a second run
    # every file already in the tree counts as stale and is deleted. Keep the
    # engine's flat output somewhere separate and point this at the site.
    if os.path.normcase(out_dir) == os.path.normcase(os.path.abspath(DATA_DIR)):
        log.error("--to-dir must differ from the source directory (%s).", DATA_DIR)
        log.error("Build the flat output elsewhere first, e.g.:")
        log.error("  MF_OUTPUT_DIR=build/data-flat python scripts/daily_run.py")
        log.error("  MF_OUTPUT_DIR=build/data-flat python scripts/publish_data.py "
                  "--to-dir site/public/data")
        return 1

    slug_ac, code_slug = load_maps()
    items, skipped = build_plan(only)
    if not items:
        log.error("Nothing to write from %s", DATA_DIR)
        return 1

    log.info("=" * 62)
    log.info("WRITE LOCAL TREE  ->  %s", out_dir)
    log.info("=" * 62)
    print_plan(items, skipped)

    # Every copy happens before any deletion, which is what makes it safe to
    # write the tree into the directory the flat files came from: a flat source
    # is only removed after it has been copied to its place in the tree.
    written = {}
    for src, dest in items:
        target = os.path.join(out_dir, dest.replace("/", os.sep))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        # The global files (meta.json, glance_*, index/*) keep their path, so
        # source and target are the same file and copyfile would raise.
        if os.path.normcase(os.path.abspath(src)) != os.path.normcase(target):
            shutil.copyfile(src, target)
        written[os.path.normcase(target)] = True

    # manifest.json is generated, not copied — the site cannot resolve a single
    # path without it.
    # Built by the SAME function the upload uses; see build_manifest for what
    # went wrong when there were two.
    manifest = build_manifest(slug_ac, code_slug)
    mpath = os.path.join(out_dir, "manifest.json")
    with open(mpath, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, separators=(",", ":"))
    written[os.path.normcase(mpath)] = True
    log.info("manifest.json: %d categories, %d funds (%.0f KB)",
             len(slug_ac), len(code_slug), os.path.getsize(mpath) / 1024)

    # Anything left behind is from an older build. The flat files the engine
    # emitted into this directory are included in that: they are superseded by
    # the tree and would otherwise sit there looking authoritative.
    removed, locked = 0, 0
    for root, _dirs, files in os.walk(out_dir, topdown=False):
        for f in files:
            full = os.path.join(root, f)
            if os.path.normcase(full) not in written:
                try:
                    os.remove(full)
                    removed += 1
                except OSError:
                    locked += 1
        # An emptied directory is tidiness, not correctness. OneDrive holds a
        # handle on directories it is syncing and rmdir raises WinError 5, which
        # is no reason to fail a build whose files are already all in place.
        if (os.path.normcase(root) != os.path.normcase(out_dir)
                and not os.listdir(root)):
            try:
                os.rmdir(root)
            except OSError:
                pass
    if locked:
        log.warning("%d stale file(s) could not be deleted (locked); they are "
                    "not referenced by the site", locked)
    log.info("wrote %s file(s); removed %s stale file(s)",
             format(len(written), ","), format(removed, ","))
    return 0


# A run that would remove more than this share of the bucket is treated as a bad
# build rather than a cleanup. Pruning follows a successful upload, so the only
# way to reach that number is a plan that collapsed -- and deleting most of the
# published data on the strength of it would take the dashboard down.
MAX_PRUNE_FRACTION = 0.40


def prune_remote(sb, keep: set[str], apply: bool) -> int:
    """
    Delete bucket objects the current build no longer produces.

    Publishing only ever uploaded, so every fund ever removed from the catalogue
    left its nav/<code>.json behind -- 855 of them after the universe was pruned
    to funds AMFI still tracks. Those files are invisible to the dashboard, which
    only follows manifest.json, but they are real objects taking real space and
    they make the bucket a poor record of what the site actually serves.
    """
    remote = {o["name"] for o in sb.list_objects("", bucket=sb.DATA_BUCKET)}
    if not remote:
        log.warning("bucket listing came back empty; skipping the prune rather "
                    "than assuming everything is stale")
        return 0

    stale = sorted(remote - keep)
    if not stale:
        log.info("prune: nothing stale in the bucket")
        return 0

    share = len(stale) / len(remote)
    log.info("prune: %s of %s object(s) are stale (%.0f%%)",
             format(len(stale), ","), format(len(remote), ","), share * 100)
    for name in stale[:10]:
        log.info("    - %s", name)
    if len(stale) > 10:
        log.info("    ... and %s more", format(len(stale) - 10, ","))

    if share > MAX_PRUNE_FRACTION:
        log.error("REFUSING to prune: that is more than %.0f%% of the bucket. "
                  "Check the build before cleaning up.", MAX_PRUNE_FRACTION * 100)
        return 0
    if not apply:
        log.info("prune: dry run, nothing deleted (pass --prune to apply)")
        return 0

    removed = 0
    for i in range(0, len(stale), 200):          # the API takes a batch of paths
        removed += sb.delete_objects(stale[i:i + 200], bucket=sb.DATA_BUCKET)
    log.info("prune: deleted %s object(s)", format(removed, ","))
    return removed


def main() -> int:
    ap = argparse.ArgumentParser(description="Publish dashboard data to Supabase")
    ap.add_argument("--plan", action="store_true", help="print the layout and exit")
    ap.add_argument("--only", help="restrict to a prefix, e.g. nav/ or category_")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--verify", action="store_true",
                    help="read a sample back anonymously and exit")
    ap.add_argument("--prune", action="store_true",
                    help="after uploading, delete bucket objects this build no "
                         "longer produces (e.g. nav files for funds removed from "
                         "the catalogue). Without it they are only listed.")
    ap.add_argument("--to-dir", metavar="DIR",
                    help="write the same asset-class tree to DIR instead of "
                         "uploading. The dashboard reads that layout, not the "
                         "flat files the engine emits, so this is what makes a "
                         "local `npm run dev` show a freshly built dataset "
                         "without publishing anything.")
    args = ap.parse_args()

    if args.to_dir:
        return write_local_tree(args.to_dir, args.only)

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
    if not failed:
        # Only prune after a clean upload: pruning against a partial plan would
        # delete files that simply had not been re-uploaded yet.
        keep = {dest for _, dest in items} | {"manifest.json"}
        prune_remote(sb, keep, apply=args.prune)
    else:
        log.warning("skipping the prune because %d upload(s) failed", len(failed))
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
