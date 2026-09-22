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
import CategoryPicker from '../components/CategoryPicker'
import ComingFunds from '../components/ComingFunds'
import { categoryColor } from '../config/categoryColors'
import { useTableSort, sortRows } from '../hooks/useTableSort'
import DownloadButton from '../components/DownloadButton'
import { currentDesk } from '../config/products'
import type { SheetSpec } from '../utils/xlsx'
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

/** Above this many categories a row of chips stops being readable. */
const CHIP_LIMIT = 12

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

  // Bound every picker to the data. Nothing exists after meta.as_of, so allowing
  // a later date only produced an empty table with no explanation — the reader
  // cannot tell "no data yet" from "something is broken".
  const maxDate = meta?.as_of ?? new Date().toISOString().slice(0, 10)
  const minDate = '2010-01-01'          // build_db_from_api.HISTORY_START

  // A saved or default date can sit past the data after a stale day; clamp on
  // read rather than rewriting state, so the picker cannot fight the user.
  const anchor = anchorDate > maxDate ? maxDate : anchorDate
  const from = startDate > maxDate ? maxDate : startDate
  const to = endDate > maxDate ? maxDate : endDate

  // The fund list and benchmark id come from the category table, which is one
  // small file — cheaper than reading every NAV file just to learn who is in the
  // category.
  const { data: table, error: tableError } = useCategoryTable(activeSlug, 'trailing')
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
    if (!benchSeries.length) {
      return { ret: null, abs: null, cagr: null, startDate: null, endDate: null, days: null }
    }
    return mode === 'p2p'
      ? pointToPoint(benchSeries, from, to)
      : trailingFrom(benchSeries, anchor, window)
  }, [benchSeries, mode, from, to, anchor, window])

  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const code of codes) {
      const s = series[code]
      if (!s) continue
      const r = mode === 'p2p'
        ? pointToPoint(s, from, to)
        : trailingFrom(s, anchor, window)
      if (r.abs == null) continue
      out.push({
        code,
        name: names[code] ?? code,
        r,
        // Compared on the same basis as the column beside it. Measuring the
        // fund's absolute return against the benchmark's annualised one would
        // manufacture outperformance out of nothing but the two conventions.
        vsBench: bench.abs != null ? r.abs - bench.abs : null,
      })
    }
    out.sort((a, b) => (b.r.abs ?? -Infinity) - (a.r.abs ?? -Infinity))
    return out
  }, [codes, series, names, mode, from, to, anchor, window, bench.abs])

  const sort = useTableSort()
  // rows already arrives sorted by absolute return, descending — the section's
  // own ranking. sortRows leaves it exactly so until a heading is clicked.
  const visibleRows = sortRows(rows, sort,
    (r, k) => k === 'fund' ? r.name
            : k === 'abs' ? r.r.abs
            : k === 'cagr' ? r.r.cagr
            : k === 'vs' ? r.vsBench
            : k === 'start' ? r.r.startDate
            : k === 'end' ? r.r.endDate
            : null)

  // Best and worst are properties of the RETURN ranking, not of wherever a row
  // happens to sit once the reader sorts by CAGR or by name. Held by code so the
  // tags stay on the right funds.
  const bestCode = rows.length > 1 ? rows[0].code : null
  const worstCode = rows.length > 1 ? rows[rows.length - 1].code : null

  const buildExport = (): SheetSpec | null => {
    if (!rows.length) return null
    const desk = currentDesk()
    const label = mode === 'p2p' ? `${from} to ${to}` : `rolling ${window}`
    return {
      sheet: `Rolling ${mode === 'p2p' ? 'P2P' : window}`,
      title: `Rolling & Point-to-Point - ${catInfo?.category_name ?? activeSlug}`,
      meta: [
        ['Desk', desk.name],
        ['Category', catInfo?.category_name ?? activeSlug],
        ['Mode', mode === 'p2p' ? 'Point to point' : 'Rolling window'],
        ['Period', label],
        ['Measured', windowLabel],
        ['Benchmark', catInfo?.benchmark_name ?? '-'],
        ['Benchmark absolute return',
         bench.abs != null ? `${(bench.abs * 100).toFixed(2)}%` : 'n/a'],
        ['Benchmark CAGR', bench.cagr != null ? `${(bench.cagr * 100).toFixed(2)}%` : 'n/a'],
        ['Funds', `${rows.length} of ${total} have a full window`],
        ['Note', 'Only funds with NAVs covering the whole window appear. '
               + 'Absolute Return is the total move over the window; CAGR is that '
               + 'return expressed per year, and is shown only beyond 366 days. '
               + 'vs Benchmark compares absolute against absolute.'],
      ],
      columns: [
        { key: 'fund', label: 'Fund Name', type: 'text', width: 46 },
        { key: 'abs', label: 'Absolute Return', type: 'percent' },
        { key: 'cagr', label: 'CAGR', type: 'percent' },
        { key: 'vs', label: 'vs Benchmark', type: 'percent' },
        { key: 'start', label: 'Start date', type: 'text', width: 13 },
        { key: 'end', label: 'End date', type: 'text', width: 13 },
      ],
      rows: [
        ...visibleRows.map(r => ({
          fund: r.name,
          abs: r.r.abs ?? null,
          cagr: r.r.cagr ?? null,
          vs: r.vsBench ?? null,
          start: r.r.startDate ?? '',
          end: r.r.endDate ?? '',
        })),
        // The two summary lines the screen shows under the table. Leaving them
        // out of the download made the file disagree with the dashboard.
        {
          fund: 'Category average', abs: avg, cagr: avgCagr,
          vs: avg != null && bench.abs != null ? avg - bench.abs : null,
          start: '', end: '',
        },
        {
          fund: catInfo?.benchmark_name ?? 'Benchmark',
          abs: bench.abs ?? null, cagr: bench.cagr ?? null, vs: null,
          start: bench.startDate ?? '', end: bench.endDate ?? '',
        },
      ],
      fileName: `${desk.code} Rolling P2P - ${catInfo?.category_name ?? activeSlug} - ${label} - ${anchor}`,
    }
  }

  const avg = average(rows.map(r => r.r.abs))
  // The category average CAGR was simply absent from the table — the cell was
  // there but empty, which reads as "this cannot be computed" rather than "we
  // did not compute it". It averages the funds that HAVE a CAGR, so under a
  // year, when no fund has one, it is legitimately null and stays blank.
  const avgCagr = average(rows.map(r => r.r.cagr))
  const beat = bench.abs != null ? rows.filter(r => (r.r.abs ?? 0) > bench.abs!).length : null
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
    const winFrom = rows[0].r.startDate!
    const winTo = rows[0].r.endDate!
    const isLight = typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme') === 'light'
    const axis = isLight ? '#4B5563' : '#5E6F8F'
    const grid = isLight ? '#E5E7EB' : '#24314F'

    // Rebased to 0% at the window start, so the two shapes are comparable rather
    // than sitting at unrelated levels.
    const norm = (sr: Series): [number, number][] => {
      const c = sr.filter(([d]) => d >= winFrom && d <= winTo)
      if (!c.length) return []
      const base = c[0][1]
      return c.map(([d, v]) => [Date.parse(d), +(((v / base) - 1) * 100).toFixed(2)])
    }

    const b = norm(benchSeries)
    // Equal-weighted category line from whatever funds have a value on each date,
    // rather than only those present for the whole window.
    const byDate = new Map<number, number[]>()
    for (const code of codes) {
      const sr = series[code]
      if (!sr) continue
      for (const [t, v] of norm(sr)) {
        if (!byDate.has(t)) byDate.set(t, [])
        byDate.get(t)!.push(v)
      }
    }
    const cat: [number, number][] = [...byDate.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([t, vs]) => [t, +(vs.reduce((a, c) => a + c, 0) / vs.length).toFixed(2)])

    // A time axis, not a category axis. With a category axis every trading day
    // became a tick — 250 overlapping labels for a one-year window. ECharts
    // spaces a time axis by itself and switches granularity with the zoom.
    const spanDays = (Date.parse(winTo) - Date.parse(winFrom)) / 86400000
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const label = (ms: number) => {
      const d = new Date(ms)
      const yy = String(d.getUTCFullYear()).slice(2)
      // Under ~4 months a day number is useful; beyond that it is clutter, and
      // past ~3 years only the year carries information.
      if (spanDays <= 120) return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`
      if (spanDays <= 1100) return `${MON[d.getUTCMonth()]} ${yy}`
      return `${d.getUTCFullYear()}`
    }

    return {
      backgroundColor: 'transparent',
      grid: { top: 28, right: 16, bottom: 26, left: 48 },
      legend: { top: 0, textStyle: { color: axis, fontSize: 10 }, itemWidth: 14, itemHeight: 8 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: isLight ? '#FFFFFF' : '#18233C',
        borderColor: grid,
        textStyle: { color: isLight ? '#111827' : '#F1F5FB', fontSize: 11 },
        axisPointer: { type: 'line', lineStyle: { color: grid } },
        formatter: (ps: any[]) => {
          if (!ps?.length) return ''
          const d = new Date(ps[0].value[0])
          const head = `<b>${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}</b>`
          const body = ps.map(x => {
            const v = x.value[1]
            return `${x.marker} ${x.seriesName}: ${v > 0 ? '+' : ''}${v}%`
          }).join('<br/>')
          return `${head}<br/>${body}`
        },
      },
      xAxis: {
        type: 'time',
        min: Date.parse(winFrom),
        max: Date.parse(winTo),
        axisLabel: { color: axis, fontSize: 10, hideOverlap: true, formatter: label },
        axisLine: { lineStyle: { color: grid } },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value', name: '% from start', nameTextStyle: { color: axis, fontSize: 10 },
        axisLabel: { color: axis, fontSize: 10, formatter: '{value}%' },
        splitLine: { lineStyle: { color: grid, type: 'dashed' } },
      },
      series: [
        {
          name: 'Category avg', type: 'line', smooth: true, showSymbol: false,
          data: cat, lineStyle: { width: 2, color: '#22D3EE' }, itemStyle: { color: '#22D3EE' },
        },
        {
          name: catInfo?.benchmark_name ?? 'Benchmark', type: 'line', smooth: true,
          showSymbol: false, data: b,
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
                <input type="date" value={anchor} min={minDate} max={maxDate}
                  onChange={e => setAnchor(e.target.value)}
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
                <input type="date" value={from} min={minDate} max={to || maxDate}
                  onChange={e => setStart(e.target.value)}
                  className={dateInput} style={inputStyle} />
              </div>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>End Date</label>
                <input type="date" value={to} min={from || minDate} max={maxDate}
                  onChange={e => setEnd(e.target.value)}
                  className={dateInput} style={inputStyle} />
              </div>
            </>
          )}
          <div>
            <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>Category</label>
            {/* Short lists get chips, so the colour that identifies a category
                everywhere else is visible here too. 41 of them stay a dropdown. */}
            {allCats.length <= CHIP_LIMIT ? (
              <CategoryPicker cats={allCats} active={activeSlug} onChange={setSlug} />
            ) : (
              <select value={activeSlug} onChange={e => setSlug(e.target.value)}
                className={dateInput}
                style={{ ...inputStyle, borderColor: categoryColor(activeSlug, catInfo?.asset_class) }}>
                {allCats.map(c => <option key={c.slug} value={c.slug}>{c.category_name}</option>)}
              </select>
            )}
          </div>

          <div className="ml-auto flex items-center gap-3">
          <DownloadButton build={buildExport}
                          disabledHint="No fund has a full window for these dates" />
          <div className="text-xs text-right" style={{ color: 'var(--text-low)' }}>
            <div>measured {windowLabel}</div>
            <div>
              {loading
                ? `loading NAVs ${loaded}/${total} …`
                : `${rows.length} of ${total} funds have a full window`}
            </div>
          </div>
          </div>
        </div>
        <div className="text-[11px] mt-2" style={{ color: 'var(--text-low)' }}>
          <b>Absolute Return</b> is the total move over the window; <b>CAGR</b> is that same
          return expressed per year, so beyond one year it is the smaller of the two — a fund up
          60% over three years compounds at about 17% a year. Both are shown because they answer
          different questions. CAGR appears only past 366 days, since annualising a few months
          would magnify that period's noise and read as a forecast.
          {mode === 'p2p' && ' Start resolves to the first NAV on or after the chosen date and '
            + 'end to the last on or before it, so the window stays inside the range you asked for.'}
        </div>
      </div>

      {/* Table on the left, benchmark comparison on the right */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="xl:col-span-3 card overflow-hidden">
          <div className="overflow-auto" style={{ maxHeight: 720 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>#</th>
                  <th {...sort.headerProps('fund')}
                      className={`text-left ${sort.headerProps('fund').className}`}
                      style={{ minWidth: 320 }}>
                    Fund <span className="sort-caret">{sort.caret('fund')}</span>
                  </th>
                  {/* The heading's own tooltip is the sort affordance, so the
                      explanation is appended to it rather than replacing it. */}
                  {([
                    ['abs', 'Absolute Return',
                     'Total return over the window, not annualised'],
                    ['cagr', 'CAGR',
                     'The same return expressed per year; shown only beyond 366 days'],
                    ['vs', 'vs Benchmark',
                     'Fund absolute return minus benchmark absolute return'],
                  ] as const).map(([key, label, hint]) => {
                    const hp = sort.headerProps(key)
                    return (
                      <th key={key} {...hp} className={`ret-cell ${hp.className}`}
                          title={`${hint} — ${hp.title}`}>
                        {label} <span className="sort-caret">{sort.caret(key)}</span>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody key={`${activeSlug}-${mode}-${window}-${from}-${to}-${anchor}`} className="rows-enter">
                {visibleRows.map((r, i) => {
                  // Best and worst belong to the return ranking, so they are matched
                  // by code — sorting the table by CAGR or by name must not move the
                  // badges onto whichever fund lands at the top. Marked with a tinted
                  // band, an edge and a label rather than colour alone, which the
                  // return column already uses for sign.
                  const isBest = r.code === bestCode
                  const isWorst = r.code === worstCode
                  const tint = isBest ? 'rgba(52,211,153,0.10)'
                    : isWorst ? 'rgba(248,113,113,0.10)' : undefined
                  const edge = isBest ? 'var(--gain)' : isWorst ? 'var(--loss)' : 'transparent'
                  const tag = (text: string, colour: string, bg: string) => (
                    <span className="ml-2 px-1.5 py-0.5 rounded align-middle"
                          style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                                   background: bg, color: colour }}>
                      {text}
                    </span>
                  )
                  return (
                    <tr key={r.code}
                        style={{ background: tint, boxShadow: `inset 3px 0 0 ${edge}` }}>
                      <td className="text-xs" style={{ color: 'var(--text-low)' }}>{i + 1}</td>
                      <td className="text-left text-xs font-medium" style={{ maxWidth: 340 }}
                          title={r.name}>
                        <span className="truncate inline-block align-middle"
                              style={{ maxWidth: isBest || isWorst ? 248 : 330 }}>
                          {shortFundName(r.name, 52)}
                        </span>
                        {isBest && tag('BEST', 'var(--gain)', 'rgba(52,211,153,0.18)')}
                        {isWorst && tag('WORST', 'var(--loss)', 'rgba(248,113,113,0.18)')}
                      </td>
                      <td className={`ret-cell ${retColor(r.r.abs)}`}
                          style={{ fontWeight: isBest || isWorst ? 700 : undefined }}>
                        {fmtPct(r.r.abs)}
                      </td>
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
                  )
                })}
                {!rows.length && (
                  <tr>
                    <td colSpan={5} className="text-center py-8" style={{ color: 'var(--text-low)' }}>
                      {/* Three different reasons for an empty table, and the
                          date range is only one of them. A category with nothing
                          launched under it has no file at all, and telling that
                          reader to "try a later start date" sends them hunting
                          for a window that does not exist. */}
                      {loading
                        ? `Loading NAV series … ${loaded}/${total}`
                        : tableError
                        ? <ComingFunds error={tableError} subject="measure"
                                       failedLabel="this category" />
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
                    <td className="ret-cell" style={{ color: 'var(--text-mid)' }}>
                      {avgCagr != null ? fmtPct(avgCagr) : '—'}
                    </td>
                    <td className="ret-cell">
                      {avg != null && bench.abs != null && (
                        <span className={`spread-chip ${avg - bench.abs >= 0 ? 'pos' : 'neg'}`}>
                          {avg - bench.abs >= 0 ? '+' : ''}{((avg - bench.abs) * 100).toFixed(1)}%
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr style={{ fontWeight: 600 }}>
                    <td /><td className="text-left text-xs" style={{ color: '#F59E0B' }}>
                      {catInfo?.benchmark_name ?? 'Benchmark'}
                    </td>
                    <td className={`ret-cell ${retColor(bench.abs)}`}>{fmtPct(bench.abs)}</td>
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

          {bench.abs == null ? (
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
                  <div className={`font-semibold tabnum ${retColor(bench.abs)}`} style={{ fontSize: 15 }}>
                    {fmtPct(bench.abs)}
                  </div>
                  {bench.cagr != null && (
                    <div className="tabnum" style={{ fontSize: 10, color: 'var(--text-low)' }}>
                      {fmtPct(bench.cagr)} CAGR
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ color: 'var(--text-low)' }}>Category average</div>
                  <div className={`font-semibold tabnum ${retColor(avg)}`} style={{ fontSize: 15 }}>
                    {fmtPct(avg)}
                  </div>
                  {avgCagr != null && (
                    <div className="tabnum" style={{ fontSize: 10, color: 'var(--text-low)' }}>
                      {fmtPct(avgCagr)} CAGR
                    </div>
                  )}
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
                    color: avg != null && avg >= bench.abs ? 'var(--gain)' : 'var(--loss)',
                  }}>
                    {avg != null ? `${avg - bench.abs >= 0 ? '+' : ''}${((avg - bench.abs) * 100).toFixed(2)}%` : '—'}
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
                  <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded"
                       style={{ background: 'rgba(52,211,153,0.10)',
                                boxShadow: 'inset 3px 0 0 var(--gain)' }}>
                    <span className="truncate" title={best.name}>
                      <span className="font-bold mr-1.5" style={{ color: 'var(--gain)', fontSize: 9,
                            letterSpacing: '0.04em' }}>BEST</span>
                      <span style={{ color: 'var(--text-mid)' }}>{shortFundName(best.name, 24)}</span>
                    </span>
                    <span className={`tabnum font-bold shrink-0 ${retColor(best.r.abs)}`}>
                      {fmtPct(best.r.abs)}
                    </span>
                  </div>
                )}
                {worst && worst !== best && (
                  <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded"
                       style={{ background: 'rgba(248,113,113,0.10)',
                                boxShadow: 'inset 3px 0 0 var(--loss)' }}>
                    <span className="truncate" title={worst.name}>
                      <span className="font-bold mr-1.5" style={{ color: 'var(--loss)', fontSize: 9,
                            letterSpacing: '0.04em' }}>WORST</span>
                      <span style={{ color: 'var(--text-mid)' }}>{shortFundName(worst.name, 24)}</span>
                    </span>
                    <span className={`tabnum font-bold shrink-0 ${retColor(worst.r.abs)}`}>
                      {fmtPct(worst.r.abs)}
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
