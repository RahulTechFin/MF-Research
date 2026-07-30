"""
supabase_store.py — Supabase Storage helper for the MF Research pipeline.

Deliberately the same shape as the ETF dashboard's supabase_store.py (same env
var names, same enabled()/download_file()/upload_file() contract) so the two
projects can be reasoned about together and secrets copy across unchanged.

Credentials come from environment variables (GitHub Actions secrets) OR a local
`.env` in the repo root. Real environment variables win over `.env`.

If credentials are absent or still placeholders, enabled() returns False and
every call becomes a no-op returning False. That is what lets a local run with
no .env behave exactly as it does today, falling back to the committed file —
nothing breaks without Supabase.

Bucket layout:
    indices/index_history.json.gz   <- the rolling daily index store
"""

from __future__ import annotations

import logging
import os
import urllib.parse

import requests

log = logging.getLogger("supabase_store")

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_KEYS = ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_BUCKET")


def _load_env() -> dict[str, str]:
    vals: dict[str, str] = {}
    envf = os.path.join(_BASE, ".env")
    if os.path.exists(envf):
        try:
            with open(envf, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        vals[k.strip()] = v.strip().strip('"').strip("'")
        except Exception:
            pass
    # Real environment variables take precedence (GitHub Actions secrets).
    for k in _KEYS:
        if os.environ.get(k):
            vals[k] = os.environ[k]
    return vals


_ENV = _load_env()
URL = (_ENV.get("SUPABASE_URL") or "").rstrip("/")
KEY = _ENV.get("SUPABASE_SERVICE_KEY") or ""
# Matches the bucket that exists in the project, so SUPABASE_BUCKET only has to
# be set if it is ever renamed. The space is fine — _object_url percent-encodes
# it — but note the spelling is "Indicies", as created.
BUCKET = _ENV.get("SUPABASE_BUCKET") or "Indicies Data"


def enabled() -> bool:
    """True only when real, non-placeholder credentials are present."""
    return bool(URL and KEY and "PASTE" not in KEY.upper())


def why_disabled() -> str:
    """Human-readable reason, so a skipped sync is never silent."""
    if not URL:
        return "SUPABASE_URL is not set"
    if not KEY:
        return "SUPABASE_SERVICE_KEY is not set"
    if "PASTE" in KEY.upper():
        return "SUPABASE_SERVICE_KEY is still a placeholder"
    return "enabled"


def _headers(extra: dict | None = None) -> dict:
    h = {"apikey": KEY, "Authorization": "Bearer " + KEY}
    if extra:
        h.update(extra)
    return h


def _object_url(remote_path: str, bucket: str | None = None) -> str:
    eb = urllib.parse.quote(bucket or BUCKET)
    ep = "/".join(urllib.parse.quote(seg) for seg in remote_path.split("/"))
    return f"{URL}/storage/v1/object/{eb}/{ep}"


def download_file(remote_path: str, local_path: str, bucket: str | None = None,
                  timeout: int = 120) -> bool:
    """Download bucket:remote_path -> local_path. True on success."""
    if not enabled():
        return False
    try:
        r = requests.get(_object_url(remote_path, bucket), headers=_headers(), timeout=timeout)
        if r.status_code == 200:
            os.makedirs(os.path.dirname(os.path.abspath(local_path)), exist_ok=True)
            # Write via a temp file and replace, so an interrupted download can
            # never leave a truncated store where a good one used to be.
            tmp = local_path + ".part"
            with open(tmp, "wb") as f:
                f.write(r.content)
            os.replace(tmp, local_path)
            return True
        if r.status_code not in (400, 404):
            log.warning("Supabase download %s -> HTTP %d", remote_path, r.status_code)
        return False
    except Exception as exc:
        log.warning("Supabase download %s failed: %s", remote_path, exc)
        return False


def download_bytes(remote_path: str, bucket: str | None = None,
                   timeout: int = 120) -> bytes | None:
    """Object body, or None when it is absent or unreachable."""
    if not enabled():
        return None
    try:
        r = requests.get(_object_url(remote_path, bucket), headers=_headers(), timeout=timeout)
        if r.status_code == 200:
            return r.content
        if r.status_code not in (400, 404):
            log.warning("Supabase get %s -> HTTP %d", remote_path, r.status_code)
        return None
    except Exception as exc:
        log.warning("Supabase get %s failed: %s", remote_path, exc)
        return None


def upload_bytes(body: bytes, remote_path: str, bucket: str | None = None,
                 content_type: str = "application/octet-stream",
                 cache_control: str | None = None, timeout: int = 180) -> bool:
    """Upload an in-memory body, overwriting. True on success."""
    if not enabled():
        return False
    try:
        extra = {"x-upsert": "true", "Content-Type": content_type}
        if cache_control:
            extra["cache-control"] = cache_control
        r = requests.post(_object_url(remote_path, bucket), headers=_headers(extra),
                          data=body, timeout=timeout)
        if r.status_code not in (200, 201):
            log.warning("Supabase upload %s -> HTTP %d %s", remote_path,
                        r.status_code, r.text[:180])
            return False
        return True
    except Exception as exc:
        log.warning("Supabase upload %s failed: %s", remote_path, exc)
        return False


def list_objects(prefix: str = "", bucket: str | None = None,
                 timeout: int = 60) -> list[dict]:
    """
    Every object at or below `prefix`, recursively.

    The list endpoint returns folders as entries with metadata=None rather than
    descending into them, so this walks them itself.
    """
    if not enabled():
        return []
    eb = urllib.parse.quote(bucket or BUCKET)
    out: list[dict] = []

    def walk(pfx: str):
        try:
            r = requests.post(
                f"{URL}/storage/v1/object/list/{eb}",
                headers=_headers({"Content-Type": "application/json"}),
                json={"prefix": pfx, "limit": 500, "offset": 0,
                      "sortBy": {"column": "name", "order": "asc"}},
                timeout=timeout,
            )
            if r.status_code != 200:
                log.warning("Supabase list %r -> HTTP %d", pfx, r.status_code)
                return
            for o in r.json():
                name = (pfx + o["name"]) if pfx else o["name"]
                if o.get("metadata") is None:
                    walk(name + "/")
                else:
                    out.append({"name": name, "size": o["metadata"].get("size", 0)})
        except Exception as exc:
            log.warning("Supabase list %r failed: %s", pfx, exc)

    walk(prefix)
    return out


def delete_objects(paths: list[str], bucket: str | None = None,
                   timeout: int = 120) -> int:
    """Delete objects by path. Returns how many the API reported removed."""
    if not enabled() or not paths:
        return 0
    eb = urllib.parse.quote(bucket or BUCKET)
    try:
        r = requests.delete(
            f"{URL}/storage/v1/object/{eb}",
            headers=_headers({"Content-Type": "application/json"}),
            json={"prefixes": paths},
            timeout=timeout,
        )
        if r.status_code != 200:
            log.warning("Supabase delete -> HTTP %d %s", r.status_code, r.text[:180])
            return 0
        return len(r.json())
    except Exception as exc:
        log.warning("Supabase delete failed: %s", exc)
        return 0


def upload_file(local_path: str, remote_path: str, bucket: str | None = None,
                content_type: str | None = None, cache_control: str | None = None,
                timeout: int = 180) -> bool:
    """Upload local_path -> bucket:remote_path, overwriting. True on success."""
    if not enabled():
        return False
    if content_type is None:
        if local_path.endswith(".gz"):
            content_type = "application/gzip"
        elif local_path.endswith(".json"):
            content_type = "application/json"
        else:
            content_type = "application/octet-stream"
    try:
        with open(local_path, "rb") as f:
            body = f.read()
        extra = {"x-upsert": "true", "Content-Type": content_type}
        if cache_control:
            extra["cache-control"] = cache_control
        r = requests.post(_object_url(remote_path, bucket), headers=_headers(extra),
                          data=body, timeout=timeout)
        if r.status_code not in (200, 201):
            log.warning("Supabase upload %s -> HTTP %d %s", remote_path,
                        r.status_code, r.text[:180])
            return False
        return True
    except Exception as exc:
        log.warning("Supabase upload %s failed: %s", remote_path, exc)
        return False
