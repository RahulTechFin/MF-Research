// src/components/IndexChartModal.tsx
// Modal that opens when clicking an index card.
// • Single index  → raw close price chart
// • 2–5 indices   → normalized % return from period start (comparable)
// • Custom date   → "Custom" pill reveals From/To date pickers

import { useState, useEffect, useCallback } from 'react'
import ReactECharts from 'echarts-for-react'
import { marketUrl } from '../config/dataPaths'

const TIMEFRAMES = ['1M', '3M', '6M', '1Y', '3Y', '5Y', 'All', 'Custom']

const INDEX_META: Record<string, { gradient: [string, string]; color: string }> = {
  'NIFTY 50':           { gradient: ['#1d4ed8', '#22D3EE'], color: '#22D3EE' },
  'SENSEX':             { gradient: ['#7c3aed', '#F472B6'], color: '#F472B6' },
  'NIFTY 100':          { gradient: ['#1565c0', '#38BDF8'], color: '#38BDF8' },
  'NIFTY MIDCAP 150':   { gradient: ['#0f766e', '#14B8A6'], color: '#14B8A6' },
  'NIFTY SMALLCAP 250': { gradient: ['#065f46', '#34D399'], color: '#34D399' },
  'NIFTY BANK':         { gradient: ['#4338ca', '#818CF8'], color: '#818CF8' },
  'NIFTY 500':          { gradient: ['#0369a1', '#7DD3FC'], color: '#7DD3FC' },
  'GOLD (GOLDBEES)':    { gradient: ['#92400e', '#F59E0B'], color: '#F59E0B' },
}

const SERIES_COLORS = ['#22D3EE', '#F472B6', '#34D399', '#F59E0B', '#818CF8']

// history is optional: the live Supabase index files include it, the committed
// indices.json fallback does not.
interface IndexInfo { index_id: number; index_name: string; history?: [string, number][] }
interface Props { initial: IndexInfo; allIndices: IndexInfo[]; onClose: () => void }
interface SeriesData { id: number; name: string; data: [string, number][] }

function getStartDate(maxDateStr: string, period: string): string {
  const d = new Date(maxDateStr)
  if (period === '1M') d.setMonth(d.getMonth() - 1)
  else if (period === '3M') d.setMonth(d.getMonth() - 3)
  else if (period === '6M') d.setMonth(d.getMonth() - 6)
  else if (period === '1Y') d.setFullYear(d.getFullYear() - 1)
  else if (period === '3Y') d.setFullYear(d.getFullYear() - 3)
  else if (period === '5Y') d.setFullYear(d.getFullYear() - 5)
  else return '2000-01-01'
  return d.toISOString().split('T')[0]
}

// Shared pill button style
function PillBtn({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 12px', fontSize: 12, borderRadius: 20, cursor: 'pointer',
        background: active ? 'var(--accent-a)' : 'var(--bg-raised)',
        color: active ? '#000' : 'var(--text-mid)',
        border: `1px solid ${active ? 'var(--accent-a)' : 'var(--line)'}`,
        fontWeight: active ? 600 : 400,
        transition: 'all 120ms',
      }}
    >
      {children}
    </button>
  )
}

export default function IndexChartModal({ initial, allIndices, onClose }: Props) {
  const [period, setPeriod] = useState('1Y')
  const [selected, setSelected] = useState<number[]>([initial.index_id])
  const [seriesMap, setSeriesMap] = useState<Record<number, SeriesData>>({})
  const [loadingIds, setLoadingIds] = useState<number[]>([])

  // Custom date state — default: last 1 year
  const today = new Date().toISOString().split('T')[0]
  const oneYearAgo = new Date(new Date().setFullYear(new Date().getFullYear() - 1)).toISOString().split('T')[0]
  const [customFrom, setCustomFrom] = useState(oneYearAgo)
  const [customTo, setCustomTo]   = useState(today)

  const isCustom = period === 'Custom'

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Series for an index, if not already loaded.
  //
  // The live Supabase files carry their own history, so the common case needs no
  // request at all — the data arrived with the strip. Only the committed
  // indices.json fallback lacks it, and then we fetch as before.
  const fetchSeries = useCallback((id: number, name: string) => {
    if (seriesMap[id]) return

    const inline = allIndices.find(i => i.index_id === id)?.history
    if (inline && inline.length) {
      setSeriesMap(prev => ({ ...prev, [id]: { id, name, data: inline } }))
      return
    }

    setLoadingIds(prev => [...prev, id])
    fetch(marketUrl(`index/${id}.json`))
      .then(r => r.json())
      .then(d => {
        setSeriesMap(prev => ({
          ...prev,
          [id]: { id, name, data: d.series as [string, number][] },
        }))
        setLoadingIds(prev => prev.filter(x => x !== id))
      })
      .catch(() => setLoadingIds(prev => prev.filter(x => x !== id)))
  }, [seriesMap, allIndices])

  // Fetch initial on mount
  useEffect(() => {
    fetchSeries(initial.index_id, initial.index_name)
  }, []) // eslint-disable-line

  const toggleIndex = (id: number, name: string) => {
    if (selected.includes(id)) {
      if (selected.length === 1) return
      setSelected(prev => prev.filter(x => x !== id))
    } else {
      if (selected.length >= 5) return
      setSelected(prev => [...prev, id])
      fetchSeries(id, name)
    }
  }

  // Theme colours
  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light'
  const axisColor  = isLight ? '#6B7280' : '#5E6F8F'
  const gridColor  = isLight ? '#E5E7EB' : '#1E2D47'
  const tooltipBg  = isLight ? '#FFFFFF' : '#0F1929'
  const tooltipBrd = isLight ? '#D1D5DB' : '#24314F'
  const tooltipTxt = isLight ? '#111827' : '#F1F5FB'

  const isComparing = selected.length > 1
  const readySeries = selected.filter(id => !!seriesMap[id])
  const isLoading   = loadingIds.length > 0 || readySeries.length === 0

  // Determine date window
  let maxDate = '2000-01-01'
  readySeries.forEach(id => {
    const s = seriesMap[id].data
    const last = s[s.length - 1]?.[0] ?? '2000-01-01'
    if (last > maxDate) maxDate = last
  })
  const startDate = isCustom ? customFrom : getStartDate(maxDate, period)
  const endDate   = isCustom ? customTo   : maxDate

  // Build chart series
  const chartSeries: object[] = []
  let xDates: string[] = []

  if (readySeries.length > 0) {
    if (isComparing) {
      const allDates = new Set<string>()
      readySeries.forEach(id => {
        seriesMap[id].data.forEach(([d]) => {
          if (d >= startDate && d <= endDate) allDates.add(d)
        })
      })
      xDates = Array.from(allDates).sort()

      readySeries.forEach((id, i) => {
        const map = new Map(seriesMap[id].data)
        let base = 1
        for (const d of xDates) {
          const v = map.get(d)
          if (v !== undefined) { base = v; break }
        }
        const values = xDates.map(d => {
          const v = map.get(d)
          if (v === undefined) return null
          return parseFloat((((v / base) - 1) * 100).toFixed(2))
        })
        const color = SERIES_COLORS[i % SERIES_COLORS.length]
        chartSeries.push({
          name: seriesMap[id].name, type: 'line', data: values,
          smooth: true, showSymbol: false,
          lineStyle: { width: 2, color }, itemStyle: { color },
        })
      })
    } else {
      const id = readySeries[0]
      const raw = seriesMap[id].data.filter(([d]) => d >= startDate && d <= endDate)
      xDates = raw.map(([d]) => d)
      const values = raw.map(([, v]) => v)
      const meta = INDEX_META[seriesMap[id].name]
      const [g1, g2] = meta?.gradient ?? ['#1d4ed8', '#22D3EE']
      chartSeries.push({
        name: seriesMap[id].name, type: 'line', data: values,
        smooth: true, showSymbol: false,
        lineStyle: { width: 2.5, color: g2 }, itemStyle: { color: g2 },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: g1 + '50' },
              { offset: 1, color: g2 + '05' },
            ],
          },
        },
      })
    }
  }

  const option = {
    backgroundColor: 'transparent',
    animation: true,
    grid: { top: 40, right: 20, bottom: 50, left: isComparing ? 65 : 75 },
    xAxis: {
      type: 'category', data: xDates,
      axisLine: { lineStyle: { color: gridColor } },
      axisLabel: {
        color: axisColor, fontSize: 11,
        interval: Math.max(0, Math.floor(xDates.length / 10) - 1),
        formatter: (v: string) => {
          const d = new Date(v)
          return `${d.toLocaleString('en', { month: 'short' })} '${String(d.getFullYear()).slice(2)}`
        },
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value', axisLine: { show: false },
      axisLabel: {
        color: axisColor, fontSize: 11,
        formatter: isComparing
          ? (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`
          : (v: number) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : `${v.toFixed(0)}`,
      },
      splitLine: { lineStyle: { color: gridColor, type: 'dashed' } },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tooltipBg, borderColor: tooltipBrd,
      textStyle: { color: tooltipTxt, fontSize: 12 },
      axisPointer: { lineStyle: { color: '#22D3EE', width: 1, type: 'dashed' } },
      formatter: (params: any[]) => {
        const date = params[0]?.axisValue ?? ''
        const lines = params.map((p: any) => {
          const val = p.value == null ? '—'
            : isComparing
              ? `${p.value > 0 ? '+' : ''}${(p.value as number).toFixed(2)}%`
              : (p.value as number).toLocaleString('en-IN', { maximumFractionDigits: 2 })
          return `<div style="display:flex;align-items:center;gap:6px;margin-top:3px">
            <span style="width:8px;height:8px;border-radius:50%;background:${p.color};display:inline-block;flex-shrink:0"></span>
            <span style="flex:1;color:${tooltipTxt}">${p.seriesName}</span>
            <strong style="color:${tooltipTxt}">${val}</strong>
          </div>`
        }).join('')
        return `<div style="font-size:11px;color:${axisColor};margin-bottom:4px">${date}</div>${lines}`
      },
    },
    legend: isComparing
      ? { show: true, top: 6, textStyle: { color: isLight ? '#374151' : '#9FB0CC', fontSize: 11 } }
      : { show: false },
    series: chartSeries,
  }

  // Shared date input style
  const dateInputStyle: React.CSSProperties = {
    background: 'var(--bg-base)',
    border: '1px solid var(--line)',
    borderRadius: 8,
    color: 'var(--text-hi)',
    fontSize: 12,
    padding: '4px 10px',
    height: 30,
    outline: 'none',
    cursor: 'pointer',
    colorScheme: isLight ? 'light' : 'dark',
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="w-full max-w-5xl rounded-2xl overflow-hidden flex flex-col"
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--line)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
          maxHeight: '90vh',
        }}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-6 py-4 border-b"
          style={{ borderColor: 'var(--line)', background: 'var(--bg-raised)' }}
        >
          <div>
            <div className="font-display font-bold text-base" style={{ color: 'var(--text-hi)' }}>
              {isComparing ? 'Index Comparison' : seriesMap[selected[0]]?.name ?? initial.index_name}
            </div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--text-low)' }}>
              {isComparing
                ? 'Normalized % returns — select up to 5 indices'
                : 'Daily closing price — click another index to compare'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 transition-colors duration-150"
            style={{ color: 'var(--text-mid)', border: '1px solid var(--line)' }}
            title="Close (Esc)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-4 p-5 overflow-y-auto">

          {/* Timeframe row */}
          <div className="flex items-center flex-wrap gap-2">
            {/* Period pills */}
            <div className="flex gap-1.5 flex-wrap items-center">
              {TIMEFRAMES.map(tf => (
                <PillBtn key={tf} active={period === tf} onClick={() => setPeriod(tf)}>
                  {tf === 'Custom' ? '📅 Custom' : tf}
                </PillBtn>
              ))}
            </div>

            {/* Custom date pickers — slide in when Custom is active */}
            {isCustom && (
              <div
                className="flex items-center gap-2 flex-wrap"
                style={{
                  paddingLeft: 8,
                  borderLeft: '1px solid var(--line)',
                  marginLeft: 4,
                }}
              >
                <span className="text-xs" style={{ color: 'var(--text-low)' }}>From</span>
                <input
                  type="date"
                  value={customFrom}
                  max={customTo}
                  onChange={e => setCustomFrom(e.target.value)}
                  style={dateInputStyle}
                />
                <span className="text-xs" style={{ color: 'var(--text-low)' }}>To</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom}
                  max={today}
                  onChange={e => setCustomTo(e.target.value)}
                  style={dateInputStyle}
                />
              </div>
            )}

            {/* Normalized badge */}
            {isComparing && (
              <div
                className="text-xs px-2.5 py-1 rounded-full font-semibold ml-auto"
                style={{
                  background: 'rgba(34,211,238,0.1)',
                  color: 'var(--accent-a)',
                  border: '1px solid rgba(34,211,238,0.2)',
                  whiteSpace: 'nowrap',
                }}
              >
                📊 Normalized Mode
              </div>
            )}
          </div>

          {/* Index selector checkboxes */}
          <div className="flex flex-wrap gap-2">
            {allIndices.map(idx => {
              const isChecked = selected.includes(idx.index_id)
              const meta = INDEX_META[idx.index_name]
              const color = isChecked
                ? (SERIES_COLORS[selected.indexOf(idx.index_id)] ?? meta?.color ?? '#22D3EE')
                : 'var(--text-low)'
              const disabled = !isChecked && selected.length >= 5
              return (
                <button
                  key={idx.index_id}
                  onClick={() => toggleIndex(idx.index_id, idx.index_name)}
                  disabled={disabled}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '5px 12px', borderRadius: 20, fontSize: 12,
                    border: `1px solid ${isChecked ? color : 'var(--line)'}`,
                    background: isChecked ? color + '18' : 'var(--bg-raised)',
                    color: isChecked ? color : 'var(--text-mid)',
                    fontWeight: isChecked ? 600 : 400,
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.4 : 1,
                    transition: 'all 120ms',
                  }}
                >
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: isChecked ? color : 'var(--line)',
                    flexShrink: 0, transition: 'background 120ms',
                  }} />
                  {idx.index_name}
                </button>
              )
            })}
          </div>

          {/* Chart */}
          <div
            className="rounded-xl overflow-hidden"
            style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', minHeight: 360 }}
          >
            {isLoading ? (
              <div className="flex items-center justify-center h-96" style={{ color: 'var(--text-low)' }}>
                <div className="flex flex-col items-center gap-3">
                  <svg className="animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25"/>
                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"/>
                  </svg>
                  <span className="text-sm">Loading chart data…</span>
                </div>
              </div>
            ) : (
              <ReactECharts
                option={option}
                style={{ height: 380, width: '100%' }}
                notMerge
                lazyUpdate={false}
              />
            )}
          </div>

          {/* Footer */}
          <div className="text-xs text-center" style={{ color: 'var(--text-low)' }}>
            {isComparing
              ? `Normalized to 0% at ${isCustom ? customFrom : 'period start'} for fair comparison.`
              : 'Select another index badge above to compare (max 5). Chart switches to normalized % mode automatically.'}
          </div>
        </div>
      </div>
    </div>
  )
}
