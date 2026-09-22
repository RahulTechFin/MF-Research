// src/sections/BlendPanels.tsx — the analysis panels Blend Studio switches between.
//
// Separated from BlendStudio.tsx so that file stays about STATE — what the
// portfolio is, what window it is measured over — while these are pure views of
// an already-computed result. Each takes finished numbers and renders them; none
// fetches, and none decides what to measure.
//
// A NOTE ON WHAT IS SHOWN WHEN A NUMBER CANNOT BE COMPUTED
// Every panel here prints an em dash for a missing figure and says why in a
// footnote if the reason is structural (too few months, no reference series).
// A zero in place of "unknown" is the one presentation error that changes
// decisions, so it never appears.

import ReactECharts from 'echarts-for-react'
import { fmtPct, retColor } from '../utils/format'
import { REBALANCE_LABELS, RISK_FREE } from '../utils/blend'
import type { BlendStats, Rebalance, Series } from '../utils/blend'
import type {
  Contribution, CorrelationMatrix, Distribution, Episode, Frontier, RollingPoint,
  StressRow,
} from '../utils/blendAnalytics'

export const BLEND_COLOUR = '#22D3EE'

export function themeColours() {
  const isLight = typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-theme') === 'light'
  return {
    isLight,
    axis: isLight ? '#4B5563' : '#5E6F8F',
    grid: isLight ? '#E5E7EB' : '#24314F',
    tipBg: isLight ? '#FFFFFF' : '#111A2E',
    tipLine: isLight ? '#D1D5DB' : '#24314F',
    tipText: isLight ? '#111827' : '#F1F5FB',
    ref: isLight ? '#6B7280' : '#9FB0CC',
  }
}

const pct = (v: number | null | undefined, dp = 2) =>
  v == null ? '—' : `${(v * 100).toFixed(dp)}%`
const rat = (v: number | null | undefined, dp = 2) => v == null ? '—' : v.toFixed(dp)

function Card({ title, note, children, right }: {
  title: string; note?: string; right?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-2.5 border-b flex items-baseline justify-between gap-2 flex-wrap"
           style={{ borderColor: 'var(--line)' }}>
        <div className="text-xs font-semibold" style={{ color: 'var(--text-hi)' }}>{title}</div>
        {right}
      </div>
      {note && (
        <div className="px-4 pt-2 text-[11px]" style={{ color: 'var(--text-low)' }}>{note}</div>
      )}
      {children}
    </div>
  )
}

// ── contribution ────────────────────────────────────────────────────────────

export function ContributionPanel({ rows, totalReturn, totalVol, realisedVol }: {
  rows: Contribution[]
  totalReturn: number | null
  totalVol: number | null
  realisedVol: number | null
}) {
  if (!rows.length) return null
  return (
    <Card
      title="Where the return and the risk came from"
      note={'Return contributions are an exact split of the portfolio’s total '
        + 'return — they add up to it, using the weights the portfolio actually '
        + 'held each day rather than the target. Risk uses Euler decomposition on '
        + 'monthly covariance, so the shares add to 100% of volatility.'}
    >
      <div className="table-scroll" style={{ ['--table-max-h' as string]: '320px' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th className="text-left" style={{ minWidth: 150 }}>Component</th>
              <th className="ret-cell" title="Share of capital">Weight</th>
              <th className="ret-cell" title="What this index did on its own">Own return</th>
              <th className="ret-cell" title="How much of the portfolio's return came from here">
                Return contrib
              </th>
              <th className="ret-cell" title="Annualised volatility of this index alone">
                Own vol
              </th>
              <th className="ret-cell" title="Share of the portfolio's total volatility">
                Risk share
              </th>
              <th className="ret-cell" title="Risk share minus capital share">Risk − weight</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.index_id}>
                <td className="text-left text-xs" title={r.label}>{r.label}</td>
                <td className="ret-cell tabnum">{r.weight.toFixed(1)}%</td>
                <td className={`ret-cell ${retColor(r.ownReturn)}`}>{pct(r.ownReturn)}</td>
                <td className={`ret-cell ${retColor(r.returnContribution)}`}>
                  {pct(r.returnContribution)}
                </td>
                <td className="ret-cell tabnum" style={{ color: 'var(--text-mid)' }}>
                  {pct(r.ownVol)}
                </td>
                <td className="ret-cell tabnum" style={{ color: 'var(--text-hi)', fontWeight: 600 }}>
                  {r.riskShare == null ? '—' : `${r.riskShare.toFixed(1)}%`}
                </td>
                <td className="ret-cell">
                  {r.riskVsWeight != null && (
                    <span className={`spread-chip ${r.riskVsWeight >= 0 ? 'neg' : 'pos'}`}
                          title={r.riskVsWeight >= 0
                            ? 'Carries more of the risk than of the capital'
                            : 'Carries less of the risk than of the capital'}>
                      {r.riskVsWeight >= 0 ? '+' : ''}{r.riskVsWeight.toFixed(1)}pp
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--line)', fontWeight: 600 }}>
              <td className="text-left text-xs">Portfolio</td>
              <td className="ret-cell tabnum">100.0%</td>
              <td />
              <td className={`ret-cell ${retColor(totalReturn)}`}>{pct(totalReturn)}</td>
              <td className="ret-cell tabnum">{pct(totalVol)}</td>
              <td className="ret-cell tabnum">100.0%</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      {totalVol != null && realisedVol != null
        && Math.abs(totalVol - realisedVol) > 0.0005 && (
        <div className="px-4 py-2 text-[11px]"
             style={{ color: 'var(--text-low)', borderTop: '1px solid var(--line)' }}>
          The decomposition totals {pct(totalVol)} against the path's realised
          {' '}{pct(realisedVol)}. Both are right: Euler decomposition describes a
          portfolio held at fixed weights, while the path's own volatility includes
          what drift between rebalances did. The gap IS the rebalancing effect on
          risk, and it closes as the frequency shortens.
        </div>
      )}
    </Card>
  )
}

// ── correlation ─────────────────────────────────────────────────────────────

export function CorrelationPanel({ matrix }: { matrix: CorrelationMatrix }) {
  if (matrix.labels.length < 2) return null
  const shade = (v: number | null) => {
    if (v == null) return { background: 'transparent', color: 'var(--text-low)' }
    // Diverging: high correlation is the thing to worry about in a blend, so it
    // gets the warm end.
    const a = Math.min(1, Math.abs(v))
    return {
      background: v >= 0 ? `rgba(248,113,113,${0.06 + a * 0.34})`
                         : `rgba(52,211,153,${0.06 + a * 0.34})`,
      color: 'var(--text-hi)',
    }
  }
  return (
    <Card
      title="Correlation between components"
      note={'Monthly returns over the window. Two sleeves near +1 are one sleeve '
        + 'with two names — no weighting of them diversifies anything. Negative '
        + 'pairs are what actually lowers portfolio risk.'}
      right={<span className="text-[11px]" style={{ color: 'var(--text-low)' }}>
        {matrix.months} months
      </span>}
    >
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th className="text-left sticky-col" style={{ minWidth: 140 }} />
              {matrix.labels.map(l => (
                <th key={l} className="ret-cell" style={{ minWidth: 84, fontSize: 10 }} title={l}>
                  {l.length > 14 ? l.slice(0, 13) + '…' : l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.labels.map((l, i) => (
              <tr key={l}>
                <td className="text-left text-xs sticky-col" title={l}>
                  {l.length > 20 ? l.slice(0, 19) + '…' : l}
                </td>
                {matrix.rows[i].map((v, j) => (
                  <td key={j} className="ret-cell tabnum" style={shade(v)}>
                    {v == null ? '—' : v.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// ── frontier ────────────────────────────────────────────────────────────────

export function FrontierPanel({ frontier, labels, onApply }: {
  frontier: Frontier
  labels: string[]
  onApply: (weights: number[]) => void
}) {
  const c = themeColours()
  if (!frontier.points.length) return null

  const pointsXY = frontier.points.map(p => [+(p.vol * 100).toFixed(3), +(p.cagr * 100).toFixed(3)])
  const mark = (p: typeof frontier.current, colour: string, name: string) =>
    p ? [{
      name, value: [+(p.vol * 100).toFixed(3), +(p.cagr * 100).toFixed(3)],
      itemStyle: { color: colour, borderColor: c.isLight ? '#fff' : '#0B1220', borderWidth: 2 },
      symbolSize: 15,
    }] : []

  const option = {
    backgroundColor: 'transparent',
    grid: { top: 28, right: 22, bottom: 42, left: 52 },
    xAxis: {
      type: 'value', name: 'Volatility', nameLocation: 'middle', nameGap: 26,
      nameTextStyle: { color: c.axis, fontSize: 10 },
      axisLine: { lineStyle: { color: c.grid } },
      axisLabel: { color: c.axis, fontSize: 10, formatter: (v: number) => `${v.toFixed(0)}%` },
      splitLine: { lineStyle: { color: c.grid, type: 'dashed' } },
    },
    yAxis: {
      type: 'value', name: 'CAGR', nameLocation: 'middle', nameGap: 38,
      nameTextStyle: { color: c.axis, fontSize: 10 },
      axisLine: { show: false },
      axisLabel: { color: c.axis, fontSize: 10, formatter: (v: number) => `${v.toFixed(0)}%` },
      splitLine: { lineStyle: { color: c.grid, type: 'dashed' } },
    },
    tooltip: {
      trigger: 'item', backgroundColor: c.tipBg, borderColor: c.tipLine,
      textStyle: { color: c.tipText, fontSize: 11 },
      formatter: (p: { seriesName: string; value: number[] }) =>
        `${p.seriesName}<br/>vol ${p.value[0].toFixed(2)}% · CAGR ${p.value[1].toFixed(2)}%`,
    },
    legend: { show: true, top: 0, textStyle: { color: c.axis, fontSize: 10 } },
    series: [
      {
        name: 'Possible mixes', type: 'scatter', data: pointsXY, symbolSize: 4,
        itemStyle: { color: c.isLight ? '#9CA3AF' : '#3C4F73', opacity: 0.75 },
      },
      { name: 'Min variance', type: 'scatter',
        data: mark(frontier.minVariance, '#818CF8', 'Min variance'), symbolSize: 15 },
      { name: 'Max Sharpe', type: 'scatter',
        data: mark(frontier.maxSharpe, '#34D399', 'Max Sharpe'), symbolSize: 15 },
      { name: 'Your blend', type: 'scatter',
        data: mark(frontier.current, BLEND_COLOUR, 'Your blend'), symbolSize: 15 },
    ],
  }

  const row = (label: string, p: typeof frontier.current, colour: string) => p && (
    <tr>
      <td className="text-left text-xs" style={{ color: colour, fontWeight: 600 }}>{label}</td>
      <td className="ret-cell tabnum">{pct(p.cagr)}</td>
      <td className="ret-cell tabnum">{pct(p.vol)}</td>
      <td className="ret-cell tabnum">{rat(p.sharpe)}</td>
      <td className="text-left text-[11px]" style={{ color: 'var(--text-mid)' }}>
        {p.weights.map((w, i) => `${labels[i]?.split(' ')[0] ?? i} ${w.toFixed(0)}%`).join(' · ')}
      </td>
      <td>
        <button onClick={() => onApply(p.weights)} className="pill text-[10px]"
                title="Load these weights into the builder">
          Apply
        </button>
      </td>
    </tr>
  )

  return (
    <Card
      title="The opportunity set"
      note={labels.length === 2
        ? 'Every mix of these two, stepped 1% at a time — this is the exact curve, '
          + 'not a sample. Return is the blend’s realised CAGR over the window, '
          + 'not a weighted average of the components’.'
        : 'A fixed 5% lattice over every mix, with the two optimal points solved '
          + 'for precisely. Return is the blend’s realised CAGR over the window.'}
      right={<span className="text-[11px]" style={{ color: 'var(--text-low)' }}>
        {frontier.points.length} mixes · {frontier.months} months
      </span>}
    >
      <div className="px-2 pt-1">
        <ReactECharts option={option} style={{ height: 260 }} notMerge lazyUpdate
                      opts={{ renderer: 'svg' }} />
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th className="text-left" style={{ minWidth: 110 }}>Mix</th>
            <th className="ret-cell">CAGR</th>
            <th className="ret-cell">Vol</th>
            <th className="ret-cell">Sharpe</th>
            <th className="text-left">Weights</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {row('Your blend', frontier.current, BLEND_COLOUR)}
          {row('Min variance', frontier.minVariance, '#818CF8')}
          {row('Max Sharpe', frontier.maxSharpe, '#34D399')}
        </tbody>
      </table>
      <div className="px-4 py-2 text-[11px]"
           style={{ color: 'var(--text-low)', borderTop: '1px solid var(--line)' }}>
        Both optima are fitted to what already happened. The mix that maximised
        Sharpe over this window is not the mix that will maximise it over the next
        one, and the more sleeves there are the more of that number is hindsight.
        Min variance is the more transportable of the two, because covariances move
        around less than means do.
      </div>
    </Card>
  )
}

// ── rolling ─────────────────────────────────────────────────────────────────

export function RollingPanel({ points, windowMonths, metric, refLabel, onMetric, onWindow }: {
  points: RollingPoint[]
  windowMonths: number
  metric: 'cagr' | 'vol' | 'excess' | 'te' | 'beta'
  refLabel: string
  onMetric: (m: 'cagr' | 'vol' | 'excess' | 'te' | 'beta') => void
  onWindow: (m: number) => void
}) {
  const c = themeColours()
  const LABELS: Record<string, string> = {
    cagr: 'Rolling CAGR', vol: 'Rolling volatility', excess: 'Excess CAGR vs category',
    te: 'Tracking error', beta: 'Beta vs category',
  }
  const asPercent = metric !== 'beta'
  const dates = points.map(p => p.date)
  const option = {
    backgroundColor: 'transparent',
    grid: { top: 26, right: 18, bottom: 28, left: 54 },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: c.grid } },
      axisLabel: { color: c.axis, fontSize: 10, interval: Math.floor(dates.length / 7) || 0 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', axisLine: { show: false },
      axisLabel: {
        color: c.axis, fontSize: 10,
        formatter: (v: number) => asPercent ? `${v.toFixed(0)}%` : v.toFixed(2),
      },
      splitLine: { lineStyle: { color: c.grid, type: 'dashed' } },
    },
    tooltip: {
      trigger: 'axis', backgroundColor: c.tipBg, borderColor: c.tipLine,
      textStyle: { color: c.tipText, fontSize: 11 },
      valueFormatter: (v: number) => v == null ? '—'
        : asPercent ? `${Number(v).toFixed(2)}%` : Number(v).toFixed(3),
    },
    legend: { show: true, top: 0, textStyle: { color: c.axis, fontSize: 10 } },
    series: [
      {
        name: 'Your blend', type: 'line', smooth: true, showSymbol: false,
        data: points.map(p => p.blend == null ? null
          : +(asPercent ? p.blend * 100 : p.blend).toFixed(3)),
        lineStyle: { width: 2, color: BLEND_COLOUR }, itemStyle: { color: BLEND_COLOUR },
      },
      ...(metric === 'cagr' || metric === 'vol' ? [{
        name: refLabel, type: 'line', smooth: true, showSymbol: false,
        data: points.map(p => p.ref == null ? null : +(p.ref * 100).toFixed(3)),
        lineStyle: { width: 1.5, type: 'dashed', color: c.ref }, itemStyle: { color: c.ref },
      }] : []),
      ...(metric === 'excess' || metric === 'beta' ? [{
        name: metric === 'beta' ? 'Beta = 1' : 'Level pegging', type: 'line',
        showSymbol: false, data: points.map(() => metric === 'beta' ? 1 : 0),
        lineStyle: { width: 1, type: 'dotted', color: c.ref }, itemStyle: { color: c.ref },
      }] : []),
    ],
  }

  const values = points.map(p => p.blend).filter((v): v is number => v != null)
  return (
    <Card
      title={LABELS[metric]}
      note={'Every point recomputes the measure over the preceding window, so a '
        + 'single headline figure can be seen for what it is — typical, or a '
        + 'one-off that happens to end today.'}
      right={
        <div className="flex gap-1.5 flex-wrap">
          {(['cagr', 'vol', 'excess', 'te', 'beta'] as const).map(m => (
            <button key={m} onClick={() => onMetric(m)}
                    className={`pill text-[10px]${metric === m ? ' active' : ''}`}
                    style={metric === m ? { color: BLEND_COLOUR, borderColor: BLEND_COLOUR,
                                            background: `${BLEND_COLOUR}1f` } : undefined}>
              {m === 'cagr' ? 'CAGR' : m === 'vol' ? 'Vol' : m === 'excess' ? 'Excess'
                : m === 'te' ? 'Tracking' : 'Beta'}
            </button>
          ))}
          <span style={{ width: 8 }} />
          {[12, 36, 60].map(w => (
            <button key={w} onClick={() => onWindow(w)}
                    className={`pill text-[10px]${windowMonths === w ? ' active' : ''}`}
                    style={windowMonths === w ? { color: BLEND_COLOUR, borderColor: BLEND_COLOUR,
                                                  background: `${BLEND_COLOUR}1f` } : undefined}>
              {w / 12}Y
            </button>
          ))}
        </div>
      }
    >
      {points.length < 2 ? (
        <div className="py-12 text-center text-xs" style={{ color: 'var(--text-mid)' }}>
          The window has fewer than {windowMonths} months of history before its
          first point, so no rolling figure exists yet. Try a shorter rolling
          window, or widen the measurement period.
        </div>
      ) : (
        <>
          <div className="px-2 pt-1">
            <ReactECharts option={option} style={{ height: 240 }} notMerge lazyUpdate
                          opts={{ renderer: 'svg' }} />
          </div>
          <div className="px-4 py-2 text-[11px] flex flex-wrap gap-x-5 gap-y-1"
               style={{ color: 'var(--text-low)', borderTop: '1px solid var(--line)' }}>
            <span>{points.length} rolling {windowMonths / 12}-year windows</span>
            {values.length > 0 && (
              <>
                <span>best {asPercent ? pct(Math.max(...values)) : rat(Math.max(...values))}</span>
                <span>worst {asPercent ? pct(Math.min(...values)) : rat(Math.min(...values))}</span>
                {(metric === 'cagr' || metric === 'excess') && (
                  <span>
                    positive in {((values.filter(v => v > 0).length / values.length) * 100).toFixed(0)}%
                    {' '}of windows
                  </span>
                )}
              </>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

// ── drawdown episodes ───────────────────────────────────────────────────────

export function EpisodePanel({ episodes }: { episodes: Episode[] }) {
  return (
    <Card
      title="Deepest falls"
      note={'Each runs from a high-water mark to the day that mark was regained, '
        + 'so a single crash is counted once. Measured on daily closes — month-ends '
        + 'would have missed the 23 March 2020 bottom altogether.'}
    >
      <table className="data-table">
        <thead>
          <tr>
            <th className="ret-cell" style={{ width: 80 }}>Depth</th>
            <th className="text-left">From peak</th>
            <th className="text-left">To trough</th>
            <th className="ret-cell">Fall</th>
            <th className="text-left">Recovered</th>
            <th className="ret-cell">Recovery</th>
          </tr>
        </thead>
        <tbody>
          {episodes.map((e, i) => (
            <tr key={i}>
              <td className="ret-cell tabnum" style={{ color: 'var(--loss)', fontWeight: 700 }}>
                {pct(e.depth, 1)}
              </td>
              <td className="text-left text-xs tabnum">{e.peakDate}</td>
              <td className="text-left text-xs tabnum">{e.troughDate}</td>
              <td className="ret-cell tabnum" style={{ color: 'var(--text-mid)' }}>
                {e.fallDays}d
              </td>
              <td className="text-left text-xs tabnum">
                {e.recoveryDate ?? (
                  <span style={{ color: 'var(--loss)', fontWeight: 600 }}>still under water</span>
                )}
              </td>
              <td className="ret-cell tabnum" style={{ color: 'var(--text-mid)' }}>
                {e.recoveryDays == null ? '—' : `${e.recoveryDays}d`}
              </td>
            </tr>
          ))}
          {!episodes.length && (
            <tr><td colSpan={6} className="text-center py-6 text-xs"
                    style={{ color: 'var(--text-low)' }}>
              No fall from a high-water mark in this window.
            </td></tr>
          )}
        </tbody>
      </table>
      {episodes.some(e => e.underwater) && (
        <div className="px-4 py-2 text-[11px]"
             style={{ color: 'var(--text-low)', borderTop: '1px solid var(--line)' }}>
          An unrecovered drawdown is a live position, not history — the recovery
          column is blank because it has not happened, not because it is unknown.
        </div>
      )}
    </Card>
  )
}

// ── distribution ────────────────────────────────────────────────────────────

export function DistributionPanel({ dist, refLabel }: {
  dist: Distribution; refLabel: string
}) {
  const rows: [string, string, string][] = [
    ['95% monthly VaR', pct(dist.var95),
     'The loss a bad month in twenty reaches. Historical, from the actual months, not a normal curve.'],
    ['95% CVaR', pct(dist.cvar95),
     'Average of the worst 5% of months — what a bad month looks like once it is bad.'],
    ['Best quarter', pct(dist.bestQuarter), 'Strongest calendar quarter in the window.'],
    ['Worst quarter', pct(dist.worstQuarter), 'Weakest calendar quarter in the window.'],
    ['Skew', rat(dist.skew),
     'Negative means the big moves are more often down than up.'],
    ['Excess kurtosis', rat(dist.excessKurtosis),
     'Fat tails. Zero is a normal distribution; above 1 means outliers are common.'],
    ['Beat ' + refLabel, dist.hitRate == null ? '—' : `${(dist.hitRate * 100).toFixed(0)}% of months`,
     'Share of months the blend finished ahead of the category average.'],
    ['Longest winning run', `${dist.longestRun} months`, 'Consecutive positive months.'],
    ['Longest losing run', `${dist.longestDrought} months`, 'Consecutive negative months.'],
  ]
  return (
    <Card title="Shape of the returns"
          right={<span className="text-[11px]" style={{ color: 'var(--text-low)' }}>
            {dist.months} months
          </span>}>
      <table className="data-table">
        <tbody>
          {rows.map(([label, value, hint]) => (
            <tr key={label}>
              <td className="text-left text-xs" title={hint}>
                {label}
                <span className="ml-1" style={{ color: 'var(--text-low)' }}>ⓘ</span>
              </td>
              <td className="ret-cell tabnum" style={{ color: 'var(--text-hi)' }}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {dist.months < 36 && (
        <div className="px-4 py-2 text-[11px]"
             style={{ color: 'var(--text-low)', borderTop: '1px solid var(--line)' }}>
          Tail measures need a long sample to mean much. {dist.months} months gives
          roughly {Math.max(1, Math.round(dist.months * 0.05))} observation(s) in the
          worst 5%, so VaR and CVaR here are indicative at best.
        </div>
      )}
    </Card>
  )
}

// ── stress ──────────────────────────────────────────────────────────────────

export function StressPanel({ rows, refLabel }: { rows: StressRow[]; refLabel: string }) {
  return (
    <Card
      title="How it behaved when it mattered"
      note={'Calendar windows, stated as dates. The row shows what each line did '
        + 'between those two dates and claims nothing about cause. A window the '
        + 'data does not substantially cover is left out rather than shown short.'}
    >
      <table className="data-table">
        <thead>
          <tr>
            <th className="text-left" style={{ minWidth: 150 }}>Episode</th>
            <th className="text-left" style={{ minWidth: 150 }}>Window</th>
            <th className="ret-cell" style={{ color: BLEND_COLOUR }}>Blend</th>
            <th className="ret-cell">{refLabel}</th>
            <th className="ret-cell">Diff</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label}>
              <td className="text-left text-xs" title={r.note}>
                {r.label}
                <div style={{ fontSize: 10, color: 'var(--text-low)' }}>{r.note}</div>
              </td>
              <td className="text-left text-[11px] tabnum" style={{ color: 'var(--text-mid)' }}>
                {r.from} → {r.to}
              </td>
              <td className={`ret-cell ${retColor(r.blend)}`}>{pct(r.blend, 1)}</td>
              <td className={`ret-cell ${retColor(r.ref)}`}>{pct(r.ref, 1)}</td>
              <td className="ret-cell">
                {r.diff != null && (
                  <span className={`spread-chip ${r.diff >= 0 ? 'pos' : 'neg'}`}>
                    {r.diff >= 0 ? '+' : ''}{(r.diff * 100).toFixed(1)}%
                  </span>
                )}
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td colSpan={5} className="text-center py-6 text-xs"
                    style={{ color: 'var(--text-low)' }}>
              No stress window falls inside this measurement period. Widen it to Max.
            </td></tr>
          )}
        </tbody>
      </table>
    </Card>
  )
}

// ── monthly heatmap ─────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function HeatmapPanel({ grid }: {
  grid: { years: string[]; cells: Record<string, (number | null)[]> }
}) {
  const all = grid.years.flatMap(y => grid.cells[y]).filter((v): v is number => v != null)
  const scale = all.length ? Math.max(...all.map(Math.abs)) : 0.05
  const shade = (v: number | null) => {
    if (v == null) return { background: 'transparent', color: 'var(--text-low)' }
    const a = 0.10 + Math.min(1, Math.abs(v) / (scale || 1)) * 0.42
    return {
      background: v >= 0 ? `rgba(52,211,153,${a})` : `rgba(248,113,113,${a})`,
      color: 'var(--text-hi)',
    }
  }
  return (
    <Card
      title="Monthly returns"
      note={'Shaded against the largest absolute month in this window, so the '
        + 'colour is relative to what this portfolio actually did rather than to a '
        + 'fixed scale. A blank cell is a month with no complete pair of closes.'}
    >
      <div className="table-scroll" style={{ ['--table-max-h' as string]: '340px' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th className="text-left sticky-col" style={{ minWidth: 58 }}>Year</th>
              {MONTHS.map(m => (
                <th key={m} className="ret-cell" style={{ minWidth: 52, fontSize: 10 }}>{m}</th>
              ))}
              <th className="ret-cell" style={{ minWidth: 62, fontSize: 10 }}>Year</th>
            </tr>
          </thead>
          <tbody>
            {grid.years.map(y => {
              const cells = grid.cells[y]
              const present = cells.filter((v): v is number => v != null)
              const yearRet = present.length
                ? present.reduce((a, v) => a * (1 + v), 1) - 1 : null
              return (
                <tr key={y}>
                  <td className="text-left text-xs sticky-col tabnum">{y}</td>
                  {cells.map((v, i) => (
                    <td key={i} className="ret-cell tabnum" style={{ ...shade(v), fontSize: 10 }}>
                      {v == null ? '' : `${(v * 100).toFixed(1)}`}
                    </td>
                  ))}
                  <td className={`ret-cell tabnum ${retColor(yearRet)}`}
                      style={{ fontWeight: 600 }}
                      title={present.length < 12
                        ? `${present.length} of 12 months present` : 'full year'}>
                    {yearRet == null ? '—' : `${(yearRet * 100).toFixed(1)}`}
                    {present.length < 12 && (
                      <span style={{ color: 'var(--text-low)', fontSize: 9 }}>*</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 text-[11px]"
           style={{ color: 'var(--text-low)', borderTop: '1px solid var(--line)' }}>
        Figures are percent. The Year column compounds the months shown, so a row
        marked * is a part year and not comparable with a full one.
      </div>
    </Card>
  )
}

// ── rebalancing comparison ──────────────────────────────────────────────────

export function RebalancePanel({ rows, active, onPick }: {
  rows: { freq: Rebalance; stats: BlendStats; drift: number | null }[]
  active: Rebalance
  onPick: (f: Rebalance) => void
}) {
  return (
    <Card
      title="What the rebalancing rule costs"
      note={'The same components and weights under every rule, measured over the '
        + 'same window. Rebalancing is not free and not obviously good: it trims '
        + 'the winner, which lowers return in a trending market and lowers risk in '
        + 'every market.'}
    >
      <table className="data-table">
        <thead>
          <tr>
            <th className="text-left" style={{ minWidth: 110 }}>Rule</th>
            <th className="ret-cell">CAGR</th>
            <th className="ret-cell">Vol</th>
            <th className="ret-cell">Sharpe</th>
            <th className="ret-cell">Max DD</th>
            <th className="ret-cell" title="How far the largest sleeve ended from its target">
              Drift
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.freq} style={r.freq === active
              ? { background: `${BLEND_COLOUR}12`, boxShadow: `inset 3px 0 0 ${BLEND_COLOUR}` }
              : undefined}>
              <td className="text-left text-xs" style={{
                fontWeight: r.freq === active ? 700 : 500,
                color: r.freq === active ? BLEND_COLOUR : 'var(--text-hi)',
              }}>
                {REBALANCE_LABELS[r.freq]}
              </td>
              <td className={`ret-cell ${retColor(r.stats.cagr)}`}>{pct(r.stats.cagr)}</td>
              <td className="ret-cell tabnum">{pct(r.stats.vol)}</td>
              <td className="ret-cell tabnum">{rat(r.stats.sharpe)}</td>
              <td className="ret-cell tabnum" style={{ color: 'var(--loss)' }}>
                {pct(r.stats.maxDrawdown, 1)}
              </td>
              <td className="ret-cell tabnum" style={{ color: 'var(--text-mid)' }}>
                {r.drift == null ? '—' : `${r.drift >= 0 ? '+' : ''}${r.drift.toFixed(1)}pp`}
              </td>
              <td>
                {r.freq !== active && (
                  <button onClick={() => onPick(r.freq)} className="pill text-[10px]">Use</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

// ── growth / drawdown charts, shared by the overview ────────────────────────

export function growthOption(
  blend: Series, ref: Series, refLabel: string, extra?: { label: string; series: Series },
) {
  const c = themeColours()
  if (blend.length < 2) return null
  const base = (s: Series) => {
    if (!s.length || !s[0][1]) return new Map<string, number>()
    const b = s[0][1]
    return new Map(s.map(([d, v]) => [d, ((v / b) - 1) * 100]))
  }
  const b = base(blend)
  const r = base(ref)
  const x = base(extra?.series ?? [])
  const dates = blend.map(([d]) => d)
  const line = (name: string, map: Map<string, number>, colour: string, dash: boolean) => ({
    name, type: 'line', smooth: true, showSymbol: false,
    data: dates.map(d => { const v = map.get(d); return v == null ? null : +v.toFixed(2) }),
    lineStyle: { width: dash ? 1.6 : 2.5, type: dash ? 'dashed' : 'solid', color: colour },
    itemStyle: { color: colour },
    ...(dash ? {} : {
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [{ offset: 0, color: `${colour}38` }, { offset: 1, color: `${colour}00` }],
        },
      },
    }),
  })
  return {
    backgroundColor: 'transparent',
    grid: { top: 34, right: 18, bottom: 30, left: 58 },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: c.grid } },
      axisLabel: { color: c.axis, fontSize: 10, interval: Math.floor(dates.length / 7) || 0 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', axisLine: { show: false },
      axisLabel: { color: c.axis, fontSize: 10,
                   formatter: (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%` },
      splitLine: { lineStyle: { color: c.grid, type: 'dashed' } },
    },
    tooltip: {
      trigger: 'axis', backgroundColor: c.tipBg, borderColor: c.tipLine,
      textStyle: { color: c.tipText, fontSize: 11 },
      axisPointer: { lineStyle: { color: BLEND_COLOUR, width: 1, type: 'dashed' } },
      valueFormatter: (v: number) => v == null ? '—'
        : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}%`,
    },
    legend: { show: true, top: 2, textStyle: { color: c.axis, fontSize: 11 } },
    series: [
      line('Your blend', b, BLEND_COLOUR, false),
      line(refLabel, r, c.ref, true),
      ...(extra && x.size ? [line(extra.label, x, '#F59E0B', true)] : []),
    ],
  }
}

export function drawdownOption(blend: Series, ref: Series, refLabel: string) {
  const c = themeColours()
  if (blend.length < 2) return null
  const under = (s: Series) => {
    if (!s.length) return new Map<string, number>()
    let peak = s[0][1]
    return new Map(s.map(([d, v]) => {
      if (v > peak) peak = v
      return [d, peak > 0 ? ((v / peak) - 1) * 100 : 0]
    }))
  }
  const b = under(blend)
  const r = under(ref)
  const dates = blend.map(([d]) => d)
  return {
    backgroundColor: 'transparent',
    grid: { top: 30, right: 18, bottom: 28, left: 54 },
    xAxis: {
      type: 'category', data: dates, boundaryGap: false,
      axisLine: { lineStyle: { color: c.grid } },
      axisLabel: { color: c.axis, fontSize: 10, interval: Math.floor(dates.length / 7) || 0 },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', max: 0, axisLine: { show: false },
      axisLabel: { color: c.axis, fontSize: 10, formatter: (v: number) => `${v.toFixed(0)}%` },
      splitLine: { lineStyle: { color: c.grid, type: 'dashed' } },
    },
    tooltip: {
      trigger: 'axis', backgroundColor: c.tipBg, borderColor: c.tipLine,
      textStyle: { color: c.tipText, fontSize: 11 },
      valueFormatter: (v: number) => v == null ? '—' : `${Number(v).toFixed(2)}%`,
    },
    legend: { show: true, top: 0, textStyle: { color: c.axis, fontSize: 10 } },
    series: [
      {
        name: 'Your blend', type: 'line', smooth: true, showSymbol: false,
        data: dates.map(d => +(b.get(d) ?? 0).toFixed(2)),
        lineStyle: { width: 2, color: '#F87171' }, itemStyle: { color: '#F87171' },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: '#F8717100' }, { offset: 1, color: '#F8717145' }],
          },
        },
      },
      {
        name: refLabel, type: 'line', smooth: true, showSymbol: false,
        data: dates.map(d => { const v = r.get(d); return v == null ? null : +v.toFixed(2) }),
        lineStyle: { width: 1.5, type: 'dashed', color: c.ref }, itemStyle: { color: c.ref },
      },
    ],
  }
}
