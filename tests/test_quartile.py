"""
Locks the quartile ranking rule. If a change here fails, the change is wrong
unless the owner has explicitly asked for a new rule.

THE RULE
  Equal brackets of n // 4. Any remainder goes to the BOTTOM quartiles, Q4
  first, then Q3, then Q2. Q1 never takes a leftover.

      n = 40  ->  10 10 10 10        n = 17  ->   4  4  4  5
      n = 18  ->   4  4  5  5        n = 31  ->   7  8  8  8

  Pools smaller than SMALL_POOL (3) keep the older ROUNDUP behaviour, which
  puts the spare at the TOP, so the only fund in a sector is not labelled
  bottom-quartile:

      n = 1   ->  Q1                 n = 2   ->  Q1, Q3

  `n` is the count of funds with a return for that period. Funds without one are
  excluded before ranking and get quartile None, displayed as a dash.

Run:  python -m pytest tests/test_quartile.py -q
      python tests/test_quartile.py          (no pytest needed)
"""

from __future__ import annotations

import collections
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.calculation_engine import SMALL_POOL, quartile, rank_and_quartile


def sizes(n: int) -> list[int]:
    """Bracket sizes actually produced, [Q1, Q2, Q3, Q4]."""
    c = collections.Counter(quartile(r, n) for r in range(1, n + 1))
    return [c[1], c[2], c[3], c[4]]


def expected(n: int) -> list[int]:
    """The rule, written out independently of the implementation."""
    if n < SMALL_POOL:
        c = collections.Counter()
        for r in range(1, n + 1):
            if r <= math.ceil(n * 0.25):
                c[1] += 1
            elif r <= math.ceil(n * 0.50):
                c[2] += 1
            elif r <= math.ceil(n * 0.75):
                c[3] += 1
            else:
                c[4] += 1
        return [c[1], c[2], c[3], c[4]]
    base, rem = divmod(n, 4)
    return [base,
            base + (1 if rem >= 3 else 0),
            base + (1 if rem >= 2 else 0),
            base + (1 if rem >= 1 else 0)]


# ── the worked examples from the rule, pinned exactly ────────────────────────
GOLDEN = {
    40: [10, 10, 10, 10],   # divides evenly
    100: [25, 25, 25, 25],
    17: [4, 4, 4, 5],       # 1 spare -> Q4
    13: [3, 3, 3, 4],
    25: [6, 6, 6, 7],
    18: [4, 4, 5, 5],       # 2 spare -> Q4, Q3
    6: [1, 1, 2, 2],
    31: [7, 8, 8, 8],       # 3 spare -> Q4, Q3, Q2
    23: [5, 6, 6, 6],
    11: [2, 3, 3, 3],
    7: [1, 2, 2, 2],
    3: [0, 1, 1, 1],        # new rule applies at 3: no Q1
    2: [1, 0, 1, 0],        # small-pool fallback: spare at the TOP
    1: [1, 0, 0, 0],
}


def test_golden_bracket_sizes():
    for n, want in GOLDEN.items():
        got = sizes(n)
        assert got == want, f'n={n}: got {got}, rule says {want}'


def test_matches_the_rule_for_every_n():
    for n in range(1, 400):
        assert sizes(n) == expected(n), f'n={n}: {sizes(n)} != {expected(n)}'


def test_every_fund_lands_in_exactly_one_bracket():
    for n in range(1, 400):
        assert sum(sizes(n)) == n, f'n={n} brackets sum to {sum(sizes(n))}'


def test_better_rank_never_gets_a_worse_quartile():
    """The reported symptom: a high return in Q3 beside a lower return in Q2."""
    for n in range(1, 400):
        qs = [quartile(r, n) for r in range(1, n + 1)]
        assert qs == sorted(qs), f'n={n} is not monotonic: {qs}'


def test_remainder_never_promotes_into_q1():
    """Q1 must never be the largest bracket once the new rule applies."""
    for n in range(SMALL_POOL, 400):
        q1, q2, q3, q4 = sizes(n)
        assert q1 <= min(q2, q3, q4), f'n={n}: Q1={q1} exceeds a lower bracket'


def test_small_pools_keep_the_top_loaded_fallback():
    assert quartile(1, 1) == 1, 'a lone fund must not be bottom-quartile'
    assert quartile(1, 2) == 1
    assert SMALL_POOL == 3, 'changing SMALL_POOL changes published quartiles'


def test_missing_returns_are_excluded_from_n():
    """A fund with no return must not occupy a bracket or shrink anyone else's."""
    returns = {'a': 0.10, 'b': 0.08, 'c': None, 'd': 0.05, 'e': None}
    out = rank_and_quartile(returns)
    assert out['c'] == (None, None)
    assert out['e'] == (None, None)
    ranked = {k: v for k, v in out.items() if v[0] is not None}
    assert len(ranked) == 3, 'n should be the eligible count, not the total'
    assert out['a'][0] == 1 and out['b'][0] == 2 and out['d'][0] == 3
    # n=3 -> [0,1,1,1]
    assert [out['a'][1], out['b'][1], out['d'][1]] == [2, 3, 4]


def test_ranking_is_by_descending_return():
    out = rank_and_quartile({'lo': 0.01, 'hi': 0.99, 'mid': 0.50})
    assert out['hi'][0] == 1 and out['mid'][0] == 2 and out['lo'][0] == 3


def test_degenerate_inputs():
    assert quartile(None, 10) is None
    assert quartile(1, 0) is None
    assert rank_and_quartile({}) == {}


if __name__ == '__main__':
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            try:
                fn()
                print(f'  PASS  {name}')
            except AssertionError as exc:
                fails += 1
                print(f'  FAIL  {name}: {exc}')
    print()
    print('quartile rule is locked' if not fails else f'{fails} test(s) FAILED')
    sys.exit(1 if fails else 0)
