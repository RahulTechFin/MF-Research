// src/sections/BlendStudio.tsx — Section 9: Blend Studio (Hybrid benchmark blend builder)

import { useState, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import { useMeta } from '../hooks/useData'
import { categoryPath, dataUrl } from '../config/dataPaths'

interface BlendWeight {
  index_id: number
  index_name: string
  weight: number
}

// Client-side blend computation (E7.1 — the ONLY sanctioned client-side calculation)
function computeBlend(
  componentSeries: Record<number, [string, number][]>,
  weights: BlendWeight[],
): [string, number][] {
  if (weights.length === 0) return []

  // Find common dates
  const dateSets = weights.map(w => new Set(componentSeries[w.index_id]?.map(d => d[0]) ?? []))
  if (dateSets.length === 0) return []
  const commonDates = [...dateSets[0]].filter(d => dateSets.every(s => s.has(d))).sort()
  if (commonDates.length < 2) return []

  // Build lookup maps
  const maps: Record<number, Map<string, number>> = {}
  for (const w of weights) {
    maps[w.index_id] = new Map(componentSeries[w.index_id]?.map(([d, v]) => [d, v]) ?? [])
  }

  const result: [string, number][] = []
  let prev_value = 100.0
  let prev_closes: Record<number, number | null> = {}

  for (let i = 0; i < commonDates.length; i++) {
    const d = commonDates[i]
    if (i === 0) {
      for (const w of weights) prev_closes[w.index_id] = maps[w.index_id].get(d) ?? null
      result.push([d, 100.0])
      continue
    }

    let daily_return = 0
    let valid = true
    for (const w of weights) {
      const close_t    = maps[w.index_id].get(d) ?? null
      const close_prev = prev_closes[w.index_id]
      if (close_t == null || close_prev == null) { valid = false; break }
      daily_return += w.weight * ((close_t / close_prev) - 1)
      prev_closes[w.index_id] = close_t
    }

    if (!valid) {
      result.push([d, prev_value])
      continue
    }

    prev_value = prev_value * (1 + daily_return)
    result.push([d, Math.round(prev_value * 10000) / 10000])
  }

  return result
}

export default function BlendStudio() {
  const { data: meta } = useMeta()
  const [weights, setWeights] = useState<BlendWeight[]>([])
  const [total, setTotal]     = useState(100)
  const [error, setError]     = useState<string | null>(null)

  // Comparative category and index data loading states
  const [compareCategory, setCompareCategory] = useState('aggressive-hybrid')
  const [indexSeries, setIndexSeries] = useState<Record<number, [string, number][]>>({})
  const [categorySeries, setCategorySeries] = useState<[string, number][]>([])
  const [loading, setLoading] = useState(false)

  // Initialize with Aggressive Hybrid preset
  useEffect(() => {
    if (!meta) return
    const nifty50 = meta.benchmarks.find(b => b.index_name === 'NIFTY 50')
    const gilt    = meta.benchmarks.find(b => b.index_name === 'GILT ETF (LTGILTBEES)')
    if (nifty50 && gilt) {
      setWeights([
        { index_id: nifty50.index_id, index_name: nifty50.index_name, weight: 65 },
        { index_id: gilt.index_id,    index_name: gilt.index_name,    weight: 35 },
      ])
    }
  }, [meta])

  // Fetch index series when weights are initialized/change
  useEffect(() => {
    if (weights.length === 0) return

    weights.forEach(w => {
      if (indexSeries[w.index_id]) return // already loaded
      fetch(`${import.meta.env.BASE_URL}data/index/${w.index_id}.json`)
        .then(r => r.json())
        .then(d => {
          setIndexSeries(prev => ({
            ...prev,
            [w.index_id]: d.series as [string, number][]
          }))
        })
        .catch(() => {})
    })
  }, [weights])

  // Fetch category history for comparative line
  useEffect(() => {
    setLoading(true)
    categoryPath(compareCategory, 'history.json')
      .then(p => fetch(dataUrl(p)))
      .then(r => r.json())
      .then(d => {
        setCategorySeries(d.series as [string, number][])
        setLoading(false)
      })
      .catch(() => {
        setCategorySeries([])
        setLoading(false)
      })
  }, [compareCategory])

  const handleWeightChange = (index_id: number, val: string) => {
    const n = parseFloat(val) || 0
    const updated = weights.map(w => w.index_id === index_id ? { ...w, weight: n } : w)
    setWeights(updated)
    const sum = updated.reduce((s, w) => s + w.weight, 0)
    setTotal(Math.round(sum))
    setError(sum < 99.5 || sum > 100.5 ? `Weights must sum to 100 (currently ${sum.toFixed(1)})` : null)
  }

  // Client-side computations & Normalisation to 0% at common start date
  const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light'
  const axisColor = isLight ? '#4B5563' : '#5E6F8F'
  const lineColor = isLight ? '#E5E7EB' : '#24314F'
  const tooltipBg = isLight ? '#FFFFFF' : '#111A2E'
  const tooltipBorder = isLight ? '#D1D5DB' : '#24314F'
  const tooltipText = isLight ? '#111827' : '#F1F5FB'

  const rawBlend = computeBlend(indexSeries, weights)
  const chartSeries: any[] = []
  let dates: string[] = []

  if (rawBlend.length > 0 && categorySeries.length > 0) {
    // Find common start date
    const start_nav_date = rawBlend[0][0] > categorySeries[0][0] ? rawBlend[0][0] : categorySeries[0][0]
    const end_nav_date = rawBlend[rawBlend.length - 1][0] < categorySeries[categorySeries.length - 1][0]
      ? rawBlend[rawBlend.length - 1][0]
      : categorySeries[categorySeries.length - 1][0]

    // Align dates
    const blendMap = new Map(rawBlend)
    const catMap = new Map(categorySeries)

    dates = rawBlend.map(d => d[0]).filter(d => d >= start_nav_date && d <= end_nav_date)

    // Normalize Blend
    const blendBase = blendMap.get(start_nav_date) || 100.0
    const blendValues = dates.map(d => {
      const val = blendMap.get(d) ?? blendBase
      return parseFloat((((val / blendBase) - 1) * 100).toFixed(2))
    })

    // Normalize Category Average
    const catBase = catMap.get(start_nav_date) || 1.0
    const catValues = dates.map(d => {
      const val = catMap.get(d) ?? catBase
      return parseFloat((((val / catBase) - 1) * 100).toFixed(2))
    })

    chartSeries.push({
      name: 'Custom Blended Benchmark',
      type: 'line',
      data: blendValues,
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2.5 },
      itemStyle: { color: 'var(--accent-a)' }
    })

    const categoryLabel = meta?.categories.find(c => c.slug === compareCategory)?.category_name || 'Category Average'
    chartSeries.push({
      name: `∑ ${categoryLabel} Average`,
      type: 'line',
      data: catValues,
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 1.5, type: 'dashed' },
      itemStyle: { color: isLight ? '#4B5563' : '#9FB0CC' }
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

  const realBenchmarks = (meta?.benchmarks ?? []).filter(b => !b.is_synthetic)

  return (
    <section id="blend-studio" className="px-6 py-6 max-w-screen-2xl mx-auto">
      <div className="section-header">Blend Studio</div>

      <div className="card p-5">
        <p className="text-sm mb-4" style={{ color: 'var(--text-mid)' }}>
          Interactive hybrid benchmark what-if tool. Adjust component weights to visualise a custom blended benchmark.
          <br />
          <span className="text-xs" style={{ color: 'var(--text-low)' }}>
            ⓘ Permanent changes to stored benchmarks are made in the config table (not here). This is a client-side preview only.
          </span>
        </p>

        {/* Weight inputs */}
        <div className="space-y-3 mb-5">
          {weights.map(w => (
            <div key={w.index_id} className="flex items-center gap-3">
              <div className="flex-1 text-sm" style={{ color: 'var(--text-hi)' }}>{w.index_name}</div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={w.weight}
                  min={0} max={100} step={5}
                  onChange={e => handleWeightChange(w.index_id, e.target.value)}
                  className="w-20 px-2 py-1 rounded text-sm text-right font-mono"
                  style={{ background: 'var(--bg-raised)', border: `1px solid ${error ? 'var(--loss)' : 'var(--line)'}`, color: 'var(--text-hi)', outline: 'none' }}
                />
                <span className="text-xs" style={{ color: 'var(--text-mid)' }}>%</span>
              </div>
            </div>
          ))}
        </div>

        {/* Total + error */}
        <div className={`text-sm font-semibold mb-4 ${total === 100 ? 'text-[var(--gain)]' : 'text-[var(--loss)]'}`}>
          Total: {total}%
          {error && <span className="text-xs font-normal ml-2" style={{ color: 'var(--loss)' }}>{error}</span>}
        </div>

        {/* Chart rendering */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="skeleton w-full h-80" />
          </div>
        ) : rawBlend.length === 0 ? (
          <div className="flex items-center justify-center py-16 flex-col gap-2"
            style={{ color: 'var(--text-mid)', border: '1px dashed var(--line)', borderRadius: 8 }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
            </svg>
            <p className="text-sm">Wait for index histories to populate...</p>
          </div>
        ) : (
          <div style={{ height: 380, marginBottom: '1.25rem' }}>
            <ReactECharts
              option={option}
              style={{ height: '100%', width: '100%' }}
              notMerge
            />
          </div>
        )}

        {/* Presets */}
        <div className="mt-4 border-t border-[var(--line)] pt-3">
          <div className="text-xs mb-2" style={{ color: 'var(--text-mid)' }}>Load preset blend:</div>
          <div className="flex gap-2 flex-wrap">
            {[
              { label: 'Aggressive Hybrid (65:35)', nifty: 65, gilt: 35, slug: 'aggressive-hybrid' },
              { label: 'Balanced Advantage (50:50)', nifty: 50, gilt: 50, slug: 'balanced-advantage' },
              { label: 'Conservative (25:75)', nifty: 25, gilt: 75, slug: 'conservative-hybrid' },
            ].map(preset => (
              <button key={preset.label}
                onClick={() => {
                  const nifty50 = meta?.benchmarks.find(b => b.index_name === 'NIFTY 50')
                  const gilt    = meta?.benchmarks.find(b => b.index_name === 'GILT ETF (LTGILTBEES)')
                  if (nifty50 && gilt) {
                    setWeights([
                      { index_id: nifty50.index_id, index_name: nifty50.index_name, weight: preset.nifty },
                      { index_id: gilt.index_id,    index_name: gilt.index_name,    weight: preset.gilt },
                    ])
                    setCompareCategory(preset.slug)
                    setTotal(100)
                    setError(null)
                  }
                }}
                className="pill text-xs">
                {preset.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
