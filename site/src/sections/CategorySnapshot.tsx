// src/sections/CategorySnapshot.tsx — Section 2: Category Snapshot table

import { useState } from 'react'
import { useGlance } from '../hooks/useData'
import { fmtPct, heatmapClass, retColor, assetClassColor } from '../utils/format'
import type { ViewType } from '../types'

const VIEWS: { key: ViewType; label: string }[] = [
  { key: 'trailing',  label: 'Trailing' },
  { key: 'monthly',   label: 'Monthly' },
  { key: 'quarterly', label: 'Quarterly' },
  { key: 'annual',    label: 'Annual' },
]

const ASSET_ORDER = ['Equity', 'Hybrid', 'Debt', 'Other']

interface Props {
  selectedCategories: string[]
  onToggleCategory: (slug: string) => void
}

export default function CategorySnapshot({ selectedCategories, onToggleCategory }: Props) {
  const [view, setView] = useState<ViewType>('trailing')
  const [showBenchmark, setShowBenchmark] = useState(false)
  // Slug of the category whose theme breakdown is open. One at a time: with 22
  // themes, two expanded rows push everything else off the screen.
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data, loading } = useGlance(view)

  const grouped = data
    ? ASSET_ORDER.map(ac => ({
        ac,
        rows: data.rows.filter(r => r.asset_class === ac),
      })).filter(g => g.rows.length > 0)
    : []

  return (
    <section id="category-snapshot" className="px-6 py-6 max-w-screen-2xl mx-auto">
      <div className="section-header">Category Snapshot</div>

      {/* Controls */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="tab-bar">
          {VIEWS.map(v => (
            <button key={v.key} onClick={() => setView(v.key)}
              className={`tab-btn${view === v.key ? ' active accent' : ''}`}>
              {v.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowBenchmark(!showBenchmark)}
          className={`amc-toggle${showBenchmark ? ' active' : ''}`}>
          Compare to Benchmark {showBenchmark ? '▴' : '▾'}
        </button>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {loading ? (
          <div className="p-8 text-center" style={{ color: 'var(--text-mid)' }}>
            <div className="skeleton w-full h-6 mb-2" />
            <div className="skeleton w-full h-6 mb-2" />
            <div className="skeleton w-3/4 h-6" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 45, textAlign: 'center' }}>Select</th>
                  <th className="sticky-col text-left" style={{ minWidth: 220 }}>Category</th>
                  <th style={{ minWidth: 60 }}>Funds</th>
                  {(data?.rows[0]?.periods ?? []).map(p => (
                    <th key={String(p)} className="ret-cell">{String(p)}</th>
                  ))}
                </tr>
              </thead>
              <tbody key={view} className="rows-enter">
                {grouped.map(({ ac, rows }) => (
                  <Fragment key={ac}>
                    {/* Asset class header row */}
                    <tr>
                      <td colSpan={100}
                        className="sticky-col py-1.5 px-4 text-xs font-bold uppercase tracking-widest"
                        style={{ color: assetClassColor(ac), background: 'var(--bg-raised)', borderLeft: `3px solid ${assetClassColor(ac)}` }}>
                        {ac}
                      </td>
                    </tr>
                    {rows.map(row => (
                      <Fragment key={row.slug}>
                        <tr
                          className="cursor-pointer"
                          onClick={() => {
                            onToggleCategory(row.slug)
                          }}>
                          {/* Checkbox column */}
                          <td className="text-center" onClick={e => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedCategories.includes(row.slug)}
                              onChange={() => onToggleCategory(row.slug)}
                              disabled={!selectedCategories.includes(row.slug) && selectedCategories.length >= 5}
                              className="cursor-pointer"
                            />
                          </td>
                          <td className="sticky-col font-medium" style={{ paddingLeft: '1.5rem', borderLeft: `3px solid ${assetClassColor(ac)}22` }}>
                            {/* A category with themes underneath gets a disclosure
                                control. Everything else keeps its plain label, so
                                the column does not sprout arrows it cannot use. */}
                            {row.sectors?.length ? (
                              <button
                                onClick={() => setExpanded(e =>
                                  e === row.slug ? null : row.slug)}
                                aria-expanded={expanded === row.slug}
                                title={expanded === row.slug
                                  ? 'Hide the theme breakdown'
                                  : `Show the ${row.sectors.length} themes inside this category`}
                                className="flex items-center gap-1.5"
                                style={{ background: 'none', border: 'none', padding: 0,
                                         color: 'inherit', font: 'inherit', cursor: 'pointer' }}>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" strokeWidth="3"
                                     style={{ color: 'var(--accent-a)', flexShrink: 0,
                                              transform: expanded === row.slug ? 'rotate(90deg)' : 'none',
                                              transition: 'transform 160ms' }}>
                                  <polyline points="9 18 15 12 9 6" />
                                </svg>
                                <span className="hover:text-[var(--accent-a)] transition-colors">
                                  {row.category_name}
                                </span>
                                <span className="text-[10px] px-1.5 rounded-full"
                                      style={{ background: 'var(--bg-raised)',
                                               color: 'var(--text-low)' }}>
                                  {row.sectors.length} themes
                                </span>
                              </button>
                            ) : (
                              <span className="hover:text-[var(--accent-a)] transition-colors">
                                {row.category_name}
                              </span>
                            )}
                          </td>
                          <td className="text-center" style={{ color: 'var(--text-mid)', fontSize: '0.75rem' }}>
                            {row.fund_count}
                          </td>
                          {(data?.rows[0]?.periods ?? []).map(p => {
                            const pk = String(p)
                            const v = row.averages[pk]
                            return (
                              <td key={pk} className={`ret-cell ${heatmapClass(v)} ${retColor(v)}`}>
                                {fmtPct(v)}
                              </td>
                            )
                          })}
                        </tr>
                        {/* Theme breakdown.
                            Each line is that theme's own average over the same
                            periods, precomputed in build_json — not averaged in
                            the browser, so it agrees with the quartile screen
                            which also ranks each theme separately. The chip
                            compares the theme against its parent category, which
                            is the comparison the row is actually for. */}
                        {expanded === row.slug && row.sectors?.map(s => (
                          <tr key={`sec-${row.slug}-${s.sector}`} className="sector-row">
                            <td />
                            <td className="sticky-col" style={{ paddingLeft: '2.75rem' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-hi)' }}>
                                {s.sector}
                              </span>
                              <span className="ml-2 text-[10px]"
                                    style={{ color: 'var(--text-low)' }}>
                                {s.fund_count}
                              </span>
                            </td>
                            <td />
                            {(data?.rows[0]?.periods ?? []).map(p => {
                              const pk = String(p)
                              const v = s.averages[pk]
                              const parent = row.averages[pk]
                              const spread = v != null && parent != null ? v - parent : null
                              return (
                                <td key={pk} className={`ret-cell ${retColor(v)}`}
                                    title={parent != null && v != null
                                      ? `${s.sector} ${fmtPct(v)} vs category ${fmtPct(parent)}`
                                      : undefined}>
                                  <div style={{ fontSize: '0.75rem' }}>{fmtPct(v)}</div>
                                  {spread != null && (
                                    <div className={`spread-chip ${spread >= 0 ? 'pos' : 'neg'}`}
                                         style={{ display: 'block', fontSize: '0.625rem' }}>
                                      {spread >= 0 ? '+' : ''}{(spread * 100).toFixed(1)}%
                                    </div>
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        ))}
                        {/* Benchmark sub-row */}
                        {showBenchmark && row.benchmark_id && (
                          <tr key={`bm-${row.slug}`} className="benchmark-row">
                            <td />
                            <td className="sticky-col pl-8" style={{ color: 'var(--text-mid)', fontSize: '0.75rem', fontStyle: 'italic' }}>
                              ↳ Benchmark
                            </td>
                            <td />
                            {(data?.rows[0]?.periods ?? []).map(p => {
                              const pk = String(p)
                              const bv  = row.benchmark[pk]
                              const av  = row.averages[pk]
                              const spread = bv != null && av != null ? av - bv : null
                              return (
                                <td key={pk} className="ret-cell">
                                  <div style={{ color: 'var(--text-mid)', fontSize: '0.75rem' }}>{fmtPct(bv)}</div>
                                  {spread != null && (
                                    <div className={`spread-chip ${spread >= 0 ? 'pos' : 'neg'}`} style={{ display: 'block', fontSize: '0.625rem' }}>
                                      {spread >= 0 ? '+' : ''}{(spread * 100).toFixed(1)}%
                                    </div>
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data && (
        <div className="mt-2 text-right text-xs" style={{ color: 'var(--text-low)' }}>
          Data as of {data.as_of} · Returns are category averages of all eligible funds
        </div>
      )}
    </section>
  )
}

import { Fragment } from 'react'
