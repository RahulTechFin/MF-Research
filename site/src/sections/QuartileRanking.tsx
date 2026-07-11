// src/sections/QuartileRanking.tsx — Section 6: Quartile Ranking — Full Professional Suite

import { useState, useMemo } from 'react'
import { useMeta, useQuartiles } from '../hooks/useData'
import { quartilePillClass, fmtPct, shortFundName } from '../utils/format'

/* ─── Constants ──────────────────────────────────────────── */
const EQUITY_HYBRID_CLASSES = ['Equity', 'Hybrid']
const MAIN_TAB_NAMES = [
  'Large Cap', 'Large & Mid Cap', 'Mid Cap', 'Small Cap',
  'Flexi Cap', 'Balanced Advantage', 'Multi Asset Allocation',
]
const Q_COLORS: Record<number, string> = {
  1: '#34D399', 2: '#F59E0B', 3: '#F472B6', 4: '#F87171',
}
const Q_BG: Record<number, string> = {
  1: 'rgba(52,211,153,0.15)', 2: 'rgba(245,158,11,0.15)',
  3: 'rgba(244,114,182,0.15)', 4: 'rgba(248,113,113,0.15)',
}

/* ─── Helpers ────────────────────────────────────────────── */

/** "Q2-2026" → "Q2-2026 (Apr - June 26)" */
function parsePeriodLabel(label: string): string {
  const qMatch = label.match(/^Q(\d)-(\d{4})$/)
  if (qMatch) {
    const q = parseInt(qMatch[1])
    const yr = qMatch[2].slice(2)
    const months = ['Jan - Mar', 'Apr - June', 'July - Sept', 'Oct - Dec'][q - 1] ?? ''
    return `${label} (${months} ${yr})`
  }
  return label
}

/* ─── Small Components ───────────────────────────────────── */

function QuartileBar({ history }: { history: (number | null)[] }) {
  return (
    <div className="flex gap-0.5 mt-1.5 flex-wrap">
      {history.map((q, i) => (
        <div
          key={i}
          title={q ? `Q${q}` : '—'}
          style={{
            width: 15, height: 15, borderRadius: 3,
            background: q ? Q_BG[q] : 'var(--bg-raised)',
            border: q ? `1px solid ${Q_COLORS[q]}44` : '1px solid var(--line)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 8, color: q ? Q_COLORS[q] : 'var(--text-low)', fontWeight: 700,
          }}
        >
          {q ?? ''}
        </div>
      ))}
    </div>
  )
}

function RankBadge({ rank }: { rank: number }) {
  const style = rank === 1
    ? { background: 'linear-gradient(135deg,#F59E0B,#FCD34D)', color: '#000' }
    : rank === 2
    ? { background: 'linear-gradient(135deg,#9CA3AF,#D1D5DB)', color: '#000' }
    : rank === 3
    ? { background: 'linear-gradient(135deg,#B45309,#D97706)', color: '#000' }
    : { background: 'var(--bg-raised)', color: 'var(--text-mid)', border: '1px solid var(--line)' }
  return (
    <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold mt-0.5" style={style}>
      {rank <= 3 ? ['🥇','🥈','🥉'][rank - 1] : rank}
    </div>
  )
}

function HowToRead({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-xl overflow-hidden mb-3" style={{ border: '1px solid rgba(34,211,238,0.2)', background: 'rgba(34,211,238,0.04)' }}>
      <button
        className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-left"
        style={{ color: 'var(--accent-a)' }}
        onClick={() => setOpen(v => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>
        </svg>
        How to read this section
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          style={{ marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 200ms' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div className="px-4 pb-3 text-xs leading-relaxed" style={{ color: 'var(--text-mid)', borderTop: '1px solid rgba(34,211,238,0.15)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

function InsightHeader({
  icon, title, subtitle, count, accentColor, onHelpClick,
}: {
  icon: React.ReactNode; title: string; subtitle: string; count?: number; accentColor: string; onHelpClick?: () => void;
}) {
  return (
    <div
      className="px-5 py-4 border-b flex items-center justify-between gap-3"
      style={{
        borderColor: `${accentColor}25`,
        background: `linear-gradient(135deg, ${accentColor}0A 0%, var(--bg-card) 100%)`,
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 font-display font-bold text-sm" style={{ color: accentColor }}>
          {icon} {title}
        </div>
        <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-low)' }}>{subtitle}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {count !== undefined && (
          <div className="text-xs px-2.5 py-1 rounded-full font-semibold" style={{ background: `${accentColor}18`, color: accentColor, border: `1px solid ${accentColor}30` }}>
            {count} funds
          </div>
        )}
        {onHelpClick && (
          <button
            onClick={onHelpClick}
            className="p-1 rounded-lg transition-colors hover:bg-white/5"
            style={{ border: '1px solid var(--line)', color: accentColor, background: 'transparent', cursor: 'pointer', fontSize: 13 }}
            title="Explanation (Click to learn more)"
          >
            💡
          </button>
        )}
      </div>
    </div>
  )
}

/* ─── Main Component ─────────────────────────────────────── */

export default function QuartileRanking() {
  const { data: meta } = useMeta()
  const [slug, setSlug] = useState<string>('')
  const [mode, setMode] = useState<'quarterly' | 'annual'>('quarterly')
  const [showHelpModal, setShowHelpModal] = useState(false)
  const [activeHelp, setActiveHelp] = useState<{ title: string; meaning: string; helpful: string } | null>(null)

  const eligibleCats = (meta?.categories ?? []).filter(c => EQUITY_HYBRID_CLASSES.includes(c.asset_class))
  const activeSlug = slug || (eligibleCats[0]?.slug ?? '')
  const { data, loading } = useQuartiles(activeSlug, mode)

  const mainTabs  = eligibleCats.filter(c => MAIN_TAB_NAMES.includes(c.category_name))
  const otherCats = eligibleCats.filter(c => !MAIN_TAB_NAMES.includes(c.category_name))

  const reversedPeriodLabels = data ? [...data.period_labels].reverse() : []

  // Fund name lookup
  const fundNameMap = useMemo(
    () => new Map(data?.funds.map(f => [f.scheme_code, f.scheme_name]) ?? []),
    [data]
  )
  const getName = (code: string) => shortFundName(fundNameMap.get(code) || code)

  // Fund quartile history lookup
  const fundHistoryMap = useMemo(
    () => new Map(data?.funds.map(f => [f.scheme_code, f.quartiles as (number | null)[]]) ?? []),
    [data]
  )

  /* ── Computed Insights (all from funds array) ───────── */
  const insights = useMemo(() => {
    if (!data || data.funds.length === 0) return null
    const funds = data.funds
    const n = data.period_labels.length

    // Q1 Strike Rate — pct of non-null periods in Q1
    const strikeRate = funds
      .map(f => {
        const qs = f.quartiles as (number | null)[]
        const valid = qs.filter(q => q !== null)
        const q1cnt = qs.filter(q => q === 1).length
        return { code: f.scheme_code, rate: valid.length > 0 ? q1cnt / valid.length : 0, q1cnt, total: valid.length, history: qs }
      })
      .filter(x => x.total >= 4)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 5)

    // Consecutive Q1 Streak — count trailing Q1s from end
    const streak = funds
      .map(f => {
        const qs = (f.quartiles as (number | null)[]).filter(q => q !== null)
        let cnt = 0
        for (let i = qs.length - 1; i >= 0; i--) {
          if (qs[i] === 1) cnt++; else break
        }
        return { code: f.scheme_code, streak: cnt, history: f.quartiles as (number | null)[] }
      })
      .filter(x => x.streak >= 2)
      .sort((a, b) => b.streak - a.streak)
      .slice(0, 5)

    // Fallen Angels — was Q1 in majority of past periods, now Q3/Q4 last 2
    const lookback = Math.min(n, 8)
    const recentN  = 2
    const fallenAngels = funds
      .map(f => {
        const qs = (f.quartiles as (number | null)[]).slice(-lookback)
        const past = qs.slice(0, lookback - recentN).filter(q => q !== null)
        const recent = qs.slice(-recentN).filter(q => q !== null)
        const pastQ1Pct  = past.length > 0 ? past.filter(q => q === 1).length / past.length : 0
        const recentBad  = recent.length > 0 && recent.every(q => (q ?? 0) >= 3)
        return { code: f.scheme_code, pastQ1Pct, history: f.quartiles as (number | null)[] }
      })
      .filter(x => x.pastQ1Pct >= 0.4 && (() => {
        const r = (fundHistoryMap.get(x.code) ?? []).slice(-recentN).filter(q => q !== null)
        return r.length > 0 && r.every(q => (q ?? 0) >= 3)
      })())
      .sort((a, b) => b.pastQ1Pct - a.pastQ1Pct)
      .slice(0, 5)

    // Rising Stars — was Q3/Q4 in majority of past periods, now Q1/Q2 last 2
    const risingStars = funds
      .map(f => {
        const qs = (f.quartiles as (number | null)[]).slice(-lookback)
        const past = qs.slice(0, lookback - recentN).filter(q => q !== null)
        const recent = qs.slice(-recentN).filter(q => q !== null)
        const pastBadPct  = past.length > 0 ? past.filter(q => (q ?? 0) >= 3).length / past.length : 0
        const recentGood  = recent.length > 0 && recent.every(q => (q ?? 0) <= 2 && (q ?? 0) > 0)
        return { code: f.scheme_code, pastBadPct, recentGood, history: f.quartiles as (number | null)[] }
      })
      .filter(x => x.pastBadPct >= 0.4 && x.recentGood)
      .sort((a, b) => b.pastBadPct - a.pastBadPct)
      .slice(0, 5)

    // Q1 Persistence Rate — what % of Q1 funds in period (t-1) stayed in Q1/Q2 in period (t)
    const persistenceTrend = data.period_labels.map((_, i) => {
      if (i === 0) return null
      let prevQ1Count = 0
      let retainedCount = 0
      funds.forEach(f => {
        const prevQ = (f.quartiles as (number | null)[])[i - 1]
        const currQ = (f.quartiles as (number | null)[])[i]
        if (prevQ === 1) {
          prevQ1Count++
          if (currQ === 1 || currQ === 2) {
            retainedCount++
          }
        }
      })
      return prevQ1Count > 0 ? (retainedCount / prevQ1Count) * 100 : null
    })

    return { strikeRate, streak, fallenAngels, risingStars, persistenceTrend }
  }, [data, fundHistoryMap])

  return (
    <>
      <section id="quartile-ranking" className="px-6 py-6 max-w-screen-2xl mx-auto">
        <div className="section-header">
          <span>Quartile Ranking</span>
          <button
            onClick={() => setShowHelpModal(true)}
            className="tab-btn font-semibold ml-auto"
            style={{
              borderColor: 'var(--accent-a)',
              background: 'rgba(34,211,238,0.08)',
              color: 'var(--accent-a)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '11px',
              padding: '4px 10px',
              borderRadius: '6px',
            }}
          >
            📖 How to Read
          </button>
        </div>

      {/* ── Controls ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex gap-2 flex-wrap items-center">
          <div className="tab-bar">
            {mainTabs.map(c => (
              <button key={c.slug} onClick={() => setSlug(c.slug)}
                className={`tab-btn${activeSlug === c.slug ? ' active accent' : ''}`}>
                {c.category_name}
              </button>
            ))}
          </div>
          {otherCats.length > 0 && (
            <select
              value={mainTabs.some(c => c.slug === activeSlug) ? '' : activeSlug}
              onChange={e => { if (e.target.value) setSlug(e.target.value) }}
              className="px-3 py-1.5 rounded-lg text-sm"
              style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-hi)', outline: 'none' }}
            >
              <option value="" disabled>-- Other Categories --</option>
              {otherCats.map(c => <option key={c.slug} value={c.slug}>{c.category_name}</option>)}
            </select>
          )}
        </div>
        <div className="tab-bar shrink-0">
          <button onClick={() => setMode('quarterly')} className={`tab-btn${mode === 'quarterly' ? ' active accent' : ''}`}>Quarterly</button>
          <button onClick={() => setMode('annual')}    className={`tab-btn${mode === 'annual'    ? ' active accent' : ''}`}>Annual</button>
        </div>
      </div>

      {/* ── Legend ───────────────────────────────────────────────── */}
      <div className="flex gap-4 mb-4 flex-wrap">
        {[
          { q: 1, label: 'Top 25%',    desc: 'Outperformer' },
          { q: 2, label: '25–50%',     desc: 'Above Average' },
          { q: 3, label: '50–75%',     desc: 'Below Average' },
          { q: 4, label: 'Bottom 25%', desc: 'Underperformer' },
        ].map(({ q, label, desc }) => (
          <div key={q} className="flex items-center gap-2 text-xs" style={{ color: 'var(--text-mid)' }}>
            <div className={quartilePillClass(q)}>Q{q}</div>
            <div>
              <div className="font-semibold">{label}</div>
              <div style={{ color: 'var(--text-low)', fontSize: 10 }}>{desc}</div>
            </div>
          </div>
        ))}
        <div className="ml-auto text-xs" style={{ color: 'var(--text-low)', alignSelf: 'center' }}>
          Columns sorted latest → oldest
        </div>
      </div>

      {/* ── Quartile Table ───────────────────────────────────────── */}
      <div className="card overflow-hidden mb-6">
        {loading ? (
          <div className="p-6 space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}</div>
        ) : data ? (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col text-left" style={{ minWidth: 240 }}>Fund</th>
                  {reversedPeriodLabels.map(p => (
                    <th key={p} style={{ minWidth: 150, textAlign: 'center', fontSize: 11 }}>
                      {parsePeriodLabel(p)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.funds.map(fund => (
                  <tr key={fund.scheme_code}>
                    <td className="sticky-col text-xs font-medium truncate" style={{ maxWidth: 240 }}>
                      {fund.scheme_name}
                    </td>
                    {[...fund.quartiles].reverse().map((q, i) => (
                      <td key={i} className="text-center">
                        <div className={quartilePillClass(q as number | null)}>{q ? `Q${q}` : '−'}</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center" style={{ color: 'var(--text-mid)' }}>No quartile data yet. Complete the backfill first.</div>
        )}
      </div>

      {/* ── Insight Panels — Row 1 ───────────────────────────────── */}
      {data && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">

            {/* Most Consistent */}
            <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(52,211,153,0.25)', background: 'var(--bg-card)' }}>
              <InsightHeader
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/></svg>}
                title="Most Consistent Performers"
                subtitle="Lowest average quartile rank — steady, reliable outperformance"
                count={data.most_consistent.length}
                accentColor="#34D399"
                onHelpClick={() => setActiveHelp({
                  title: "🏆 Most Consistent Performers",
                  meaning: "Funds that regularly maintain top-tier rankings (Q1 or Q2) across consecutive periods, rarely slipping into the underperforming quartiles.",
                  helpful: "Best used for selecting core holdings in a long-term portfolio. High consistency implies a robust investing process and a manager capable of navigating various market conditions successfully."
                })}
              />
              <div className="p-4">
                {data.most_consistent.length === 0 ? (
                  <div className="text-xs py-6 text-center" style={{ color: 'var(--text-low)' }}>Need minimum 6 completed periods.</div>
                ) : (
                  <div className="space-y-4">
                    {data.most_consistent.map((entry, i) => {
                      const q1Pct = Math.round((entry.pct_q1 ?? 0) * 100)
                      return (
                        <div key={entry.scheme_code} className="flex items-start gap-3">
                          <RankBadge rank={i + 1} />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-hi)' }}>
                              {getName(entry.scheme_code)}
                            </div>
                            <div className="flex items-center gap-3 mt-1">
                              <span className="text-xs" style={{ color: 'var(--text-low)' }}>
                                Avg Q: <strong style={{ color: '#34D399' }}>{entry.avg_quartile.toFixed(2)}</strong>
                              </span>
                              <span className="text-xs" style={{ color: 'var(--text-low)' }}>
                                Q1 Rate: <strong style={{ color: q1Pct >= 50 ? '#34D399' : 'var(--text-mid)' }}>{q1Pct}%</strong>
                              </span>
                              <div className="flex-1 rounded-full overflow-hidden" style={{ height: 4, background: 'var(--bg-raised)', minWidth: 40 }}>
                                <div style={{ width: `${q1Pct}%`, height: '100%', borderRadius: 9999, background: q1Pct >= 60 ? 'linear-gradient(90deg,#34D399,#6EE7B7)' : q1Pct >= 40 ? 'linear-gradient(90deg,#F59E0B,#FCD34D)' : 'linear-gradient(90deg,#F87171,#FCA5A5)', transition: 'width 0.4s' }} />
                              </div>
                            </div>
                            <QuartileBar history={entry.history} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Most Volatile */}
            <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(251,146,60,0.25)', background: 'var(--bg-card)' }}>
              <InsightHeader
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>}
                title="Most Volatile Performers"
                subtitle="Highest return standard deviation — extreme swings between quarters"
                count={data.most_volatile.length}
                accentColor="#FB923C"
                onHelpClick={() => setActiveHelp({
                  title: "⚡ Most Volatile Performers",
                  meaning: "Funds with the highest volatility (standard deviation of returns), showing frequent rank swings between quarters.",
                  helpful: "Useful for identifying high-beta, aggressive strategies. While these funds can yield massive returns during market upswings, their extreme swings require caution and tactical monitoring."
                })}
              />
              <div className="p-4">
                {data.most_volatile.length === 0 ? (
                  <div className="text-xs py-6 text-center" style={{ color: 'var(--text-low)' }}>Need minimum 6 completed periods.</div>
                ) : (
                  <div className="space-y-4">
                    {data.most_volatile.map((entry, i) => {
                      const history = fundHistoryMap.get(entry.scheme_code) ?? []
                      return (
                        <div key={entry.scheme_code} className="flex items-start gap-3">
                          <RankBadge rank={i + 1} />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-hi)' }}>
                              {getName(entry.scheme_code)}
                            </div>
                            <div className="flex items-center gap-3 mt-1">
                              <span className="text-xs" style={{ color: 'var(--text-low)' }}>
                                Volatility (σ): <strong style={{ color: '#FB923C' }}>{fmtPct(entry.sigma)}</strong>
                              </span>
                            </div>
                            <QuartileBar history={history} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Insight Panels — Row 2 ─────────────────────────────── */}
          {insights && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-5">

                {/* Q1 Strike Rate Leaderboard */}
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(34,211,238,0.25)', background: 'var(--bg-card)' }}>
                  <InsightHeader
                    icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>}
                    title="Q1 Strike Rate"
                    subtitle="% of periods ranked in Top 25% — higher is better"
                    accentColor="#22D3EE"
                    onHelpClick={() => setActiveHelp({
                      title: "📈 Q1 Strike Rate Leaderboard",
                      meaning: "The percentage of all active historical periods that a fund has successfully finished in the top 25% (Q1) of its peer group.",
                      helpful: "Helps rule out 'one-hit wonders'. A strike rate above 50% indicates persistent, repeatable outperformance rather than a single lucky period."
                    })}
                  />
                  <div className="p-4">
                    {insights.strikeRate.length === 0 ? (
                      <div className="text-xs py-4 text-center" style={{ color: 'var(--text-low)' }}>Need at least 4 completed periods.</div>
                    ) : (
                      <div className="space-y-3">
                        {insights.strikeRate.map((entry, i) => (
                          <div key={entry.code} className="flex items-center gap-2.5">
                            <div className="text-xs font-bold w-4 text-right shrink-0" style={{ color: 'var(--text-low)' }}>{i + 1}</div>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-semibold truncate mb-1" style={{ color: 'var(--text-hi)' }}>
                                {getName(entry.code)}
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="flex-1 rounded-full overflow-hidden" style={{ height: 6, background: 'var(--bg-raised)' }}>
                                  <div style={{ width: `${Math.round(entry.rate * 100)}%`, height: '100%', borderRadius: 9999, background: 'linear-gradient(90deg,#22D3EE,#38BDF8)', transition: 'width 0.4s' }} />
                                </div>
                                <span className="text-xs font-bold shrink-0" style={{ color: '#22D3EE', minWidth: 32 }}>
                                  {Math.round(entry.rate * 100)}%
                                </span>
                              </div>
                              <div className="text-xs mt-0.5" style={{ color: 'var(--text-low)', fontSize: 10 }}>
                                {entry.q1cnt} of {entry.total} periods in Q1
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Consecutive Q1 Streak */}
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.25)', background: 'var(--bg-card)' }}>
                  <InsightHeader
                    icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87m-4-12a4 4 0 0 1 0 7.75"/></svg>}
                    title="Consecutive Q1 Streaks"
                    subtitle="Funds on an unbroken run of top-quartile performance"
                    accentColor="#8B5CF6"
                    onHelpClick={() => setActiveHelp({
                      title: "🔥 Consecutive Q1 Streaks",
                      meaning: "Funds currently on an active, uninterrupted run of top-quartile (Q1) performance over consecutive quarters.",
                      helpful: "Identifies strong near-term momentum. Useful to see which managers are currently in a highly favorable macro cycle or holding winning sector allocations."
                    })}
                  />
                  <div className="p-4">
                    {insights.streak.length === 0 ? (
                      <div className="text-xs py-4 text-center" style={{ color: 'var(--text-low)' }}>No fund has 2+ consecutive Q1 periods currently.</div>
                    ) : (
                      <div className="space-y-3">
                        {insights.streak.map((entry, i) => (
                          <div key={entry.code} className="flex items-start gap-2.5">
                            <div className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold mt-0.5"
                              style={{ background: 'rgba(139,92,246,0.15)', color: '#8B5CF6' }}>{i + 1}</div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <div className="text-xs font-semibold truncate flex-1" style={{ color: 'var(--text-hi)' }}>
                                  {getName(entry.code)}
                                </div>
                                <div className="shrink-0 px-2 py-0.5 rounded-full text-xs font-bold"
                                  style={{ background: 'rgba(139,92,246,0.15)', color: '#8B5CF6', whiteSpace: 'nowrap' }}>
                                  🔥 {entry.streak} in a row
                                </div>
                              </div>
                              <QuartileBar history={entry.history} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Q1 Persistence Rate (Quartile Retention) */}
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.25)', background: 'var(--bg-card)' }}>
                  <InsightHeader
                    icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>}
                    title="Q1 Persistence Rate"
                    subtitle="% of Q1 funds that stayed in Q1/Q2 next period"
                    accentColor="#8B5CF6"
                    onHelpClick={() => setActiveHelp({
                      title: "📊 Q1 Persistence Rate (Quartile Retention)",
                      meaning: "The percentage of funds that were in Q1 (Top 25%) in the previous quarter and managed to remain in the top half (Q1 or Q2) in the next quarter.",
                      helpful: "Measures overall category consistency. A high persistence rate suggests that outperformance in this category is durable; a low rate suggests top performers rotate rapidly due to cyclical factors."
                    })}
                  />
                  <div className="p-4">
                    <div className="space-y-2">
                      {data.period_labels.map((label, i) => {
                        const pct = insights.persistenceTrend[i]
                        if (pct === null) return null
                        const formattedLabel = parsePeriodLabel(label)
                        const barColor = pct >= 65 ? '#34D399' : pct >= 45 ? '#F59E0B' : '#F87171'
                        return (
                          <div key={label} className="flex items-center gap-2">
                            <div className="text-xs shrink-0" style={{ color: 'var(--text-low)', minWidth: 140 }}>
                              <div style={{ fontWeight: 600, color: 'var(--text-mid)', fontSize: 10 }}>{formattedLabel}</div>
                            </div>
                            <div className="flex-1 rounded-full overflow-hidden" style={{ height: 6, background: 'var(--bg-raised)' }}>
                              <div style={{ width: `${pct}%`, height: '100%', borderRadius: 9999, background: barColor, transition: 'width 0.4s' }} />
                            </div>
                            <div className="text-xs font-bold shrink-0" style={{ color: barColor, minWidth: 32, textAlign: 'right' }}>
                              {Math.round(pct)}%
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <div className="text-xs mt-3 text-center" style={{ color: 'var(--text-low)', lineHeight: 1.3 }}>
                      Higher % = Top managers consistently retain their lead.<br />
                      Lower % = Rapid rotation among top performers.
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Fallen Angels + Rising Stars ───────────────────── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">

                {/* Fallen Angels */}
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(248,113,113,0.25)', background: 'var(--bg-card)' }}>
                  <InsightHeader
                    icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>}
                    title="Fallen Angels"
                    subtitle="Historically strong funds that have recently slipped to Q3/Q4"
                    count={insights.fallenAngels.length}
                    accentColor="#F87171"
                    onHelpClick={() => setActiveHelp({
                      title: "⚠️ Fallen Angels",
                      meaning: "Funds that ranked heavily in the top tiers (Q1/Q2) historically, but have recently dropped into the bottom tiers (Q3/Q4) in the last 2 quarters.",
                      helpful: "Serves as an early warning system. Alerts you to funds experiencing style drift, fund manager changes, or deteriorating momentum, indicating it might be time to exit."
                    })}
                  />
                  <div className="p-4">
                    {insights.fallenAngels.length === 0 ? (
                      <div className="text-xs py-4 text-center" style={{ color: 'var(--text-low)' }}>
                        No fallen angels detected. Good sign — previous top performers are holding up.
                      </div>
                    ) : (
                      <>
                        <div className="text-xs mb-3 px-3 py-2 rounded-lg" style={{ background: 'rgba(248,113,113,0.08)', color: '#F87171', border: '1px solid rgba(248,113,113,0.2)' }}>
                          ⚠️ These funds ranked Q1/Q2 historically but have dropped to Q3/Q4 in the last 2 periods. Monitor closely — may signal a change in fund management or strategy.
                        </div>
                        <div className="space-y-4">
                          {insights.fallenAngels.map((entry, i) => (
                            <div key={entry.code} className="flex items-start gap-3">
                              <RankBadge rank={i + 1} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <div className="text-xs font-semibold truncate flex-1" style={{ color: 'var(--text-hi)' }}>
                                    {getName(entry.code)}
                                  </div>
                                  <span className="text-xs px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(248,113,113,0.1)', color: '#F87171', fontSize: 10 }}>
                                    {Math.round(entry.pastQ1Pct * 100)}% historical Q1
                                  </span>
                                </div>
                                <QuartileBar history={entry.history} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Rising Stars */}
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(56,189,248,0.25)', background: 'var(--bg-card)' }}>
                  <InsightHeader
                    icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>}
                    title="Rising Stars"
                    subtitle="Previously weak funds that have recently surged to Q1/Q2"
                    count={insights.risingStars.length}
                    accentColor="#38BDF8"
                    onHelpClick={() => setActiveHelp({
                      title: "💡 Rising Stars",
                      meaning: "Funds that previously spent most of their time in the underperforming bottom tiers (Q3/Q4) but have recently climbed to Q1/Q2.",
                      helpful: "Turnaround candidates. Helps identify turnaround managers, style adjustments, or strategies that are gaining momentum before they attract massive fund flows."
                    })}
                  />
                  <div className="p-4">
                    {insights.risingStars.length === 0 ? (
                      <div className="text-xs py-4 text-center" style={{ color: 'var(--text-low)' }}>
                        No rising stars detected yet for this period. Check back after the next quarter.
                      </div>
                    ) : (
                      <>
                        <div className="text-xs mb-3 px-3 py-2 rounded-lg" style={{ background: 'rgba(56,189,248,0.08)', color: '#38BDF8', border: '1px solid rgba(56,189,248,0.2)' }}>
                          💡 These funds underperformed historically (Q3/Q4) but have recently jumped to Q1/Q2. Potential turnaround candidates worth deeper analysis before investing.
                        </div>
                        <div className="space-y-4">
                          {insights.risingStars.map((entry, i) => (
                            <div key={entry.code} className="flex items-start gap-3">
                              <RankBadge rank={i + 1} />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <div className="text-xs font-semibold truncate flex-1" style={{ color: 'var(--text-hi)' }}>
                                    {getName(entry.code)}
                                  </div>
                                  <span className="text-xs px-1.5 py-0.5 rounded shrink-0" style={{ background: 'rgba(56,189,248,0.1)', color: '#38BDF8', fontSize: 10 }}>
                                    {Math.round(entry.pastBadPct * 100)}% historical Q3/Q4
                                  </span>
                                </div>
                                <QuartileBar history={entry.history} />
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </section>

    {/* ── Help Modal Popup ────────────────────────────────────────── */}
    {showHelpModal && (
      <div
        className="fixed inset-0 z-[110] flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
        onClick={e => { if (e.target === e.currentTarget) setShowHelpModal(false) }}
      >
        <div
          className="w-full max-w-2xl rounded-2xl overflow-hidden flex flex-col"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--line)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
            maxHeight: '90vh',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-6 py-4 border-b"
            style={{ borderColor: 'var(--line)', background: 'var(--bg-raised)' }}
          >
            <div className="font-display font-bold text-base" style={{ color: 'var(--text-hi)' }}>
              📖 How to Read Quartile Rankings
            </div>
            <button
              onClick={() => setShowHelpModal(false)}
              className="rounded-lg p-1.5 transition-colors duration-150 hover:bg-red-500/10"
              style={{ color: 'var(--text-mid)', border: '1px solid var(--line)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          {/* Content */}
          <div className="p-6 space-y-4 overflow-y-auto text-sm leading-relaxed" style={{ color: 'var(--text-mid)' }}>
            <div>
              <h4 className="font-bold text-base mb-1" style={{ color: 'var(--text-hi)' }}>📊 What is a Quartile?</h4>
              <p>Each period (Quarter or Year), all mutual funds in a category are ranked by their returns and divided into four equal groups:</p>
              <ul className="list-disc pl-5 mt-2 space-y-1">
                <li><strong style={{ color: '#34D399' }}>Q1 (Top Quartile):</strong> Top 25% best performing funds in that period.</li>
                <li><strong style={{ color: '#F59E0B' }}>Q2 (Second Quartile):</strong> 25% to 50% above average funds.</li>
                <li><strong style={{ color: '#F472B6' }}>Q3 (Third Quartile):</strong> 50% to 75% below average funds.</li>
                <li><strong style={{ color: '#F87171' }}>Q4 (Bottom Quartile):</strong> Bottom 25% worst performing funds.</li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-base mb-1" style={{ color: 'var(--text-hi)' }}>🏆 Consistency & Volatility</h4>
              <ul className="list-disc pl-5 mt-2 space-y-2">
                <li><strong>Most Consistent Performers:</strong> Funds that maintain the lowest average quartile ranks across all periods. Consistent Q1/Q2 hit rates suggest reliable management.</li>
                <li><strong>Most Volatile Performers:</strong> Funds with high risk and swing between extremes. These show the quartile boxes to track historical rankings.</li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-base mb-1" style={{ color: 'var(--text-hi)' }}>🌟 Rising Stars & Fallen Angels</h4>
              <ul className="list-disc pl-5 mt-2 space-y-2">
                <li><strong>Rising Stars:</strong> Funds that underperformed historically (Q3/Q4) but have recently moved up to Q1/Q2. These are turnaround candidates.</li>
                <li><strong>Fallen Angels:</strong> Previously strong funds (Q1/Q2) that have recently dropped to Q3/Q4 in the last 2 periods. Monitor closely for changes in style or performance.</li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-base mb-1" style={{ color: 'var(--text-hi)' }}>🔥 Additional Insights</h4>
              <ul className="list-disc pl-5 mt-2 space-y-2">
                <li><strong>Q1 Strike Rate:</strong> The percentage of periods the fund ranked in the top 25% (Q1). A higher strike rate indicates excellent risk-adjusted performance.</li>
                <li><strong>Q1 Retention Rate:</strong> The percentage of top-performing (Q1) managers from the previous quarter who managed to stay in the top half (Q1/Q2) this quarter. Higher rates indicate category stability and manager persistence.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    )}

    {/* ── Active Help Popup Modal ────────────────────────────────────── */}
    {activeHelp && (
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
        onClick={() => setActiveHelp(null)}
      >
        <div
          className="w-full max-w-md rounded-2xl overflow-hidden flex flex-col"
          style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--line)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
          }}
          onClick={e => e.stopPropagation()} // prevent close on inner click
        >
          {/* Header */}
          <div
            className="flex items-center justify-between px-5 py-3.5 border-b"
            style={{ borderColor: 'var(--line)', background: 'var(--bg-raised)' }}
          >
            <div className="font-display font-bold text-sm" style={{ color: 'var(--text-hi)' }}>
              💡 Explanation
            </div>
            <button
              onClick={() => setActiveHelp(null)}
              className="rounded-lg p-1 transition-colors duration-150 hover:bg-red-500/10"
              style={{ color: 'var(--text-mid)', border: '1px solid var(--line)', padding: '2px 6px' }}
            >
              ✕
            </button>
          </div>

          {/* Content */}
          <div className="p-5 space-y-4 text-xs leading-relaxed" style={{ color: 'var(--text-mid)' }}>
            <div>
              <div className="text-sm font-bold mb-1.5" style={{ color: 'var(--text-hi)' }}>
                {activeHelp.title}
              </div>
            </div>

            <div>
              <div className="font-semibold text-xs mb-1" style={{ color: 'var(--text-hi)' }}>
                🔍 What it means:
              </div>
              <p>{activeHelp.meaning}</p>
            </div>

            <div>
              <div className="font-semibold text-xs mb-1" style={{ color: 'var(--accent-a)' }}>
                📈 How it is helpful for analysis:
              </div>
              <p>{activeHelp.helpful}</p>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
