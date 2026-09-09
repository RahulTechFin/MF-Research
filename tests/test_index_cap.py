"""
The index store may not carry a date past the previous business close.

WHY THIS FILE EXISTS
Yahoo answers a request made during market hours with a LIVE, PARTIAL bar dated
today. Nothing in the index path refused it, so a refresh run at 13:08 IST stored
the running price of an open market as though it were that day's close — and
every 1-day change derived from it was wrong. The only thing that had been
preventing it was the cron firing at 23:45 IST, long after the 15:30 close.

A schedule is not a safeguard. Any manual run, any re-run of a failed job, any
retry at the wrong hour reintroduces it. These tests pin the safeguard to the
DATA instead.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from scripts import index_store


def test_the_cap_is_the_same_rule_the_navs_use():
    """
    Not a copy of the rule — the rule itself. A benchmark and a fund compared
    across different days is the failure this prevents.
    """
    from scripts.build_db_from_api import previous_business_close
    assert index_store.cap_date() == previous_business_close()


def test_todays_intraday_point_is_dropped():
    points = {"2026-09-04": 100.0, "2026-09-07": 101.0,
              "2026-09-08": 102.0, "2026-09-09": 99.5}
    kept = index_store.drop_after(points, "2026-09-08")
    assert "2026-09-09" not in kept
    assert max(kept) == "2026-09-08"


def test_the_cap_date_itself_is_kept():
    """Inclusive: the cap is the newest ALLOWED day, not the first excluded one."""
    points = {"2026-09-08": 102.0}
    assert index_store.drop_after(points, "2026-09-08") == points


def test_nothing_is_dropped_when_everything_is_within_the_cap():
    points = {"2026-09-04": 100.0, "2026-09-07": 101.0}
    assert index_store.drop_after(points, "2026-09-08") == points


def test_the_validation_gate_would_reject_the_correction_uncapped():
    """
    Establishes the trap this fix had to get past, so the ordering in
    refresh_one is not mistaken for arbitrary.

    validate_one refuses a result whose newest date went backwards. A file
    holding a bad 09-09 point, corrected to end at 09-08, looks exactly like
    that — so the published baseline has to be capped BEFORE the comparison, or
    the gate rejects the very fix that removes the bad value.
    """
    on_disk = {f"2026-0{1 + d // 28}-{1 + d % 28:02d}": 100.0 for d in range(300)}
    on_disk["2026-09-09"] = 99.5
    corrected = index_store.drop_after(on_disk, "2026-09-08")

    # Uncapped baseline: refused.
    assert any("backwards" in p
               for p in index_store.validate_one(corrected, on_disk))
    # Capped baseline, which is what refresh_one actually passes: accepted.
    assert index_store.validate_one(corrected, corrected) == []


def test_a_trim_still_counts_as_a_change_worth_uploading():
    """
    The second half of the same trap. The skip-upload decision compares against
    what the FILE holds, not against the capped view — those differ precisely
    when a trim is needed, which is the one case that must not be skipped.
    """
    on_disk = {"2026-09-07": 101.0, "2026-09-08": 102.0, "2026-09-09": 99.5}
    capped = index_store.drop_after(on_disk, "2026-09-08")
    assert capped != index_store.prune(on_disk), (
        "a file needing a trim must not compare equal to the corrected result, "
        "or refresh_one reports 'already current' and never uploads the fix")


def test_retention_and_the_cap_are_separate_concerns():
    """
    prune() drops what is too OLD, drop_after() drops what is too NEW. Folding
    them together would make a retention change silently move the cap.
    """
    points = {"2019-01-02": 50.0, "2026-09-08": 102.0, "2026-09-09": 99.5}
    assert "2026-09-09" in index_store.prune(points)
    assert "2019-01-02" in index_store.drop_after(points, "2026-09-08")
