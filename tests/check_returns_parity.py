"""
Does utils/returns.ts agree with engine/calculation_engine.py?

Point-to-Point takes arbitrary user dates, so it cannot be precomputed and the
arithmetic had to be repeated in TypeScript. That is a documented exception to the
single-source rule, and this is what keeps it honest: the same NAV series is run
through both implementations and every value compared.

Run:  python tests/check_returns_parity.py
"""
from __future__ import annotations

import datetime
import json
import os
import random
import sqlite3
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)

NODE = os.path.join(ROOT, '.node', 'node-v22.12.0-win-x64', 'node.exe')
if not os.path.exists(NODE):
    NODE = 'node'


def build_series() -> list[tuple[str, float]]:
    """
    A deliberately awkward series: weekday-only, with a few multi-day holes, so
    the nearest-previous / nearest-next rules and the 10-day window are actually
    exercised rather than sidestepped by perfectly dense data.
    """
    random.seed(42)
    out = []
    d = datetime.date(2019, 1, 1)
    v = 100.0
    holes = {datetime.date(2021, 3, 15), datetime.date(2022, 8, 1),
             datetime.date(2024, 1, 10)}
    while d <= datetime.date(2026, 6, 30):
        skip = d.weekday() >= 5 or any(0 <= (d - h).days <= 5 for h in holes)
        if not skip:
            out.append((d.isoformat(), round(v, 4)))
        v *= 1 + random.uniform(-0.012, 0.014)
        d += datetime.timedelta(days=1)
    return out


CASES = [
    # (start, end) for point-to-point — includes ranges landing in the holes
    ('2020-01-01', '2021-01-01'),
    ('2019-06-15', '2026-06-30'),
    ('2021-03-15', '2022-03-15'),   # start inside a hole
    ('2022-07-28', '2022-08-05'),   # both ends near a hole
    ('2024-01-08', '2024-06-30'),
    ('2023-02-28', '2023-03-31'),
    ('2020-02-29', '2021-02-28'),   # leap day
]
ANCHORS = ['2026-06-30', '2025-12-31', '2024-01-09']
PERIODS = ['1M', '3M', '6M', '1Y', '3Y', '5Y']


def python_side(series):
    db = os.path.join(tempfile.mkdtemp(), 'p.db')
    os.environ['MF_DB_PATH'] = db
    from scripts.init_db import create_schema
    from engine.calculation_engine import point_to_point_return, trailing_return

    conn = sqlite3.connect(db)
    create_schema(conn)
    conn.execute("INSERT INTO amcs(amc_id,amc_name) VALUES(1,'A')")
    conn.execute("INSERT INTO categories(category_id,asset_class,category_name,slug,"
                 "display_order) VALUES(1,'Equity','C','c',1)")
    conn.execute("INSERT INTO schemes(scheme_code,scheme_name,amc_id,category_id,"
                 "is_active) VALUES('1','F',1,1,1)")
    conn.executemany('INSERT INTO nav_history(scheme_code,nav_date,nav) VALUES(?,?,?)',
                     [('1', d, v) for d, v in series])
    conn.commit()

    out = {'p2p': {}, 'trailing': {}}
    for s, e in CASES:
        r = point_to_point_return(conn, '1',
                                  datetime.date.fromisoformat(s),
                                  datetime.date.fromisoformat(e))
        out['p2p'][f'{s}|{e}'] = {
            'ret': r['return'], 'cagr': r['cagr'],
            'startDate': r['start_date'], 'endDate': r['end_date'],
        }
    for a in ANCHORS:
        for p in PERIODS:
            key = '12M' if p == '1Y' else p
            r = trailing_return(conn, '1', key,
                                as_of=datetime.date.fromisoformat(a))
            out['trailing'][f'{a}|{p}'] = r
    conn.close()
    return out


JS = r'''
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
const require = createRequire(path.join(process.cwd(), 'site', 'package.json'))
const esbuild = require('esbuild')

const src = fs.readFileSync('site/src/utils/returns.ts', 'utf8')
const js = esbuild.transformSync(src, { loader: 'ts', format: 'esm' }).code
const m = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const series = input.series
const out = { p2p: {}, trailing: {} }
for (const [s, e] of input.cases) {
  const r = m.pointToPoint(series, s, e)
  out.p2p[`${s}|${e}`] = { ret: r.ret, cagr: r.cagr, startDate: r.startDate, endDate: r.endDate }
}
for (const a of input.anchors) {
  for (const p of input.periods) {
    const r = m.trailingFrom(series, a, p)
    out.trailing[`${a}|${p}`] = r.ret
  }
}
console.log(JSON.stringify(out))
'''


def main() -> int:
    series = build_series()
    print(f'series: {len(series)} points, {series[0][0]} .. {series[-1][0]}')

    py = python_side(series)

    tmp = tempfile.mkdtemp()
    payload = os.path.join(tmp, 'in.json')
    with open(payload, 'w') as fh:
        json.dump({'series': series, 'cases': CASES,
                   'anchors': ANCHORS, 'periods': PERIODS}, fh)
    runner = os.path.join(tmp, 'r.mjs')
    with open(runner, 'w', encoding='utf-8') as fh:
        fh.write(JS)

    res = subprocess.run([NODE, runner, payload], capture_output=True, text=True,
                         cwd=ROOT)
    if res.returncode != 0:
        print('node failed:\n', res.stderr[:1500])
        return 1
    ts = json.loads(res.stdout.strip().splitlines()[-1])

    bad = 0

    def cmp(label, a, b, tol=1e-9):
        """
        point_to_point_return does round(x, 6) before returning, so comparing its
        output against full-precision TypeScript at 1e-9 flagged eight values that
        differ only by that rounding — e.g. py 16.489413 vs ts 16.4894126903.
        Both are rounded to 6dp here, which is the precision the engine actually
        publishes and far finer than the 2dp the dashboard shows.
        """
        nonlocal bad
        if a is not None:
            a = round(a, 6)
        if b is not None:
            b = round(b, 6)
        if a is None and b is None:
            print(f'  ok   {label:<34} both None')
            return
        if a is None or b is None:
            bad += 1
            print(f'  FAIL {label:<34} py={a} ts={b}')
            return
        if abs(a - b) > tol:
            bad += 1
            print(f'  FAIL {label:<34} py={a:.10f} ts={b:.10f} diff={a-b:.2e}')
        else:
            print(f'  ok   {label:<34} {a * 100:9.5f}%')

    print()
    print('=== point-to-point ===')
    for k, p in py['p2p'].items():
        t = ts['p2p'][k]
        cmp(f'ret  {k}', p['ret'], t['ret'])
        cmp(f'cagr {k}', p['cagr'], t['cagr'])
        if p['startDate'] != t['startDate'] or p['endDate'] != t['endDate']:
            bad += 1
            print(f'  FAIL dates {k}: py {p["startDate"]}..{p["endDate"]} '
                  f'ts {t["startDate"]}..{t["endDate"]}')

    print()
    print('=== trailing ===')
    for k, p in py['trailing'].items():
        cmp(k, p, ts['trailing'][k])

    print()
    if bad:
        print(f'{bad} MISMATCH(ES) — returns.ts has drifted from the engine')
        return 1
    print('returns.ts agrees with engine/calculation_engine.py on every case')
    return 0


if __name__ == '__main__':
    sys.exit(main())
