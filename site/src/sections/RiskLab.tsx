// src/sections/RiskLab.tsx — Section 8: Risk Lab (INTERNAL USE ONLY)

import { useState, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { useMeta, useRisk, useDrawdown } from '../hooks/useData'
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

function MetricHeader({ label, metric }: { label: string; metric: string }) {
  const [show, setShow] = useState(false)
  return (
    <th className="ret-cell relative cursor-help" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {label} <span style={{ color: 'var(--accent-a)' }}>ⓘ</span>
      {show && (
        <div className="absolute z-50 p-2 text-xs rounded-lg shadow-xl"
          style={{
            background: 'var(--bg-card)', border: '1px solid var(--line)', color: 'var(--text-mid)',
            bottom: '100%', left: '50%', transform: 'translateX(-50%)', width: 200, whiteSpace: 'normal', lineHeight: 1.4,
          }}>
          {METRIC_INFO[metric]}
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

  const { data: riskData, loading } = useRisk(activeSlug)
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
  const activeCatInfo = allCats.find(c => c.slug === activeSlug)
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

      <div className="section-header">Risk Lab</div>

      {/* Category selector (Tabs + Dropdown) */}
      <div className="flex gap-2 flex-wrap items-center mb-4">
        <div className="tab-bar">
          {mainTabs.map(c => (
            <button
              key={c.slug}
              onClick={() => setSlug(c.slug)}
              className={`tab-btn${activeSlug === c.slug ? ' active accent' : ''}`}
            >
              {c.category_name}
            </button>
          ))}
        </div>

        {otherCats.length > 0 && (
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
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col text-left" style={{ minWidth: 240 }}>Fund</th>
                  <MetricHeader label="σ ann." metric="std_annual" />
                  <MetricHeader label="Sharpe" metric="sharpe" />
                  <MetricHeader label="Sortino" metric="sortino" />
                  <MetricHeader label="Beta" metric="beta" />
                  <MetricHeader label="Alpha" metric="alpha" />
                  <MetricHeader label="Max DD" metric="max_drawdown" />
                  <MetricHeader label="Recovery" metric="recovery_days" />
                  <MetricHeader label="Up Cap" metric="upside_capture" />
                  <MetricHeader label="Dn Cap" metric="downside_capture" />
                  <MetricHeader label="Score" metric="composite_score" />
                </tr>
              </thead>
              <tbody key={slug} className="rows-enter">
                {[...riskData.funds]
                  .sort((a, b) => (b.composite_score ?? 0) - (a.composite_score ?? 0))
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
            No risk data yet. Complete the backfill first (min 30 months required).
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
