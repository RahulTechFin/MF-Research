// src/sections/CategoryTrends.tsx — Section 3: Category Trends chart

import { useState, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { useMeta } from '../hooks/useData'
import { categoryPath, dataUrl } from '../config/dataPaths'
import { fmtPct, retColor } from '../utils/format'

const CHART_COLORS = ['#22D3EE', '#F472B6', '#8B5CF6', '#F59E0B', '#34D399']
// A second palette, so a sector line is never mistaken for a category line.
const SECTOR_COLORS = ['#FBBF24', '#FB7185', '#4ADE80', '#60A5FA', '#C084FC',
                       '#F97316', '#2DD4BF', '#E879F9']
const TIMEFRAMES   = ['1M', '3M', '6M', '12M', '3Y', '5Y', 'All']

// AMFI files every theme under one category, so its single average blends
// banking with pharma and technology. The sub-list lets each theme be charted
// on its own. Capped for the same reason categories are: past this the chart is
// a colour test rather than a comparison.
const SECTORAL_THEMATIC_SLUG = 'sectoral-thematic'
const MAX_SECTOR_LINES = 6

interface Props {
  selectedCategories: string[]
}

interface CategoryHistory {
  label: string
  series: [string, number][]
}

interface SectorHistory {
  sector: string
  fund_count: number
  series: [string, number][]
}

export default function CategoryTrends({ selectedCategories }: Props) {
  const { data: meta } = useMeta()
  const [activePeriod, setActivePeriod] = useState('3M')
  const [seriesData, setSeriesData] = useState<Record<string, CategoryHistory>>({})
  const [loading, setLoading] = useState(false)

  // Per-theme averages, published inside the sectoral-thematic history file.
  const [sectorData, setSectorData] = useState<SectorHistory[]>([])
  const [visibleSectors, setVisibleSectors] = useState<string[]>([])

  const sectoralSelected = selectedCategories.includes(SECTORAL_THEMATIC_SLUG)

  // Drop the sector selection when the category itself is unticked, so the chart
  // never keeps plotting themes whose parent category is gone.
  useEffect(() => {
    if (!sectoralSelected) setVisibleSectors([])
  }, [sectoralSelected])

  // Fetch histories for all checked categories dynamically
  useEffect(() => {
    if (selectedCategories.length === 0) {
      setSeriesData({})
      return
    }

    setLoading(true)
    // async because the path is now <asset-class>/<slug>/history.json and the
    // asset class comes from manifest.json.
    const fetches = selectedCategories.map(async slug => {
      const catName = meta?.categories.find(c => c.slug === slug)?.category_name || slug
      try {
        const r = await fetch(dataUrl(await categoryPath(slug, 'history.json')))
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const d = await r.json()
        return {
          slug, label: catName, series: d.series as [string, number][],
          // Only sectoral-thematic carries this; everything else gets undefined.
          sectors: d.sectors as SectorHistory[] | undefined,
        }
      } catch {
        return null
      }
    })

    Promise.all(fetches).then(results => {
      const newMap: Record<string, CategoryHistory> = {}
      let sectors: SectorHistory[] = []
      results.forEach(res => {
        if (res && res.series && res.series.length > 0) {
          newMap[res.slug] = { label: res.label, series: res.series }
        }
        if (res?.slug === SECTORAL_THEMATIC_SLUG && res.sectors) {
          sectors = res.sectors.filter(s => s.series && s.series.length > 0)
        }
      })
      setSeriesData(newMap)
      setSectorData(sectors)
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
  const activeSectors = sectoralSelected
    ? sectorData.filter(s => visibleSectors.includes(s.sector))
    : []

  if (activeCategorySlugs.length > 0 || activeSectors.length > 0) {
    // Categories and sectors are the same shape, so the timeframe and the
    // normalisation base are worked out over both at once.
    const allRaw: [string, number][][] = [
      ...activeCategorySlugs.map(slug => seriesData[slug].series),
      ...activeSectors.map(s => s.series),
    ]

    let maxDateStr = '2010-01-01'
    allRaw.forEach(s => {
      const lastDate = s[s.length - 1][0]
      if (lastDate > maxDateStr) maxDateStr = lastDate
    })

    const startDateStr = getStartDate(maxDateStr)

    const allDates = new Set<string>()
    allRaw.forEach(s => s.forEach(([d]) => {
      if (d >= startDateStr && d <= maxDateStr) allDates.add(d)
    }))
    dates = Array.from(allDates).sort()

    // Rebased to 0% at the first date each series actually has in range, so a
    // theme whose funds are younger than the window still starts from its own
    // beginning rather than from a borrowed value.
    const push = (raw: [string, number][], name: string, color: string,
                  dashed: boolean) => {
      const rawMap = new Map(raw)
      let baseVal = 1.0
      for (const d of dates) {
        const val = rawMap.get(d)
        if (val !== undefined && val !== null) { baseVal = val; break }
      }
      const values = dates.map(d => {
        const val = rawMap.get(d)
        if (val === undefined || val === null) return null
        return parseFloat((((val / baseVal) - 1) * 100).toFixed(2))
      })
      chartSeries.push({
        name, type: 'line', data: values, smooth: true, showSymbol: false,
        lineStyle: { width: dashed ? 1.5 : 2, type: dashed ? 'dashed' : 'solid' },
        itemStyle: { color },
      })
    }

    activeCategorySlugs.forEach((slug, idx) => {
      push(seriesData[slug].series, seriesData[slug].label,
           CHART_COLORS[idx % CHART_COLORS.length], false)
    })
    // Dashed, so a theme is visibly a breakdown of a category rather than a peer.
    activeSectors.forEach((s, idx) => {
      push(s.series, s.sector, SECTOR_COLORS[idx % SECTOR_COLORS.length], true)
    })
  }

  /**
   * The chart's series as table rows, grouped under sub-headings.
   *
   * Read from `chartSeries` rather than recomputed, so the number in the table is
   * the last point of the very line drawn above it — there is no second
   * calculation that could drift from the first.
   */
  interface Row {
    key: string
    label: string
    isHeading?: boolean
    indent?: boolean
    colour?: string
    ret: number | null
    first: string | null
    last: string | null
    points: number
    count?: number | null
  }

  const tableRows: Row[] = []
  if (chartSeries.length > 0) {
    const rowFor = (s: any, indent: boolean, count?: number | null): Row => {
      const pts = (s.data as (number | null)[])
        .map((v, i) => [dates[i], v] as [string, number | null])
        .filter(([, v]) => v != null) as [string, number][]
      return {
        key: s.name,
        label: s.name,
        indent,
        colour: s.itemStyle?.color,
        // Series are normalised to 0% at their own first point in range, so the
        // final value IS the return over the plotted window.
        ret: pts.length ? pts[pts.length - 1][1] / 100 : null,
        first: pts.length ? pts[0][0] : null,
        last: pts.length ? pts[pts.length - 1][0] : null,
        points: pts.length,
        count,
      }
    }

    const catCount = activeCategorySlugs.length
    const secCount = activeSectors.length

    if (catCount > 0) {
      tableRows.push({ key: '#cat', label: 'Categories', isHeading: true,
                       ret: null, first: null, last: null, points: 0 })
      chartSeries.slice(0, catCount).forEach(s => tableRows.push(rowFor(s, false)))
    }
    if (secCount > 0) {
      tableRows.push({ key: '#sec', label: 'Sectoral/Thematic — by theme',
                       isHeading: true, ret: null, first: null, last: null, points: 0 })
      chartSeries.slice(catCount, catCount + secCount).forEach((s, i) =>
        tableRows.push(rowFor(s, true, activeSectors[i]?.fund_count ?? null)))
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

        {/* Sector breakdown, shown only while Sectoral/Thematic is selected */}
        {sectoralSelected && sectorData.length > 0 && (
          <div className="mb-4 p-3 rounded-lg"
               style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)' }}>
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <span className="text-xs font-semibold" style={{ color: 'var(--text-mid)' }}>
                Sectoral/Thematic breakdown — average of each theme
              </span>
              <span className="text-[11px]" style={{ color: 'var(--text-low)' }}>
                {visibleSectors.length}/{MAX_SECTOR_LINES} plotted
                {visibleSectors.length > 0 && (
                  <button onClick={() => setVisibleSectors([])}
                          className="ml-2 underline"
                          style={{ color: 'var(--accent-a)' }}>clear</button>
                )}
              </span>
            </div>
            <div className="flex gap-2 flex-wrap">
              {sectorData.map(s => {
                const on = visibleSectors.includes(s.sector)
                const full = !on && visibleSectors.length >= MAX_SECTOR_LINES
                const colour = on
                  ? SECTOR_COLORS[visibleSectors.indexOf(s.sector) % SECTOR_COLORS.length]
                  : undefined
                return (
                  <button key={s.sector}
                    disabled={full}
                    onClick={() => setVisibleSectors(prev => prev.includes(s.sector)
                      ? prev.filter(x => x !== s.sector)
                      : [...prev, s.sector])}
                    title={full ? `Untick one first — at most ${MAX_SECTOR_LINES} themes at a time`
                                : `${s.fund_count} fund(s) in ${s.sector}`}
                    className="px-2 py-1 rounded text-[11px] font-medium"
                    style={{
                      border: `1px solid ${on ? colour : 'var(--line)'}`,
                      color: on ? colour : 'var(--text-mid)',
                      background: on ? `${colour}18` : 'transparent',
                      cursor: full ? 'not-allowed' : 'pointer',
                      opacity: full ? 0.45 : 1,
                    }}>
                    {s.sector} <span style={{ opacity: 0.7 }}>({s.fund_count})</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}

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
          <>
            <div style={{ height: 380 }}>
              <ReactECharts
                option={option}
                style={{ height: '100%', width: '100%' }}
                notMerge
              />
            </div>

            {/* The same series as numbers.
                A normalised chart shows shape but is a poor way to read a value:
                two lines a few pixels apart can be a percentage point or ten.
                Every row is the return over exactly the plotted window, so the
                table and the chart cannot disagree. */}
            {tableRows.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="sticky-col text-left" style={{ minWidth: 240 }}>
                        Series
                      </th>
                      <th className="ret-cell">Return</th>
                      <th className="ret-cell">Start</th>
                      <th className="ret-cell">End</th>
                      <th className="ret-cell">Points</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.map(r => (
                      r.isHeading ? (
                        <tr key={r.key}>
                          <td className="sticky-col py-1.5 text-xs font-bold uppercase"
                              colSpan={5}
                              style={{ background: 'var(--bg-raised)',
                                       letterSpacing: '0.08em',
                                       color: 'var(--text-mid)' }}>
                            {r.label}
                          </td>
                        </tr>
                      ) : (
                        <tr key={r.key}>
                          <td className="sticky-col text-xs font-medium"
                              style={{ paddingLeft: r.indent ? '1.75rem' : undefined }}>
                            <span style={{ display: 'inline-block', width: 8, height: 8,
                                           borderRadius: 2, marginRight: 8,
                                           background: r.colour }} />
                            {r.label}
                            {r.count != null && (
                              <span style={{ color: 'var(--text-low)', marginLeft: 6 }}>
                                ({r.count})
                              </span>
                            )}
                          </td>
                          <td className={`ret-cell tabnum font-semibold ${retColor(r.ret)}`}>
                            {fmtPct(r.ret)}
                          </td>
                          <td className="ret-cell text-xs" style={{ color: 'var(--text-low)' }}>
                            {r.first ?? '—'}
                          </td>
                          <td className="ret-cell text-xs" style={{ color: 'var(--text-low)' }}>
                            {r.last ?? '—'}
                          </td>
                          <td className="ret-cell text-xs" style={{ color: 'var(--text-low)' }}>
                            {r.points}
                          </td>
                        </tr>
                      )
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}
