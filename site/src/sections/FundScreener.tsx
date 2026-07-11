// src/sections/FundScreener.tsx — Section 4: Fund Screener (main returns table) + dynamic Leaders & Laggards

import { useState, useEffect } from 'react'
import { useMeta, useCategoryTable } from '../hooks/useData'
import { fmtPct, heatmapClass, retColor, assetClassColor } from '../utils/format'
import type { ViewType, AssetClass } from '../types'

const VIEWS: { key: ViewType; label: string }[] = [
  { key: 'trailing',  label: 'Trailing' },
  { key: 'monthly',   label: 'Monthly' },
  { key: 'quarterly', label: 'Quarterly' },
  { key: 'annual',    label: 'Annual' },
]

const ASSET_CLASSES: AssetClass[] = ['Equity', 'Hybrid', 'Debt', 'Other']

const MOVER_PERIODS = ['1M', '3M', '6M', '12M']

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
  // YYYY-Q#
  if (/^\d{4}-Q[1-4]$/.test(pk)) {
    const [y, q] = pk.split('-')
    return `${q} ${y}`
  }
  return pk
}

const SECTORS = [
  'All Sectors',
  'Financial Services & Banking',
  'Healthcare & Pharma',
  'Technology & Telecom',
  'Infrastructure & Realty',
  'Consumption & FMCG',
  'PSE & CPSE',
  'MNC',
  'Metal & Commodities',
  'Energy & Utilities',
  'Thematic - Other (Defence, Railways, Auto)',
  'Other Sectoral / Thematic'
]

function getSectorOfFund(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('bank') || n.includes('finan') || n.includes('fsi') || n.includes('pru bank')) return 'Financial Services & Banking'
  if (n.includes('healthcare') || n.includes('pharma') || n.includes('health') || n.includes('medical') || n.includes('biotech')) return 'Healthcare & Pharma'
  if (n.includes('tech') || n.includes('it ') || n.includes('digital') || n.includes('telecom') || n.includes('software') || n.includes('internet')) return 'Technology & Telecom'
  if (n.includes('infra') || n.includes('realty') || n.includes('housing') || n.includes('real estate') || n.includes('construct')) return 'Infrastructure & Realty'
  if (n.includes('consumption') || n.includes('fmcg') || n.includes('consumer') || n.includes('retail') || n.includes('brand')) return 'Consumption & FMCG'
  if (n.includes('pse') || n.includes('psu') || n.includes('public sector')) return 'PSE & CPSE'
  if (n.includes('mnc') || n.includes('multinational')) return 'MNC'
  if (n.includes('metal') || n.includes('commodit') || n.includes('resource') || n.includes('material')) return 'Metal & Commodities'
  if (n.includes('energy') || n.includes('power') || n.includes('utility') || n.includes('utilities')) return 'Energy & Utilities'
  if (n.includes('defence') || n.includes('railway') || n.includes('transport') || n.includes('mobility') || n.includes('auto')) return 'Thematic - Other (Defence, Railways, Auto)'
  return 'Other Sectoral / Thematic'
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
      <div className="flex gap-2 mb-4">
        {MOVER_PERIODS.map(p => (
          <button key={p} onClick={() => setPeriod(p)}
            className={`pill${period === p ? ' active' : ''}`}>{p}</button>
        ))}
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
              <tbody>
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
              <tbody>
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
}

export default function FundScreener({ selectedFunds, onToggleFund }: Props) {
  const { data: meta } = useMeta()
  const [activeAsset, setActiveAsset] = useState<AssetClass>('Equity')
  const [view, setView]               = useState<ViewType>('trailing')
  const [activeSlug, setActiveSlug]   = useState<string>('')
  const [amcMode, setAmcMode]         = useState(false)
  const [selectedSector, setSelectedSector] = useState('All Sectors')

  const categories = (meta?.categories ?? []).filter(c => c.asset_class === activeAsset)

  // Set first slug when asset/categories change
  const slug = activeSlug || (categories[0]?.slug ?? '')

  const { data: tableData, loading } = useCategoryTable(slug, view)

  // Reset sector sub-filter when active category slug changes
  useEffect(() => {
    setSelectedSector('All Sectors')
  }, [slug])

  // Filter sectoral/thematic funds if chosen
  const filteredFunds = tableData?.funds.filter(fund => {
    if (slug !== 'sectoral-thematic' || selectedSector === 'All Sectors') return true
    return getSectorOfFund(fund.scheme_name) === selectedSector
  }) ?? []

  // Dynamic category average calculator based on sub-category selector
  const getCategoryAvgForPeriod = (pk: string): number | null => {
    if (slug === 'sectoral-thematic' && selectedSector !== 'All Sectors') {
      const vals = filteredFunds.map(f => f.returns[pk]).filter(v => v !== null) as number[]
      return vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length) : null
    }
    return tableData?.category_avg[pk] ?? null
  }

  // Sorting columns descending (latest first) for quarterly, annual, and monthly views
  const sortedPeriodKeys = [...(tableData?.period_keys ?? [])]
  if (view !== 'trailing') {
    sortedPeriodKeys.sort((a, b) => b.localeCompare(a))
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
      {slug === 'sectoral-thematic' && (
        <div className="flex items-center gap-2 mb-4 bg-[var(--bg-card)] p-3 rounded-lg border border-[var(--line)]">
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
            {SECTORS.map(sec => (
              <option key={sec} value={sec}>{sec}</option>
            ))}
          </select>
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
        <button onClick={() => setAmcMode(!amcMode)}
          className={`amc-toggle${amcMode ? ' active' : ''}`}>
          {amcMode ? '← Category Mode' : '🏢 AMC Mode'}
        </button>
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
                {tableData.category_name} {slug === 'sectoral-thematic' && selectedSector !== 'All Sectors' && ` — ${selectedSector}`}
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
              <tbody>
                {filteredFunds.map(fund => (
                  <tr key={fund.scheme_code}>
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
                    {sortedPeriodKeys.map(pk => {
                      const v = fund.returns[pk]
                      return (
                        <td key={pk} className={`ret-cell ${heatmapClass(v)} ${retColor(v)}`}>
                          {fmtPct(v)}
                        </td>
                      )
                    })}
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
