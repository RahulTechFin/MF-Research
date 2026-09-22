// src/sections/QuartileRanking.tsx — Section 6: Quartile Ranking — Full Professional Suite

import { useState, useMemo, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { useMeta, useQuartiles } from '../hooks/useData'
import CategoryPicker from '../components/CategoryPicker'
import ComingFunds from '../components/ComingFunds'
import { periodLabelParts } from '../utils/periods'
import DownloadButton from '../components/DownloadButton'
import { currentDesk } from '../config/products'
import type { SheetSpec } from '../utils/xlsx'
import { categoryColor } from '../config/categoryColors'
import { quartilePillClass, fmtPct, shortFundName } from '../utils/format'
import { ALL_SECTORS, SECTORAL_THEMATIC_SLUG, sectorOf, sectorOptions } from '../utils/sectors'

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
  const [mode, setMode] = useState<'monthly' | 'quarterly' | 'annual'>('quarterly')

  // Explanatory copy talks about "the previous quarter" etc., which reads wrong
  // once Monthly and Annual are selectable. Derive the noun from the mode.
  const periodWord = mode === 'monthly' ? 'month' : mode === 'annual' ? 'year' : 'quarter'
  // Mirrors min_p in build_json.build_quartiles: 6 for monthly/quarterly, 4 for
  // annual. The copy previously said 6 in every mode, which was wrong on Annual.
  const minPeriods = mode === 'annual' ? 4 : 6
  const [showHelpModal, setShowHelpModal] = useState(false)
  const [activeHelp, setActiveHelp] = useState<{ title: string; meaning: string; helpful: string } | null>(null)

  const eligibleCats = (meta?.categories ?? []).filter(c => EQUITY_HYBRID_CLASSES.includes(c.asset_class))
  const activeSlug = slug || (eligibleCats[0]?.slug ?? '')
  const { data, loading, error } = useQuartiles(activeSlug, mode)

  const mainTabs  = eligibleCats.filter(c => MAIN_TAB_NAMES.includes(c.category_name))
  const otherCats = eligibleCats.filter(c => !MAIN_TAB_NAMES.includes(c.category_name))

  /* ── Sectoral/Thematic sub-category ─────────────────────────────────────
     ~250 funds land in the one Sectoral/Thematic category, so the table is
     unreadable without narrowing it. Same taxonomy as Fund Screener — both
     import utils/sectors, so a fund cannot be Healthcare in one and Other in
     the other.

     Note what this does NOT do: quartiles come precomputed from build_json,
     ranked against the WHOLE category. Narrowing to Healthcare shows only
     healthcare funds but their Q1–Q4 still means "versus all Sectoral/Thematic
     peers", not "versus other healthcare funds". Re-ranking within the sector
     here would silently disagree with Fund Signals, which reads the same
     numbers — so the caption below says so instead. */
  const [sector, setSector] = useState<string>(ALL_SECTORS)
  const isSectoral = activeSlug === SECTORAL_THEMATIC_SLUG

  useEffect(() => { setSector(ALL_SECTORS) }, [activeSlug])

  const sectorOpts = useMemo(
    () => (isSectoral ? sectorOptions(data?.funds ?? []) : []),
    [isSectoral, data]
  )

  // A sector present on Quarterly can be absent on Annual, where fewer funds
  // clear the minimum history. Falling back to All Sectors beats leaving the
  // select on a value that matches nothing and an empty table with no reason.
  const activeSector = sectorOpts.some(o => o.sector === sector) ? sector : ALL_SECTORS

  const funds = useMemo(() => {
    const all = data?.funds ?? []
    if (!isSectoral || activeSector === ALL_SECTORS) return all
    return all.filter(f => sectorOf(f) === activeSector)
  }, [data, isSectoral, activeSector])

  const reversedPeriodLabels = data ? [...data.period_labels].reverse() : []

  /**
   * The quartile grid as a workbook.
   *
   * Two cells per period — the quartile and the return that produced it — because
   * a grid of bare 1s and 4s is unusable away from the colour coding on screen.
   * Columns run latest first, matching the table.
   */
  const buildExport = (): SheetSpec | null => {
    if (!data) return null
    const desk = currentDesk()
    const order = data.period_labels.map((_l, i) => i).reverse()
    const cols: SheetSpec['columns'] = [
      { key: 'fund', label: 'Fund Name', type: 'text', width: 46 },
      // isSectoral is how the rest of this screen decides the same thing —
      // derived from the slug, not from a payload field that the type does not
      // declare. One source for one fact.
      ...(isSectoral
        ? [{ key: 'sector', label: 'Sector', type: 'text' as const, width: 22 }] : []),
    ]
    for (const i of order) {
      const { main, sub } = periodLabelParts(data.period_labels[i])
      const head = sub ? `${main} ${sub}` : main
      cols.push({ key: `q${i}`, label: `${head} - Quartile`, type: 'int', width: 10 })
      cols.push({ key: `r${i}`, label: `${head} - Return`, type: 'percent' })
    }
    // Exports the funds the sector filter has left visible, not the raw payload.
    const rows: SheetSpec['rows'] = funds.map(f => {
      const row: SheetSpec['rows'][number] = { fund: f.scheme_name }
      if (isSectoral) row.sector = f.sector ?? ''
      for (const i of order) {
        row[`q${i}`] = f.quartiles[i] ?? null
        // `returns` is optional on the row — older payloads carry only the
        // quartiles, and an absent array must read as an empty cell.
        row[`r${i}`] = f.returns?.[i] ?? null
      }
      return row
    })
    return {
      sheet: `Quartiles ${mode}`,
      title: `Quartile Ranking - ${data.category_name} (${mode})`,
      meta: [
        ['Desk', desk.name],
        ['Category', data.category_name],
        ['Mode', mode],
        ['Data as of', data.as_of],
        ['Funds', String(funds.length)],
        ...(isSectoral && activeSector !== ALL_SECTORS
          ? [['Sector filter', activeSector] as [string, string]] : []),
        ['Ranked within', isSectoral
          ? 'Each sector separately' : 'The whole category'],
        ['Quartile', 'Q1 is the best-performing quarter of the peer group, Q4 the '
                   + 'worst. An empty cell means the fund was not ranked that '
                   + 'period, usually because it had not launched.'],
        ['Column order', 'Latest to oldest, left to right'],
      ],
      columns: cols,
      rows,
      fileName: `${desk.code} Quartiles - ${data.category_name} - ${mode} - ${data.as_of}`,
    }
  }

  // Fund name lookup
  const fundNameMap = useMemo(
    () => new Map(funds.map(f => [f.scheme_code, f.scheme_name])),
    [funds]
  )
  const getName = (code: string) => shortFundName(fundNameMap.get(code) || code)

  // Fund quartile history lookup
  const fundHistoryMap = useMemo(
    () => new Map(funds.map(f => [f.scheme_code, f.quartiles as (number | null)[]])),
    [funds]
  )

  /* ── Quartile Journey chart ──────────────────────────
     Reads the same `quartiles` arrays the table above renders, so the chart can
     never disagree with the grid. Y is inverted: Q1 sits at the top, which is
     how the ranking is read. */
  const [compareCodes, setCompareCodes] = useState<string[]>([])
  const MAX_COMPARE = 5

  // Category or mode change invalidates the selection.
  // Sector too: a fund picked under Healthcare must not linger in the chart
  // after switching to Technology, where it is no longer in the list.
  useEffect(() => { setCompareCodes([]) }, [activeSlug, mode, activeSector])

  const toggleCompare = (code: string) =>
    setCompareCodes(prev =>
      prev.includes(code)
        ? prev.filter(c => c !== code)
        : prev.length >= MAX_COMPARE ? prev : [...prev, code]
    )

  const journeyOption = useMemo(() => {
    if (!data || compareCodes.length === 0) return null

    const isLight = typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-theme') === 'light'
    const axisColor = isLight ? '#4B5563' : '#5E6F8F'
    const lineColor = isLight ? '#E5E7EB' : '#24314F'
    const palette = ['#22D3EE', '#F472B6', '#34D399', '#F59E0B', '#A78BFA']

    const byCode = new Map(funds.map(f => [f.scheme_code, f]))

    return {
      backgroundColor: 'transparent',
      // Extra left padding makes room for the rotated axis name.
      grid: { top: 20, right: 18, bottom: 64, left: 64 },
      legend: {
        bottom: 0,
        type: 'scroll',
        textStyle: { color: axisColor, fontSize: 10 },
        itemWidth: 14, itemHeight: 8,
      },
      tooltip: {
        trigger: 'axis',
        backgroundColor: isLight ? '#FFFFFF' : '#18233C',
        borderColor: lineColor,
        textStyle: { color: isLight ? '#111827' : '#F1F5FB', fontSize: 11 },
        formatter: (ps: any[]) => {
          const head = `<b>${ps[0].axisValue}</b>`
          // Series values are category indices; shift back to quartile numbers.
          const rows = ps
            .map(p => `${p.marker} ${p.seriesName}: ${p.value == null ? '—' : 'Q' + (p.value + 1)}`)
            .join('<br/>')
          return `${head}<br/>${rows}`
        },
      },
      xAxis: {
        type: 'category',
        data: data.period_labels,
        axisLabel: { color: axisColor, fontSize: 9, rotate: data.period_labels.length > 8 ? 35 : 0 },
        axisLine: { lineStyle: { color: lineColor } },
        splitLine: { show: false },
      },
      // Category axis, not a value axis. As a value axis with min 0.5 and
      // interval 1 the ticks land on 0.5/1.5/2.5/… — never integers — so a
      // "Q{n}" formatter produced an empty label at every tick and the scale
      // came out blank. Four named bands cannot drift like that, and their
      // padding keeps a Q1 or Q4 marker off the grid edge.
      yAxis: {
        type: 'category',
        data: ['Q1', 'Q2', 'Q3', 'Q4'],
        inverse: true,          // Q1 at the top
        boundaryGap: true,
        name: 'Quartile Rank',
        nameLocation: 'middle',
        nameGap: 44,
        nameTextStyle: { color: axisColor, fontSize: 11, fontWeight: 500 },
        axisLabel: { color: axisColor, fontSize: 11, fontWeight: 600 },
        axisTick: { show: false },
        splitLine: { show: true, lineStyle: { color: lineColor, type: 'dashed' } },
        axisLine: { show: false },
      },
      series: compareCodes.map((code, i) => ({
        name: shortFundName(byCode.get(code)?.scheme_name ?? code),
        type: 'line',
        // A fund unranked in a period leaves a gap rather than a false line.
        connectNulls: false,
        // Quartile 1–4 -> category index 0–3.
        data: ((byCode.get(code)?.quartiles ?? []) as (number | null)[])
          .map(q => (q == null ? null : q - 1)),
        symbol: 'circle',
        symbolSize: 7,
        lineStyle: { width: 2, color: palette[i % palette.length] },
        itemStyle: { color: palette[i % palette.length] },
        z: 3,
      })),
    }
  }, [data, funds, compareCodes])

  /* ── Computed Insights (all from funds array) ───────── */
  const insights = useMemo(() => {
    if (!data || funds.length === 0) return null
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

    // Fallen Angels / Rising Stars.
    //
    // Window: the 5 periods BEFORE the most recent 3, then the most recent 3.
    // Whether those are months, quarters or years follows the selected mode.
    //
    //   Fallen Angel — held Q1/Q2 through the earlier stretch, then sat in
    //                  Q3/Q4 for all 3 of the latest periods.
    //   Rising Star  — the mirror image.
    //
    // Two fixes over the previous version: the "strong past" test counted only
    // Q1 and ignored Q2, and the recent window was 2 periods, which flipped
    // funds in and out on noise — especially on the Monthly view.
    const RECENT_N   = 3   // the reversal window
    const PAST_N     = 6   // the settled stretch before it
    const PAST_MIN   = 5   // tolerate at most one gap in that stretch
    const lookback   = Math.min(n, RECENT_N + PAST_N)

    const splitWindow = (qs: (number | null)[]) => {
      const w = qs.slice(-lookback)
      return {
        past:   w.slice(0, Math.max(0, w.length - RECENT_N)).filter(q => q !== null) as number[],
        recent: w.slice(-RECENT_N).filter(q => q !== null) as number[],
      }
    }

    // A Fallen Angel must have been UNBROKEN — every one of the 6 earlier
    // periods in Q1 or Q2, not merely a majority. A single Q3 disqualifies it,
    // which is the point: this list is for genuine reversals, not wobbles.
    // Both windows must also be complete, so one stray reading cannot trigger it.
    const fallenAngels = funds
      .map(f => {
        const qs = f.quartiles as (number | null)[]
        const { past, recent } = splitWindow(qs)
        return {
          code: f.scheme_code,
          pastLen: past.length,
          pastGoodPct: past.length > 0 ? past.filter(q => q <= 2).length / past.length : 0,
          qualifies:
            past.length >= PAST_MIN && past.every(q => q <= 2) &&
            recent.length === RECENT_N && recent.every(q => q >= 3),
          history: qs,
        }
      })
      .filter(x => x.qualifies)
      // Longest clean run first — a 6-period streak outranks a 5-period one.
      .sort((a, b) => b.pastLen - a.pastLen)
      .slice(0, 5)

    // Rising Star — the exact mirror: every earlier period in Q3/Q4, then all
    // three of the latest in Q1/Q2.
    const risingStars = funds
      .map(f => {
        const qs = f.quartiles as (number | null)[]
        const { past, recent } = splitWindow(qs)
        return {
          code: f.scheme_code,
          pastLen: past.length,
          pastBadPct: past.length > 0 ? past.filter(q => q >= 3).length / past.length : 0,
          qualifies:
            past.length >= PAST_MIN && past.every(q => q >= 3) &&
            recent.length === RECENT_N && recent.every(q => q <= 2 && q > 0),
          history: qs,
        }
      })
      .filter(x => x.qualifies)
      .sort((a, b) => b.pastLen - a.pastLen)
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
  }, [data, funds, fundHistoryMap])

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
      {/* The mode buttons and Download stay pinned top-right whatever the left
          side does. With the SIF strategies laid out in a row the left side is
          wide enough to wrap, and a wrapping PARENT would carry the mode buttons
          down with it — moving a control the reader expects to find in one
          place. So the parent no longer wraps: the category list wraps inside
          its own box, and the right-hand group cannot be pushed off the line. */}
      <div className="flex items-start justify-between mb-4 gap-3">
        <div className="flex gap-2 flex-wrap items-center flex-1 min-w-0">
          {/* A desk whose categories match none of the mutual fund main-tab names
              would otherwise put every one of them in the dropdown. Show them all
              instead, in a row, each in its own colour — the same arrangement as
              every other tab, so the control does not move between them. */}
          {mainTabs.length === 0 ? (
            <CategoryPicker cats={eligibleCats} active={activeSlug}
                            onChange={setSlug} />
          ) : (
            <>
              <div className="tab-bar">
                {mainTabs.map(c => {
                  const colour = categoryColor(c.slug, c.asset_class)
                  const on = activeSlug === c.slug
                  return (
                    <button key={c.slug} onClick={() => setSlug(c.slug)}
                      className={`tab-btn${on ? ' active' : ''}`}
                      style={on ? { color: colour, background: `${colour}1f` } : undefined}>
                      {c.category_name}
                    </button>
                  )
                })}
              </div>
              {otherCats.length > 0 && (
                <select
                  value={mainTabs.some(c => c.slug === activeSlug) ? '' : activeSlug}
                  onChange={e => { if (e.target.value) setSlug(e.target.value) }}
                  className="px-3 py-1.5 rounded-lg text-sm"
                  style={{ background: 'var(--bg-raised)',
                           border: `1px solid ${mainTabs.some(c => c.slug === activeSlug)
                             ? 'var(--line)' : categoryColor(activeSlug)}`,
                           color: 'var(--text-hi)', outline: 'none' }}
                >
                  <option value="" disabled>-- Other Categories --</option>
                  {otherCats.map(c => <option key={c.slug} value={c.slug}>{c.category_name}</option>)}
                </select>
              )}
            </>
          )}
        </div>
        <div className="tab-bar shrink-0 flex items-center gap-2">
          <button onClick={() => setMode('monthly')}   className={`tab-btn${mode === 'monthly'   ? ' active accent' : ''}`}>Monthly</button>
          <button onClick={() => setMode('quarterly')} className={`tab-btn${mode === 'quarterly' ? ' active accent' : ''}`}>Quarterly</button>
          <button onClick={() => setMode('annual')}    className={`tab-btn${mode === 'annual'    ? ' active accent' : ''}`}>Annual</button>
          <DownloadButton build={buildExport}
                          disabledHint="No ranked funds in this category yet" />
        </div>
      </div>

      {/* ── Sectoral/Thematic sub-category ───────────────────────── */}
      {isSectoral && (
        <div className="card p-3 mb-4 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold" style={{ color: 'var(--text-mid)' }}>Filter by Sector:</span>
          <select
            value={activeSector}
            onChange={e => setSector(e.target.value)}
            className="px-3 py-1.5 rounded-lg text-sm"
            style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-hi)', outline: 'none' }}
          >
            {sectorOpts.map(({ sector: s, count }) => (
              <option key={s} value={s}>{s} ({count})</option>
            ))}
          </select>
          <span className="text-[11px]" style={{ color: 'var(--text-low)' }}>
            {activeSector === ALL_SECTORS
              ? 'AMFI files every theme under one category, so each sector is ranked as its own category — a Q1 here means top quartile among its own sector.'
              : `Showing ${funds.length} ${activeSector} fund${funds.length === 1 ? '' : 's'}, ranked against each other only — exactly as Large Cap or Mid Cap are.`}
          </span>
        </div>
      )}

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
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col text-left" style={{ minWidth: 240 }}>Fund</th>
                  {reversedPeriodLabels.map(p => {
                    const { main, sub } = periodLabelParts(p)
                    return (
                      <th key={p} style={{ minWidth: 150, textAlign: 'center', fontSize: 11 }}>
                        <div style={{ lineHeight: 1.35 }}>
                          <div>{main}</div>
                          {sub && (
                            <div style={{ fontWeight: 400, opacity: 0.7, fontSize: 10 }}>
                              {sub}
                            </div>
                          )}
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              {/* Keyed on category + mode + sector so the rows fade in whenever
                  any of them changes, instead of the grid swapping instantly. */}
              <tbody key={`${activeSlug}-${mode}-${activeSector}`} className="rows-enter">
                {funds.map(fund => (
                  <tr key={fund.scheme_code}>
                    <td className="sticky-col text-xs font-medium truncate" style={{ maxWidth: 240 }}>
                      {fund.scheme_name}
                    </td>
                    {/* Each cell carries the return it was ranked on. Without it
                        the grid looks wrong whenever a fund is strong over 1Y and
                        weak in one quarter — the quartile is per period, and the
                        only return on screen elsewhere is the 1Y one. */}
                    {[...fund.quartiles].reverse().map((q, i) => {
                      const label = reversedPeriodLabels[i]
                      // `returns` is optional: JSON built before it was added has
                      // no such array. Distinguish "we were not sent the return"
                      // from "the fund had no return" — conflating them would
                      // label a perfectly ranked fund as unranked.
                      const hasReturns = Array.isArray(fund.returns)
                      const ret = hasReturns ? [...fund.returns!].reverse()[i] : undefined
                      const pool = isSectoral ? sectorOf(fund) : data.category_name
                      const tip =
                        q == null
                          ? `${label}: not ranked (no return for this period)`
                          : hasReturns && ret != null
                            ? `${label}: ${fmtPct(ret)} → Q${q}\n` +
                              `ranked against ${pool} funds for ${label} alone — not 1Y`
                            : `${label}: Q${q}\nranked against ${pool} funds for ${label} alone — not 1Y`
                      return (
                        <td key={i} className="text-center" title={tip}>
                          <div className={quartilePillClass(q as number | null)}>{q ? `Q${q}` : '−'}</div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center" style={{ color: 'var(--text-mid)' }}>
            {/* An absent file means the category has no funds to rank -- the
                engine only writes one where it found schemes. See ComingFunds
                for why a 400 counts as absent too. */}
            {error ? (
              <ComingFunds error={error} subject="rank"
                           failedLabel="the quartile grid" />
            ) : (
              <>
                <div style={{ color: 'var(--text-hi)', marginBottom: 4 }}>
                  Not enough history to rank yet.
                </div>
                <div className="text-xs">
                  A fund needs {minPeriods} completed {periodWord}s before it can be
                  placed in a quartile.
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Quartile Journey — visual comparison ─────────────────── */}
      {data && funds.length > 0 && (
        <div className="card overflow-hidden mb-6">
          <InsightHeader
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></svg>}
            title="Quartile Journey"
            subtitle={`Pick up to ${MAX_COMPARE} funds to compare their ranking over time`}
            count={compareCodes.length || undefined}
            accentColor="#22D3EE"
            onHelpClick={() => setActiveHelp({
              title: '📉 Quartile Journey',
              meaning: `Each line traces one fund's quartile across the ${data.period_labels.length} ${periodWord}s shown in the table above. Q1 is plotted at the top, so a line that stays high is a fund that keeps ranking well. Gaps mean the fund was not ranked that ${periodWord} — usually because it had not launched yet.`,
              helpful: 'The table tells you where funds sit; this shows how they got there. A steadily rising line is a genuine improvement, while a line that zig-zags between Q1 and Q4 signals a fund whose ranking depends heavily on market conditions.',
            })}
          />

          <div className="px-5 py-3 border-b" style={{ borderColor: 'var(--line)' }}>
            <div className="flex flex-wrap gap-1.5">
              {funds.map(f => {
                const on = compareCodes.includes(f.scheme_code)
                const full = !on && compareCodes.length >= MAX_COMPARE
                return (
                  <button
                    key={f.scheme_code}
                    onClick={() => toggleCompare(f.scheme_code)}
                    disabled={full}
                    className="pill"
                    style={{
                      opacity: full ? 0.35 : 1,
                      cursor: full ? 'not-allowed' : 'pointer',
                      ...(on ? { background: 'var(--accent-a)', borderColor: 'var(--accent-a)', color: '#04121A' } : {}),
                    }}
                    title={f.scheme_name}
                  >
                    {shortFundName(f.scheme_name)}
                  </button>
                )
              })}
            </div>
            {compareCodes.length > 0 && (
              <button
                onClick={() => setCompareCodes([])}
                className="text-xs mt-2.5"
                style={{ color: 'var(--text-low)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                Clear selection
              </button>
            )}
          </div>

          <div className="p-4">
            {journeyOption ? (
              <ReactECharts option={journeyOption} style={{ height: 320 }} notMerge />
            ) : (
              <div className="flex flex-col items-center justify-center text-center" style={{ height: 320, color: 'var(--text-low)' }}>
                <div style={{ fontSize: 26, opacity: 0.5 }}>📉</div>
                <div className="text-xs mt-2">Select a fund above to plot its quartile journey.</div>
                <div className="text-xs mt-1" style={{ opacity: 0.7 }}>Compare up to {MAX_COMPARE} at once.</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Insight Panels — Row 1 ───────────────────────────────── */}
      {data && (
        <>
          {/* How to read the little quartile boxes in the panels below.
              The direction is not guessable from the boxes themselves — they
              carry no dates — and reading them backwards inverts every story
              they tell, so it is stated once, right above them. Derived from
              period_labels rather than written out, so it cannot drift if the
              engine ever reverses the grid. */}
          {data.period_labels?.length > 1 && (
            <div className="flex justify-end mb-1.5">
              <span className="text-[11px]" style={{ color: 'var(--text-low)' }}>
                Quartile boxes read left → right, oldest to newest
                <span style={{ color: 'var(--text-mid)' }}>
                  {' '}({data.period_labels[0]} → {data.period_labels[data.period_labels.length - 1]})
                </span>
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">

            {/* Most Consistent */}
            <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(52,211,153,0.25)', background: 'var(--bg-card)' }}>
              <InsightHeader
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="6"/><path d="M15.477 12.89L17 22l-5-3-5 3 1.523-9.11"/></svg>}
                title="Most Consistent Performers"
                subtitle={`Mostly Q1/Q2 across ${minPeriods}+ ${periodWord}s, and not among the biggest swingers`}
                count={data.most_consistent.length}
                accentColor="#34D399"
                onHelpClick={() => setActiveHelp({
                  title: "🏆 Most Consistent Performers",
                  meaning: "Funds that spent most of their periods (at least 60%) in the top half — Q1 or Q2. Most Volatile is settled first, so any fund among the biggest swingers is listed there instead and never in both boxes at once.",
                  helpful: "Best used for selecting core holdings in a long-term portfolio. High consistency implies a robust investing process and a manager capable of navigating various market conditions successfully."
                })}
              />
              <div className="p-4">
                {data.most_consistent.length === 0 ? (
                  <div className="text-xs py-6 text-center" style={{ color: 'var(--text-low)' }}>Need minimum {minPeriods} completed {periodWord}s.</div>
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
                                In Q1/Q2: <strong style={{ color: '#34D399' }}>
                                  {Math.round(entry.top_share * 100)}%
                                </strong>
                              </span>
                              <span className="text-xs" style={{ color: 'var(--text-low)' }}>
                                Avg Q: <strong style={{ color: 'var(--text-mid)' }}>{entry.avg_quartile.toFixed(2)}</strong>
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
                subtitle={`Swung between Q1/Q2 and Q3/Q4 — the most rank crossings`}
                count={data.most_volatile.length}
                accentColor="#FB923C"
                onHelpClick={() => setActiveHelp({
                  title: "⚡ Most Volatile Performers",
                  meaning: `Funds that crossed between the top half (Q1/Q2) and the bottom half (Q3/Q4) from one ${periodWord} to the next — counted in either direction. Ranked by how often they cross, then by how evenly they split their time between the halves.`,
                  helpful: "Useful for identifying high-beta, aggressive strategies. A fund that qualifies as both consistent and volatile is listed here, because the swing is the more important fact about it."
                })}
              />
              <div className="p-4">
                {data.most_volatile.length === 0 ? (
                  <div className="text-xs py-6 text-center" style={{ color: 'var(--text-low)' }}>Need minimum {minPeriods} completed {periodWord}s.</div>
                ) : (
                  <div className="space-y-4">
                    {data.most_volatile.map((entry, i) => (
                      <div key={entry.scheme_code} className="flex items-start gap-3">
                        <RankBadge rank={i + 1} />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-hi)' }}>
                            {getName(entry.scheme_code)}
                          </div>
                          <div className="flex items-center gap-3 mt-1 flex-wrap">
                            <span className="text-xs" style={{ color: 'var(--text-low)' }}>
                              Crossings: <strong style={{ color: '#FB923C' }}>{entry.crossings}</strong>
                              <span style={{ opacity: 0.7 }}> / {entry.periods - 1}</span>
                            </span>
                            <span className="text-xs" style={{ color: 'var(--text-low)' }}>
                              Top half: <strong style={{ color: 'var(--text-mid)' }}>
                                {Math.round(entry.top_share * 100)}%
                              </strong>
                            </span>
                          </div>
                          <QuartileBar history={entry.history} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Best / Worst by where the fund actually sat ─────────── */}
          {/*
            A deliberately short answer to "who is good and who is bad here".
            Unlike the pair above, these are share-based -- "most of the time in
            Q1/Q2" rather than "never left" -- so a fund can be both the best
            performer and a volatile one. That is the point: this pair measures
            level, the pair above measures stability.
          */}
          {(data.best_performers?.length || data.worst_performers?.length) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
              {([
                { key: 'best' as const, rows: data.best_performers ?? [],
                  title: 'Best — mostly Q1 / Q2', colour: '#34D399',
                  border: 'rgba(52,211,153,0.25)', shareKey: 'top_share' as const,
                  label: 'In Q1/Q2' },
                { key: 'worst' as const, rows: data.worst_performers ?? [],
                  title: 'Worst — mostly Q3 / Q4', colour: '#F87171',
                  border: 'rgba(248,113,113,0.25)', shareKey: 'bottom_share' as const,
                  label: 'In Q3/Q4' },
              ]).map(panel => (
                <div key={panel.key} className="rounded-2xl overflow-hidden"
                     style={{ border: `1px solid ${panel.border}`, background: 'var(--bg-card)' }}>
                  <div className="px-4 py-2.5 flex items-center justify-between"
                       style={{ background: 'var(--bg-raised)',
                                borderBottom: '1px solid var(--line)' }}>
                    <span className="text-sm font-semibold" style={{ color: panel.colour }}>
                      {panel.title}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--text-low)' }}>
                      top {panel.rows.length}
                    </span>
                  </div>
                  {panel.rows.length === 0 ? (
                    <div className="text-xs py-6 text-center" style={{ color: 'var(--text-low)' }}>
                      Need minimum {minPeriods} completed {periodWord}s.
                    </div>
                  ) : (
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th style={{ width: 34 }}>#</th>
                          <th className="text-left">Fund</th>
                          <th className="ret-cell">{panel.label}</th>
                          <th className="ret-cell">Avg Q</th>
                        </tr>
                      </thead>
                      <tbody>
                        {panel.rows.map((entry, i) => (
                          <tr key={entry.scheme_code}>
                            <td className="text-xs" style={{ color: 'var(--text-low)' }}>{i + 1}</td>
                            <td className="text-xs font-medium">
                              <div className="truncate" style={{ maxWidth: 240 }}
                                   title={fundNameMap.get(entry.scheme_code) ?? entry.scheme_code}>
                                {getName(entry.scheme_code)}
                              </div>
                              <QuartileBar history={entry.history} />
                            </td>
                            <td className="ret-cell tabnum font-semibold"
                                style={{ color: panel.colour }}>
                              {Math.round(entry[panel.shareKey] * 100)}%
                            </td>
                            <td className="ret-cell tabnum" style={{ color: 'var(--text-mid)' }}>
                              {entry.avg_quartile.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Insight Panels — Row 2 ─────────────────────────────── */}
          {insights && (
            <>
              {/* ── Fallen Angels + Rising Stars ───────────────────── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">

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
                      meaning: `Funds that were in Q1 or Q2 in EVERY one of the 6 ${periodWord}s before last — an unbroken run — and have then sat in Q3/Q4 for all 3 of the latest ${periodWord}s.`,
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
                          ⚠️ These funds were in Q1/Q2 in every one of the earlier 6 {periodWord}s, then fell to Q3/Q4 in all 3 of the latest. A clean break in a settled record — monitor closely, it may signal a change in management or strategy.
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
                                    {entry.pastLen} {periodWord}s unbroken in Q1/Q2
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
                        No rising stars detected yet for this period. Check back after the next {periodWord}.
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
                                    {entry.pastLen} {periodWord}s unbroken in Q3/Q4
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
                      meaning: `Funds currently on an active, uninterrupted run of top-quartile (Q1) performance over consecutive ${periodWord}s.`,
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
                      meaning: `The percentage of funds that were in Q1 (Top 25%) in the previous ${periodWord} and managed to remain in the top half (Q1 or Q2) in the next ${periodWord}.`,
                      helpful: "Measures overall category consistency. A high persistence rate suggests that outperformance in this category is durable; a low rate suggests top performers rotate rapidly due to cyclical factors."
                    })}
                  />
                  <div className="p-4">
                    <div className="space-y-2">
                      {data.period_labels.map((label, i) => {
                        const pct = insights.persistenceTrend[i]
                        if (pct === null) return null
                        const formattedLabel = periodLabelParts(label)
                        const barColor = pct >= 65 ? '#34D399' : pct >= 45 ? '#F59E0B' : '#F87171'
                        return (
                          <div key={label} className="flex items-center gap-2">
                            <div className="text-xs shrink-0" style={{ color: 'var(--text-low)', minWidth: 140 }}>
                              {/* One line here — this is a compact bar list, not
                                  the table header, so main and sub sit inline. */}
                              <div style={{ fontWeight: 600, color: 'var(--text-mid)', fontSize: 10 }}>
                                {formattedLabel.main}
                                {formattedLabel.sub ? ` ${formattedLabel.sub}` : ''}
                              </div>
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
              <p>Each period (Month, Quarter or Year), all mutual funds in a category are ranked by their returns and divided into four equal groups:</p>
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
                <li><strong>Most Consistent Performers:</strong> Funds that spent at least 60% of their periods in Q1/Q2 and are not among the biggest swingers.</li>
                <li><strong>Most Volatile Performers:</strong> Funds that crossed most often between Q1/Q2 and Q3/Q4. Settled first, so a fund qualifying for both appears only here.</li>
                <li><strong>Best / Worst:</strong> Share of periods in the top or bottom half. This measures level rather than stability, so it may overlap the two lists above.</li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-base mb-1" style={{ color: 'var(--text-hi)' }}>🌟 Rising Stars & Fallen Angels</h4>
              <ul className="list-disc pl-5 mt-2 space-y-2">
                <li><strong>Rising Stars:</strong> Funds that underperformed historically (Q3/Q4) but have recently moved up to Q1/Q2. These are turnaround candidates.</li>
                <li><strong>Fallen Angels:</strong> Funds that sat in Q1 or Q2 in <em>every one</em> of the 6 periods before last, then dropped to Q3/Q4 in <em>all 3</em> of the latest. One slip in the earlier run disqualifies a fund, so this list shows genuine reversals rather than wobbles. <strong>Rising Stars</strong> are the exact mirror.</li>
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-base mb-1" style={{ color: 'var(--text-hi)' }}>🔥 Additional Insights</h4>
              <ul className="list-disc pl-5 mt-2 space-y-2">
                <li><strong>Q1 Strike Rate:</strong> The percentage of periods the fund ranked in the top 25% (Q1). A higher strike rate indicates excellent risk-adjusted performance.</li>
                <li><strong>Q1 Retention Rate:</strong> The percentage of top-performing (Q1) managers from the previous {periodWord} who managed to stay in the top half (Q1/Q2) this {periodWord}. Higher rates indicate category stability and manager persistence.</li>
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
