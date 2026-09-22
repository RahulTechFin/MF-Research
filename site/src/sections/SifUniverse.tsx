// src/sections/SifUniverse.tsx — who exists on the SIF desk.
//
// The register, not the analysis. Every return, average, quartile and risk
// measure on this desk is produced by engine/calculation_engine and published as
// JSON, exactly as on the mutual fund desk, and the sections below this one read
// it. What this table adds is the part no calculation can tell you: which schemes
// exist, which strategy each is mapped to, and how its plan was established.
//
// That last point is why the plan tag is here. Most schemes state their plan
// outright; a handful state it nowhere, and for those the tag says how Regular
// was arrived at, so a reader can see how much to trust the row rather than
// having to take it on faith.

import { Fragment } from 'react'
import { useSif } from '../hooks/useSif'
import { categoryColor } from '../config/categoryColors'
import { assetClassColor } from '../utils/format'
import DownloadButton from '../components/DownloadButton'
import type { SheetSpec } from '../utils/xlsx'

const ASSET_ORDER = ['Equity', 'Hybrid', 'Debt']

// HOW WE KNOW A SCHEME IS THE REGULAR PLAN.
//
// AMFI's feed has a Plan column, and for most schemes it says "Regular Plan" —
// nothing to work out, and no tag is shown. For a handful it is blank in both
// SIF feeds, so the plan has to be established another way, and the tag says
// which way. It is there so a reader can see exactly how confident to be.
const PLAN_SOURCE_LABEL: Record<string, string> = {
  name: 'from name',
  inferred: 'plan inferred',
  'carried forward': 'plan carried forward',
}

const PLAN_SOURCE_HELP: Record<string, string> = {
  name:
    'AMFI left the Plan column blank, but the scheme name itself says Regular.',
  inferred:
    'AMFI states no plan anywhere for this scheme. It is the only share class of '
    + 'this fund that does not say Direct, so Regular is what remains — and its NAV '
    + 'sits below its Direct twin, which is the only way round a Regular plan can '
    + 'trade once the distributor commission is taken out. Both tests had to agree '
    + 'before it was accepted.',
  'carried forward':
    'AMFI states no plan for this scheme and it did not report inside the window '
    + 'this run read, so the classification already published for it was kept '
    + 'rather than the fund being dropped from the list.',
}

/** A year of trading days, give or take — the point at which 1Y starts working. */
const FULL_YEAR_DAYS = 250

export default function SifUniverse() {
  const { data, loading, error } = useSif()

  if (loading) {
    return (
      <section className="px-6 pt-6 max-w-screen-2xl mx-auto">
        <div className="card p-6">
          <div className="skeleton w-1/3 h-5 mb-3" />
          <div className="skeleton w-full h-4 mb-2" />
          <div className="skeleton w-full h-4" />
        </div>
      </section>
    )
  }

  if (error || !data) {
    return (
      <section className="px-6 pt-6 max-w-screen-2xl mx-auto">
        <div className="card p-5" style={{ color: 'var(--text-mid)', fontSize: '0.85rem' }}>
          <strong style={{ color: 'var(--loss)' }}>SIF register unavailable.</strong>{' '}
          {error ?? 'no data'} — the bucket holding this desk is private, and only the
          local dev server proxies it with a key. The sections below read the same
          bucket and will be empty for the same reason.
        </div>
      </section>
    )
  }

  const grouped = ASSET_ORDER
    .map(ac => ({ ac, cats: data.categories.filter(c => c.asset_class === ac) }))
    .filter(g => g.cats.length > 0)

  const youngest = Math.max(...data.funds.map(f => f.history_points), 0)

  const buildExport = (): SheetSpec | null => {
    const rows: SheetSpec['rows'] = []
    for (const { ac, cats } of grouped) {
      rows.push({ group: ac.toUpperCase() })
      for (const c of cats) {
        rows.push({ group: `${c.name}  (${c.fund_count} fund${c.fund_count === 1 ? '' : 's'})` })
        for (const f of data.funds.filter(x => x.category_slug === c.slug)) {
          rows.push({
            fund: f.scheme_name, code: f.scheme_code, isin: f.isin ?? '',
            amc: f.amc, structure: f.structure,
            nav: f.latest_nav, nav_date: f.latest_nav_date ?? '',
            first: f.history_first ?? '', days: f.history_points,
            plan_source: PLAN_SOURCE_LABEL[f.plan_source] ?? f.plan_source,
          })
        }
      }
    }
    return {
      sheet: 'SIF Register',
      title: 'SIF Register - Regular Growth schemes',
      meta: [
        ['Desk', 'SIF'],
        ['Data as of', data.as_of],
        ['Schemes', String(data.funds.length)],
        ['NAV history', `${data.history.rows.toLocaleString()} rows, `
                      + `${data.history.first} to ${data.history.last}`],
        ['Plan', 'Every scheme here is the Regular plan, Growth option. Where the '
               + 'Plan column says so outright the source is blank; otherwise it '
               + 'names how Regular was established.'],
      ],
      columns: [
        { key: 'fund', label: 'Scheme', type: 'text', width: 46 },
        { key: 'code', label: 'Scheme Code', type: 'text', width: 13 },
        { key: 'isin', label: 'ISIN', type: 'text', width: 15 },
        { key: 'amc', label: 'AMC', type: 'text', width: 20 },
        { key: 'structure', label: 'Structure', type: 'text', width: 15 },
        { key: 'nav', label: 'Latest NAV', type: 'number' },
        { key: 'nav_date', label: 'NAV date', type: 'text', width: 12 },
        { key: 'first', label: 'First NAV', type: 'text', width: 12 },
        { key: 'days', label: 'History (days)', type: 'int', width: 12 },
        { key: 'plan_source', label: 'Plan established from', type: 'text', width: 20 },
      ],
      rows,
      fileName: `SIF Register - ${data.as_of}`,
    }
  }

  return (
    <section className="px-6 pt-6 max-w-screen-2xl mx-auto">
      <div className="section-header">
        <span>SIF Register</span>
        <span className="scaffold-pill live">
          {data.funds.length} schemes · as of {data.as_of}
        </span>
        <span className="ml-auto"><DownloadButton build={buildExport} /></span>
      </div>
      <div className="text-sm mb-4" style={{ color: 'var(--text-mid)' }}>
        Every Regular Growth SIF scheme AMFI publishes, mapped to its SEBI strategy.
        {youngest < FULL_YEAR_DAYS && (
          <>
            {' '}The oldest NAV on this desk is {data.history.first}, so no fund has a
            full year yet — 1Y and every annualised figure below reads empty until
            one does.
          </>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sticky-col text-left" style={{ minWidth: 250 }}>Scheme</th>
                <th style={{ minWidth: 90 }}>Code</th>
                <th style={{ minWidth: 130 }}>AMC</th>
                <th className="ret-cell" style={{ minWidth: 90 }}>NAV</th>
                <th style={{ minWidth: 100 }}>NAV date</th>
                <th style={{ minWidth: 100 }}>First NAV</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ ac, cats }) => (
                <Fragment key={ac}>
                  <tr>
                    <td colSpan={100}
                        className="sticky-col py-1.5 px-4 text-xs font-bold uppercase tracking-widest"
                        style={{ color: assetClassColor(ac), background: 'var(--bg-raised)',
                                 borderLeft: `3px solid ${assetClassColor(ac)}` }}>
                      {ac}
                    </td>
                  </tr>

                  {cats.map(c => {
                    const colour = categoryColor(c.slug, ac)
                    const funds = data.funds.filter(f => f.category_slug === c.slug)
                    return (
                      <Fragment key={c.slug}>
                        {/* The strategy sub-heading. Its own colour, a tint of the
                            same colour behind it and a rule above, so the blocks
                            read as separate groups rather than one long list. */}
                        <tr className="strategy-row">
                          <td colSpan={100} className="sticky-col"
                              style={{ borderLeft: `3px solid ${colour}`,
                                       background: `linear-gradient(90deg, ${colour}22, transparent 60%)`,
                                       boxShadow: `inset 0 1px 0 ${colour}55` }}>
                            <span className="strategy-name" style={{ color: colour }}>
                              {c.name}
                            </span>
                            <span className="strategy-count"
                                  style={{ color: colour, borderColor: `${colour}66` }}>
                              {c.fund_count} fund{c.fund_count === 1 ? '' : 's'}
                            </span>
                            {c.fund_count === 0 && (
                              <span className="strategy-empty">
                                no scheme launched under this strategy yet
                              </span>
                            )}
                          </td>
                        </tr>

                        {funds.map(f => (
                          <tr key={f.scheme_code}>
                            <td className="sticky-col" style={{ paddingLeft: '2.5rem' }}>
                              <span style={{ fontSize: '0.8rem' }}>{f.scheme_name}</span>
                              {f.plan_source !== 'column' && (
                                <span className="plan-source-tag" title={PLAN_SOURCE_HELP[f.plan_source] ?? f.plan_source}>
                                  {PLAN_SOURCE_LABEL[f.plan_source] ?? f.plan_source}
                                </span>
                              )}
                            </td>
                            <td className="text-center"
                                style={{ fontSize: '0.7rem', color: 'var(--text-low)' }}>
                              {f.scheme_code}
                            </td>
                            <td className="text-center"
                                style={{ fontSize: '0.7rem', color: 'var(--text-mid)' }}>
                              {f.amc}
                            </td>
                            <td className="ret-cell tabnum">
                              {f.latest_nav == null ? '—' : f.latest_nav.toFixed(4)}
                            </td>
                            <td className="text-center"
                                style={{ fontSize: '0.7rem', color: 'var(--text-mid)' }}>
                              {f.latest_nav_date ?? '—'}
                            </td>
                            <td className="text-center"
                                style={{ fontSize: '0.7rem', color: 'var(--text-low)' }}>
                              {f.history_first ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    )
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-2 text-right text-xs" style={{ color: 'var(--text-low)' }}>
        {data.history.rows.toLocaleString()} NAVs from {data.history.first} to{' '}
        {data.history.last} · every figure below this table is the same engine the
        mutual fund desk runs
      </div>
    </section>
  )
}
