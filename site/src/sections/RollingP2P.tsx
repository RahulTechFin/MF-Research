// src/sections/RollingP2P.tsx — Section 7: Rolling & Point-to-Point Returns
//
// Both modes were placeholders until now: a dashed box reading "Data populates
// after backfill is complete", with the date pickers wired to nothing.
//
// They compute from nav/<code>.json — the same NAV files the pipeline reads, with
// no new data file — plus index/<id>.json for the benchmark. Point-to-Point
// cannot be precomputed because the dates are arbitrary, so the arithmetic lives
// in utils/returns.ts, which mirrors engine/calculation_engine.py; see the note at
// the top of that file for why an exception to the single-source rule is made
// here, and how it is kept honest.

import { useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { useMeta, useCategoryTable, useNavSeriesMany, useIndexSeries } from '../hooks/useData'
import { fmtPct, retColor, shortFundName } from '../utils/format'
import { pointToPoint, trailingFrom, average, TRAILING } from '../utils/returns'
import type { PeriodReturn, Series } from '../utils/returns'

type Mode = 'current' | 'p2p'

const WINDOWS = ['1M', '3M', '6M', '1Y', '3Y', '5Y']

/** A year ago, as an ISO date — the default P2P start. */
function oneYearAgo(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d.toISOString().slice(0, 10)
}

interface Row {
  code: string
  name: string
  r: PeriodReturn
  vsBench: number | null
}

export default function RollingP2P() {
  const { data: meta } = useMeta()
  const [mode, setMode] = useState<Mode>('current')
  const [anchorDate, setAnchor] = useState(new Date().toISOString().slice(0, 10))
  const [startDate, setStart] = useState(oneYearAgo())
  const [endDate, setEnd] = useState(new Date().toISOString().slice(0, 10))
  const [slug, setSlug] = useState('')
  const [window, setWindow] = useState('1Y')

  const allCats = meta?.categories ?? []
  const activeSlug = slug || (allCats[0]?.slug ?? '')
  const catInfo = allCats.find(c => c.slug === activeSlug)

  // The fund list and benchmark id come from the category table, which is one
  // small file — cheaper than reading every NAV file just to learn who is in the
  // category.
  const { data: table } = useCategoryTable(activeSlug, 'trailing')
  const codes = useMemo(() => (table?.funds ?? []).map(f => f.scheme_code), [table])
  const names = useMemo(
    () => Object.fromEntries((table?.funds ?? []).map(f => [f.scheme_code, f.scheme_name])),
    [table],
  )

  const { series, loaded, total, loading } = useNavSeriesMany(codes)
  const { data: benchData } = useIndexSeries(table?.benchmark_id ?? null)
  const benchSeries = (benchData?.series ?? []) as Series

  // ── the numbers ──────────────────────────────────────────────────────────
  const bench: PeriodReturn = useMemo(() => {
    if (!benchSeries.length) return { ret: null, cagr: null, startDate: null, endDate: null, days: null }
    return mode === 'p2p'
      ? pointToPoint(benchSeries, startDate, endDate)
      : trailingFrom(benchSeries, anchorDate, window)
  }, [benchSeries, mode, startDate, endDate, anchorDate, window])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const code of codes) {
      const s = series[code]
      if (!s) continue
      const r = mode === 'p2p'
        ? pointToPoint(s, startDate, endDate)
        : trailingFrom(s, anchorDate, window)
      if (r.ret == null) continue
      out.push({
        code,
        name: names[code] ?? code,
        r,
        vsBench: bench.ret != null ? r.ret - bench.ret : null,
      })
    }
    out.sort((a, b) => (b.r.ret ?? -Infinity) - (a.r.ret ?? -Infinity))
    return out
  }, [codes, series, names, mode, startDate, endDate, anchorDate, window, bench.ret])

  const avg = average(rows.map(r => r.r.ret))
  const beat = bench.ret != null ? rows.filter(r => (r.r.ret ?? 0) > bench.ret!).length : null
  const best = rows[0]
  const worst = rows[rows.length - 1]

  // Where the window actually landed. Shown because a typed date is a request,
  // not a fact: the nearest NAV can be days away, and a reader comparing against
  // another site needs to know which dates were really used.
  const windowLabel = rows.length
    ? `${rows[0].r.startDate} → ${rows[0].r.endDate}`
    : bench.startDate ? `${bench.startDate} → ${bench.endDate}` : '—'

  // ── benchmark comparison chart: category average vs benchmark, normalised ──
  const compareOption = useMemo(() => {
    if (!benchSeries.length || !rows.length) return null
    const from = rows[0].r.startDate!
    const to = rows[0].r.endDate!
    const isLight = typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme') === 'light'
    const axis = isLight ? '#4B5563' : '#5E6F8F'
    const grid = isLight ? '#E5E7EB' : '#24314F'

    // Rebase both to 0% at the window start so the shapes are comparable.
    const clip = (s: Series) => s.filter(([d]) => d >= from && d <= to)
    const norm = (s: Series) => {
      const c = clip(s)
      if (!c.length) return []
      const base = c[0][1]
      return c.map(([d, v]) => [d, +(((v / base) - 1) * 100).toFixed(2)] as [string, number])
    }

    const b = norm(benchSeries)
    // Equal-weighted category line, built from whatever funds have a value on
    // each date rather than only those present for the whole window.
    const byDate = new Map<string, number[]>()
    for (const code of codes) {
      const s = series[code]
      if (!s) continue
      for (const [d, v] of norm(s)) {
        if (!byDate.has(d)) byDate.set(d, [])
        byDate.get(d)!.push(v)
      }
    }
    const cat = [...byDate.entries()]
      .sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([d, vs]) => [d, +(vs.reduce((a, c) => a + c, 0) / vs.length).toFixed(2)])

    return {
      backgroundColor: 'transparent',
      grid: { top: 26, right: 14, bottom: 30, left: 46 },
      legend: { top: 0, textStyle: { color: axis, fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: isLight ? '#FFFFFF' : '#18233C',
        borderColor: grid,
        textStyle: { color: isLight ? '#111827' : '#F1F5FB', fontSize: 11 },
        valueFormatter: (v: number) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`),
      },
      xAxis: {
        type: 'category', data: cat.map(p => p[0]),
        axisLabel: { color: axis, fontSize: 9, rotate: 30 },
        axisLine: { lineStyle: { color: grid } }, splitLine: { show: false },
      },
      yAxis: {
        type: 'value', name: '% from start', nameTextStyle: { color: axis, fontSize: 10 },
        axisLabel: { color: axis, fontSize: 10, formatter: '{value}%' },
        splitLine: { lineStyle: { color: grid, type: 'dashed' } },
      },
      series: [
        {
          name: 'Category avg', type: 'line', smooth: true, showSymbol: false,
          data: cat.map(p => p[1]),
          lineStyle: { width: 2, color: '#22D3EE' }, itemStyle: { color: '#22D3EE' },
        },
        {
          name: catInfo?.benchmark_name ?? 'Benchmark', type: 'line', smooth: true,
          showSymbol: false, data: b.map(p => p[1]),
          lineStyle: { width: 2, color: '#F59E0B', type: 'dashed' },
          itemStyle: { color: '#F59E0B' },
        },
      ],
    }
  }, [benchSeries, rows, codes, series, catInfo])

  const dateInput = 'px-3 py-1.5 rounded-lg text-sm'
  const inputStyle = {
    background: 'var(--bg-raised)', border: '1px solid var(--line)',
    color: 'var(--text-hi)', outline: 'none',
  } as const

  return (
    <section id="rolling-p2p" className="px-6 py-6 max-w-screen-2xl mx-auto">
      <div className="section-header">Rolling &amp; Point-to-Point Returns</div>

      {/* Mode pills */}
      <div className="flex gap-2 mb-4">
        <button onClick={() => setMode('current')}
          className={`pill${mode === 'current' ? ' active' : ''}`}>
          Current (Dynamic)
        </button>
        <button onClick={() => setMode('p2p')}
          className={`pill${mode === 'p2p' ? ' active' : ''}`}>
          Point-to-Point
        </button>
      </div>

      {/* Controls */}
      <div className="card p-4 mb-4">
        <div className="flex items-end gap-4 flex-wrap">
          {mode === 'current' ? (
            <>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>Anchor Date</label>
                <input type="date" value={anchorDate} onChange={e => setAnchor(e.target.value)}
                  className={dateInput} style={inputStyle} />
              </div>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>Window</label>
                <div className="tab-bar">
                  {WINDOWS.map(w => (
                    <button key={w} onClick={() => setWindow(w)}
                      className={`tab-btn${window === w ? ' active accent' : ''}`}>{w}</button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>Start Date</label>
                <input type="date" value={startDate} onChange={e => setStart(e.target.value)}
                  className={dateInput} style={inputStyle} />
              </div>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>End Date</label>
                <input type="date" value={endDate} onChange={e => setEnd(e.target.value)}
                  className={dateInput} style={inputStyle} />
              </div>
            </>
          )}
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>Category</label>
            <select value={activeSlug} onChange={e => setSlug(e.target.value)}
              className={dateInput} style={inputStyle}>
              {allCats.map(c => <option key={c.slug} value={c.slug}>{c.category_name}</option>)}
            </select>
          </div>

          <div className="ml-auto text-xs text-right" style={{ color: 'var(--text-low)' }}>
            <div>measured {windowLabel}</div>
            <div>
              {loading
                ? `loading NAVs ${loaded}/${total} …`
                : `${rows.length} of ${total} funds have a full window`}
            </div>
          </div>
        </div>
        {mode === 'p2p' && (
          <div className="text-[11px] mt-2" style={{ color: 'var(--text-low)' }}>
            Start resolves to the first NAV on or after your date, end to the last on or before it,
            so the window never reaches outside what you asked for. CAGR is shown beyond 366 days.
          </div>
        )}
      </div>

      {/* Table on the left, benchmark comparison on the right */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 card overflow-hidden">
          <div className="overflow-x-auto" style={{ maxHeight: 560 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>#</th>
                  <th className="text-left" style={{ minWidth: 230 }}>Fund</th>
                  <th className="ret-cell">Return</th>
                  <th className="ret-cell">CAGR</th>
                  <th className="ret-cell">vs Benchmark</th>
                </tr>
              </thead>
              <tbody key={`${activeSlug}-${mode}-${window}-${startDate}-${endDate}`} className="rows-enter">
                {rows.map((r, i) => (
                  <tr key={r.code}>
                    <td className="text-xs" style={{ color: 'var(--text-low)' }}>{i + 1}</td>
                    <td className="text-left text-xs font-medium truncate" style={{ maxWidth: 240 }}
                        title={r.name}>
                      {shortFundName(r.name, 40)}
                    </td>
                    <td className={`ret-cell ${retColor(r.r.ret)}`}>{fmtPct(r.r.ret)}</td>
                    <td className="ret-cell" style={{ color: 'var(--text-mid)' }}>
                      {r.r.cagr != null ? fmtPct(r.r.cagr) : '—'}
                    </td>
                    <td className="ret-cell">
                      {r.vsBench != null && (
                        <span className={`spread-chip ${r.vsBench >= 0 ? 'pos' : 'neg'}`}>
                          {r.vsBench >= 0 ? '+' : ''}{(r.vsBench * 100).toFixed(1)}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={5} className="text-center py-8" style={{ color: 'var(--text-low)' }}>
                      {loading
                        ? `Loading NAV series … ${loaded}/${total}`
                        : 'No fund has NAV data covering this window. Try a later start date.'}
                    </td>
                  </tr>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--line)', fontWeight: 600 }}>
                    <td /><td className="text-left text-xs">Category average</td>
                    <td className={`ret-cell ${retColor(avg)}`}>{fmtPct(avg)}</td>
                    <td /><td className="ret-cell">
                      {avg != null && bench.ret != null && (
                        <span className={`spread-chip ${avg - bench.ret >= 0 ? 'pos' : 'neg'}`}>
                          {avg - bench.ret >= 0 ? '+' : ''}{((avg - bench.ret) * 100).toFixed(1)}%
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr style={{ fontWeight: 600 }}>
                    <td /><td className="text-left text-xs" style={{ color: '#F59E0B' }}>
                      {catInfo?.benchmark_name ?? 'Benchmark'}
                    </td>
                    <td className={`ret-cell ${retColor(bench.ret)}`}>{fmtPct(bench.ret)}</td>
                    <td className="ret-cell" style={{ color: 'var(--text-mid)' }}>
                      {bench.cagr != null ? fmtPct(bench.cagr) : '—'}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        {/* ── Benchmark Comparison ─────────────────────────────────────────── */}
        <div className="card overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--line)' }}>
            <div className="font-display font-bold text-sm" style={{ color: '#F59E0B' }}>
              Benchmark Comparison
            </div>
            <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-low)' }}
                 title={catInfo?.benchmark_name ?? ''}>
              {catInfo?.benchmark_name ?? 'No benchmark for this category'}
            </div>
          </div>

          {bench.ret == null ? (
            <div className="px-4 py-8 text-center text-xs" style={{ color: 'var(--text-low)' }}>
              {catInfo?.benchmark_id
                ? 'The benchmark has no data covering this window.'
                : 'This category has no benchmark, so there is nothing to compare against.'}
            </div>
          ) : (
            <>
              <div className="px-4 py-3 grid grid-cols-2 gap-3 text-xs border-b"
                   style={{ borderColor: 'var(--line)' }}>
                <div>
                  <div style={{ color: 'var(--text-low)' }}>Benchmark</div>
                  <div className={`font-semibold tabnum ${retColor(bench.ret)}`} style={{ fontSize: 15 }}>
                    {fmtPct(bench.ret)}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-low)' }}>Category average</div>
                  <div className={`font-semibold tabnum ${retColor(avg)}`} style={{ fontSize: 15 }}>
                    {fmtPct(avg)}
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-low)' }}>Funds beating it</div>
                  <div className="font-semibold tabnum" style={{ fontSize: 15, color: 'var(--text-hi)' }}>
                    {beat}/{rows.length}
                    <span className="font-normal ml-1" style={{ fontSize: 11, color: 'var(--text-low)' }}>
                      {rows.length ? `(${Math.round((beat! / rows.length) * 100)}%)` : ''}
                    </span>
                  </div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-low)' }}>Avg vs benchmark</div>
                  <div className="font-semibold tabnum" style={{
                    fontSize: 15,
                    color: avg != null && avg >= bench.ret ? 'var(--gain)' : 'var(--loss)',
                  }}>
                    {avg != null ? `${avg - bench.ret >= 0 ? '+' : ''}${((avg - bench.ret) * 100).toFixed(2)}%` : '—'}
                  </div>
                </div>
              </div>

              {compareOption && (
                <div className="px-2 pt-2">
                  <ReactECharts option={compareOption} style={{ height: 220 }}
                                notMerge lazyUpdate opts={{ renderer: 'svg' }} />
                </div>
              )}

              <div className="px-4 py-3 text-xs space-y-1.5 border-t mt-auto"
                   style={{ borderColor: 'var(--line)' }}>
                {best && (
                  <div className="flex justify-between gap-2">
                    <span className="truncate" style={{ color: 'var(--text-low)' }} title={best.name}>
                      Best · {shortFundName(best.name, 22)}
                    </span>
                    <span className={`tabnum font-semibold ${retColor(best.r.ret)}`}>
                      {fmtPct(best.r.ret)}
                    </span>
                  </div>
                )}
                {worst && worst !== best && (
                  <div className="flex justify-between gap-2">
                    <span className="truncate" style={{ color: 'var(--text-low)' }} title={worst.name}>
                      Worst · {shortFundName(worst.name, 22)}
                    </span>
                    <span className={`tabnum font-semibold ${retColor(worst.r.ret)}`}>
                      {fmtPct(worst.r.ret)}
                    </span>
                  </div>
                )}
                <div className="text-[11px] pt-1" style={{ color: 'var(--text-low)' }}>
                  Both lines rebased to 0% at {rows[0]?.r.startDate ?? bench.startDate}, so the
                  shapes are comparable rather than the levels.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
