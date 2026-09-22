"""
sif_daily.py — the SIF half of the daily run.

    published Parquet ──► ask AMFI for the missing days ──► gate ──► publish
                     └──► same response names the plans ──► data sheet

RUNS INSIDE THE MUTUAL FUND JOB, ON PURPOSE
daily_run.py calls this after the MF pipeline has published, in the same process
and the same GitHub Actions run. Two consequences, both wanted:

  * ONE CLOCK. The cap comes from build_db_from_api.previous_business_close, the
    same function the MF desk uses, so both desks publish the same NAV date. If
    they ever diverge the run says so rather than leaving two dashboards quietly
    a day apart.
  * SIF CANNOT BREAK MF. It runs after the MF publish and its failures are
    reported, not fatal. A bad SIF day must never take a good MF dashboard down.

ONE REQUEST DOES TWO JOBS
The history report's response carries both the NAVs and the NAV Names, and the
names are where plan and option come from. So the window is fetched once and
used twice: merged into the Parquet, and read by the catalogue. The window is
whichever is wider — the gap since the last published day, or the 90 days the
catalogue needs to see every fund that is still reporting.

NOTHING IS KEPT LOCALLY
No JSON, no database, no cache. Everything lands in the "SIF Data" bucket:

    catalogue/funds.parquet       the 30-fund data sheet
    catalogue/categories.parquet  the seven strategies
    catalogue/manifest.json       as-of, coverage, exclusions, inferences
    nav/history.parquet           every NAV of every fund on the sheet
    web/sif.json                  the same thing, in what a browser can read

WHY web/sif.json EXISTS, AND WHY IT IS NOT A SECOND COPY OF THE TRUTH
The Parquet is the store: 16 KB for the whole history, and what this pipeline
reads back tomorrow. A browser cannot open it -- Parquet needs a decoder, and
the site has no Parquet library -- so the dashboard would have nothing to read.

web/sif.json is a VIEW, not a source. It is rewritten from the Parquet on every
run, nothing ever reads it back in, and deleting it costs nothing because the
next run recreates it. The same relationship the MF desk has between its
throwaway SQLite database and the JSON it serves.

It can be dropped entirely by installing a JS Parquet reader (hyparquet is
~10 KB with no dependencies) and pointing the dashboard at nav/history.parquet
directly. That is the tidier end state; it needs an npm install.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts import sif_catalogue as catalogue      # noqa: E402
from scripts import sif_nav_store as store          # noqa: E402
from scripts import sif_source as src               # noqa: E402

log = logging.getLogger("sif_daily")

# The data sheet losing a tenth of its funds overnight is a feed problem, not a
# fund-closure problem. Same reasoning as daily_run's MIN_SCHEMES_FRACTION: a
# ratio, so the universe growing does not require retuning.
MIN_FUNDS_FRACTION = 0.90

# Roughly how many trading days a calendar window should contain. Used only to
# notice a response that came back far thinner than the range asked for, which
# is what a silent server-side cap would look like.
TRADING_DAYS_PER_CALENDAR_DAY = 0.6


class SifRunFailed(RuntimeError):
    """Raised before anything is published, so a bad day changes nothing."""


def _window_looks_complete(frm: date, to: date, days_seen: int) -> str | None:
    """A warning string when the response is implausibly thin, else None."""
    span = (to - frm).days + 1
    if span < 10:
        return None
    expected = span * TRADING_DAYS_PER_CALENDAR_DAY
    if days_seen < expected * 0.5:
        return (f"asked for {span} calendar days and got NAVs on only "
                f"{days_seen} of them — expected around {expected:.0f}. The "
                f"range endpoint may be capping the response.")
    return None


REMOTE_WEB = "web/sif.json"


def publish_web(cat: dict, series_by_code: dict[str, dict]) -> bool:
    """
    Write the browser-readable view of what was just stored.

    Deliberately ONE file and one request. At 30 funds the whole desk -- every
    category, every fund, every NAV since October 2025 -- is smaller than a
    single MF category file, so splitting it per screen would cost more in round
    trips than it saves in bytes. Revisit if the universe reaches the hundreds.

    The NAV series uses the same [date, nav] pair shape as the MF desk's
    nav/<code>.json, so anything on the site that already consumes one can
    consume these unchanged.
    """
    from scripts import supabase_store as sb

    payload = {
        "version": 1,
        "generated": cat.get("generated"),
        "as_of": cat.get("as_of"),
        "cap": cat.get("cap"),
        "history": cat.get("history"),
        "categories": cat.get("categories"),
        "funds": cat.get("funds"),
        "navs": {code: [[d, series_by_code[code][d]] for d in sorted(series_by_code[code])]
                 for code in sorted(series_by_code)},
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"),
                      default=str).encode("utf-8")
    ok = sb.upload_bytes(body, REMOTE_WEB, bucket=sb.SIF_BUCKET,
                         content_type="application/json")
    log.info("  %-28s %6.1f KB  %s", REMOTE_WEB, len(body) / 1024,
             "ok" if ok else "FAILED")
    return ok


def run(cap: str | None = None, mf_as_of: str | None = None,
        full_history: bool = False, dry_run: bool = False,
        index_source_db: str | None = None) -> dict:
    """
    One SIF update. Returns a summary; raises SifRunFailed before publishing
    anything if the day does not look trustworthy.
    """
    cap = cap or store.cap_date()
    log.info("SIF: capping at %s (the same rule the MF desk uses)", cap)

    published = store.read_published()
    if full_history:
        frm, to = src.HISTORY_START, date.fromisoformat(cap)
        log.info("SIF: --full-history, reading from %s", frm)
    else:
        frm, to = store.fetch_window(published, cap, src.HISTORY_START)
    log.info("SIF: asking AMFI for %s .. %s", frm, to)

    history_text = src.fetch_history(frm, to)
    if not history_text:
        raise SifRunFailed("the AMFI history report could not be fetched")
    navall_text = src.fetch_navall()
    if not navall_text:
        raise SifRunFailed("the AMFI SIF snapshot could not be fetched")

    hist_rows, hist_stats = src.parse(history_text, "history")
    days_seen = len({r.nav_date for r in hist_rows if r.nav_date})
    warnings: list[str] = []
    thin = _window_looks_complete(frm, to, days_seen)
    if thin:
        warnings.append(thin)
        log.warning("SIF: %s", thin)
    log.info("SIF: %s history row(s) over %d day(s)",
             f"{len(hist_rows):,}", days_seen)

    # ── the data sheet ───────────────────────────────────────────────────
    previous = catalogue.load_previous()
    cat = catalogue.build(navall_text, history_text, previous=previous)
    keep = {f["scheme_code"] for f in cat["funds"]}
    if not keep:
        raise SifRunFailed("the catalogue came out empty")
    if previous and len(keep) < len(previous) * MIN_FUNDS_FRACTION:
        raise SifRunFailed(
            f"the data sheet fell to {len(keep)} fund(s) from {len(previous)} "
            f"— below {MIN_FUNDS_FRACTION:.0%} of what is published")
    log.info("SIF: data sheet has %d Regular Growth fund(s) (%d published before)",
             len(keep), len(previous))

    # ── the NAVs ─────────────────────────────────────────────────────────
    # Start from the published series for the funds still on the sheet. A fund
    # that has dropped off keeps nothing, which is safe here in a way it is not
    # on the MF desk: the range endpoint will re-serve its entire history in one
    # request if it ever comes back.
    merged = {c: dict(s) for c, s in published.items() if c in keep}
    dropped = sorted(set(published) - keep)
    if dropped:
        log.warning("SIF: %d fund(s) are no longer on the data sheet; their NAVs "
                    "are not carried forward: %s", len(dropped), ", ".join(dropped))
        warnings.append(f"dropped from the sheet: {', '.join(dropped)}")

    incoming = [(r.scheme_code, r.nav_date, r.nav)
                for r in hist_rows if r.nav_date and r.nav]
    stats = store.merge(merged, incoming, keep_codes=keep, cap=cap)
    log.info("SIF: NAVs added=%d already_held=%d capped=%d refused=%d "
             "not_tracked=%d", stats["added"], stats["already_held"],
             stats["capped"], stats["rejected_move"], stats["not_tracked"])

    baseline = {c: s for c, s in published.items() if c in keep}
    problems = store.validate(merged, baseline)
    if problems:
        raise SifRunFailed("; ".join(problems[:5]))

    summary = store.summarise(merged)
    catalogue.apply_coverage(cat, merged)
    cat["warnings"] = list(cat.get("warnings") or []) + warnings
    cat["window"] = {"from": frm.isoformat(), "to": to.isoformat()}
    cat["cap"] = cap
    cat["aligned_with_mf"] = mf_as_of

    # ── alignment ────────────────────────────────────────────────────────
    if mf_as_of and summary["last"] and summary["last"] != mf_as_of:
        msg = (f"SIF newest NAV is {summary['last']} but the MF desk published "
               f"{mf_as_of}. Both cap at {cap}, so this means one of the two "
               f"feeds had not published for that day yet.")
        log.warning("SIF: %s", msg)
        cat["warnings"].append(msg)

    if dry_run:
        log.info("SIF: --dry-run, publishing nothing")
        return {"dry_run": True, "funds": len(keep), **summary, "stats": stats}

    if not store.write_published(merged):
        raise SifRunFailed("could not write nav/history.parquet")
    if not catalogue.publish(cat):
        raise SifRunFailed("could not write the catalogue")
    if not publish_web(cat, merged):
        raise SifRunFailed("could not write the browser view")

    # ── the common engine ────────────────────────────────────────────────
    # The same build_json, over the same calculation_engine, that produced the
    # mutual fund dashboard minutes ago -- just pointed at a database holding
    # these funds. That is what makes a SIF trailing return and an MF trailing
    # return the same number computed the same way, rather than two
    # implementations that agree until they do not.
    #
    # index_source_db is the MF pipeline's own temp database when daily_run
    # passes it: the benchmark closes are then provably identical between the two
    # desks and nothing is downloaded twice.
    from scripts import sif_engine
    engine_out = sif_engine.run(cat, merged, index_source_db=index_source_db)
    log.info("SIF: engine wrote %d file(s), published %d",
             engine_out["files"], engine_out["published"])
    if not engine_out["published"]:
        raise SifRunFailed("the engine published nothing")

    log.info("SIF COMPLETE  funds=%d rows=%s days=%d  %s .. %s",
             summary["funds"], f"{summary['rows']:,}", summary["days"],
             summary["first"], summary["last"])
    return {"funds": len(keep), **summary, "stats": stats,
            "engine": engine_out, "warnings": cat["warnings"]}


def main() -> int:
    ap = argparse.ArgumentParser(description="Update the SIF desk in Supabase")
    ap.add_argument("--full-history", action="store_true",
                    help="read every day since the first SIF NAV rather than "
                         "only the days that are missing")
    ap.add_argument("--dry-run", action="store_true", help="publish nothing")
    ap.add_argument("--cap", default=None,
                    help="override the newest publishable date (ISO)")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
    try:
        out = run(cap=args.cap, full_history=args.full_history,
                  dry_run=args.dry_run)
    except SifRunFailed as exc:
        log.error("SIF ABORTED: %s", exc)
        log.error("Nothing was published — yesterday's SIF data stays live.")
        return 2
    for w in out.get("warnings") or []:
        log.warning("  ! %s", w)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
