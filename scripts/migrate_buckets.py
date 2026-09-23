"""
migrate_buckets.py — copy every object from one Supabase project to another.

    python scripts/migrate_buckets.py --dry-run     # list what would move
    python scripts/migrate_buckets.py               # do it
    python scripts/migrate_buckets.py --verify      # compare the two, copy nothing

WHY A COPY AND NOT A REBUILD
Re-running the pipeline against the new project would produce the same figures,
but not the same FILES: NAV history is read back from the bucket, so an empty
one bootstraps every fund from api.mfapi.in over 30-60 minutes and the result
is a fresh dataset rather than the one that is live today. Copying moves
exactly what is serving now, byte for byte, and can be checked against the
source afterwards.

CREDENTIALS
Reading is unauthenticated where the source bucket is public; the listing needs
the SOURCE service key, and writing needs the TARGET one. They are read from
.env and never printed:

    SUPABASE_URL                 source project        (already there)
    SUPABASE_SERVICE_KEY         source service_role   (already there)
    SUPABASE_NEW_URL             target project
    SUPABASE_NEW_SERVICE_KEY     target service_role

Kept as separate names on purpose. Overwriting the originals would point the
whole pipeline at the new project the moment they changed, and the cutover
should be a decision, not a side effect of a copy.

SAFETY
Nothing is deleted, in either project. An object that already exists in the
target is overwritten only with --force; by default it is skipped and counted,
so re-running after an interruption resumes rather than starting again.
"""

from __future__ import annotations

import argparse
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, ROOT_DIR)

import requests

from scripts import supabase_store as sb

# Both public data buckets. SIF is added by --include-sif because it is private
# and a target project may not have it.
DEFAULT_BUCKETS = ["MF Data", "Indicies Data"]


def _env(name: str) -> str:
    v = (sb._ENV.get(name) or os.environ.get(name) or "").strip()
    return v.rstrip("/") if name.endswith("URL") else v


def target_url(path: str, bucket: str, base: str) -> str:
    from urllib.parse import quote
    return f"{base}/storage/v1/object/{quote(bucket)}/{quote(path)}"


def content_type(path: str) -> str:
    if path.endswith(".json"):
        return "application/json"
    if path.endswith(".gz"):
        return "application/gzip"
    if path.endswith(".parquet"):
        return "application/octet-stream"
    return "application/octet-stream"


def existing_in_target(bucket: str, base: str, key: str) -> set[str]:
    """Paths already present in the target, so an interrupted run can resume."""
    out: set[str] = set()
    stack = [""]
    session = requests.Session()
    while stack:
        prefix = stack.pop()
        offset = 0
        while True:
            r = session.post(
                f"{base}/storage/v1/object/list/{bucket}",
                headers={"Authorization": f"Bearer {key}", "apikey": key},
                json={"prefix": prefix, "limit": 1000, "offset": offset},
                timeout=60,
            )
            if r.status_code != 200:
                return out                      # bucket absent or unreadable
            rows = r.json()
            if not rows:
                break
            for row in rows:
                name = f"{prefix}{row['name']}" if prefix else row["name"]
                if row.get("id") is None:       # a folder
                    stack.append(name + "/")
                else:
                    out.add(name)
            if len(rows) < 1000:
                break
            offset += len(rows)
    return out


def migrate(bucket: str, dry_run: bool, force: bool, verify_only: bool) -> tuple[int, int, int]:
    src_base = _env("SUPABASE_URL")
    dst_base = _env("SUPABASE_NEW_URL")
    dst_key = _env("SUPABASE_NEW_SERVICE_KEY")
    if not dst_base or not dst_key:
        raise SystemExit(
            "SUPABASE_NEW_URL and SUPABASE_NEW_SERVICE_KEY must be set in .env — "
            "see the module docstring."
        )

    print(f"\n=== {bucket} ===")
    source = [o["name"] for o in sb.list_objects("", bucket=bucket)]
    print(f"  source holds {len(source):,} object(s)")
    if not source:
        print("  nothing to copy")
        return 0, 0, 0

    present = existing_in_target(bucket, dst_base, dst_key)
    print(f"  target holds {len(present):,} object(s) already")

    if verify_only:
        missing = [p for p in source if p not in present]
        extra = [p for p in present if p not in set(source)]
        print(f"  missing from target : {len(missing):,}")
        for p in missing[:10]:
            print(f"      {p}")
        print(f"  only in target      : {len(extra):,}")
        return 0, 0, len(missing)

    todo = source if force else [p for p in source if p not in present]
    print(f"  to copy: {len(todo):,}   (skipping {len(source) - len(todo):,} already there)")
    if dry_run:
        for p in todo[:15]:
            print(f"      would copy {p}")
        if len(todo) > 15:
            print(f"      ... and {len(todo) - 15:,} more")
        return 0, len(source) - len(todo), 0

    session = requests.Session()
    copied = failed = 0
    t0 = time.time()
    for i, path in enumerate(todo, 1):
        try:
            body = sb.download_bytes(path, bucket=bucket)
            if body is None:
                failed += 1
                print(f"  ! could not read {path}")
                continue
            r = session.post(
                target_url(path, bucket, dst_base),
                headers={
                    "Authorization": f"Bearer {dst_key}",
                    "apikey": dst_key,
                    "Content-Type": content_type(path),
                    "x-upsert": "true",
                },
                data=body,
                timeout=120,
            )
            if r.status_code in (200, 201):
                copied += 1
            else:
                failed += 1
                print(f"  ! {r.status_code} writing {path}: {r.text[:120]}")
        except Exception as exc:
            failed += 1
            print(f"  ! {type(exc).__name__} on {path}: {str(exc)[:120]}")
        if i % 200 == 0:
            rate = i / max(time.time() - t0, 1)
            print(f"     {i:,}/{len(todo):,}  ({rate:.0f}/s)")

    print(f"  copied {copied:,}, failed {failed:,}")
    return copied, len(source) - len(todo), failed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true", help="list what would move")
    ap.add_argument("--verify", action="store_true", help="compare only, copy nothing")
    ap.add_argument("--force", action="store_true", help="overwrite objects already in the target")
    ap.add_argument("--include-sif", action="store_true", help="also copy the private SIF bucket")
    ap.add_argument("--bucket", action="append", help="copy only this bucket (repeatable)")
    args = ap.parse_args()

    buckets = args.bucket or list(DEFAULT_BUCKETS)
    if args.include_sif and not args.bucket:
        buckets.append(sb.SIF_BUCKET)

    total_copied = total_skipped = total_failed = 0
    for b in buckets:
        c, s, f = migrate(b, args.dry_run, args.force, args.verify)
        total_copied += c
        total_skipped += s
        total_failed += f

    print("\n" + "=" * 58)
    if args.verify:
        print(f"VERIFY: {total_failed:,} object(s) missing from the target")
        return 1 if total_failed else 0
    print(f"copied {total_copied:,}   already present {total_skipped:,}   failed {total_failed:,}")
    if total_failed:
        print("Re-run to retry the failures — objects already copied are skipped.")
    return 1 if total_failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
