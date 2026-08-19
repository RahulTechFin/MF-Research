// src/sections/TrendFinder.tsx — Section 5: Trend Finder (fund comparison chart)

import { useState, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { useMeta } from '../hooks/useData'
import { shortFundName } from '../utils/format'
import { navPath, dataUrl } from '../config/dataPaths'

const CHART_COLORS = ['#22D3EE', '#F472B6', '#8B5CF6', '#F59E0B', '#34D399']
const TIMEFRAMES   = ['1M', '3M', '6M', '12M', '3Y', '5Y', 'All']

interface Props {
  selectedFunds: string[]
  onToggleFund: (code: string) => void
}

interface FundSeries {
  code: string
  label: string
  series: [string, number][]
}

export default function TrendFinder({ selectedFunds, onToggleFund }: Props) {
  const { data: meta } = useMeta()
  const [period, setPeriod] = useState('12M')
  const [loading, setLoading] = useState(false)

  // Sub-selections (which ones to toggle plot rendering)
  const [visibleFunds, setVisibleFunds] = useState<string[]>([])
  const [plotNifty50, setPlotNifty50]   = useState(true)
  const [plotNifty100, setPlotNifty100] = useState(false)

  // Loaded data maps
  const [fundData, setFundData] = useState<Record<string, FundSeries>>({})
  const [indexData, setIndexData] = useState<Record<number, { label: string; series: [string, number][] }>>({})

  // Keep visibleFunds synchronized when selectedFunds changes
  useEffect(() => {
    setVisibleFunds(selectedFunds)
  }, [selectedFunds])

  // Fetch NAV series for selected funds dynamically
  useEffect(() => {
    if (selectedFunds.length === 0) {
      setFundData({})
      return
    }

    setLoading(true)
    // async because a fund's NAV now lives at <asset-class>/<slug>/nav/<code>.json
    // and only manifest.json knows which category a code belongs to. That lookup
    // is why this screen does not need the slug passed down from the screener.
    const fetches = selectedFunds.map(async code => {
      try {
        const r = await fetch(dataUrl(await navPath(code)))
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        return { code, label: d.scheme_name || `Fund ${code}`, series: d.series as [string, number][] }
      } catch {
        return null
      }
    })

    Promise.all(fetches).then(results => {
      const newMap: Record<string, FundSeries> = {}
      results.forEach(res => {
        if (res && res.series && res.series.length > 0) {
          newMap[res.code] = res
        }
      })
      setFundData(newMap)
      setLoading(false)
    })
  }, [selectedFunds])

  // Fetch benchmark series dynamically
  useEffect(() => {
    if (!meta) return
    const nifty50 = meta.benchmarks.find(b => b.index_name === 'NIFTY 50')
    const nifty100 = meta.benchmarks.find(b => b.index_name === 'NIFTY 100')

    const indexesToFetch = [
      { id: nifty50?.index_id || 1, name: 'NIFTY 50' },
      { id: nifty100?.index_id || 3, name: 'NIFTY 100' }
    ]

    indexesToFetch.forEach(idx => {
      if (indexData[idx.id]) return // already fetched
      fetch(`${import.meta.env.BASE_URL}data/index/${idx.id}.json`)
        .then(r => r.json())
        .then(d => {
          setIndexData(prev => ({
            ...prev,
            [idx.id]: { label: idx.name, series: d.series as [string, number][] }
          }))
        })
        .catch(() => {})
    })
  }, [meta])

  const nifty50Info = meta?.benchmarks.find(b => b.index_name === 'NIFTY 50')
  const nifty100Info = meta?.benchmarks.find(b => b.index_name === 'NIFTY 100')

  // Theme colors
  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light'
  const axisColor = isLight ? '#4B5563' : '#5E6F8F'
  const lineColor = isLight ? '#E5E7EB' : '#24314F'
  const tooltipBg = isLight ? '#FFFFFF' : '#111A2E'
  const tooltipBorder = isLight ? '#D1D5DB' : '#24314F'
  const tooltipText = isLight ? '#111827' : '#F1F5FB'

  // Timeframe calculation
  const getStartDate = (maxDateStr: string): string => {
    const maxDate = new Date(maxDateStr)
    if (period === '1M') maxDate.setMonth(maxDate.getMonth() - 1)
    else if (period === '3M') maxDate.setMonth(maxDate.getMonth() - 3)
    else if (period === '6M') maxDate.setMonth(maxDate.getMonth() - 6)
    else if (period === '12M') maxDate.setFullYear(maxDate.getFullYear() - 1)
    else if (period === '3Y') maxDate.setFullYear(maxDate.getFullYear() - 3)
    else if (period === '5Y') maxDate.setFullYear(maxDate.getFullYear() - 5)
    else return '2010-01-01'
    return maxDate.toISOString().split('T')[0]
  }

  const handleTogglePlotVisibility = (code: string) => {
    setVisibleFunds(prev => prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code])
  }

  // Align and normalise chart data
  const chartSeries: any[] = []
  let dates: string[] = []

  const activeCodes = Object.keys(fundData).filter(code => visibleFunds.includes(code))
  const showN50 = plotNifty50 && nifty50Info && indexData[nifty50Info.index_id]
  const showN100 = plotNifty100 && nifty100Info && indexData[nifty100Info.index_id]

  if (activeCodes.length > 0 || showN50 || showN100) {
    // Find max date
    let maxDateStr = '2010-01-01'
    activeCodes.forEach(code => {
      const s = fundData[code].series
      const lastDate = s[s.length - 1][0]
      if (lastDate > maxDateStr) maxDateStr = lastDate
    })
    if (showN50) {
      const s = indexData[nifty50Info!.index_id].series
      const lastDate = s[s.length - 1][0]
      if (lastDate > maxDateStr) maxDateStr = lastDate
    }
    if (showN100) {
      const s = indexData[nifty100Info!.index_id].series
      const lastDate = s[s.length - 1][0]
      if (lastDate > maxDateStr) maxDateStr = lastDate
    }

    const startDateStr = getStartDate(maxDateStr)

    // Gather all distinct dates
    const allDates = new Set<string>()
    activeCodes.forEach(code => {
      fundData[code].series.forEach(([d]) => {
        if (d >= startDateStr && d <= maxDateStr) allDates.add(d)
      })
    })
    if (showN50) {
      indexData[nifty50Info!.index_id].series.forEach(([d]) => {
        if (d >= startDateStr && d <= maxDateStr) allDates.add(d)
      })
    }
    if (showN100) {
      indexData[nifty100Info!.index_id].series.forEach(([d]) => {
        if (d >= startDateStr && d <= maxDateStr) allDates.add(d)
      })
    }
    dates = Array.from(allDates).sort()

    // Helper to calculate normalised series
    const buildNormalisedSeries = (series: [string, number][], name: string, color: string, isDash = false) => {
      const rawMap = new Map(series)
      let baseVal = 1.0
      for (const d of dates) {
        const val = rawMap.get(d)
        if (val !== undefined && val !== null) {
          baseVal = val
          break
        }
      }

      const values = dates.map(d => {
        const val = rawMap.get(d)
        if (val === undefined || val === null) return null
        return parseFloat((((val / baseVal) - 1) * 100).toFixed(2))
      })

      chartSeries.push({
        name,
        type: 'line',
        data: values,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: isDash ? 1.5 : 2, type: isDash ? 'dashed' : 'solid' },
        itemStyle: { color }
      })
    }

    // Add selected funds
    activeCodes.forEach((code, idx) => {
      const label = shortFundName(fundData[code].label)
      buildNormalisedSeries(fundData[code].series, label, CHART_COLORS[idx % CHART_COLORS.length])
    })

    // Add benchmarks as dashed lines
    if (showN50 && nifty50Info) {
      buildNormalisedSeries(indexData[nifty50Info.index_id].series, 'NIFTY 50', isLight ? '#059669' : '#10B981', true)
    }
    if (showN100 && nifty100Info) {
      buildNormalisedSeries(indexData[nifty100Info.index_id].series, 'NIFTY 100', isLight ? '#8B5CF6' : '#A78BFA', true)
    }
  }

  const option = {
    backgroundColor: 'transparent',
    grid: { top: 40, right: 30, bottom: 40, left: 55 },
    xAxis: {
      type: 'category',
      data: dates,
      axisLine:  { lineStyle: { color: lineColor } },
      axisLabel: { color: axisColor, fontSize: 10, interval: Math.floor(dates.length / 8) },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLine:  { show: false },
      axisLabel: { color: axisColor, fontSize: 10, formatter: (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%` },
      splitLine: { lineStyle: { color: lineColor, type: 'dashed' } },
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: tooltipBg,
      borderColor: tooltipBorder,
      textStyle: { color: tooltipText, fontSize: 11 },
      axisPointer: { lineStyle: { color: 'var(--accent-a)', width: 1, type: 'dashed' } },
    },
    legend: {
      show: true,
      top: 5,
      textStyle: { color: isLight ? '#1F2937' : '#9FB0CC', fontSize: 11 },
    },
    series: chartSeries,
  }

  return (
    <section id="trend-finder" className="px-6 py-6 max-w-screen-2xl mx-auto">
      <div className="section-header">Trend Finder</div>

      <div className="card p-4">
        {/* Controls Layout */}
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-4 pb-4 border-b border-[var(--line)]">
          {/* Left side: Toggles for selected funds */}
          <div className="flex-1">
            <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-mid)' }}>
              Compare Funds (selected from table above):
            </div>
            {selectedFunds.length === 0 ? (
              <div className="text-xs italic" style={{ color: 'var(--text-low)' }}>
                No funds selected yet. Tock the "Select" checkbox on any row in the Fund Screener table above to plot here.
              </div>
            ) : (
              <div className="flex gap-4 flex-wrap">
                {selectedFunds.map((code, idx) => (
                  <label key={code} className="flex items-center gap-2 text-xs font-medium cursor-pointer" style={{ color: CHART_COLORS[idx % CHART_COLORS.length] }}>
                    <input
                      type="checkbox"
                      checked={visibleFunds.includes(code)}
                      onChange={() => handleTogglePlotVisibility(code)}
                      className="cursor-pointer"
                    />
                    <span className="truncate max-w-[160px]">
                      {fundData[code]?.label.replace(/Regular/gi, '').replace(/Growth/gi, '').trim() || code}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Right side: Fixed Benchmarks checkboxes */}
          <div className="shrink-0 flex flex-col gap-1 border-t md:border-t-0 md:border-l border-[var(--line)] pt-3 md:pt-0 md:pl-4">
            <div className="text-xs font-semibold mb-1" style={{ color: 'var(--text-mid)' }}>
              Fixed Benchmarks:
            </div>
            <div className="flex md:flex-col gap-3 md:gap-1">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer" style={{ color: isLight ? '#059669' : '#10B981' }}>
                <input
                  type="checkbox"
                  checked={plotNifty50}
                  onChange={() => setPlotNifty50(!plotNifty50)}
                  className="cursor-pointer"
                />
                NIFTY 50
              </label>
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer" style={{ color: isLight ? '#8B5CF6' : '#A78BFA' }}>
                <input
                  type="checkbox"
                  checked={plotNifty100}
                  onChange={() => setPlotNifty100(!plotNifty100)}
                  className="cursor-pointer"
                />
                NIFTY 100
              </label>
            </div>
          </div>
        </div>

        {/* Timeframe pills */}
        <div className="flex gap-2 flex-wrap mb-4">
          {TIMEFRAMES.map(tf => (
            <button key={tf} onClick={() => setPeriod(tf)}
              className={`pill${period === tf ? ' active' : ''}`}>
              {tf}
            </button>
          ))}
        </div>

        {/* Chart area */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="skeleton w-full h-80" />
          </div>
        ) : selectedFunds.length === 0 && !plotNifty50 && !plotNifty100 ? (
          <div className="flex items-center justify-center py-16 flex-col gap-2"
            style={{ color: 'var(--text-mid)', border: '1px dashed var(--line)', borderRadius: 8 }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <p className="text-sm">No series selected to plot.</p>
          </div>
        ) : (
          <div style={{ height: 400 }}>
            <ReactECharts
              option={option}
              style={{ height: '100%', width: '100%' }}
              notMerge
            />
          </div>
        )}

        {/* Instructions */}
        <div className="mt-3 text-xs text-center" style={{ color: 'var(--text-low)' }}>
          Dashed lines represent Fixed Benchmarks · Solid lines represent selected Growth Funds · All series normalised to 0% at the timeframe start date
        </div>
      </div>
    </section>
  )
}
