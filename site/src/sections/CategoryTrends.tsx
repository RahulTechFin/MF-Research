// src/sections/CategoryTrends.tsx — Section 3: Category Trends chart

import { useState, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { useMeta } from '../hooks/useData'

const CHART_COLORS = ['#22D3EE', '#F472B6', '#8B5CF6', '#F59E0B', '#34D399']
const TIMEFRAMES   = ['1M', '3M', '6M', '12M', '3Y', '5Y', 'All']

interface Props {
  selectedCategories: string[]
}

interface CategoryHistory {
  label: string
  series: [string, number][]
}

export default function CategoryTrends({ selectedCategories }: Props) {
  const { data: meta } = useMeta()
  const [activePeriod, setActivePeriod] = useState('3M')
  const [seriesData, setSeriesData] = useState<Record<string, CategoryHistory>>({})
  const [loading, setLoading] = useState(false)

  // Fetch histories for all checked categories dynamically
  useEffect(() => {
    if (selectedCategories.length === 0) {
      setSeriesData({})
      return
    }

    setLoading(true)
    const fetches = selectedCategories.map(slug => {
      const catName = meta?.categories.find(c => c.slug === slug)?.category_name || slug
      const url = `${import.meta.env.BASE_URL}data/category_history/${slug}.json`
      return fetch(url)
        .then(r => {
          if (!r.ok) throw new Error()
          return r.json()
        })
        .then(d => ({ slug, label: catName, series: d.series as [string, number][] }))
        .catch(() => null)
    })

    Promise.all(fetches).then(results => {
      const newMap: Record<string, CategoryHistory> = {}
      results.forEach(res => {
        if (res && res.series && res.series.length > 0) {
          newMap[res.slug] = { label: res.label, series: res.series }
        }
      })
      setSeriesData(newMap)
      setLoading(false)
    })
  }, [selectedCategories, meta])

  // Get active theme variables
  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light'
  const axisColor = isLight ? '#4B5563' : '#5E6F8F'
  const lineColor = isLight ? '#E5E7EB' : '#24314F'
  const tooltipBg = isLight ? '#FFFFFF' : '#111A2E'
  const tooltipBorder = isLight ? '#D1D5DB' : '#24314F'
  const tooltipText = isLight ? '#111827' : '#F1F5FB'

  // Determine starting date based on period
  const getStartDate = (maxDateStr: string): string => {
    const maxDate = new Date(maxDateStr)
    if (activePeriod === '1M') maxDate.setMonth(maxDate.getMonth() - 1)
    else if (activePeriod === '3M') maxDate.setMonth(maxDate.getMonth() - 3)
    else if (activePeriod === '6M') maxDate.setMonth(maxDate.getMonth() - 6)
    else if (activePeriod === '12M') maxDate.setFullYear(maxDate.getFullYear() - 1)
    else if (activePeriod === '3Y') maxDate.setFullYear(maxDate.getFullYear() - 3)
    else if (activePeriod === '5Y') maxDate.setFullYear(maxDate.getFullYear() - 5)
    else return '2010-01-01'
    return maxDate.toISOString().split('T')[0]
  }

  // Build normalisation data
  const chartSeries: any[] = []
  let dates: string[] = []

  const activeCategorySlugs = Object.keys(seriesData)
  if (activeCategorySlugs.length > 0) {
    // Find the max date across all series to anchor the timeframe
    let maxDateStr = '2010-01-01'
    activeCategorySlugs.forEach(slug => {
      const s = seriesData[slug].series
      const lastDate = s[s.length - 1][0]
      if (lastDate > maxDateStr) maxDateStr = lastDate
    })

    const startDateStr = getStartDate(maxDateStr)

    // Find the dates in the timeframe
    const allDates = new Set<string>()
    activeCategorySlugs.forEach(slug => {
      seriesData[slug].series.forEach(([d]) => {
        if (d >= startDateStr && d <= maxDateStr) allDates.add(d)
      })
    })
    dates = Array.from(allDates).sort()

    // Calculate normalised series starting at 0%
    activeCategorySlugs.forEach((slug, idx) => {
      const raw = seriesData[slug].series
      const rawMap = new Map(raw)
      
      // Find the first available date in our range to use as reference value
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
        name: seriesData[slug].label,
        type: 'line',
        data: values,
        smooth: true,
        showSymbol: false,
        lineStyle: { width: 2 },
        itemStyle: { color: CHART_COLORS[idx % CHART_COLORS.length] }
      })
    })
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
    <section id="category-trends" className="px-6 py-6 max-w-screen-2xl mx-auto">
      <div className="section-header">Category Trends</div>

      <div className="card p-4">
        {/* Timeframe pills */}
        <div className="flex gap-2 flex-wrap mb-4">
          {TIMEFRAMES.map(tf => (
            <button key={tf} onClick={() => setActivePeriod(tf)}
              className={`pill${activePeriod === tf ? ' active' : ''}`}>
              {tf}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="skeleton w-full h-80" />
          </div>
        ) : selectedCategories.length === 0 ? (
          <div className="flex items-center justify-center py-16 flex-col gap-3"
            style={{ color: 'var(--text-mid)', borderRadius: 8, border: '1px dashed var(--line)' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <p className="text-sm font-semibold">No Category Selected</p>
            <p className="text-xs text-center px-4 max-w-md" style={{ color: 'var(--text-low)' }}>
              Tick up to 5 checkboxes in the Category Snapshot table above to compare their average NAV trends side-by-side.
            </p>
          </div>
        ) : (
          <div style={{ height: 380 }}>
            <ReactECharts
              option={option}
              style={{ height: '100%', width: '100%' }}
              notMerge
            />
          </div>
        )}
      </div>
    </section>
  )
}
