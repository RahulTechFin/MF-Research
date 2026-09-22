// src/sections/BlendStudio.tsx — Section 9: Blend Studio
//
// WHAT THIS TAB IS FOR
// A category's mandate is a range ("65–80% equity") and its benchmark is a blend
// someone chose. Three questions follow, and none can be answered from a
// precomputed table because the analyst invents the portfolio:
//
//   1. If I hold THIS mix, what do I get? Return, but also volatility, the
//      drawdown, the worst month, where the risk actually sits — the things that
//      decide whether a client can hold it.
//   2. What mix does this category behave like? Not what its mandate permits:
//      what its funds' own monthly returns imply. That is "Fit to category".
//   3. Could the mix have been better? The opportunity set, min-variance and
//      max-Sharpe points, and what the rebalancing rule costs.
//
// The maths is in utils/blend.ts (primitives) and utils/blendAnalytics.ts
// (analysis), both checked against the Python engine's published output by
// scripts/verify_blend.mjs. The panels are in BlendPanels.tsx. This file owns
// only the state: what the portfolio is and what window it is measured over.

import { useEffect, useMemo, useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { useMeta } from '../hooks/useData'
import { categoryPath, dataUrl, marketUrl } from '../config/dataPaths'
import DownloadButton from '../components/DownloadButton'
import { currentDesk } from '../config/products'
import type { SheetSpec } from '../utils/xlsx'
import { fmtPct, retColor } from '../utils/format'
import {
  buildBlend, calendarYears, clip, commonDates, endingWeights, fitWeights,
  stats, REBALANCE_LABELS, RISK_FREE,
} from '../utils/blend'
import type { Rebalance, Series, Sleeve } from '../utils/blend'
import {
  applyFee, contributions, correlationMatrix, distribution, drawdownEpisodes,
  frontier, monthlyGrid, rolling, stressTest,
} from '../utils/blendAnalytics'
import {
  BLEND_COLOUR, ContributionPanel, CorrelationPanel, DistributionPanel,
  EpisodePanel, FrontierPanel, HeatmapPanel, RebalancePanel, RollingPanel,
  StressPanel, drawdownOption, growthOption,
} from './BlendPanels'

const WINDOWS = ['1Y', '3Y', '5Y', 'Max'] as const
type Window = typeof WINDOWS[number]

const VIEWS = [
  ['overview', 'Overview'],
  ['allocation', 'Allocation'],
  ['risk', 'Risk'],
  ['rolling', 'Stability'],
  ['seasonality', 'Seasonality'],
] as const
type View = typeof VIEWS[number][0]

const ALL_FREQS: Rebalance[] = ['daily', 'monthly', 'quarterly', 'annual', 'none']

/**
 * The five blends the pipeline itself publishes as category benchmarks, copied
 * from meta.benchmarks rather than invented.
 *
 * Loading one puts the analyst on the SAME starting line the dashboard grades
 * that category against, so the first thing "Fit to category" reveals is how far
 * the official blend sits from how the funds have actually behaved.
 */
const PRESETS: { label: string; slug: string; mix: [string, number][] }[] = [
  { label: 'Aggressive Hybrid 65:35', slug: 'aggressive-hybrid',
    mix: [['NIFTY 50', 65], ['GILT ETF (LTGILTBEES)', 35]] },
  { label: 'Balanced Advantage 50:50', slug: 'balanced-advantage',
    mix: [['NIFTY 50', 50], ['GILT ETF (LTGILTBEES)', 50]] },
  { label: 'Conservative 25:75', slug: 'conservative-hybrid',
    mix: [['NIFTY 50', 25], ['GILT ETF (LTGILTBEES)', 75]] },
  { label: 'Equity Savings 35:65', slug: 'equity-savings',
    mix: [['NIFTY 50', 35], ['GILT ETF (LTGILTBEES)', 65]] },
  { label: 'Multi Asset 65:25:10', slug: 'multi-asset',
    mix: [['NIFTY 50', 65], ['GILT ETF (LTGILTBEES)', 25], ['GOLD (GOLDBEES)', 10]] },
]

function windowStart(window: Window, lastDate: string): string | undefined {
  if (window === 'Max') return undefined
  const years = window === '1Y' ? 1 : window === '3Y' ? 3 : 5
  const d = new Date(lastDate)
  d.setFullYear(d.getFullYear() - years)
  return d.toISOString().slice(0, 10)
}

export default function BlendStudio() {
  const { data: meta } = useMeta()
  const [sleeves, setSleeves] = useState<Sleeve[]>([])
  const [rebalanceMode, setRebalance] = useState<Rebalance>('quarterly')
  const [window, setWindow] = useState<Window>('5Y')
  const [compareCategory, setCompareCategory] = useState('aggressive-hybrid')
  const [extraIndexId, setExtraIndexId] = useState<number | null>(null)
  const [feePct, setFeePct] = useState(0)
  const [view, setView] = useState<View>('overview')
  const [rollMetric, setRollMetric] = useState<'cagr' | 'vol' | 'excess' | 'te' | 'beta'>('cagr')
  const [rollWindow, setRollWindow] = useState(36)

  const [indexSeries, setIndexSeries] = useState<Record<number, Series>>({})
  const [categorySeries, setCategorySeries] = useState<Series>([])
  const [catLoading, setCatLoading] = useState(false)
  const [catError, setCatError] = useState<string | null>(null)
  const [fitNote, setFitNote] = useState<string | null>(null)

  const benchmarks = useMemo(
    () => (meta?.benchmarks ?? []).filter(b => !b.is_synthetic),
    [meta],
  )

  useEffect(() => {
    if (!benchmarks.length || sleeves.length) return
    const mix = PRESETS[0].mix
      .map(([name, w]) => {
        const b = benchmarks.find(x => x.index_name === name)
        return b ? { index_id: b.index_id, index_name: b.index_name, weight: w } : null
      })
      .filter((s): s is Sleeve => s !== null)
    if (mix.length) setSleeves(mix)
  }, [benchmarks, sleeves.length])

  // Index series, fetched once each and kept — a sleeve removed and re-added
  // should not refetch.
  const wanted = useMemo(
    () => [...new Set([...sleeves.map(s => s.index_id),
                       ...(extraIndexId ? [extraIndexId] : [])])],
    [sleeves, extraIndexId],
  )
  useEffect(() => {
    for (const id of wanted) {
      if (indexSeries[id]) continue
      fetch(marketUrl(`index/${id}.json`))
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
        .then(d => setIndexSeries(prev => ({ ...prev, [id]: d.series as Series })))
        .catch(() => setIndexSeries(prev => ({ ...prev, [id]: [] })))
    }
  }, [wanted, indexSeries])

  useEffect(() => {
    let cancelled = false
    setCatLoading(true)
    setCatError(null)
    setCategorySeries([])
    categoryPath(compareCategory, 'history.json')
      .then(p => fetch(dataUrl(p)))
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => { if (!cancelled) { setCategorySeries(d.series as Series); setCatLoading(false) } })
      .catch(e => { if (!cancelled) { setCatError(e.message); setCatLoading(false) } })
    return () => { cancelled = true }
  }, [compareCategory])

  const total = sleeves.reduce((a, s) => a + s.weight, 0)
  const ready = sleeves.length > 0 && sleeves.every(s => indexSeries[s.index_id]?.length)

  // ── the measured window ──────────────────────────────────────────────────
  //
  // Both lines must start and end on the same day or the comparison is between
  // two different periods. The committed index series can lag the NAV data, so
  // the end is the LAST DAY BOTH HAVE, not today.
  const { blendGross, category, from, to } = useMemo(() => {
    if (!ready || !categorySeries.length) {
      return { blendGross: [] as Series, category: [] as Series, from: '', to: '' }
    }
    const raw = buildBlend(indexSeries, sleeves, rebalanceMode)
    if (raw.length < 2) return { blendGross: [], category: [], from: '', to: '' }
    const shared = commonDates([raw, categorySeries])
    if (shared.length < 2) return { blendGross: [], category: [], from: '', to: '' }
    const end = shared[shared.length - 1]
    const floor = windowStart(window, end)
    const start = floor && floor > shared[0] ? floor : shared[0]
    // Rebuilt inside the window, so a rebalanced blend starts at its target
    // weights on the first day shown rather than inheriting drift from 2010.
    const b = buildBlend(indexSeries, sleeves, rebalanceMode, start, end)
    return { blendGross: b, category: clip(categorySeries, b[0]?.[0], end),
             from: b[0]?.[0] ?? '', to: end }
  }, [ready, indexSeries, sleeves, rebalanceMode, categorySeries, window])

  // A blend of index closes has no expense ratio; netting one off is the only
  // way comparing it to a real category average is fair.
  const blend = useMemo(() => applyFee(blendGross, feePct), [blendGross, feePct])

  const blendStats = useMemo(() => stats(blend, category), [blend, category])
  const catStats = useMemo(() => stats(category, blend), [category, blend])
  const drift = useMemo(
    () => endingWeights(indexSeries, sleeves, rebalanceMode, from, to),
    [indexSeries, sleeves, rebalanceMode, from, to],
  )
  const years = useMemo(() => {
    const b = new Map(calendarYears(blend).map(y => [y.year, y]))
    const c = new Map(calendarYears(category).map(y => [y.year, y]))
    return [...new Set([...b.keys(), ...c.keys()])].sort().reverse()
      .map(y => ({ year: y, blend: b.get(y), cat: c.get(y) }))
  }, [blend, category])

  const catName = meta?.categories.find(c => c.slug === compareCategory)?.category_name
    ?? compareCategory
  const extraName = benchmarks.find(b => b.index_id === extraIndexId)?.index_name ?? ''

  // ── analysis, computed only for the view being looked at ─────────────────
  const liveSleeves = useMemo(
    () => sleeves.filter(s => indexSeries[s.index_id]?.length),
    [sleeves, indexSeries],
  )

  const contrib = useMemo(
    () => view === 'allocation' && blend.length > 1
      ? contributions(indexSeries, sleeves, rebalanceMode, from, to)
      : { rows: [], totalReturn: null, totalVol: null },
    [view, indexSeries, sleeves, rebalanceMode, from, to, blend.length],
  )

  const corr = useMemo(
    () => view === 'allocation' && liveSleeves.length > 1
      ? correlationMatrix(liveSleeves.map(s => s.index_name),
          liveSleeves.map(s => clip(indexSeries[s.index_id], from, to)))
      : { labels: [], rows: [], months: 0 },
    [view, liveSleeves, indexSeries, from, to],
  )

  const front = useMemo(
    () => view === 'allocation' && liveSleeves.length > 1 && from
      ? frontier(indexSeries, liveSleeves, rebalanceMode, from, to)
      : { points: [], current: null, minVariance: null, maxSharpe: null, months: 0 },
    [view, indexSeries, liveSleeves, rebalanceMode, from, to],
  )

  const episodes = useMemo(
    () => view === 'risk' ? drawdownEpisodes(blend, 6) : [],
    [view, blend],
  )
  const dist = useMemo(
    () => view === 'risk' ? distribution(blend, category)
      : { months: 0, skew: null, excessKurtosis: null, var95: null, cvar95: null,
          bestQuarter: null, worstQuarter: null, hitRate: null,
          longestRun: 0, longestDrought: 0 },
    [view, blend, category],
  )
  const rebalRows = useMemo(
    () => view === 'risk' && ready && from
      ? ALL_FREQS.map(freq => {
          const b = applyFee(buildBlend(indexSeries, sleeves, freq, from, to), feePct)
          const w = endingWeights(indexSeries, sleeves, freq, from, to)
          const biggest = [...sleeves].sort((a, b2) => b2.weight - a.weight)[0]
          const share = total > 0 && biggest ? (biggest.weight / total) * 100 : null
          return {
            freq, stats: stats(b),
            drift: share != null && w[biggest.index_id] != null
              ? w[biggest.index_id] - share : null,
          }
        })
      : [],
    [view, ready, indexSeries, sleeves, from, to, feePct, total],
  )

  const roll = useMemo(
    () => view === 'rolling' && blend.length > 1
      ? rolling(blend, category, rollWindow, rollMetric)
      : { points: [], windowMonths: rollWindow },
    [view, blend, category, rollWindow, rollMetric],
  )

  const stress = useMemo(
    () => view === 'seasonality' && blend.length > 1 ? stressTest(blend, category) : [],
    [view, blend, category],
  )
  const grid = useMemo(
    () => view === 'seasonality' ? monthlyGrid(blend) : { years: [], cells: {} },
    [view, blend],
  )

  const extraSeries = extraIndexId ? (indexSeries[extraIndexId] ?? []) : []
  const growth = useMemo(
    () => growthOption(blend, category, `${catName} average`,
      extraIndexId && extraSeries.length
        ? { label: extraName, series: clip(extraSeries, from, to) } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blend, category, catName, extraIndexId, extraSeries.length, from, to],
  )
  const under = useMemo(
    () => drawdownOption(blend, category, `${catName} average`),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blend, category, catName],
  )

  // ── actions ──────────────────────────────────────────────────────────────
  const setWeight = (id: number, v: string) =>
    setSleeves(prev => prev.map(s =>
      s.index_id === id ? { ...s, weight: Math.max(0, parseFloat(v) || 0) } : s))
  const remove = (id: number) => setSleeves(prev => prev.filter(s => s.index_id !== id))
  const add = (idStr: string) => {
    const id = Number(idStr)
    const b = benchmarks.find(x => x.index_id === id)
    if (!b || sleeves.some(s => s.index_id === id)) return
    // A new sleeve arrives at zero so nothing else moves until it is given a
    // weight — adding a component must not silently restate the portfolio.
    setSleeves(prev => [...prev, { index_id: b.index_id, index_name: b.index_name, weight: 0 }])
  }
  const normalise = () => {
    if (total <= 0) return
    setSleeves(prev => prev.map(s => ({ ...s, weight: Math.round((s.weight / total) * 1000) / 10 })))
  }
  const equalise = () => setSleeves(prev => prev.map(s => ({
    ...s, weight: Math.round((100 / prev.length) * 10) / 10,
  })))
  const applyWeights = (weights: number[]) =>
    setSleeves(prev => {
      const byId = new Map(liveSleeves.map((s, i) => [s.index_id, weights[i]]))
      return prev.map(s => ({ ...s, weight: Math.round((byId.get(s.index_id) ?? 0) * 10) / 10 }))
    })

  const fitToCategory = () => {
    if (liveSleeves.length < 2 || !category.length) {
      setFitNote('Two loaded components and a category are needed to fit.')
      return
    }
    const win = liveSleeves.map(s => clip(indexSeries[s.index_id], from, to))
    const fit = fitWeights(category, win)
    if (!fit) {
      setFitNote('Not enough overlapping months in this window to fit — try Max.')
      return
    }
    applyWeights(fit.weights)
    setFitNote(
      `Best fit over ${fit.months} months — R² ${fit.rSquared != null
        ? fit.rSquared.toFixed(3) : '—'}, tracking error ${fit.trackingError != null
        ? (fit.trackingError * 100).toFixed(2) + '%' : '—'}. Describes how the `
      + 'category behaved in this window; it is not a holdings disclosure.',
    )
  }

  const applyPreset = (p: typeof PRESETS[number]) => {
    const mix = p.mix
      .map(([name, w]) => {
        const b = benchmarks.find(x => x.index_name === name)
        return b ? { index_id: b.index_id, index_name: b.index_name, weight: w } : null
      })
      .filter((s): s is Sleeve => s !== null)
    if (!mix.length) return
    setSleeves(mix)
    setCompareCategory(p.slug)
    setFitNote(mix.length < p.mix.length
      ? 'Some components of this preset are not in the benchmark list; the rest loaded.'
      : null)
  }

  // ── measures ─────────────────────────────────────────────────────────────
  const pct = (v: number | null | undefined, dp = 2) =>
    v == null ? '—' : `${(v * 100).toFixed(dp)}%`
  const rat = (v: number | null | undefined, dp = 2) => v == null ? '—' : v.toFixed(dp)

  const measures: {
    label: string; hint: string; blend: string; cat: string
    dir?: 'up' | 'down'; raw?: [number | null, number | null]
  }[] = [
    { label: 'Absolute return', hint: 'Total move over the window, not annualised',
      blend: pct(blendStats.abs), cat: pct(catStats.abs), dir: 'up',
      raw: [blendStats.abs, catStats.abs] },
    { label: 'CAGR', hint: 'The same return per year; equals absolute under one year',
      blend: pct(blendStats.cagr), cat: pct(catStats.cagr), dir: 'up',
      raw: [blendStats.cagr, catStats.cagr] },
    { label: 'Volatility', hint: 'Standard deviation of monthly returns, annualised',
      blend: pct(blendStats.vol), cat: pct(catStats.vol), dir: 'down',
      raw: [blendStats.vol, catStats.vol] },
    { label: 'Sharpe', hint: `(CAGR − ${(RISK_FREE * 100).toFixed(1)}%) ÷ volatility`,
      blend: rat(blendStats.sharpe), cat: rat(catStats.sharpe), dir: 'up',
      raw: [blendStats.sharpe, catStats.sharpe] },
    { label: 'Sortino', hint: 'Same, counting only downside deviation as risk',
      blend: rat(blendStats.sortino), cat: rat(catStats.sortino), dir: 'up',
      raw: [blendStats.sortino, catStats.sortino] },
    { label: 'Max drawdown', hint: 'Worst peak-to-trough fall inside the window',
      blend: pct(blendStats.maxDrawdown), cat: pct(catStats.maxDrawdown), dir: 'up',
      raw: [blendStats.maxDrawdown, catStats.maxDrawdown] },
    { label: 'Best month', hint: 'Strongest single calendar month',
      blend: pct(blendStats.bestMonth), cat: pct(catStats.bestMonth) },
    { label: 'Worst month', hint: 'Weakest single calendar month',
      blend: pct(blendStats.worstMonth), cat: pct(catStats.worstMonth) },
    { label: 'Positive months', hint: 'Share of months that finished up',
      blend: pct(blendStats.positiveMonths, 0), cat: pct(catStats.positiveMonths, 0) },
  ]
  const relative: { label: string; hint: string; blend: string; cat: string }[] = [
    { label: 'Beta vs category', hint: 'Sensitivity to the category average',
      blend: rat(blendStats.beta), cat: '1.00' },
    { label: 'Correlation', hint: 'How closely the two move together, −1 to +1',
      blend: rat(blendStats.correlation), cat: '1.00' },
    { label: 'Tracking error', hint: 'Annualised volatility of blend minus category',
      blend: pct(blendStats.trackingError), cat: '0.00%' },
    { label: 'Information ratio', hint: 'Excess CAGR per unit of tracking error',
      blend: rat(blendStats.infoRatio), cat: '—' },
    { label: 'Alpha', hint: 'Return beyond what its beta to the category would explain',
      blend: pct(blendStats.alpha), cat: '0.00%' },
    { label: 'Upside capture', hint: 'Share of the category’s gains captured in up months',
      blend: blendStats.upCapture == null ? '—' : `${blendStats.upCapture.toFixed(0)}%`,
      cat: '100%' },
    { label: 'Downside capture', hint: 'Share of the category’s losses taken in down months',
      blend: blendStats.downCapture == null ? '—' : `${blendStats.downCapture.toFixed(0)}%`,
      cat: '100%' },
  ]

  const buildExport = (): SheetSpec | null => {
    if (blend.length < 2) return null
    const desk = currentDesk()
    return {
      sheet: 'Blend Studio',
      title: `Blend Studio - ${sleeves.filter(s => s.weight > 0)
        .map(s => `${s.index_name} ${s.weight}%`).join(' / ')}`,
      meta: [
        ['Desk', desk.name],
        ['Window', `${from} to ${to}`],
        ['Rebalancing', REBALANCE_LABELS[rebalanceMode]],
        ['Compared against', `${catName} category average`],
        ['Fee applied to the blend', feePct ? `${feePct.toFixed(2)}% a year` : 'none'],
        ['Months of data', String(blendStats.months)],
        ['Risk-free rate', `${(RISK_FREE * 100).toFixed(1)}%`],
        ...sleeves.filter(s => s.weight > 0).map(s => [
          `Weight - ${s.index_name}`,
          `${((s.weight / total) * 100).toFixed(1)}%`
          + (drift[s.index_id] != null && rebalanceMode !== 'daily'
            ? ` (drifted to ${drift[s.index_id].toFixed(1)}%)` : ''),
        ] as [string, string]),
        ['Note', 'A blend is a hypothetical portfolio of index closes. Unless a fee '
               + 'is set above it carries no expense ratio, no tracking difference '
               + 'and no cash drag, so it is not investable and will read slightly '
               + 'better than any fund following it.'],
      ],
      columns: [
        { key: 'measure', label: 'Measure', type: 'text', width: 26 },
        { key: 'blend', label: 'Your blend', type: 'text', width: 14 },
        { key: 'cat', label: `${catName} avg`, type: 'text', width: 18 },
      ],
      rows: [
        ...measures.map(m => ({ measure: m.label, blend: m.blend, cat: m.cat })),
        { measure: '', blend: '', cat: '' },
        { measure: 'Relative to the category', blend: '', cat: '' },
        ...relative.map(m => ({ measure: m.label, blend: m.blend, cat: m.cat })),
        { measure: '', blend: '', cat: '' },
        { measure: 'Calendar year', blend: 'Your blend', cat: `${catName} avg` },
        ...years.map(y => ({
          measure: y.year + (y.blend?.partial || y.cat?.partial ? ' (partial)' : ''),
          blend: y.blend ? `${(y.blend.ret * 100).toFixed(2)}%` : '—',
          cat: y.cat ? `${(y.cat.ret * 100).toFixed(2)}%` : '—',
        })),
      ],
      fileName: `${desk.code} Blend Studio - ${catName} - ${to}`,
    }
  }

  const available = benchmarks.filter(b => !sleeves.some(s => s.index_id === b.index_id))
  const weightsOff = Math.abs(total - 100) > 0.5
  const pillStyle = (on: boolean) => on
    ? { color: BLEND_COLOUR, borderColor: BLEND_COLOUR, background: `${BLEND_COLOUR}1f` }
    : undefined

  return (
    <section id="blend-studio" className="px-6 py-6 max-w-screen-2xl mx-auto">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
        <div className="section-header" style={{ marginBottom: 0 }}>Blend Studio</div>
        <DownloadButton build={buildExport} disabledHint="Build a blend before downloading" />
      </div>
      <p className="text-xs mb-4" style={{ color: 'var(--text-low)' }}>
        Build a benchmark from index closes and take it apart against a category's
        own history. Nothing is stored — it is computed in the browser from the same
        files the rest of the dashboard reads.
      </p>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        {/* ── Builder ──────────────────────────────────────────────────── */}
        <div className="card p-4 flex flex-col gap-4 self-start">
          <div>
            <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-hi)' }}>
              Components
            </div>
            <div className="space-y-2">
              {sleeves.map(s => {
                const share = total > 0 ? (s.weight / total) * 100 : 0
                const drifted = drift[s.index_id]
                return (
                  <div key={s.index_id}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 text-xs truncate" title={s.index_name}
                           style={{ color: 'var(--text-hi)' }}>
                        {s.index_name}
                        {!indexSeries[s.index_id] && (
                          <span className="ml-1" style={{ color: 'var(--text-low)' }}>loading…</span>
                        )}
                        {indexSeries[s.index_id]?.length === 0 && (
                          <span className="ml-1" style={{ color: 'var(--loss)' }}>no history</span>
                        )}
                      </div>
                      <input type="number" value={s.weight} min={0} max={100} step={5}
                             onChange={e => setWeight(s.index_id, e.target.value)}
                             className="w-16 px-2 py-1 rounded text-xs text-right tabnum"
                             style={{ background: 'var(--bg-raised)',
                                      border: `1px solid ${weightsOff ? 'var(--loss)' : 'var(--line)'}`,
                                      color: 'var(--text-hi)', outline: 'none' }} />
                      <span className="text-xs" style={{ color: 'var(--text-mid)' }}>%</span>
                      <button onClick={() => remove(s.index_id)} title="Remove this component"
                              className="px-1.5 rounded text-xs"
                              style={{ color: 'var(--text-low)', background: 'var(--bg-raised)',
                                       border: '1px solid var(--line)' }}>×</button>
                    </div>
                    {/* The bar shows the NORMALISED share, so weights that do not
                        add to 100 still read correctly. */}
                    <div className="mt-1" style={{ height: 3, borderRadius: 999,
                         background: 'var(--bg-raised)' }}>
                      <div style={{ width: `${Math.min(100, share)}%`, height: '100%',
                                    borderRadius: 999, background: BLEND_COLOUR }} />
                    </div>
                    {drifted != null && rebalanceMode !== 'daily'
                      && Math.abs(drifted - share) > 0.5 && (
                      <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-low)' }}>
                        drifts to {drifted.toFixed(1)}% by {to}
                      </div>
                    )}
                  </div>
                )
              })}
              {!sleeves.length && (
                <div className="text-xs" style={{ color: 'var(--text-low)' }}>
                  No components yet — add one below or load a preset.
                </div>
              )}
            </div>

            <select value="" onChange={e => add(e.target.value)}
                    className="w-full mt-3 px-2 py-1 rounded text-xs"
                    style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)',
                             color: 'var(--text-hi)', outline: 'none' }}>
              <option value="">+ Add component…</option>
              {available.map(b => (
                <option key={b.index_id} value={b.index_id}>{b.index_name}</option>
              ))}
            </select>

            <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
              <div className="text-xs font-semibold tabnum"
                   style={{ color: weightsOff ? 'var(--loss)' : 'var(--gain)' }}>
                Total {total.toFixed(1)}%
              </div>
              <div className="flex gap-1.5">
                <button onClick={normalise} className="pill text-[11px]"
                        title="Scale the weights so they add to 100">Normalise</button>
                <button onClick={equalise} className="pill text-[11px]"
                        title="Give every component the same weight">Equal</button>
              </div>
            </div>
            {weightsOff && (
              <div className="text-[11px] mt-1" style={{ color: 'var(--text-low)' }}>
                Weights are scaled to 100% for the calculation, so the chart is a
                valid portfolio either way — Normalise just makes the numbers say so.
              </div>
            )}
          </div>

          <div>
            <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-hi)' }}>
              Rebalancing
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ALL_FREQS.map(f => (
                <button key={f} onClick={() => setRebalance(f)}
                        className={`pill text-[11px]${rebalanceMode === f ? ' active' : ''}`}
                        style={pillStyle(rebalanceMode === f)}>
                  {REBALANCE_LABELS[f]}
                </button>
              ))}
            </div>
            <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-low)' }}>
              <b>Buy &amp; hold</b> never restores the mix, so the winner grows into
              a larger share — what an un-rebalanced portfolio actually does.
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-hi)' }}>
                Window
              </div>
              <div className="flex flex-wrap gap-1.5">
                {WINDOWS.map(w => (
                  <button key={w} onClick={() => setWindow(w)}
                          className={`pill text-[11px]${window === w ? ' active' : ''}`}
                          style={pillStyle(window === w)}>{w}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-hi)' }}>
                Fee on the blend
              </div>
              <div className="flex items-center gap-1.5">
                <input type="number" value={feePct} min={0} max={5} step={0.25}
                       onChange={e => setFeePct(Math.max(0, parseFloat(e.target.value) || 0))}
                       className="w-16 px-2 py-1 rounded text-xs text-right tabnum"
                       style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)',
                                color: 'var(--text-hi)', outline: 'none' }} />
                <span className="text-xs" style={{ color: 'var(--text-mid)' }}>% a year</span>
              </div>
            </div>
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-low)', marginTop: -8 }}>
            An index blend has no expense ratio. Charging one — try 1.0–2.0% for a
            regular-plan hybrid — is the only way the comparison against a category
            of real funds is fair.
          </div>

          <div>
            <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-hi)' }}>
              Compare against
            </div>
            <select value={compareCategory} onChange={e => setCompareCategory(e.target.value)}
                    className="w-full px-2 py-1 rounded text-xs mb-1.5"
                    style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)',
                             color: 'var(--text-hi)', outline: 'none' }}>
              {(meta?.categories ?? []).map(c => (
                <option key={c.slug} value={c.slug}>{c.category_name}</option>
              ))}
            </select>
            <select value={extraIndexId ?? ''}
                    onChange={e => setExtraIndexId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full px-2 py-1 rounded text-xs"
                    style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)',
                             color: 'var(--text-hi)', outline: 'none' }}>
              <option value="">+ Add an index to the chart…</option>
              {benchmarks.map(b => (
                <option key={b.index_id} value={b.index_id}>{b.index_name}</option>
              ))}
            </select>
          </div>

          <div>
            <button onClick={fitToCategory} className="w-full px-3 py-2 rounded text-xs font-semibold"
                    style={{ background: `${BLEND_COLOUR}1f`, color: BLEND_COLOUR,
                             border: `1px solid ${BLEND_COLOUR}` }}>
              Fit weights to {catName}
            </button>
            <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-low)' }}>
              {fitNote ?? 'Solves for the mix of the components above that best '
                + 'explains this category’s monthly returns — the allocation its funds '
                + 'have behaved like, as opposed to the one their mandate allows.'}
            </div>
          </div>

          <div className="border-t pt-3" style={{ borderColor: 'var(--line)' }}>
            <div className="text-xs font-semibold mb-1.5" style={{ color: 'var(--text-hi)' }}>
              Presets
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map(p => (
                <button key={p.label} onClick={() => applyPreset(p)} className="pill text-[11px]">
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Analysis ────────────────────────────────────────────────────── */}
        <div className="xl:col-span-3 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="tab-bar">
              {VIEWS.map(([id, label]) => (
                <button key={id} onClick={() => setView(id)}
                        className={`tab-btn${view === id ? ' active' : ''}`}
                        style={view === id
                          ? { color: BLEND_COLOUR, background: `${BLEND_COLOUR}1f` }
                          : undefined}>
                  {label}
                </button>
              ))}
            </div>
            <div className="text-[11px] tabnum" style={{ color: 'var(--text-low)' }}>
              {from && to ? `${from} → ${to}` : '—'}
              {blendStats.months ? ` · ${blendStats.months} months` : ''}
              {` · ${REBALANCE_LABELS[rebalanceMode].toLowerCase()}`}
              {feePct ? ` · ${feePct.toFixed(2)}% fee` : ''}
            </div>
          </div>

          {catLoading || !ready ? (
            <div className="card p-4"><div className="skeleton w-full" style={{ height: 320 }} /></div>
          ) : catError ? (
            <div className="card p-8 text-center text-xs" style={{ color: 'var(--loss)' }}>
              Could not load {catName}: {catError}
            </div>
          ) : !growth ? (
            <div className="card p-8 text-center text-xs" style={{ color: 'var(--text-mid)' }}>
              No window where every component and the category all have data. Try
              Max, or remove the newest component.
            </div>
          ) : (
            <>
              {view === 'overview' && (
                <>
                  <div className="card p-4">
                    <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-hi)' }}>
                      Growth, rebased to 0%
                    </div>
                    <ReactECharts option={growth} style={{ height: 300 }} notMerge lazyUpdate
                                  opts={{ renderer: 'svg' }} />
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="card overflow-hidden">
                      <div className="px-4 py-2.5 border-b text-xs font-semibold"
                           style={{ borderColor: 'var(--line)', color: 'var(--text-hi)' }}>
                        Measures
                      </div>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th className="text-left" style={{ minWidth: 130 }}>Measure</th>
                            <th className="ret-cell" style={{ color: BLEND_COLOUR }}>Your blend</th>
                            <th className="ret-cell">{catName}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {measures.map(m => {
                            let win: 'blend' | 'cat' | null = null
                            if (m.dir && m.raw && m.raw[0] != null && m.raw[1] != null) {
                              win = (m.dir === 'up' ? m.raw[0] > m.raw[1] : m.raw[0] < m.raw[1])
                                ? 'blend' : 'cat'
                            }
                            return (
                              <tr key={m.label}>
                                <td className="text-left text-xs" title={m.hint}>
                                  {m.label}
                                  <span className="ml-1" style={{ color: 'var(--text-low)' }}>ⓘ</span>
                                </td>
                                <td className="ret-cell tabnum"
                                    style={{ fontWeight: win === 'blend' ? 700 : 500,
                                             color: win === 'blend' ? 'var(--gain)' : 'var(--text-hi)' }}>
                                  {m.blend}
                                </td>
                                <td className="ret-cell tabnum"
                                    style={{ fontWeight: win === 'cat' ? 700 : 500,
                                             color: win === 'cat' ? 'var(--gain)' : 'var(--text-mid)' }}>
                                  {m.cat}
                                </td>
                              </tr>
                            )
                          })}
                          <tr>
                            <td colSpan={3} className="text-left text-[11px] py-2"
                                style={{ color: 'var(--text-low)',
                                         borderTop: '1px solid var(--line)' }}>
                              Relative to the category average
                            </td>
                          </tr>
                          {relative.map(m => (
                            <tr key={m.label}>
                              <td className="text-left text-xs" title={m.hint}>
                                {m.label}
                                <span className="ml-1" style={{ color: 'var(--text-low)' }}>ⓘ</span>
                              </td>
                              <td className="ret-cell tabnum" style={{ color: 'var(--text-hi)' }}>
                                {m.blend}
                              </td>
                              <td className="ret-cell tabnum" style={{ color: 'var(--text-low)' }}>
                                {m.cat}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {blendStats.months < 30 && blendStats.months > 0 && (
                        <div className="px-4 py-2 text-[11px]"
                             style={{ color: 'var(--text-low)',
                                      borderTop: '1px solid var(--line)' }}>
                          {blendStats.months} monthly observations. Risk Lab requires 30
                          before showing these for a fund; below that they are
                          indicative, not settled.
                        </div>
                      )}
                    </div>

                    <div className="card overflow-hidden">
                      <div className="px-4 py-2.5 border-b text-xs font-semibold"
                           style={{ borderColor: 'var(--line)', color: 'var(--text-hi)' }}>
                        Calendar years
                      </div>
                      <div className="table-scroll" style={{ ['--table-max-h' as string]: '360px' }}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th className="text-left">Year</th>
                              <th className="ret-cell" style={{ color: BLEND_COLOUR }}>Blend</th>
                              <th className="ret-cell">{catName}</th>
                              <th className="ret-cell">Diff</th>
                            </tr>
                          </thead>
                          <tbody>
                            {years.map(y => {
                              const d = y.blend && y.cat ? y.blend.ret - y.cat.ret : null
                              return (
                                <tr key={y.year}>
                                  <td className="text-left text-xs">
                                    {y.year}
                                    {(y.blend?.partial || y.cat?.partial) && (
                                      <span className="ml-1" style={{ color: 'var(--text-low)' }}>
                                        part
                                      </span>
                                    )}
                                  </td>
                                  <td className={`ret-cell ${retColor(y.blend?.ret ?? null)}`}>
                                    {y.blend ? fmtPct(y.blend.ret) : '—'}
                                  </td>
                                  <td className={`ret-cell ${retColor(y.cat?.ret ?? null)}`}>
                                    {y.cat ? fmtPct(y.cat.ret) : '—'}
                                  </td>
                                  <td className="ret-cell">
                                    {d != null && (
                                      <span className={`spread-chip ${d >= 0 ? 'pos' : 'neg'}`}>
                                        {d >= 0 ? '+' : ''}{(d * 100).toFixed(1)}%
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </>
              )}

              {view === 'allocation' && (
                <>
                  <FrontierPanel frontier={front}
                                 labels={liveSleeves.map(s => s.index_name)}
                                 onApply={applyWeights} />
                  <ContributionPanel rows={contrib.rows} totalReturn={contrib.totalReturn}
                                     totalVol={contrib.totalVol} realisedVol={blendStats.vol} />
                  <CorrelationPanel matrix={corr} />
                </>
              )}

              {view === 'risk' && (
                <>
                  <div className="card p-4">
                    <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-hi)' }}>
                      Drawdown from peak
                    </div>
                    <div className="text-[11px] mb-1" style={{ color: 'var(--text-low)' }}>
                      How far below its own high-water mark each line sat on any day —
                      the depth a client has to sit through, which an annual return hides.
                    </div>
                    {under && (
                      <ReactECharts option={under} style={{ height: 220 }} notMerge lazyUpdate
                                    opts={{ renderer: 'svg' }} />
                    )}
                  </div>
                  <EpisodePanel episodes={episodes} />
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <DistributionPanel dist={dist} refLabel={catName} />
                    <RebalancePanel rows={rebalRows} active={rebalanceMode}
                                    onPick={setRebalance} />
                  </div>
                </>
              )}

              {view === 'rolling' && (
                <RollingPanel points={roll.points} windowMonths={roll.windowMonths}
                              metric={rollMetric} refLabel={`${catName} average`}
                              onMetric={setRollMetric} onWindow={setRollWindow} />
              )}

              {view === 'seasonality' && (
                <>
                  <HeatmapPanel grid={grid} />
                  <StressPanel rows={stress} refLabel={`${catName} avg`} />
                </>
              )}

              <div className="text-[11px]" style={{ color: 'var(--text-low)' }}>
                A blend is a hypothetical portfolio of index closes.
                {feePct
                  ? ` A ${feePct.toFixed(2)}% annual fee is charged against it above, but it still carries no tracking difference or cash drag.`
                  : ' It carries no expense ratio, no tracking difference and no cash drag, so it is not investable and will read better than any fund following it — set a fee on the left to close most of that gap.'}
                {' '}Stored category benchmarks are configured in the pipeline, not here.
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
