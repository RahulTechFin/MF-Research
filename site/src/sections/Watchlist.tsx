// src/sections/Watchlist.tsx — cross-category exit / entry signals.
//
// Every other quartile view is scoped to one category. This one spans all of
// them, so it can answer "which funds anywhere have been sliding?" — the
// question that actually precedes an exit decision.
//
// Streaks count back from the latest period and are broken by an unranked
// period, never skipped over: a gap means we do not know how the fund did, and
// treating it as continuity would overstate the run.

import { useState, useMemo, useEffect } from 'react'
import DownloadButton from '../components/DownloadButton'
import { currentDesk } from '../config/products'
import type { SheetSpec } from '../utils/xlsx'
import { useJson } from '../hooks/useData'
import { fmtPct, shortFundName } from '../utils/format'
import { ALL_SECTORS, SECTORAL_THEMATIC_SLUG, sectorOf, sectorOptions } from '../utils/sectors'

type Mode = 'monthly' | 'quarterly' | 'annual'
type View = 'category' | 'ranked'

interface WatchFund {
  scheme_code: string
  scheme_name: string
  amc_name: string
  category_name: string
  category_slug: string
  asset_class: string
  quartiles: (number | null)[]
  latest_q: number | null
  exit_streak: number
  entry_streak: number
  top_half_pct: number | null
  ranked_periods: number
  eligible: boolean
  last_ranked_q: number | null
  ret_1y: number | null
  /**
   * The fund's own peer-group 1Y average: its SECTOR for sectoral/thematic funds
   * (which are ranked within sector), its category everywhere else. Named
   * cat_avg_1y for continuity - build_json substitutes the sector figure.
   */
  cat_avg_1y: number | null
  /** Stamped by build_json for sectoral/thematic funds only. */
  sector?: string
  /** Whole-category average, kept for reference where sector != category. */
  category_avg_1y?: number | null
}

interface AmcRow {
  amc_name: string
  funds: number; ranked: number
  q1: number; q2: number; q3: number; q4: number
  top_half: number; top_half_pct: number; avg_quartile: number
}

interface WatchlistData {
  as_of: string
  mode: Mode
  min_history: number
  period_labels: string[]
  categories: { category_name: string; slug: string; asset_class: string; fund_count: number; avg_1y: number | null }[]
  funds: WatchFund[]
  amc_leaderboard: AmcRow[]
}

const Q_COLORS: Record<number, string> = { 1: '#34D399', 2: '#F59E0B', 3: '#F472B6', 4: '#F87171' }
const EXIT = '#F87171'
const ENTRY = '#34D399'

/**
 * Quartile history in chronological order — OLDEST on the left, latest on the
 * right, matching the stored array.
 *
 * Note this is the opposite of the Quartile Ranking *table*, which reverses so
 * the newest column comes first. The sparklines in that section read this way
 * too, so all sparklines agree with each other; only the wide table differs.
 */
function Sparkline({ history, labels, compact }: {
  history: (number | null)[]; labels?: string[]; compact?: boolean
}) {
  const cells = history.map((q, i) => ({ q, label: labels?.[i] }))
  return (
    <div className="flex gap-[2px]">
      {cells.map(({ q, label }, i) => (
        <div key={i} title={`${label ? label + ': ' : ''}${q ? 'Q' + q : 'not ranked'}`}
          style={{
            width: compact ? 13 : 15, height: compact ? 14 : 16, borderRadius: 2,
            background: q ? `${Q_COLORS[q]}33` : 'var(--bg-raised)',
            border: q ? `1px solid ${Q_COLORS[q]}66` : '1px solid var(--line)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: compact ? 8 : 9, fontWeight: 700,
            color: q ? Q_COLORS[q] : 'var(--text-low)',
          }}>
          {q ?? ''}
        </div>
      ))}
    </div>
  )
}

function FundRow({ fund, streak, tone, periodWord, compact, labels }: {
  fund: WatchFund; streak: number; tone: 'exit' | 'entry'; periodWord: string
  compact?: boolean; labels?: string[]
}) {
  const accent = tone === 'exit' ? EXIT : ENTRY
  const diff = fund.ret_1y != null && fund.cat_avg_1y != null ? fund.ret_1y - fund.cat_avg_1y : null

  return (
    <div className="px-3 py-2.5 border-b" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 rounded-lg flex flex-col items-center justify-center"
          style={{ width: 36, height: 34, background: `${accent}18`, border: `1px solid ${accent}44` }}
          title={`${streak} consecutive ${periodWord}s`}>
          <div style={{ fontSize: 13, fontWeight: 800, color: accent, lineHeight: 1 }}>{streak}</div>
          <div style={{ fontSize: 7, color: 'var(--text-low)' }}>{periodWord.slice(0, 2).toUpperCase()}</div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-hi)' }} title={fund.scheme_name}>
            {shortFundName(fund.scheme_name)}
          </div>
          <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--text-low)' }}>
            {fund.amc_name}{!compact && ` · ${fund.category_name}`}
          </div>
          <div className="mt-1"><Sparkline history={fund.quartiles} labels={labels} compact /></div>
        </div>

        <div className="shrink-0 text-right" style={{ minWidth: 78 }}>
          {/* Labelled "1Y" deliberately. The boxes to the left are per-period
              quartiles, so a fund can be strong over a year and weak in the
              latest quarter. Unlabelled, the two read as contradicting. */}
          <div className="text-xs font-semibold tabnum"
            title={`Trailing 1-year return. The quartile boxes rank each ${periodWord} separately, so they need not agree with this.`}
            style={{ color: fund.ret_1y == null ? 'var(--text-low)' : fund.ret_1y >= 0 ? 'var(--gain)' : 'var(--loss)' }}>
            <span className="font-normal" style={{ color: 'var(--text-low)', fontSize: 9 }}>1Y </span>
            {fund.ret_1y != null ? fmtPct(fund.ret_1y) : '—'}
          </div>
          {diff != null && (
            <div className="text-[10px] tabnum" style={{ color: diff >= 0 ? 'var(--gain)' : 'var(--loss)' }}
              title={`Versus its own peer group average${fund.sector ? ` — ${fund.sector}` : ''}`}>
              {diff >= 0 ? '▲' : '▼'} {fmtPct(Math.abs(diff))}
            </div>
          )}
          {fund.top_half_pct != null && (
            <div className="text-[10px]" style={{ color: 'var(--text-low)' }}>
              {Math.round(fund.top_half_pct * 100)}% top½
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ListPanel({ title, icon, accent, rows, streakKey, periodWord, onCsv, compact, emptyNote, labels }: {
  title: string; icon: string; accent: string; rows: WatchFund[]
  streakKey: 'exit_streak' | 'entry_streak'; periodWord: string
  onCsv?: () => void; compact?: boolean; emptyNote: string; labels?: string[]
}) {
  return (
    <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${accent}40`, background: 'var(--bg-card)' }}>
      <div className="px-4 py-2.5 border-b flex items-center justify-between gap-2"
        style={{ borderColor: `${accent}30`, background: `linear-gradient(135deg, ${accent}0D 0%, transparent 100%)` }}>
        <div className="font-display font-bold text-xs" style={{ color: accent }}>{icon} {title}</div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold"
            style={{ background: `${accent}20`, color: accent }}>{rows.length}</span>
          {onCsv && rows.length > 0 && (
            <button onClick={onCsv} className="pill" style={{ fontSize: 10, padding: '2px 8px' }} title="Download CSV">CSV</button>
          )}
        </div>
      </div>
      <div style={{ maxHeight: compact ? 300 : 560, overflowY: 'auto' }}>
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-[11px]" style={{ color: 'var(--text-low)' }}>{emptyNote}</div>
        ) : rows.map(f => (
          <FundRow key={f.scheme_code} fund={f} streak={f[streakKey]} periodWord={periodWord}
            tone={streakKey === 'exit_streak' ? 'exit' : 'entry'} compact={compact} labels={labels} />
        ))}
      </div>
    </div>
  )
}

function toCsv(rows: WatchFund[], kind: string, mode: Mode, periodWord: string) {
  const head = ['Fund', 'AMC', 'Category', `${kind} streak (${periodWord}s)`,
                'Latest Q', 'Top-half %', '1Y return', 'Category avg 1Y', 'vs category']
  const body = rows.map(f => {
    const streak = kind === 'Exit' ? f.exit_streak : f.entry_streak
    const diff = f.ret_1y != null && f.cat_avg_1y != null ? f.ret_1y - f.cat_avg_1y : null
    return [
      `"${f.scheme_name.replace(/"/g, '""')}"`,
      `"${(f.amc_name ?? '').replace(/"/g, '""')}"`,
      `"${f.category_name}"`, streak, f.latest_q ?? '',
      f.top_half_pct != null ? (f.top_half_pct * 100).toFixed(1) : '',
      f.ret_1y != null ? (f.ret_1y * 100).toFixed(2) : '',
      f.cat_avg_1y != null ? (f.cat_avg_1y * 100).toFixed(2) : '',
      diff != null ? (diff * 100).toFixed(2) : '',
    ].join(',')
  })
  const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = `${kind.toLowerCase()}-watch-${mode}.csv`; a.click()
  URL.revokeObjectURL(url)
}

export default function Watchlist() {
  const [mode, setMode] = useState<Mode>('monthly')
  const [minStreak, setMinStreak] = useState(3)
  const [catFilter, setCatFilter] = useState<string>('')
  const [view, setView] = useState<View>('category')
  const [amcOpen, setAmcOpen] = useState(false)
  // A two-fund house can top the leaderboard on luck, so the modal can be
  // restricted to houses with enough funds to mean something.
  const [minAmcFunds, setMinAmcFunds] = useState(1)

  const { data, loading, error } = useJson<WatchlistData>(`watchlist_${mode}.json`)

  /**
   * The signal list as a workbook. The quartile run that produced each call is
   * exported alongside it — a bare "EXIT" with no evidence behind it is not
   * something anyone should be forwarding.
   */
  const buildExport = (): SheetSpec | null => {
    if (!data) return null
    const desk = currentDesk()
    return {
      sheet: `Fund Signals ${mode}`,
      title: `Fund Signals - Exit & Entry Watch (${mode})`,
      meta: [
        ['Desk', desk.name],
        ['Mode', mode],
        ['Data as of', data.as_of],
        ['Periods examined', `${data.period_labels.length} ${mode === 'annual' ? 'years'
                              : mode === 'monthly' ? 'months' : 'quarters'}`],
        ['Minimum history', `${data.min_history} ranked periods`],
        ['Funds', String(data.funds.length)],
        ['Quartile run', 'Oldest to newest, left to right within the cell. '
                       + 'Q1 is the best quarter of the peer group, Q4 the worst.'],
      ],
      columns: [
        { key: 'fund', label: 'Fund Name', type: 'text', width: 46 },
        { key: 'category', label: 'Category', type: 'text', width: 26 },
        { key: 'amc', label: 'AMC', type: 'text', width: 22 },
        { key: 'signal', label: 'Signal', type: 'text', width: 15 },
        { key: 'exit_streak', label: 'Bottom-half streak', type: 'int', width: 12 },
        { key: 'entry_streak', label: 'Top-half streak', type: 'int', width: 12 },
        { key: 'run', label: 'Quartile run (oldest to newest)', type: 'text', width: 34 },
      ],
      rows: data.funds.map(f => ({
        fund: f.scheme_name,
        category: f.category_name,
        amc: f.amc_name,
        signal: f.exit_streak >= data.min_history ? 'EXIT'
              : f.entry_streak >= data.min_history ? 'KEEP' : 'REVIEW',
        exit_streak: f.exit_streak,
        entry_streak: f.entry_streak,
        run: f.quartiles.map((q: number | null) => q == null ? '-' : `Q${q}`).join(' '),
      })),
      fileName: `${desk.code} Fund Signals - ${mode} - ${data.as_of}`,
    }
  }
  const periodWord = mode === 'monthly' ? 'month' : mode === 'annual' ? 'year' : 'quarter'

  /* ── Sectoral/Thematic sub-category ─────────────────────────────────────
     Focusing the Sectoral/Thematic tile still leaves ~250 funds spanning
     pharma, defence, ESG and quant strategies — an exit signal is only useful
     against comparable funds. Taxonomy comes from utils/sectors, shared with
     Fund Screener and Quartile Ranking so the three cannot disagree. */
  const [sector, setSector] = useState<string>(ALL_SECTORS)
  const isSectoral = catFilter === SECTORAL_THEMATIC_SLUG

  // Leaving a sector applied after the category focus moves would silently
  // empty every list, with nothing on screen explaining why.
  useEffect(() => { setSector(ALL_SECTORS) }, [catFilter])

  const sectorOpts = useMemo(() => {
    if (!isSectoral || !data) return []
    return sectorOptions(data.funds.filter(f => f.category_slug === SECTORAL_THEMATIC_SLUG))
  }, [isSectoral, data])

  // Monthly, Quarterly and Annual are separate files with different eligibility,
  // so a sector can vanish when the period changes. Fall back rather than filter
  // to nothing.
  const activeSector = sectorOpts.some(o => o.sector === sector) ? sector : ALL_SECTORS

  const scopedFunds = useMemo(() => {
    if (!data) return []
    const inCategory = catFilter ? data.funds.filter(f => f.category_slug === catFilter) : data.funds
    if (!isSectoral || activeSector === ALL_SECTORS) return inCategory
    return inCategory.filter(f => sectorOf(f) === activeSector)
  }, [data, catFilter, isSectoral, activeSector])

  const { exits, entries, byCategory, tooNew } = useMemo(() => {
    if (!data) return { exits: [], entries: [], byCategory: [], tooNew: 0 }
    const scoped = scopedFunds
    // Funds without enough ranked history are excluded outright: a two-month
    // record cannot show a 'consistent' streak, only a coincidence.
    //
    // `!== false` rather than a truthy test on purpose. A JSON file written
    // before this field existed has `eligible === undefined`, and a truthy test
    // filtered out every fund and blanked the whole page. Code can reach a
    // browser before the pipeline has rebuilt the data, so the absent case has
    // to mean "include", not "exclude".
    const pool = scoped.filter(f => f.eligible !== false)
    const tooNew = scoped.length - pool.length

    const exits = pool.filter(f => f.exit_streak >= minStreak)
      .sort((a, b) => b.exit_streak - a.exit_streak || (a.ret_1y ?? 0) - (b.ret_1y ?? 0))
    const entries = pool.filter(f => f.entry_streak >= minStreak)
      .sort((a, b) => b.entry_streak - a.entry_streak || (b.ret_1y ?? 0) - (a.ret_1y ?? 0))

    // Category blocks, most-active first — a category with nothing to report
    // should not take up space above one with eight funds sliding.
    const byCategory = data.categories.map(c => {
      const e = exits.filter(f => f.category_slug === c.slug)
      const n = entries.filter(f => f.category_slug === c.slug)
      return { ...c, exits: e, entries: n, total: e.length + n.length }
    }).filter(c => c.total > 0)
    // Deliberately NOT re-sorted: this keeps the same order as the Category
    // Pulse tiles above, so scanning down matches scanning across.

    return { exits, entries, byCategory, tooNew }
  }, [data, minStreak, scopedFunds])

  const maxStreak = mode === 'annual' ? 5 : 8

  /* ── Verdicts ───────────────────────────────────────────────────────────
     Two facts decide everything here: is the fund ranking well, and is it
     actually beating its own category? A streak alone conflates them — a fund
     can rank badly simply because its peer group is strong.

     This was a scatter plot first. It carried the same information but asked
     the reader to decode two axes before drawing any conclusion, so it is now
     four plain verdicts with a count, a reason and the funds behind each.     */
  const verdicts = useMemo(() => {
    if (!data) return []
    const scoped = scopedFunds

    const rated = scoped
      .filter(f => f.eligible !== false && f.ret_1y != null && f.cat_avg_1y != null)
      .map(f => ({
        f,
        vs: (f.ret_1y! - f.cat_avg_1y!) * 100,
        top: f.entry_streak >= f.exit_streak,
        streak: Math.max(f.entry_streak, f.exit_streak),
      }))
      .filter(p => p.streak >= minStreak)

    const defs = [
      { key: 'keep',   label: 'KEEP',        icon: '🟢', color: ENTRY,
        rule: 'Ranking well AND beating its category',
        action: 'Working as intended — hold, or add.',
        pick: (p: typeof rated[0]) => p.top && p.vs >= 0 },
      { key: 'time',   label: 'GIVE IT TIME', icon: '🔵', color: '#38BDF8',
        rule: 'Ranking poorly BUT still beating its category',
        action: 'The peer group is strong, not the fund weak. Do not exit on rank alone.',
        pick: (p: typeof rated[0]) => !p.top && p.vs >= 0 },
      { key: 'review', label: 'REVIEW',      icon: '🟠', color: '#F59E0B',
        rule: 'Ranking well BUT losing to its category',
        action: 'Flattered by rank. The good position hides weak absolute returns.',
        pick: (p: typeof rated[0]) => p.top && p.vs < 0 },
      { key: 'exit',   label: 'EXIT',        icon: '🔴', color: EXIT,
        rule: 'Ranking poorly AND losing to its category',
        action: 'Both signals agree. The clearest case to exit.',
        pick: (p: typeof rated[0]) => !p.top && p.vs < 0 },
    ]

    return defs.map(d => ({
      ...d,
      funds: rated.filter(d.pick).sort((a, b) => b.streak - a.streak || b.vs - a.vs),
    }))
  }, [data, minStreak, scopedFunds])

  return (
    <section id="watchlist" className="px-6 py-6 max-w-screen-2xl mx-auto">
      <div className="section-header">
        <span>Fund Signals — Exit &amp; Entry Watch</span>
        <DownloadButton build={buildExport}
                        disabledHint="No signals for this selection yet" />
        <button
          onClick={() => setAmcOpen(true)}
          className="tab-btn font-semibold ml-auto"
          style={{
            border: '1px solid var(--accent-a)',
            background: 'rgba(34,211,238,0.08)',
            color: 'var(--accent-a)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
          title="Fund-house standings across every category"
        >
          🏛 AMC Leaderboard
        </button>
      </div>

      {/* Controls */}
      <div className="card p-4 mb-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--text-low)' }}>Period</span>
            <div className="tab-bar">
              {(['monthly', 'quarterly', 'annual'] as Mode[]).map(m => (
                <button key={m} onClick={() => setMode(m)} className={`tab-btn${mode === m ? ' active accent' : ''}`}>
                  {m[0].toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--text-low)' }}>Consecutive {periodWord}s</span>
            <div className="tab-bar">
              {Array.from({ length: maxStreak - 2 }, (_, i) => i + 3).map(n => (
                <button key={n} onClick={() => setMinStreak(n)} className={`tab-btn${minStreak === n ? ' active accent' : ''}`}>
                  {n}+
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs" style={{ color: 'var(--text-low)' }}>Layout</span>
            <div className="tab-bar">
              <button onClick={() => setView('category')} className={`tab-btn${view === 'category' ? ' active accent' : ''}`}>By category</button>
              <button onClick={() => setView('ranked')} className={`tab-btn${view === 'ranked' ? ' active accent' : ''}`}>All ranked</button>
            </div>
          </div>

          {data && (
            <div className="text-xs ml-auto" style={{ color: 'var(--text-low)' }}>
              {data.funds.length} funds · {data.period_labels.length} {periodWord}s · as of {data.as_of}
              {tooNew > 0 && (
                <span title={`Need ${data.min_history}+ ranked ${periodWord}s to qualify`}>
                  {' '}· {tooNew} too new
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {loading && <div className="card p-8 space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-8 w-full" />)}</div>}

      {!loading && error && (
        <div className="card p-8 text-center">
          <div style={{ fontSize: 26, opacity: 0.5 }}>📭</div>
          <div className="text-sm mt-2" style={{ color: 'var(--text-hi)' }}>No watchlist data yet</div>
          <div className="text-xs mt-1" style={{ color: 'var(--text-low)' }}>
            watchlist_{mode}.json has not been generated. Run the daily pipeline
            (<code>python scripts/daily_run.py</code>) and reload.
          </div>
        </div>
      )}

      {data && (
        <>
          {/* ── Category Pulse — every category at a glance ─────────── */}
          <div className="card p-4 mb-5">
            <div className="text-xs font-semibold mb-3" style={{ color: 'var(--text-mid)' }}>
              Category Pulse
              <span className="ml-2 font-normal" style={{ color: 'var(--text-low)' }}>
                click a tile to focus · net = entries − exits
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {data.categories.map(c => {
                const e = data.funds.filter(f => f.category_slug === c.slug && f.exit_streak >= minStreak).length
                const n = data.funds.filter(f => f.category_slug === c.slug && f.entry_streak >= minStreak).length
                const net = n - e
                const tone = net > 0 ? ENTRY : net < 0 ? EXIT : 'var(--text-low)'
                const on = catFilter === c.slug
                return (
                  <button key={c.slug}
                    onClick={() => setCatFilter(on ? '' : c.slug)}
                    className="rounded-lg px-2.5 py-1.5 text-left"
                    style={{
                      background: on ? `${tone}22` : 'var(--bg-raised)',
                      border: `1px solid ${on ? tone : 'var(--line)'}`,
                      cursor: 'pointer', minWidth: 118,
                    }}
                    title={`${c.category_name}: ${e} on exit watch, ${n} on entry watch`}>
                    <div className="text-[10px] truncate" style={{ color: 'var(--text-mid)', maxWidth: 150 }}>
                      {c.category_name}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[11px] font-bold tabnum" style={{ color: EXIT }}>▼{e}</span>
                      <span className="text-[11px] font-bold tabnum" style={{ color: ENTRY }}>▲{n}</span>
                      <span className="text-[10px] ml-auto font-semibold tabnum" style={{ color: tone }}>
                        {net > 0 ? `+${net}` : net}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
            {catFilter && (
              <div className="flex items-center gap-3 mt-3 flex-wrap">
                <button onClick={() => setCatFilter('')} className="text-xs"
                  style={{ color: 'var(--accent-a)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  ← Show all categories
                </button>

                {/* Sectoral/Thematic is one AMFI bucket holding every theme, so
                    the category tile alone still leaves pharma next to defence. */}
                {isSectoral && (
                  <>
                    <span className="text-xs" style={{ color: 'var(--text-low)' }}>Sector</span>
                    <select
                      value={activeSector}
                      onChange={e => setSector(e.target.value)}
                      className="px-2.5 py-1 rounded-lg text-xs"
                      style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-hi)', outline: 'none' }}
                    >
                      {sectorOpts.map(({ sector: s, count }) => (
                        <option key={s} value={s}>{s} ({count})</option>
                      ))}
                    </select>
                    <span className="text-[11px]" style={{ color: 'var(--text-low)' }}>
                      read from the scheme name — AMFI files every theme under one category
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          {/* ── The verdict — the conclusion, before the detail ───────── */}
          <div className="mb-5">
            <div className="text-xs font-semibold mb-2 px-1" style={{ color: 'var(--text-mid)' }}>
              What to do
              <span className="ml-2 font-normal" style={{ color: 'var(--text-low)' }}>
                every fund with a {minStreak}+ {periodWord} streak, sorted into one of four calls
                {catFilter && ` · ${data.categories.find(c => c.slug === catFilter)?.category_name}`}
                {activeSector !== ALL_SECTORS && ` · ${activeSector}`}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {verdicts.map(v => (
                <div key={v.key} className="rounded-xl overflow-hidden flex flex-col"
                     style={{ border: `1px solid ${v.color}44`, background: 'var(--bg-card)' }}>
                  <div className="px-4 pt-4 pb-3"
                       style={{ background: `linear-gradient(160deg, ${v.color}12 0%, transparent 70%)` }}>
                    <div className="flex items-baseline gap-2">
                      <span style={{ fontSize: 15 }}>{v.icon}</span>
                      <span className="font-display font-bold text-sm" style={{ color: v.color, letterSpacing: '0.04em' }}>
                        {v.label}
                      </span>
                      <span className="ml-auto font-display font-bold tabnum"
                            style={{ fontSize: 26, lineHeight: 1, color: v.color }}>
                        {v.funds.length}
                      </span>
                    </div>
                    <div className="text-[11px] mt-2 leading-snug" style={{ color: 'var(--text-mid)' }}>
                      {v.rule}
                    </div>
                    <div className="text-[11px] mt-1.5 leading-snug" style={{ color: 'var(--text-low)' }}>
                      {v.action}
                    </div>
                  </div>

                  <div className="border-t" style={{ borderColor: 'var(--line)', maxHeight: 190, overflowY: 'auto' }}>
                    {v.funds.length === 0 ? (
                      <div className="px-4 py-5 text-center text-[11px]" style={{ color: 'var(--text-low)' }}>
                        No fund in this group.
                      </div>
                    ) : v.funds.map(({ f, vs, streak }) => (
                      <div key={f.scheme_code} className="px-3 py-2 border-b" style={{ borderColor: 'var(--line)' }}>
                        <div className="text-[11px] font-semibold truncate" style={{ color: 'var(--text-hi)' }}
                             title={f.scheme_name}>
                          {shortFundName(f.scheme_name)}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] truncate" style={{ color: 'var(--text-low)', maxWidth: 110 }}>
                            {f.category_name}
                          </span>
                          <span className="text-[10px] ml-auto tabnum" style={{ color: 'var(--text-mid)' }}>
                            {streak}{periodWord[0]}
                          </span>
                          <span className="text-[10px] tabnum font-semibold"
                                style={{ color: vs >= 0 ? 'var(--gain)' : 'var(--loss)' }}
                                title="1Y return versus its own peer group average - its sector for sectoral/thematic funds">
                            {vs >= 0 ? '+' : ''}{vs.toFixed(1)}pp
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="text-[11px] mt-2.5 px-1 leading-relaxed" style={{ color: 'var(--text-low)' }}>
              Two facts decide the call: whether the fund <strong>ranks</strong> well, and whether it
              actually <strong>beats its own category</strong>. They usually agree — KEEP and EXIT.
              When they disagree the rank alone is misleading, which is what the middle two groups catch.
            </div>
          </div>

          {/* Reading key — sits between the Pulse and the lists, so it is read
              immediately before the first sparkline it explains. */}
          <div className="flex justify-end mb-3">
            <div className="text-[11px] flex items-center gap-1.5 px-3 py-1.5 rounded-lg"
                 style={{ color: 'var(--text-low)', background: 'var(--bg-card)', border: '1px solid var(--line)' }}>
              <span>Quartile boxes</span>
              <span className="px-1.5 py-0.5 rounded font-semibold"
                    style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-mid)' }}>
                oldest → latest
              </span>
              <span>(left = oldest {periodWord}, right = most recent)</span>
            </div>
          </div>

          {/* ── By category: Exit | Entry side by side, per category ── */}
          {view === 'category' && (
            byCategory.length === 0 ? (
              <div className="card p-10 text-center">
                <div style={{ fontSize: 26, opacity: 0.5 }}>🔍</div>
                <div className="text-sm mt-2" style={{ color: 'var(--text-hi)' }}>
                  No fund matches a {minStreak}+ {periodWord} streak
                </div>
                <div className="text-xs mt-1" style={{ color: 'var(--text-low)' }}>
                  Lower the streak threshold, or switch period.
                </div>
              </div>
            ) : byCategory.map(c => (
              <div key={c.slug} className="mb-5">
                <div className="flex items-baseline gap-2 mb-2 px-1">
                  <span className="font-display font-bold text-sm" style={{ color: 'var(--text-hi)' }}>
                    {c.category_name}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--text-low)' }}>
                    {c.fund_count} funds
                    {c.avg_1y != null && <> · category 1Y {fmtPct(c.avg_1y)}</>}
                  </span>
                  <span className="text-[11px] ml-auto">
                    <span style={{ color: EXIT }}>▼ {c.exits.length}</span>
                    <span style={{ color: 'var(--text-low)' }}> · </span>
                    <span style={{ color: ENTRY }}>▲ {c.entries.length}</span>
                  </span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <ListPanel title="Exit Watch" icon="🔴" accent={EXIT} rows={c.exits}
                    streakKey="exit_streak" periodWord={periodWord} compact labels={data.period_labels}
                    emptyNote={`Nothing in Q3/Q4 for ${minStreak}+ ${periodWord}s here.`} />
                  <ListPanel title="Entry Watch" icon="🟢" accent={ENTRY} rows={c.entries}
                    streakKey="entry_streak" periodWord={periodWord} compact labels={data.period_labels}
                    emptyNote={`Nothing in Q1/Q2 for ${minStreak}+ ${periodWord}s here.`} />
                </div>
              </div>
            ))
          )}

          {/* ── All ranked: one flat list per side ─────────────────── */}
          {view === 'ranked' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
              <ListPanel title={`Exit Watch — Q3/Q4 for ${minStreak}+ ${periodWord}s`} icon="🔴" accent={EXIT}
                rows={exits} streakKey="exit_streak" periodWord={periodWord} labels={data.period_labels}
                onCsv={() => toCsv(exits, 'Exit', mode, periodWord)}
                emptyNote={`No fund has been in Q3/Q4 for ${minStreak}+ consecutive ${periodWord}s.`} />
              <ListPanel title={`Entry Watch — Q1/Q2 for ${minStreak}+ ${periodWord}s`} icon="🟢" accent={ENTRY}
                rows={entries} streakKey="entry_streak" periodWord={periodWord} labels={data.period_labels}
                onCsv={() => toCsv(entries, 'Entry', mode, periodWord)}
                emptyNote={`No fund has been in Q1/Q2 for ${minStreak}+ consecutive ${periodWord}s.`} />
            </div>
          )}


          <div className="text-xs mt-4 leading-relaxed" style={{ color: 'var(--text-low)' }}>
            A streak counts back from the latest {periodWord} and is broken by any {periodWord} the
            fund was not ranked — a gap is treated as unknown, never as continuity.
            Compare the 1Y figure with its category average before acting: a Q3 fund in a strong
            peer group is a different case from one that is simply losing money.
          </div>
        </>
      )}

      {/* ── AMC Leaderboard — opened from the heading ──────────────── */}
      {amcOpen && data && (
        <div className="admin-modal-backdrop"
             onMouseDown={e => { if (e.target === e.currentTarget) setAmcOpen(false) }}
             role="dialog" aria-modal="true" aria-label="AMC Leaderboard">
          <div className="card overflow-hidden"
               style={{ width: 'min(940px, 96vw)', maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}>
            <div className="px-5 py-4 border-b flex items-center justify-between gap-3"
                 style={{ borderColor: 'var(--line)' }}>
              <div>
                <div className="font-display font-bold text-sm" style={{ color: 'var(--accent-a)' }}>
                  🏛 AMC Leaderboard
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'var(--text-low)' }}>
                  Where each house's funds sit in the latest {periodWord} — best average quartile first
                </div>
              </div>
              <button onClick={() => setAmcOpen(false)} aria-label="Close"
                      style={{ background: 'transparent', border: 'none', color: 'var(--text-low)',
                               fontSize: 22, lineHeight: 1, cursor: 'pointer' }}>×</button>
            </div>

            <div className="overflow-auto" style={{ flex: 1 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="text-left" style={{ minWidth: 210 }}>AMC</th>
                    <th style={{ textAlign: 'center' }} title="Funds ranked in the latest period">Ranked</th>
                    <th style={{ textAlign: 'center' }}>Q1</th>
                    <th style={{ textAlign: 'center' }}>Q2</th>
                    <th style={{ textAlign: 'center' }}>Q3</th>
                    <th style={{ textAlign: 'center' }}>Q4</th>
                    <th style={{ textAlign: 'center' }}>Top half</th>
                    <th style={{ textAlign: 'center' }}>Avg Q</th>
                  </tr>
                </thead>
                <tbody>
                  {data.amc_leaderboard
                    .filter(a => a.ranked >= minAmcFunds)
                    .map((a, i) => (
                    <tr key={a.amc_name}>
                      <td className="text-left">
                        <span style={{ color: 'var(--text-low)', marginRight: 8 }}>{i + 1}</span>{a.amc_name}
                      </td>
                      <td style={{ textAlign: 'center', color: 'var(--text-mid)' }}>{a.ranked}</td>
                      <td style={{ textAlign: 'center', color: Q_COLORS[1] }}>{a.q1 || '—'}</td>
                      <td style={{ textAlign: 'center', color: Q_COLORS[2] }}>{a.q2 || '—'}</td>
                      <td style={{ textAlign: 'center', color: Q_COLORS[3] }}>{a.q3 || '—'}</td>
                      <td style={{ textAlign: 'center', color: Q_COLORS[4] }}>{a.q4 || '—'}</td>
                      <td style={{ textAlign: 'center', fontWeight: 600 }}>{Math.round(a.top_half_pct * 100)}%</td>
                      <td style={{ textAlign: 'center', fontWeight: 600, color: 'var(--accent-a)' }}>{a.avg_quartile.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-3 border-t flex items-center gap-3 flex-wrap"
                 style={{ borderColor: 'var(--line)' }}>
              <span className="text-xs" style={{ color: 'var(--text-low)' }}>Minimum funds</span>
              <div className="tab-bar">
                {[1, 3, 5, 10].map(n => (
                  <button key={n} onClick={() => setMinAmcFunds(n)}
                          className={`tab-btn${minAmcFunds === n ? ' active accent' : ''}`}>
                    {n === 1 ? 'All' : `${n}+`}
                  </button>
                ))}
              </div>
              <span className="text-[11px] ml-auto" style={{ color: 'var(--text-low)' }}>
                A house with two funds can top the table on luck — raise the minimum to compare like with like.
              </span>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
