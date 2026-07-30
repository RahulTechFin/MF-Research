"""
mfapi_client.py — Client for api.mfapi.in (the NAV data source).

Endpoints used
--------------
  GET /mf                  -> [{schemeCode, schemeName, isinGrowth, ...}]  (~5.7 MB)
  GET /mf/{code}           -> {meta, data:[{date:"DD-MM-YYYY", nav:"123.45"}], status}
  GET /mf/{code}/latest    -> same shape, single most-recent data point

Notes that shaped this code
---------------------------
  * Dates arrive as DD-MM-YYYY strings; the database stores ISO YYYY-MM-DD.
  * NAVs arrive as strings and are occasionally "0", "0.00000" or "N.A." for
    days a fund did not report. Those rows are dropped — nav_history has a
    CHECK(nav > 0) constraint.
  * The API is community-run with no SLA, so every call is retried with
    exponential backoff and the caller is told exactly what failed.
"""

from __future__ import annotations

import logging
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Iterable

import requests

log = logging.getLogger("mfapi")

BASE_URL = "https://api.mfapi.in"
DEFAULT_WORKERS = 12
DEFAULT_TIMEOUT = 30
MAX_RETRIES = 4


class MFApiError(RuntimeError):
    pass


def _make_session(pool: int) -> requests.Session:
    sess = requests.Session()
    adapter = requests.adapters.HTTPAdapter(
        pool_connections=pool, pool_maxsize=pool, max_retries=0
    )
    sess.mount("https://", adapter)
    sess.mount("http://", adapter)
    sess.headers.update({"User-Agent": "MF-Research/1.0 (+internal research tool)"})
    return sess


def _get_json(sess: requests.Session, url: str, timeout: int = DEFAULT_TIMEOUT):
    """GET with exponential backoff. Returns parsed JSON or raises MFApiError."""
    last = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            r = sess.get(url, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            # 404 means the scheme genuinely does not exist upstream — no retry.
            if r.status_code == 404:
                raise MFApiError(f"404 not found: {url}")
            last = f"HTTP {r.status_code}"
        except MFApiError:
            raise
        except Exception as exc:
            last = repr(exc)

        if attempt < MAX_RETRIES:
            sleep = (2 ** (attempt - 1)) + random.uniform(0, 0.4)
            time.sleep(sleep)

    raise MFApiError(f"{url} failed after {MAX_RETRIES} attempts: {last}")


def list_all_schemes(sess: requests.Session | None = None) -> list[dict]:
    """Full upstream scheme listing (~37,700 entries)."""
    own = sess is None
    sess = sess or _make_session(4)
    try:
        data = _get_json(sess, f"{BASE_URL}/mf", timeout=90)
        if not isinstance(data, list):
            raise MFApiError("unexpected payload from /mf")
        return data
    finally:
        if own:
            sess.close()


def _iso(ddmmyyyy: str) -> str | None:
    """'24-07-2026' -> '2026-07-24'. Returns None if unparseable."""
    parts = ddmmyyyy.split("-")
    if len(parts) != 3:
        return None
    d, m, y = parts
    if len(y) != 4 or not (d.isdigit() and m.isdigit() and y.isdigit()):
        return None
    return f"{y}-{m.zfill(2)}-{d.zfill(2)}"


def parse_nav_rows(
    payload: dict, scheme_code: str, min_date: str | None = None
) -> list[tuple[str, str, float]]:
    """
    Convert an API payload into [(scheme_code, iso_date, nav), ...].
    Silently drops rows with unparseable dates or non-positive NAVs.

    min_date (ISO 'YYYY-MM-DD') clips history at the start. The platform's
    documented baseline is 2010-01-01; the API reaches back to 2006, and
    including those years materially changes drawdown/risk metrics because
    the 2008 crash enters the window.
    """
    rows: list[tuple[str, str, float]] = []
    seen: set[str] = set()

    for item in payload.get("data") or []:
        raw_date = item.get("date")
        raw_nav = item.get("nav")
        if not raw_date or raw_nav is None:
            continue

        iso = _iso(raw_date)
        if iso is None:
            continue
        if min_date and iso < min_date:
            continue

        try:
            nav = float(raw_nav)
        except (TypeError, ValueError):
            continue
        if not (nav > 0):
            continue

        # The API can repeat a date; keep the first (newest-first ordering).
        if iso in seen:
            continue
        seen.add(iso)
        rows.append((scheme_code, iso, nav))

    return rows


def fetch_history(
    scheme_code: str, sess: requests.Session, min_date: str | None = None
) -> tuple[dict, list[tuple[str, str, float]]]:
    """Full NAV history for one scheme."""
    payload = _get_json(sess, f"{BASE_URL}/mf/{scheme_code}")
    return payload.get("meta") or {}, parse_nav_rows(payload, scheme_code, min_date)


def fetch_latest(
    scheme_code: str, sess: requests.Session, min_date: str | None = None
) -> tuple[dict, list[tuple[str, str, float]]]:
    """Most recent NAV only (332 bytes vs ~123 KB — use for daily top-ups)."""
    payload = _get_json(sess, f"{BASE_URL}/mf/{scheme_code}/latest")
    return payload.get("meta") or {}, parse_nav_rows(payload, scheme_code, min_date)


def fetch_many(
    scheme_codes: Iterable[str],
    mode: str = "history",
    workers: int = DEFAULT_WORKERS,
    on_result: Callable[[str, dict, list], None] | None = None,
    progress_every: int = 250,
    min_date: str | None = None,
):
    """
    Fetch many schemes in parallel.

    Only the HTTP work happens on worker threads. on_result(scheme_code, meta,
    rows) is called from the calling thread inside the as_completed loop, which
    is what lets the caller write to a plain sqlite3 connection — those are
    bound to the thread that created them.

    Returns (ok_count, failures) where failures is [(scheme_code, error), ...].
    """
    codes = list(scheme_codes)
    fetch = fetch_history if mode == "history" else fetch_latest
    sess = _make_session(workers * 2)

    failures: list[tuple[str, str]] = []
    counter = {"done": 0, "rows": 0}
    lock = threading.Lock()
    t0 = time.time()

    def work(code: str):
        meta, rows = fetch(code, sess, min_date)
        return code, meta, rows

    try:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(work, c): c for c in codes}
            for fut in as_completed(futures):
                code = futures[fut]
                try:
                    code, meta, rows = fut.result()
                except Exception as exc:
                    with lock:
                        failures.append((code, str(exc)))
                    continue

                if on_result is not None:
                    on_result(code, meta, rows)

                with lock:
                    counter["done"] += 1
                    counter["rows"] += len(rows)
                    done = counter["done"]
                    total_rows = counter["rows"]

                if progress_every and done % progress_every == 0:
                    rate = done / max(time.time() - t0, 0.001)
                    log.info(
                        "  %d/%d schemes  %s NAV rows  (%.0f schemes/s)",
                        done, len(codes), f"{total_rows:,}", rate,
                    )
    finally:
        sess.close()

    elapsed = time.time() - t0
    log.info(
        "Fetched %d/%d schemes, %s NAV rows in %.0fs (%d failed)",
        counter["done"], len(codes), f"{counter['rows']:,}", elapsed, len(failures),
    )
    return counter["done"], failures
