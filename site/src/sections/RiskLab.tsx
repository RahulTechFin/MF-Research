// src/sections/RiskLab.tsx — Section 8: Risk Lab (INTERNAL USE ONLY)

import { useMemo, useState, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { useMeta, useRisk, useDrawdown } from '../hooks/useData'
import CategoryPicker from '../components/CategoryPicker'
import { categoryColor } from '../config/categoryColors'
import { useTableSort, sortRows } from '../hooks/useTableSort'
import DownloadButton from '../components/DownloadButton'
import type { SheetSpec } from '../utils/xlsx'
import { fmtPct } from '../utils/format'

const METRIC_INFO: Record<string, string> = {
  std_annual:       'How much the fund\'s returns swing around their average — higher = bumpier ride.',
  sharpe:           'Extra return earned per unit of total risk — higher is better.',
  sortino:          'Like Sharpe, but only punishes downside swings — higher is better.',
  beta:             'How hard the fund moves when its index moves (1 = same).',
  alpha:            'Return the manager added beyond what Beta alone explains.',
  max_drawdown:     'Worst peak-to-bottom fall an investor would have suffered.',
  recovery_days:    'Calendar days from the trough until NAV regained its prior peak.',
  upside_capture:   '% of the index\'s gains captured (>100 = more than index).',
  downside_capture: '% of the index\'s falls suffered (<100 = fell less — good).',
  composite_score:  'One 0–100 score combining all risk-adjusted measures.',
}

const MAIN_TAB_NAMES = [
  'Large Cap',
  'Large & Mid Cap',
  'Mid Cap',
  'Small Cap',
  'Flexi Cap',
  'Balanced Advantage',
  'Multi Asset Allocation'
]

/**
 * A metric heading that both explains itself and sorts.
 *
 * The explanation was already here and is the more valuable of the two — most of
 * these measures are unreadable without knowing which direction is good — so
 * sorting was added AROUND it rather than replacing it with a plain title
 * attribute. The cell keeps its hover card and gains a click.
 */
function MetricHeader({ label, metric, sort }:
                      { label: string; metric: string
                        sort: ReturnType<typeof useTableSort> }) {
  const [show, setShow] = useState(false)
  const hp = sort.headerProps(metric)
  return (
    <th
      className={`ret-cell relative ${hp.className}`}
      onClick={hp.onClick}
      onKeyDown={hp.onKeyDown}
      role={hp.role}
      tabIndex={hp.tabIndex}
      aria-sort={hp['aria-sort']}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {label} <span style={{ color: 'var(--accent-a)' }}>ⓘ</span>
      <span className="sort-caret">{sort.caret(metric)}</span>
      {show && (
        <div className="absolute z-50 p-2 text-xs rounded-lg shadow-xl"
          style={{
            background: 'var(--bg-card)', border: '1px solid var(--line)',
            color: 'var(--text-mid)', bottom: '100%', left: '50%',
            transform: 'translateX(-50%)', width: 210, whiteSpace: 'normal',
            lineHeight: 1.4, fontWeight: 400, textTransform: 'none',
            letterSpacing: 0,
          }}>
          {METRIC_INFO[metric]}
          <div className="mt-1" style={{ color: 'var(--text-low)' }}>
            Click to sort by this column.
          </div>
        </div>
      )}
    </th>
  )
}

export default function RiskLab() {
  const { data: meta }         = useMeta()
  const [slug, setSlug]        = useState('')
  const [selectedFund, setFund] = useState<string>('')

  const allCats = meta?.categories ?? []
  const activeSlug = slug || (allCats[0]?.slug ?? '')

  const { data: riskData, loading, error } = useRisk(activeSlug)
  const { data: ddData }            = useDrawdown(selectedFund)

  // Auto-select first fund on load or category change
  useEffect(() => {
    if (riskData && riskData.funds.length > 0) {
      setFund(riskData.funds[0].scheme_code)
    } else {
      setFund('')
    }
  }, [riskData])

  // Get active category information
  const sort = useTableSort()
  // Composite score, descending, is this table's own ranking and stays the
  // resting order — sortRows returns it untouched until a heading is clicked.
  const rankedRiskFunds = useMemo(
    () => [...(riskData?.funds ?? [])]
      .sort((a, b) => (b.composite_score ?? 0) - (a.composite_score ?? 0)),
    [riskData])
  const sortedRiskFunds = sortRows(rankedRiskFunds, sort,
    (f, k) => k === 'fund' ? f.scheme_name
            : (f as unknown as Record<string, unknown>)[k])

  const activeCatInfo = allCats.find(c => c.slug === activeSlug)

  const buildExport = (): SheetSpec | null => {
    if (!riskData) return null
    return {
      sheet: 'Risk Lab',
      title: `Risk Lab - ${activeCatInfo?.category_name ?? activeSlug}`,
      meta: [
        ['Category', activeCatInfo?.category_name ?? activeSlug],
        ['Benchmark', activeCatInfo?.benchmark_name ?? '-'],
        ['Data as of', riskData.as_of],
        ['Risk-free rate', `${(riskData.risk_free_rate * 100).toFixed(1)}% p.a.`],
        ['Funds', String(riskData.funds.length)],
        ['Basis', 'Annualised from monthly returns over about 30 months. An empty '
                + 'cell means the fund has too little history for that measure.'],
      ],
      columns: [
        { key: 'fund', label: 'Fund Name', type: 'text', width: 46 },
        { key: 'std_annual', label: 'Std Dev (ann.)', type: 'percent' },
        { key: 'sharpe', label: 'Sharpe', type: 'number' },
        { key: 'sortino', label: 'Sortino', type: 'number' },
        { key: 'beta', label: 'Beta', type: 'number' },
        { key: 'alpha', label: 'Alpha', type: 'percent' },
        { key: 'max_drawdown', label: 'Max Drawdown', type: 'percent' },
        { key: 'recovery_days', label: 'Recovery (days)', type: 'int' },
        { key: 'upside_capture', label: 'Upside Capture', type: 'number' },
        { key: 'downside_capture', label: 'Downside Capture', type: 'number' },
        { key: 'composite_score', label: 'Composite Score', type: 'number' },
        { key: 'fund_3y_cagr', label: 'Fund 3Y CAGR', type: 'percent' },
        { key: 'bench_3y_cagr', label: 'Benchmark 3Y CAGR', type: 'percent' },
      ],
      rows: sortedRiskFunds.map(f => ({
        fund: f.scheme_name,
        std_annual: f.std_annual, sharpe: f.sharpe, sortino: f.sortino,
        beta: f.beta, alpha: f.alpha, max_drawdown: f.max_drawdown,
        recovery_days: f.recovery_days, upside_capture: f.upside_capture,
        downside_capture: f.downside_capture, composite_score: f.composite_score,
        fund_3y_cagr: f.fund_3y_cagr, bench_3y_cagr: f.bench_3y_cagr,
      })),
      fileName: `Risk Lab - ${activeCatInfo?.category_name ?? activeSlug} - ${riskData.as_of}`,
    }
  }
  const categoryBenchmarkName = activeCatInfo?.benchmark_name || 'Benchmark'

  // Dynamic colors matching active theme (light / dark)
  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light'
  const axisColor = isLight ? '#4B5563' : '#5E6F8F'
  const lineColor = isLight ? '#E5E7EB' : '#24314F'
  const tooltipBg = isLight ? '#FFFFFF' : '#111A2E'
  const tooltipBorder = isLight ? '#D1D5DB' : '#24314F'
  const tooltipText = isLight ? '#111827' : '#F1F5FB'

  const mainTabs = allCats.filter(c => MAIN_TAB_NAMES.includes(c.category_name))
  const otherCats = allCats.filter(c => !MAIN_TAB_NAMES.includes(c.category_name))

  // Find the selected fund's actual name for displays
  const selectedFundName = riskData?.funds.find(f => f.scheme_code === selectedFund)?.scheme_name || selectedFund

  // Scatter chart: σ (x) vs 3Y CAGR (y), bubble = composite score
  const scatterOption = riskData
    ? {
        backgroundColor: 'transparent',
        grid: { top: 30, right: 20, bottom: 50, left: 70 },
        xAxis: {
          name: 'Ann. Std Dev (σ)',
          nameLocation: 'middle', nameGap: 30,
          axisLabel: { color: axisColor, fontSize: 10, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
          splitLine: { lineStyle: { color: lineColor, type: 'dashed' } },
          axisLine: { lineStyle: { color: lineColor } },
        },
        yAxis: {
          name: '3Y CAGR',
          nameLocation: 'middle', nameGap: 45,
          axisLabel: { color: axisColor, fontSize: 10, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
          splitLine: { lineStyle: { color: lineColor, type: 'dashed' } },
          axisLine: { show: false },
        },
        tooltip: {
          trigger: 'item',
          backgroundColor: tooltipBg,
          borderColor: tooltipBorder,
          textStyle: { color: tooltipText, fontSize: 11 },
          formatter: (p: any) => {
            const d = p.data
            // Lookup fund name in the local map
            const name = riskData.funds.find(f => f.scheme_code === d[3])?.scheme_name || d[3]
            return `<b>${name}</b><br/>σ: ${(d[0]*100).toFixed(1)}%<br/>3Y CAGR: ${(d[1]*100).toFixed(1)}%<br/>Composite Score: ${d[2]}`
          },
        },
        series: [{
          type: 'scatter',
          data: riskData.funds
            .filter(f => f.std_annual != null && f.fund_3y_cagr != null)
            .map(f => [f.std_annual, f.fund_3y_cagr, f.composite_score ?? 50, f.scheme_code]),
          symbolSize: (d: number[]) => Math.max(8, Math.min(28, (d[2] ?? 50) / 4)),
          itemStyle: { color: '#22D3EE', opacity: 0.7 },
        }],
      }
    : null

  // Underwater chart
  const ddOption = ddData
    ? {
        backgroundColor: 'transparent',
        grid: { top: 15, right: 20, bottom: 40, left: 65 },
        xAxis: {
          type: 'category',
          data: ddData.drawdown.map(d => d.date),
          axisLabel: { color: axisColor, fontSize: 10, interval: Math.floor(ddData.drawdown.length / 8) },
          axisLine: { lineStyle: { color: lineColor } },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          axisLabel: { color: axisColor, fontSize: 10, formatter: (v: number) => `${v.toFixed(0)}%` },
          splitLine: { lineStyle: { color: lineColor, type: 'dashed' } },
          axisLine: { show: false },
        },
        tooltip: {
          trigger: 'axis',
          backgroundColor: tooltipBg,
          borderColor: tooltipBorder,
          textStyle: { color: tooltipText, fontSize: 11 },
          formatter: (p: any) => `${p[0].axisValue}<br/>Drawdown: ${p[0].data.toFixed(2)}%`,
        },
        series: [{
          type: 'line',
          data: ddData.drawdown.map(d => d.drawdown_pct),
          smooth: false,
          showSymbol: false,
          lineStyle: { color: '#F87171', width: 1.2 },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: '#F8717140' }, { offset: 1, color: '#F8717100' }] } },
          markPoint: {
            data: ddData.drawdown
              .filter(d => d.is_trough)
              .map(d => ({ name: 'Max DD', value: d.drawdown_pct.toFixed(1) + '%', xAxis: d.date, yAxis: d.drawdown_pct,
                itemStyle: { color: '#DC2626' } }))
          },
        }],
      }
    : null

  return (
    <section id="risk-lab" className="px-6 py-6 max-w-screen-2xl mx-auto">
      {/* INTERNAL USE ONLY banner */}
      <div className="risk-banner mb-5">
        🔒 <strong>INTERNAL USE ONLY</strong> — This section is for internal research purposes only. Not for client distribution or public sharing.
      </div>

      <div className="section-header">
        <span>Risk Lab</span>
        <span className="ml-auto"><DownloadButton build={buildExport}
              disabledHint="No risk figures for this category yet" /></span>
      </div>

      {/* Category selector. A desk whose categories match none of the mutual
          fund main-tab names shows all of them as coloured chips instead of
          burying every one in the dropdown. */}
      <div className="flex gap-2 flex-wrap items-center mb-4">
        {mainTabs.length === 0 ? (
          <CategoryPicker cats={allCats} active={activeSlug} onChange={setSlug} />
        ) : (
        <div className="tab-bar">
          {mainTabs.map(c => {
            const colour = categoryColor(c.slug, c.asset_class)
            const on = activeSlug === c.slug
            return (
              <button
                key={c.slug}
                onClick={() => setSlug(c.slug)}
                className={`tab-btn${on ? ' active' : ''}`}
                style={on ? { color: colour, background: `${colour}1f` } : undefined}
              >
                {c.category_name}
              </button>
            )
          })}
        </div>
        )}

        {mainTabs.length > 0 && otherCats.length > 0 && (
          <select
            value={mainTabs.some(c => c.slug === activeSlug) ? '' : activeSlug}
            onChange={e => { if (e.target.value) setSlug(e.target.value) }}
            className="px-3 py-1.5 rounded-lg text-sm"
            style={{
              background: 'var(--bg-raised)',
              border: '1px solid var(--line)',
              color: 'var(--text-hi)',
              outline: 'none',
            }}
          >
            <option value="" disabled>-- Other Categories --</option>
            {otherCats.map(c => (
              <option key={c.slug} value={c.slug}>{c.category_name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Data window label */}
      {riskData && (
        <div className="text-xs mb-4 font-mono" style={{ color: 'var(--text-low)' }}>
          Based on 3-year monthly returns as of {riskData.as_of} · Benchmark: {categoryBenchmarkName} · Rf = {(riskData.risk_free_rate * 100).toFixed(1)}%
        </div>
      )}

      {/* Risk metrics table */}
      <div className="card overflow-hidden mb-6">
        {loading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}
          </div>
        ) : riskData ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col text-left" style={{ minWidth: 240 }}>Fund</th>
                  <MetricHeader sort={sort} label="σ ann." metric="std_annual" />
                  <MetricHeader sort={sort} label="Sharpe" metric="sharpe" />
                  <MetricHeader sort={sort} label="Sortino" metric="sortino" />
                  <MetricHeader sort={sort} label="Beta" metric="beta" />
                  <MetricHeader sort={sort} label="Alpha" metric="alpha" />
                  <MetricHeader sort={sort} label="Max DD" metric="max_drawdown" />
                  <MetricHeader sort={sort} label="Recovery" metric="recovery_days" />
                  <MetricHeader sort={sort} label="Up Cap" metric="upside_capture" />
                  <MetricHeader sort={sort} label="Dn Cap" metric="downside_capture" />
                  <MetricHeader sort={sort} label="Score" metric="composite_score" />
                </tr>
              </thead>
              <tbody key={slug} className="rows-enter">
                {sortedRiskFunds
                  .map(fund => (
                    <tr key={fund.scheme_code}
                      className={`cursor-pointer${selectedFund === fund.scheme_code ? ' bg-[rgba(34,211,238,0.08)]' : ''}`}
                      onClick={() => setFund(fund.scheme_code)}>
                      <td className="sticky-col text-xs font-medium truncate" style={{ maxWidth: 240 }}>
                        {fund.scheme_name}
                      </td>
                      <td className="ret-cell">{fund.std_annual != null ? fmtPct(fund.std_annual) : '—'}</td>
                      <td className={`ret-cell ${fund.sharpe != null ? (fund.sharpe >= 0 ? 'ret-pos' : 'ret-neg') : 'ret-nil'}`}>
                        {fund.sharpe != null ? fund.sharpe.toFixed(2) : '—'}
                      </td>
                      <td className={`ret-cell ${fund.sortino != null ? (fund.sortino >= 0 ? 'ret-pos' : 'ret-neg') : 'ret-nil'}`}>
                        {fund.sortino != null ? fund.sortino.toFixed(2) : '—'}
                      </td>
                      <td className="ret-cell">{fund.beta != null ? fund.beta.toFixed(2) : '—'}</td>
                      <td className={`ret-cell ${fund.alpha != null ? (fund.alpha >= 0 ? 'ret-pos' : 'ret-neg') : 'ret-nil'}`}>
                        {fund.alpha != null ? fmtPct(fund.alpha) : '—'}
                      </td>
                      <td className="ret-cell ret-neg">{fund.max_drawdown != null ? fmtPct(fund.max_drawdown) : '—'}</td>
                      <td className="ret-cell text-xs" style={{ color: 'var(--text-mid)' }}>
                        {fund.recovery_days != null ? `${fund.recovery_days}d` : fund.trough_date ? 'Ongoing' : '—'}
                      </td>
                      <td className="ret-cell">{fund.upside_capture != null ? `${fund.upside_capture.toFixed(0)}` : '—'}</td>
                      <td className="ret-cell">{fund.downside_capture != null ? `${fund.downside_capture.toFixed(0)}` : '—'}</td>
                      <td className="ret-cell">
                        {fund.composite_score != null ? (
                          <div className="inline-flex items-center justify-center w-10 h-6 rounded font-bold text-xs"
                            style={{
                              background: `rgba(34,211,238,${fund.composite_score / 150})`,
                              color: fund.composite_score >= 50 ? 'var(--gain)' : 'var(--text-mid)',
                              border: '1px solid rgba(34,211,238,0.2)',
                            }}>
                            {fund.composite_score.toFixed(0)}
                          </div>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center" style={{ color: 'var(--text-mid)' }}>
            {error && /\b(404|400)\b/.test(error) ? (
              <>
                <div style={{ color: 'var(--text-hi)', marginBottom: 4 }}>
                  No funds in this category yet.
                </div>
                <div className="text-xs">
                  Nothing to measure until a scheme is launched under this strategy.
                </div>
              </>
            ) : error ? (
              <>
                <div style={{ color: 'var(--loss)', marginBottom: 4 }}>
                  Could not load the risk table.
                </div>
                <div className="text-xs">{error}</div>
              </>
            ) : (
              <>
                <div style={{ color: 'var(--text-hi)', marginBottom: 4 }}>
                  Not enough history for risk measures yet.
                </div>
                <div className="text-xs">
                  Standard deviation, Sharpe, beta and the rest are annualised from
                  about 30 months of monthly returns. A newly launched category has
                  nowhere near that, and a partial figure would be worse than none.
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Dynamic charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Underwater chart */}
        <div className="card p-4">
          <div className="font-display font-semibold text-sm mb-3" style={{ color: 'var(--loss)' }}>
            📉 Underwater / Drawdown Chart
            {selectedFund && <span className="ml-2 text-xs font-normal" style={{ color: 'var(--text-low)' }}>({selectedFundName})</span>}
          </div>
          {!selectedFund ? (
            <div className="flex items-center justify-center" style={{ height: 220, color: 'var(--text-low)', fontSize: 13 }}>
              Click a fund row above to view its drawdown curve
            </div>
          ) : ddData ? (
            <ReactECharts option={ddOption!} style={{ height: 220 }} notMerge />
          ) : (
            <div className="skeleton" style={{ height: 220 }} />
          )}
        </div>

        {/* Risk-Return scatter */}
        <div className="card p-4">
          <div className="font-display font-semibold text-sm mb-3" style={{ color: 'var(--accent-a)' }}>
            📊 Risk-Return Scatter
          </div>
          {riskData ? (
            <ReactECharts option={scatterOption!} style={{ height: 220 }} notMerge />
          ) : (
            <div className="skeleton" style={{ height: 220 }} />
          )}
        </div>
      </div>
    </section>
  )
}
