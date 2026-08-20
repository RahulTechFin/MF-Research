// src/sections/FundScreener.tsx — Section 4: Fund Screener (main returns table) + dynamic Leaders & Laggards

import { useState, useEffect } from 'react'
import { useMeta, useCategoryTable } from '../hooks/useData'
import { fmtPct, heatmapClass, retColor, assetClassColor } from '../utils/format'
import { ALL_SECTORS, SECTORAL_THEMATIC_SLUG, sectorOf, sectorOptions } from '../utils/sectors'
import type { ViewType, AssetClass } from '../types'

const VIEWS: { key: ViewType; label: string }[] = [
  { key: 'trailing',  label: 'Trailing' },
  { key: 'monthly',   label: 'Monthly' },
  { key: 'quarterly', label: 'Quarterly' },
  { key: 'annual',    label: 'Annual' },
]

const ASSET_CLASSES: AssetClass[] = ['Equity', 'Hybrid', 'Debt', 'Other']

// Trailing periods offered by Leaders & Laggards. 3Y and 5Y are annualised in the
// engine, so a fund's number here is a CAGR rather than a cumulative return —
// which is what makes them comparable with the shorter periods beside them.
const MOVER_PERIODS = ['1M', '3M', '6M', '12M', '3Y', '5Y']

/**
 * How return cells are coloured.
 *
 * 'none' keeps the plain heat map: each cell shaded by its own magnitude.
 * 'benchmark' and 'category' re-base the colour on a comparison instead, so a
 * 9% return reads green or red depending on what it was up against rather than
 * on how large it is.
 */
type CompareMode = 'none' | 'benchmark' | 'category'

// The heat map is the resting state, not a choice: there is no button for it.
// Ticking a comparison replaces it; clicking the active comparison again turns it
// off and the heat map returns.
const COMPARE_MODES: { key: Exclude<CompareMode, 'none'>; label: string; hint: string }[] = [
  { key: 'benchmark', label: 'vs Benchmark',
    hint: 'Green above the benchmark for that period, red below. Click again for the heat map.' },
  { key: 'category',  label: 'vs Category Avg',
    hint: 'Arrow up or down against the category average. Click again for the heat map.' },
]

/** Ties in floating point are meaningless here; treat a hair's breadth as equal. */
const COMPARE_EPSILON = 1e-9

function formatPeriodHeader(pk: string): string {
  // YYYY-MM
  if (/^\d{4}-\d{2}$/.test(pk)) {
    const [y, m] = pk.split('-')
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const monthIdx = parseInt(m, 10) - 1
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${months[monthIdx]} ${y}`
    }
  }
  // Q#-YYYY, which is what build_json emits ("Q3-2024"). This used to test for
  // YYYY-Q# and so never matched, leaving the raw key on screen.
  const q = /^Q([1-4])-(\d{4})$/.exec(pk)
  if (q) return `Q${q[1]} ${q[2]}`
  return pk
}

/**
 * Chronological rank of a period column, newest highest.
 *
 * Sorting these keys as plain strings was wrong for quarters and only quarters.
 * "Q3-2024" puts the quarter BEFORE the year, so a descending string sort
 * compares the quarter digit first and interleaves the years:
 *
 *     QTD, Q4-2025, Q4-2024, Q3-2025, Q3-2024, Q2-2026, Q2-2025, Q1-2026, Q1-2025
 *
 * For a fund launched partway through, that reads as data, data, blank, data,
 * blank — which looks exactly like the engine failing to compute some quarters,
 * when in fact the columns were out of order. Monthly ("2025-08") and annual
 * ("2024") keys lead with the year, so they were never affected.
 */
function periodRank(pk: string): number {
  if (pk === 'MTD' || pk === 'QTD' || pk.startsWith('YTD')) return Number.MAX_SAFE_INTEGER
  const m = /^(\d{4})-(\d{2})$/.exec(pk)
  if (m) return Number(m[1]) * 100 + Number(m[2])
  const q = /^Q([1-4])-(\d{4})$/.exec(pk)
  if (q) return Number(q[2]) * 100 + Number(q[1]) * 3
  const y = /^(\d{4})$/.exec(pk)
  if (y) return Number(y[1]) * 100
  return -1
}

/**
 * One return cell, shaded by whichever comparison is selected.
 *
 * The three modes deliberately look different rather than all being red/green
 * fills: colour alone already carries the sign of the return in 'none' mode, so
 * re-using the same signal for "beat the benchmark" would be ambiguous. Benchmark
 * mode tints the cell and keeps a left edge; category mode leaves the cell alone
 * and adds an arrow, which also survives being read without colour.
 *
 * A missing comparison value (no benchmark for the category, no average for the
 * period) falls back to the plain heat map instead of inventing a verdict.
 */
function ReturnCell({ value, mode, benchmark, categoryAvg }: {
  value: number | null | undefined
  mode: CompareMode
  benchmark: number | null | undefined
  categoryAvg: number | null
}) {
  // The table's own type allows undefined for an absent period; the formatters
  // take null, so collapse the two here rather than at every call site.
  const v: number | null = value ?? null
  const ref: number | null =
    (mode === 'benchmark' ? benchmark : categoryAvg) ?? null

  if (v == null || mode === 'none' || ref == null) {
    return <td className={`ret-cell ${heatmapClass(v)} ${retColor(v)}`}>{fmtPct(v)}</td>
  }

  const diff = v - ref
  const flat = Math.abs(diff) < COMPARE_EPSILON
  const up = diff > 0
  const bps = `${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}%`

  if (mode === 'benchmark') {
    const tint = flat ? undefined
      : up ? 'rgba(52,211,153,0.14)' : 'rgba(248,113,113,0.14)'
    const edge = flat ? 'transparent' : up ? 'var(--gain)' : 'var(--loss)'
    return (
      <td className="ret-cell tabnum"
          title={`${fmtPct(v)} vs benchmark ${fmtPct(ref)} (${bps})`}
          style={{ background: tint, boxShadow: `inset -3px 0 0 ${edge}`,
                   color: flat ? 'var(--text-mid)'
                              : up ? 'var(--gain)' : 'var(--loss)',
                   fontWeight: flat ? undefined : 600 }}>
        {fmtPct(v)}
      </td>
    )
  }

  return (
    <td className="ret-cell tabnum"
        title={`${fmtPct(v)} vs category average ${fmtPct(ref)} (${bps})`}>
      <span style={{ color: retColorValue(v) }}>{fmtPct(v)}</span>
      {!flat && (
        <span aria-hidden style={{ marginLeft: 4, fontSize: 10, fontWeight: 700,
                                   color: up ? 'var(--gain)' : 'var(--loss)' }}>
          {up ? '▲' : '▼'}
        </span>
      )}
    </td>
  )
}

/** The colour retColor() would apply, as a value rather than a class. */
function retColorValue(v: number | null | undefined): string {
  if (v == null) return 'var(--text-low)'
  if (v > 0) return 'var(--gain)'
  if (v < 0) return 'var(--loss)'
  return 'var(--text-mid)'
}

interface MoversProps {
  filteredFunds: any[]
  categoryAvg: (pk: string) => number | null
}

function LeadersLaggards({ filteredFunds, categoryAvg }: MoversProps) {
  const [period, setPeriod] = useState('12M')

  // Calculate top/bottom performers dynamically from screener list
  const periodData = filteredFunds
    .map(f => ({
      scheme_code: f.scheme_code,
      scheme_name: f.scheme_name,
      return: f.returns[period] as number | null,
    }))
    .filter(f => f.return !== null && f.return !== undefined) as { scheme_code: string; scheme_name: string; return: number }[]

  // Sort descending for top performers
  const topSorted = [...periodData].sort((a, b) => b.return - a.return)
  const avgVal = categoryAvg(period)

  const top10 = topSorted.slice(0, 10).map((f, idx) => ({
    rank: idx + 1,
    scheme_code: f.scheme_code,
    scheme_name: f.scheme_name,
    return: f.return,
    spread_vs_avg: avgVal !== null ? (f.return - avgVal) : null,
  }))

  // Sort ascending for underperformers (worst returns first)
  const bottomSorted = [...periodData].sort((a, b) => a.return - b.return)
  const bottom10 = bottomSorted.slice(0, 10).map((f, idx) => ({
    rank: idx + 1,
    scheme_code: f.scheme_code,
    scheme_name: f.scheme_name,
    return: f.return,
    spread_vs_avg: avgVal !== null ? (f.return - avgVal) : null,
  }))

  return (
    <div className="mt-6">
      <div className="section-header">Leaders &amp; Laggards</div>
      <div className="flex gap-2 mb-4 items-center flex-wrap">
        {MOVER_PERIODS.map(p => {
          // A period with nothing behind it is offered but disabled rather than
          // hidden, so the row of choices does not shift as categories change —
          // and so an empty 5Y reads as "no fund is old enough" instead of
          // looking like a missing feature.
          const n = filteredFunds.filter(
            f => f.returns[p] !== null && f.returns[p] !== undefined).length
          return (
            <button key={p} onClick={() => n > 0 && setPeriod(p)}
              disabled={n === 0}
              title={n === 0 ? `No fund in this category has a ${p} return yet`
                             : `${n} fund(s) with a ${p} return`}
              className={`pill${period === p ? ' active' : ''}`}
              style={n === 0 ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}>
              {p}
            </button>
          )
        })}
        {periodData.length === 0 && (
          <span className="text-xs" style={{ color: 'var(--text-low)' }}>
            No fund in this selection has a {period} return.
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Top 10 winners */}
        <div className="card overflow-hidden">
          <div className="px-4 py-2 font-semibold text-sm flex items-center gap-2"
            style={{ background: 'var(--bg-hover)', borderBottom: '1px solid var(--line)', color: 'var(--gain)' }}>
            ⬆ Top 10 Performers
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>#</th><th className="text-left">Fund</th><th className="ret-cell">Return</th><th className="ret-cell">vs Avg</th></tr></thead>
              <tbody key={period} className="rows-enter">
                {top10.map(r => (
                  <tr key={r.scheme_code}>
                    <td className="text-xs" style={{ color: 'var(--text-low)' }}>{r.rank}</td>
                    <td className="font-medium text-xs max-w-xs truncate" style={{ color: 'var(--text-hi)' }}>{r.scheme_name}</td>
                    <td className={`ret-cell ${retColor(r.return)}`}>{fmtPct(r.return)}</td>
                    <td className="ret-cell">
                      {r.spread_vs_avg != null && (
                        <span className={`spread-chip ${r.spread_vs_avg >= 0 ? 'pos' : 'neg'}`}>
                          {r.spread_vs_avg >= 0 ? '+' : ''}{(r.spread_vs_avg * 100).toFixed(1)}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {top10.length === 0 && (
                  <tr><td colSpan={4} className="text-center py-4" style={{ color: 'var(--text-low)' }}>No data available for this period.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Top 10 losers */}
        <div className="card overflow-hidden">
          <div className="px-4 py-2 font-semibold text-sm flex items-center gap-2"
            style={{ background: 'var(--bg-hover)', borderBottom: '1px solid var(--line)', color: 'var(--loss)' }}>
            ⬇ Top 10 Underperformers
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>#</th><th className="text-left">Fund</th><th className="ret-cell">Return</th><th className="ret-cell">vs Avg</th></tr></thead>
              <tbody key={period} className="rows-enter">
                {bottom10.map(r => (
                  <tr key={r.scheme_code}>
                    <td className="text-xs" style={{ color: 'var(--text-low)' }}>{r.rank}</td>
                    <td className="font-medium text-xs max-w-xs truncate" style={{ color: 'var(--text-hi)' }}>{r.scheme_name}</td>
                    <td className={`ret-cell ${retColor(r.return)}`}>{fmtPct(r.return)}</td>
                    <td className="ret-cell">
                      {r.spread_vs_avg != null && (
                        <span className={`spread-chip ${r.spread_vs_avg >= 0 ? 'pos' : 'neg'}`}>
                          {r.spread_vs_avg >= 0 ? '+' : ''}{(r.spread_vs_avg * 100).toFixed(1)}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
                {bottom10.length === 0 && (
                  <tr><td colSpan={4} className="text-center py-4" style={{ color: 'var(--text-low)' }}>No data available for this period.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

interface Props {
  selectedFunds: string[]
  onToggleFund: (code: string) => void
  /** A fund chosen from the Ctrl+S search; the table jumps to it. */
  focusFund?: { code: string; name: string; slug: string; asset_class: string } | null
  onFocusHandled?: () => void
}

export default function FundScreener({ selectedFunds, onToggleFund,
                                       focusFund, onFocusHandled }: Props) {
  const { data: meta } = useMeta()
  const [activeAsset, setActiveAsset] = useState<AssetClass>('Equity')
  const [view, setView]               = useState<ViewType>('trailing')
  const [activeSlug, setActiveSlug]   = useState<string>('')
  // Replaces a "🏢 AMC Mode" toggle that was wired to state but never read
  // anywhere — it changed nothing when clicked.
  const [compare, setCompare]         = useState<CompareMode>('none')
  const [selectedSector, setSelectedSector] = useState<string>(ALL_SECTORS)
  // Name filter, typed here or handed over by the Ctrl+S search.
  const [nameFilter, setNameFilter] = useState('')
  // The code to highlight once, right after a search pick.
  const [highlight, setHighlight] = useState<string | null>(null)

  const categories = (meta?.categories ?? []).filter(c => c.asset_class === activeAsset)

  // Set first slug when asset/categories change
  const slug = activeSlug || (categories[0]?.slug ?? '')

  const { data: tableData, loading } = useCategoryTable(slug, view)

  // Reset sector sub-filter when active category slug changes
  useEffect(() => {
    setSelectedSector(ALL_SECTORS)
  }, [slug])

  // Honour a pick from the Ctrl+S search: move to the fund's asset class and
  // category, narrow the table to its name, and scroll it into view. The parent
  // is told once so re-renders do not keep re-applying it and fighting the user.
  useEffect(() => {
    if (!focusFund) return
    setActiveAsset(focusFund.asset_class as AssetClass)
    setActiveSlug(focusFund.slug)
    setSelectedSector(ALL_SECTORS)
    setNameFilter(focusFund.name)
    setHighlight(focusFund.code)
    onFocusHandled?.()
    // The row does not exist until the category table has loaded, so the scroll
    // is attempted after paint and again shortly after.
    const scroll = () => document
      .getElementById(`fund-row-${focusFund.code}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    requestAnimationFrame(scroll)
    const t = setTimeout(scroll, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusFund])

  const isSectoral = slug === SECTORAL_THEMATIC_SLUG
  const sectorOpts = isSectoral ? sectorOptions(tableData?.funds ?? []) : []

  // Filter sectoral/thematic funds if chosen
  const nameNeedle = nameFilter.trim().toLowerCase()
  const filteredFunds = tableData?.funds.filter(fund => {
    if (nameNeedle && !fund.scheme_name.toLowerCase().includes(nameNeedle)) return false
    if (!isSectoral || selectedSector === ALL_SECTORS) return true
    return sectorOf(fund) === selectedSector
  }) ?? []

  // Dynamic category average calculator based on sub-category selector
  const getCategoryAvgForPeriod = (pk: string): number | null => {
    if (isSectoral && selectedSector !== ALL_SECTORS) {
      const vals = filteredFunds.map(f => f.returns[pk]).filter(v => v !== null) as number[]
      return vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length) : null
    }
    return tableData?.category_avg[pk] ?? null
  }

  // Sorting columns descending (latest first) for quarterly, annual, and monthly views
  const sortedPeriodKeys = [...(tableData?.period_keys ?? [])]
  if (view !== 'trailing') {
    sortedPeriodKeys.sort((a, b) => periodRank(b) - periodRank(a))
  }

  const categoryInfo = meta?.categories.find(c => c.slug === slug)
  const benchmarkName = categoryInfo?.benchmark_name || 'Benchmark Index'

  return (
    <section id="fund-screener" className="px-6 py-6 max-w-screen-2xl mx-auto">
      <div className="section-header">Fund Screener</div>

      {/* Level 1: Asset class tabs */}
      <div className="tab-bar mb-3">
        {ASSET_CLASSES.map(ac => (
          <button key={ac} onClick={() => { setActiveAsset(ac); setActiveSlug('') }}
            className={`tab-btn${activeAsset === ac ? ` active ${ac.toLowerCase()}` : ''}`}>
            {ac}
          </button>
        ))}
      </div>

      {/* Level 2: Sub-category pills */}
      <div className="flex gap-2 flex-wrap mb-4">
        {categories.map(cat => (
          <button key={cat.slug} onClick={() => setActiveSlug(cat.slug)}
            className={`pill${(activeSlug || categories[0]?.slug) === cat.slug ? ' active' : ''}`}>
            {cat.category_name}
          </button>
        ))}
      </div>

      {/* Sector Sub-filter dropdown for Sectoral/Thematic category */}
      {isSectoral && (
        <div className="flex items-center gap-2 mb-4 bg-[var(--bg-card)] p-3 rounded-lg border border-[var(--line)] flex-wrap">
          <span className="text-xs font-semibold" style={{ color: 'var(--text-mid)' }}>Filter by Sector:</span>
          <select
            value={selectedSector}
            onChange={e => setSelectedSector(e.target.value)}
            className="px-3 py-1.5 rounded-lg text-sm"
            style={{
              background: 'var(--bg-raised)',
              border: '1px solid var(--line)',
              color: 'var(--text-hi)',
              outline: 'none',
            }}
          >
            {sectorOpts.map(({ sector, count }) => (
              <option key={sector} value={sector}>{sector} ({count})</option>
            ))}
          </select>
          <span className="text-[11px]" style={{ color: 'var(--text-low)' }}>
            AMFI files every theme under one category — the sub-category is read from the scheme name.
          </span>
        </div>
      )}

      {/* View selector + AMC toggle */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="tab-bar">
          {VIEWS.map(v => (
            <button key={v.key} onClick={() => setView(v.key)}
              className={`tab-btn${view === v.key ? ' active accent' : ''}`}>
              {v.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Visible so a filter applied by the Ctrl+S search can be seen and
              cleared — a narrowed table with no explanation reads as missing data. */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded"
               style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                 stroke="var(--text-low)" strokeWidth="2">
              <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
            </svg>
            <input
              value={nameFilter}
              onChange={e => { setNameFilter(e.target.value); setHighlight(null) }}
              placeholder="Filter by name (Ctrl+S to search all)"
              style={{ background: 'transparent', border: 'none', outline: 'none',
                       color: 'var(--text-hi)', fontSize: 12, width: 210 }}
            />
            {nameFilter && (
              <button onClick={() => { setNameFilter(''); setHighlight(null) }}
                      title="Clear the name filter"
                      style={{ background: 'none', border: 'none', cursor: 'pointer',
                               color: 'var(--text-low)', fontSize: 14, lineHeight: 1 }}>
                ×
              </button>
            )}
          </div>
          <span className="text-[11px] uppercase tracking-wider"
                style={{ color: 'var(--text-low)' }}
                title="With neither selected, returns are shaded by their own size (heat map)">
            Compare
          </span>
          {COMPARE_MODES.map(m => (
            <button key={m.key} title={m.hint}
              onClick={() => setCompare(compare === m.key ? 'none' : m.key)}
              className={`amc-toggle${compare === m.key ? ' active' : ''}`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main table */}
      <div className="card overflow-hidden" id={`cat-${slug}`}>
        {loading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton h-8 w-full" />
            ))}
          </div>
        ) : tableData ? (
          <div className="overflow-x-auto">
            <div className="px-4 py-2 flex items-center justify-between border-b" style={{ borderColor: 'var(--line)', background: 'var(--bg-raised)' }}>
              <span className="font-semibold text-sm" style={{ color: assetClassColor(tableData.asset_class) }}>
                {tableData.category_name} {isSectoral && selectedSector !== ALL_SECTORS && ` — ${selectedSector}`}
              </span>
              <span className="text-xs" style={{ color: 'var(--text-low)' }}>
                {filteredFunds.length} funds · Data as of {tableData.as_of}
              </span>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 45, textAlign: 'center' }}>Select</th>
                  <th className="sticky-col text-left" style={{ minWidth: 260 }}>Fund Name</th>
                  <th style={{ minWidth: 100 }}>AMC</th>
                  {sortedPeriodKeys.map(pk => (
                    <th key={pk} className="ret-cell">{formatPeriodHeader(pk)}</th>
                  ))}
                </tr>
              </thead>
              <tbody key={`${activeSlug}-${view}`} className="rows-enter">
                {filteredFunds.map(fund => (
                  <tr key={fund.scheme_code} id={`fund-row-${fund.scheme_code}`}
                      style={fund.scheme_code === highlight
                        ? { boxShadow: 'inset 0 0 0 2px var(--accent-a)' }
                        : undefined}>
                    {/* Checkbox column */}
                    <td className="text-center" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedFunds.includes(fund.scheme_code)}
                        onChange={() => onToggleFund(fund.scheme_code)}
                        disabled={!selectedFunds.includes(fund.scheme_code) && selectedFunds.length >= 5}
                        className="cursor-pointer"
                      />
                    </td>
                    <td className="sticky-col font-medium text-xs" style={{ maxWidth: 260 }}>
                      <div className="truncate">{fund.scheme_name}</div>
                    </td>
                    <td className="text-xs" style={{ color: 'var(--text-mid)' }}>{fund.amc_name}</td>
                    {sortedPeriodKeys.map(pk => (
                      <ReturnCell key={pk} value={fund.returns[pk]} mode={compare}
                                  benchmark={tableData.benchmark[pk]}
                                  categoryAvg={getCategoryAvgForPeriod(pk)} />
                    ))}
                  </tr>
                ))}
                {filteredFunds.length === 0 && (
                  <tr>
                    <td colSpan={3 + sortedPeriodKeys.length} className="text-center p-8" style={{ color: 'var(--text-mid)' }}>
                      No funds found matching this category filter.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                {/* Pinned: Benchmark */}
                <tr className="pinned-row">
                  <td />
                  <td className="sticky-col text-xs font-bold" style={{ color: 'var(--accent-a)' }}>
                    📈 Benchmark Index: {benchmarkName}
                  </td>
                  <td />
                  {sortedPeriodKeys.map(pk => {
                    const v = tableData.benchmark[pk]
                    return (
                      <td key={pk} className={`ret-cell ${retColor(v)}`}>{fmtPct(v)}</td>
                    )
                  })}
                </tr>
                {/* Pinned: Category average */}
                <tr className="pinned-row">
                  <td />
                  <td className="sticky-col text-xs font-bold" style={{ color: 'var(--text-mid)' }}>
                    ∑ Category Average
                  </td>
                  <td />
                  {sortedPeriodKeys.map(pk => {
                    const v = getCategoryAvgForPeriod(pk)
                    return (
                      <td key={pk} className={`ret-cell ${retColor(v)}`}>{fmtPct(v)}</td>
                    )
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center" style={{ color: 'var(--text-mid)' }}>
            No data available for this category yet. Run the backfill first.
          </div>
        )}
      </div>

      {/* Dynamic Leaders & Laggards */}
      {slug && <LeadersLaggards filteredFunds={filteredFunds} categoryAvg={getCategoryAvgForPeriod} />}
    </section>
  )
}
