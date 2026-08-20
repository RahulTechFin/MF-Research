// src/sections/TrendFinder.tsx — Section 5: Trend Finder (fund comparison chart)

import { useState, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { useMeta } from '../hooks/useData'
import { shortFundName } from '../utils/format'
import { navPath, dataUrl, manifest } from '../config/dataPaths'

const CHART_COLORS = ['#22D3EE', '#F472B6', '#8B5CF6', '#F59E0B', '#34D399']
const TIMEFRAMES   = ['1M', '3M', '6M', '12M', '3Y', '5Y', 'All']

/**
 * Benchmarks always offered, whatever is selected. Held as names because
 * index_id is assigned by the seed order and is not stable across rebuilds.
 */
const FIXED_BENCHMARKS: { name: string; dark: string; light: string }[] = [
  { name: 'NIFTY 50',  dark: '#10B981', light: '#059669' },
  { name: 'NIFTY 100', dark: '#A78BFA', light: '#8B5CF6' },
  { name: 'NIFTY 500', dark: '#FBBF24', light: '#D97706' },
]

/** Palette for category benchmarks — cycled so two are told apart. */
const CATEGORY_BM_COLORS = [
  { dark: '#FB7185', light: '#E11D48' },
  { dark: '#38BDF8', light: '#0284C7' },
  { dark: '#A3E635', light: '#65A30D' },
]

/** Module-level so the benchmark palette can be resolved before render locals. */
function isLightTheme(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-theme') === 'light'
}

interface Props {
  selectedFunds: string[]
  onToggleFund: (code: string) => void
}

interface FundSeries {
  code: string
  label: string
  series: [string, number][]
}

export default function TrendFinder({ selectedFunds, onToggleFund }: Props) {
  const { data: meta } = useMeta()
  const [period, setPeriod] = useState('12M')
  const [loading, setLoading] = useState(false)

  // Sub-selections (which ones to toggle plot rendering)
  const [visibleFunds, setVisibleFunds] = useState<string[]>([])

  // Which benchmark index_ids are plotted. A Set rather than a boolean per index,
  // because the list is no longer fixed: the selected funds' own category
  // benchmark joins the three standing ones.
  const [activeIndices, setActiveIndices] = useState<Set<number>>(new Set())

  // Benchmarks for EVERY category the selected funds belong to.
  //
  // This used to be a single benchmark that fell to null as soon as the selection
  // spanned two categories — so comparing a large cap against a mid cap silently
  // removed the reference line, which looked like the chart resetting itself.
  // Carrying one per represented category means adding a fund never takes a line
  // away; it adds the benchmark that fund is measured against.
  const [catBms, setCatBms] = useState<{ id: number; name: string }[]>([])
  // Which category benchmarks have already been auto-enabled, so a deliberate
  // deselection is not undone on the next render.
  const [autoApplied, setAutoApplied] = useState<Set<number>>(new Set())

  // Loaded data maps
  const [fundData, setFundData] = useState<Record<string, FundSeries>>({})
  const [indexData, setIndexData] = useState<Record<number, { label: string; series: [string, number][] }>>({})

  // Keep visibleFunds synchronized when selectedFunds changes
  useEffect(() => {
    setVisibleFunds(selectedFunds)
  }, [selectedFunds])

  // Fetch NAV series for selected funds dynamically
  useEffect(() => {
    if (selectedFunds.length === 0) {
      setFundData({})
      return
    }

    setLoading(true)
    // async because a fund's NAV now lives at <asset-class>/<slug>/nav/<code>.json
    // and only manifest.json knows which category a code belongs to. That lookup
    // is why this screen does not need the slug passed down from the screener.
    const fetches = selectedFunds.map(async code => {
      try {
        const r = await fetch(dataUrl(await navPath(code)))
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        return { code, label: d.scheme_name || `Fund ${code}`, series: d.series as [string, number][] }
      } catch {
        return null
      }
    })

    Promise.all(fetches).then(results => {
      const newMap: Record<string, FundSeries> = {}
      results.forEach(res => {
        if (res && res.series && res.series.length > 0) {
          newMap[res.code] = res
        }
      })
      setFundData(newMap)
      setLoading(false)
    })
  }, [selectedFunds])

  // The three standing benchmarks, resolved to ids once meta is in.
  const fixed = FIXED_BENCHMARKS
    .map(b => {
      const found = meta?.benchmarks.find(x => x.index_name === b.name)
      return found ? { ...b, id: found.index_id } : null
    })
    .filter((b): b is typeof FIXED_BENCHMARKS[0] & { id: number } => b !== null)

  // NIFTY 50 on by default, matching the previous behaviour.
  useEffect(() => {
    const n50 = meta?.benchmarks.find(b => b.index_name === 'NIFTY 50')
    if (n50) setActiveIndices(prev => (prev.size === 0 ? new Set([n50.index_id]) : prev))
  }, [meta])

  // Work out the selected funds' own category benchmark.
  //
  // Trend Finder is handed bare fund codes, so the category has to be recovered
  // from the manifest (code -> "<asset-class>/<slug>") and then matched against
  // meta.categories. Funds from different categories have no single "respective"
  // benchmark, so that case resolves to null rather than picking one arbitrarily.
  useEffect(() => {
    if (!meta || selectedFunds.length === 0) {
      setCatBms([])
      return
    }
    let cancelled = false
    manifest()
      .then(m => {
        if (cancelled) return
        const slugs = new Set(
          selectedFunds.map(c => (m.funds[c] ?? '').split('/')[1]).filter(Boolean))
        const seen = new Set<number>()
        const out: { id: number; name: string }[] = []
        for (const slug of slugs) {
          const cat = meta.categories.find(c => c.slug === slug)
          if (cat?.benchmark_id && cat.benchmark_name && !seen.has(cat.benchmark_id)) {
            seen.add(cat.benchmark_id)
            out.push({ id: cat.benchmark_id, name: cat.benchmark_name })
          }
        }
        setCatBms(out)
      })
      .catch(() => { if (!cancelled) setCatBms([]) })
    return () => { cancelled = true }
  }, [meta, selectedFunds])

  // Switch each category benchmark on the first time it appears. Tracked by id,
  // so turning one off stays off while a NEW category still brings its own on.
  useEffect(() => {
    const fresh = catBms.filter(b => !autoApplied.has(b.id))
    if (!fresh.length) return
    setActiveIndices(prev => {
      const next = new Set(prev)
      fresh.forEach(b => next.add(b.id))
      return next
    })
    setAutoApplied(prev => {
      const next = new Set(prev)
      fresh.forEach(b => next.add(b.id))
      return next
    })
  }, [catBms, autoApplied])

  /** True when this id is a category benchmark rather than one of the fixed three. */
  const isCategoryBm = (id: number) =>
    catBms.some(b => b.id === id) && !fixed.some(f => f.id === id)

  // Every benchmark that can be plotted right now, fixed plus category.
  const plottable = [
    ...fixed.map(b => ({ id: b.id, name: b.name,
                         color: isLightTheme() ? b.light : b.dark })),
    ...catBms
      .filter(b => !fixed.some(f => f.id === b.id))
      .map((b, i) => ({
        id: b.id, name: b.name,
        // Cycle the category palette so two category benchmarks are told apart.
        color: isLightTheme()
          ? CATEGORY_BM_COLORS[i % CATEGORY_BM_COLORS.length].light
          : CATEGORY_BM_COLORS[i % CATEGORY_BM_COLORS.length].dark,
      })),
  ]

  // Fetch the series for anything switched on that has not been loaded yet.
  useEffect(() => {
    plottable.forEach(b => {
      if (!activeIndices.has(b.id) || indexData[b.id]) return
      fetch(`${import.meta.env.BASE_URL}data/index/${b.id}.json`)
        .then(r => r.json())
        .then(d => setIndexData(prev => ({
          ...prev, [b.id]: { label: b.name, series: d.series as [string, number][] },
        })))
        .catch(() => {})
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndices, catBms, meta])

  const toggleIndex = (id: number) =>
    setActiveIndices(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** Benchmarks that are switched on AND have their data loaded. */
  const activeBenchmarks = plottable.filter(
    b => activeIndices.has(b.id) && indexData[b.id])

  // Theme colors
  const isLight = isLightTheme()
  const axisColor = isLight ? '#4B5563' : '#5E6F8F'
  const lineColor = isLight ? '#E5E7EB' : '#24314F'
  const tooltipBg = isLight ? '#FFFFFF' : '#111A2E'
  const tooltipBorder = isLight ? '#D1D5DB' : '#24314F'
  const tooltipText = isLight ? '#111827' : '#F1F5FB'

  // Timeframe calculation
  const getStartDate = (maxDateStr: string): string => {
    const maxDate = new Date(maxDateStr)
    if (period === '1M') maxDate.setMonth(maxDate.getMonth() - 1)
    else if (period === '3M') maxDate.setMonth(maxDate.getMonth() - 3)
    else if (period === '6M') maxDate.setMonth(maxDate.getMonth() - 6)
    else if (period === '12M') maxDate.setFullYear(maxDate.getFullYear() - 1)
    else if (period === '3Y') maxDate.setFullYear(maxDate.getFullYear() - 3)
    else if (period === '5Y') maxDate.setFullYear(maxDate.getFullYear() - 5)
    else return '2010-01-01'
    return maxDate.toISOString().split('T')[0]
  }

  const handleTogglePlotVisibility = (code: string) => {
    setVisibleFunds(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code])
  }

  // Align and normalise chart data
  const chartSeries: any[] = []
  let dates: string[] = []

  const activeCodes = Object.keys(fundData).filter(code => visibleFunds.includes(code))

  if (activeCodes.length > 0 || activeBenchmarks.length > 0) {
    // Every plotted series, funds and benchmarks alike, so the date range and the
    // normalisation base are worked out once instead of once per hardcoded index.
    const allSeries: [string, number][][] = [
      ...activeCodes.map(code => fundData[code].series),
      ...activeBenchmarks.map(b => indexData[b.id].series),
    ]

    let maxDateStr = '2010-01-01'
    allSeries.forEach(s => {
      const lastDate = s[s.length - 1][0]
      if (lastDate > maxDateStr) maxDateStr = lastDate
    })

    const startDateStr = getStartDate(maxDateStr)

    const allDates = new Set<string>()
    allSeries.forEach(s => s.forEach(([d]) => {
      if (d >= startDateStr && d <= maxDateStr) allDates.add(d)
    }))
    dates = Array.from(allDates).sort()

    // Helper to calculate normalised series
    const buildNormalisedSeries = (series: [string, number][], name: string, color: string, isDash = false) => {
      // [date, percent] pairs for a TIME axis, rather than one value per shared
      // category. A category axis needed 4,084 categories on the "All" range and
      // every series padded out to that length with nulls; a time axis lets each
      // series carry only the points it actually has, which is both fewer objects
      // and more honest — a fund launched last year no longer trails a long run
      // of nulls across the chart.
      //
      // Each series is rebased on ITS OWN first value inside the window, so a
      // fund younger than the timeframe still starts at 0% rather than inheriting
      // a number from a date it did not exist for. That first in-range point IS
      // the base, which is why this no longer builds a Map and re-scans the
      // shared date list to find it.
      const raw: [string, number][] = []
      for (const [d, val] of series) {
        if (d < startDateStr || d > maxDateStr || val == null || val <= 0) continue
        raw.push([d, val])
      }
      if (!raw.length) return

      const baseVal = raw[0][1]
      const points: [string, number][] = raw.map(
        ([d, val]) => [d, parseFloat((((val / baseVal) - 1) * 100).toFixed(2))])

      const last = points[points.length - 1]

      chartSeries.push({
        name,
        type: 'line',
        data: points,
        // Smoothing thousands of sub-pixel points costs real time and changes
        // nothing you can see. Only worth it when the series is short enough for
        // the curve to matter.
        smooth: points.length <= 400,
        showSymbol: false,
        // Largest-Triangle-Three-Buckets: ECharts reduces each series to about
        // one point per pixel while preserving the shape of the line. This is
        // what keeps the "All" range (~26,000 points across nine series)
        // responsive instead of stuttering on every hover.
        sampling: 'lttb',
        // Benchmarks are dashed and a touch lighter, so a fund line always reads
        // as the subject and the benchmark as the reference behind it.
        lineStyle: {
          width: isDash ? 2 : 2.5,
          type: isDash ? [6, 4] : 'solid',
          color,
          opacity: isDash ? 0.85 : 1,
          // No shadow: a blurred stroke is composited per point, which was the
          // single most expensive thing on the chart, and the area wash below
          // already separates a fund line from a benchmark.
        },
        itemStyle: { color },
        // A funds-only wash that fades downwards, so several can overlap without
        // stacking into mud. Benchmarks get none — they are the reference, not
        // the subject.
        areaStyle: isDash ? undefined : {
          opacity: 0.9,
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0,   color: color + '2E' },
              { offset: 0.6, color: color + '10' },
              { offset: 1,   color: color + '00' },
            ],
          },
        },
        emphasis: { focus: 'series', lineStyle: { width: isDash ? 2.5 : 3.5 } },
        // The final value, printed at the end of the line. This is the number a
        // reader actually wants and previously had to hover for.
        markPoint: {
          symbol: 'circle',
          symbolSize: 7,
          silent: true,
          itemStyle: { color, borderColor: 'var(--bg-card)', borderWidth: 2 },
          label: {
            show: true,
            position: 'right',
            distance: 6,
            formatter: () => `${last[1] >= 0 ? '+' : ''}${last[1].toFixed(1)}%`,
            color,
            fontSize: 10,
            fontWeight: isDash ? 'normal' : 'bold',
          },
          // A time axis takes the date itself as the coordinate, so this no
          // longer depends on the series being aligned to a shared index.
          data: [{ coord: [last[0], last[1]] }],
        },
        z: isDash ? 2 : 3,
      })
    }

    // Add selected funds
    activeCodes.forEach((code, idx) => {
      const label = shortFundName(fundData[code].label)
      buildNormalisedSeries(fundData[code].series, label, CHART_COLORS[idx % CHART_COLORS.length])
    })

    // Add benchmarks as dashed lines
    activeBenchmarks.forEach(b => {
      buildNormalisedSeries(indexData[b.id].series, b.name, b.color, true)
    })
  }

  const option = {
    backgroundColor: 'transparent',
    // Extra right margin so the end-of-line value labels are not clipped.
    grid: { top: 46, right: 78, bottom: 40, left: 55 },
    // A TIME axis, not 4,084 categories. Beyond being far cheaper to lay out, it
    // spaces points by actual date — a category axis draws a market holiday the
    // same width as a trading day — and it labels itself sensibly at any zoom
    // instead of needing an `interval` guess. Format follows the span so a
    // one-month view shows days and a five-year view shows years.
    xAxis: {
      type: 'time',
      min: dates.length ? dates[0] : undefined,
      max: dates.length ? dates[dates.length - 1] : undefined,
      axisLine:  { lineStyle: { color: lineColor } },
      axisLabel: {
        color: axisColor,
        fontSize: 10,
        hideOverlap: true,
        formatter: {
          year: '{yyyy}', month: "{MMM} '{yy}", day: '{d} {MMM}',
        },
      },
      // Faint vertical gridlines, so a point can be traced back to its date
      // without hovering. Solid and very low contrast; dashed in both directions
      // reads as graph paper.
      splitLine: { show: true, lineStyle: { color: lineColor, opacity: 0.35 } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLine:  { show: false },
      axisTick:  { show: false },
      axisLabel: { color: axisColor, fontSize: 10, formatter: (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%` },
      splitLine: { lineStyle: { color: lineColor, type: 'dashed' } },
      splitNumber: 5,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tooltipBg,
      borderColor: tooltipBorder,
      textStyle: { color: tooltipText, fontSize: 11 },
      // Best to worst rather than series order, so the ranking on a given day is
      // readable without comparing numbers by eye.
      order: 'valueDesc',
      valueFormatter: (v: number | null) =>
        v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`,
      // A full-height crosshair with the date in a pill at the axis, so the
      // reading is unambiguous across nine overlapping lines.
      axisPointer: {
        type: 'line',
        snap: true,
        lineStyle: { color: axisColor, width: 1, type: [4, 4] },
        label: {
          show: true,
          backgroundColor: tooltipBg,
          borderColor: tooltipBorder,
          borderWidth: 1,
          color: tooltipText,
          fontSize: 10,
          formatter: (p: { value: number | string }) =>
            new Date(p.value).toLocaleDateString('en-GB',
              { day: '2-digit', month: 'short', year: 'numeric' }),
        },
      },
      extraCssText: 'border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.35);',
    },
    legend: {
      show: true,
      top: 5,
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 3,
      textStyle: { color: isLight ? '#1F2937' : '#9FB0CC', fontSize: 11 },
    },
    // Draw in chunks rather than blocking on the whole dataset, and skip the
    // entry animation once there is enough on screen for it to be felt.
    progressive: 2000,
    progressiveThreshold: 4000,
    animation: chartSeries.reduce((n, s) => n + (s.data?.length ?? 0), 0) < 6000,
    series: chartSeries.length
      ? [
          {
            ...chartSeries[0],
            // Every series is rebased to 0% at the start of the window, so that
            // line is the reference the whole chart is read against. Drawn once,
            // on the first series, rather than as its own entry — a separate
            // series would appear in the legend as something selectable.
            markLine: {
              silent: true,
              symbol: 'none',
              lineStyle: { color: axisColor, width: 1, opacity: 0.5 },
              label: {
                show: true, position: 'insideEndTop', formatter: '0%',
                color: axisColor, fontSize: 9,
              },
              data: [{ yAxis: 0 }],
            },
          },
          ...chartSeries.slice(1),
        ]
      : [],
  }

  return (
    <section id="trend-finder" className="px-6 py-6 max-w-screen-2xl mx-auto">
      <div className="section-header">Trend Finder</div>

      <div className="card p-4">
        {/* Controls Layout */}
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-4 pb-4 border-b border-[var(--line)]">
          {/* Left side: Toggles for selected funds */}
          <div className="flex-1">
            <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-mid)' }}>
              Compare Funds (selected from table above):
            </div>
            {selectedFunds.length === 0 ? (
              <div className="text-xs italic" style={{ color: 'var(--text-low)' }}>
                No funds selected yet. Tock the "Select" checkbox on any row in the Fund Screener table above to plot here.
              </div>
            ) : (
              <div className="flex gap-4 flex-wrap">
                {selectedFunds.map((code, idx) => (
                  <label key={code} className="flex items-center gap-2 text-xs font-medium cursor-pointer" style={{ color: CHART_COLORS[idx % CHART_COLORS.length] }}>
                    <input
                      type="checkbox"
                      checked={visibleFunds.includes(code)}
                      onChange={() => handleTogglePlotVisibility(code)}
                      className="cursor-pointer"
                    />
                    <span className="truncate max-w-[160px]">
                      {fundData[code] ? shortFundName(fundData[code].label, 22) : code}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Right side: benchmark toggles.
              Chips rather than checkboxes, each carrying a dashed swatch in its
              own series colour — so the control reads as a legend you can click
              and the chart needs no separate key. An off chip stays outlined
              instead of greying out, which keeps the row from jumping as
              selections change. */}
          <div className="shrink-0 border-t md:border-t-0 md:border-l border-[var(--line)]
                          pt-3 md:pt-0 md:pl-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider"
                    style={{ color: 'var(--text-low)' }}>
                Benchmarks
              </span>
              <span className="text-[10px] px-1.5 rounded-full"
                    style={{ background: 'var(--bg-raised)', color: 'var(--text-low)' }}>
                {activeIndices.size}
              </span>
            </div>
            <div className="flex md:flex-col gap-1.5 flex-wrap">
              {plottable.map(b => {
                const on = activeIndices.has(b.id)
                const auto = isCategoryBm(b.id)
                return (
                  <button
                    key={b.id}
                    onClick={() => toggleIndex(b.id)}
                    aria-pressed={on}
                    title={auto
                      ? `Benchmark for a selected fund’s category. Turned on automatically — click to hide it.`
                      : on ? `Hide ${b.name}` : `Show ${b.name}`}
                    className="group flex items-center gap-2 pl-1.5 pr-2.5 py-1 rounded-full
                               text-[11px] font-medium transition-all duration-150"
                    style={{
                      background: on ? `${b.color}1F` : 'transparent',
                      border: `1px solid ${on ? b.color : 'var(--line)'}`,
                      color: on ? b.color : 'var(--text-mid)',
                      cursor: 'pointer',
                    }}>
                    {/* Dashed swatch: exactly how the line is drawn. */}
                    <span aria-hidden style={{
                      width: 16, height: 0, flexShrink: 0,
                      borderTop: `2px dashed ${on ? b.color : 'var(--text-low)'}`,
                      opacity: on ? 1 : 0.55,
                    }} />
                    <span className="truncate" style={{ maxWidth: 132 }}>{b.name}</span>
                    {auto && (
                      <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.06em',
                                     padding: '1px 4px', borderRadius: 999,
                                     background: on ? `${b.color}2E` : 'var(--bg-raised)',
                                     color: on ? b.color : 'var(--text-low)' }}>
                        AUTO
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Timeframe pills */}
        <div className="flex gap-2 flex-wrap mb-4">
          {TIMEFRAMES.map(tf => (
            <button key={tf} onClick={() => setPeriod(tf)}
              className={`pill${period === tf ? ' active' : ''}`}>
              {tf}
            </button>
          ))}
        </div>

        {/* Chart area */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="skeleton w-full h-80" />
          </div>
        ) : activeCodes.length === 0 && activeBenchmarks.length === 0 ? (
          <div className="flex items-center justify-center py-16 flex-col gap-2"
            style={{ color: 'var(--text-mid)', border: '1px dashed var(--line)', borderRadius: 8 }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <p className="text-sm">No series selected to plot.</p>
          </div>
        ) : (
          <div style={{ height: 400 }}>
            <ReactECharts
              option={option}
              style={{ height: '100%', width: '100%' }}
              notMerge
            />
          </div>
        )}

        {/* Instructions */}
        <div className="mt-3 text-xs text-center" style={{ color: 'var(--text-low)' }}>
          Dashed lines represent Fixed Benchmarks · Solid lines represent selected Growth Funds · All series normalised to 0% at the timeframe start date
        </div>
      </div>
    </section>
  )
}
