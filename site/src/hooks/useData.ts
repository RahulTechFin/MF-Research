// src/hooks/useData.ts — Data fetching hooks for all JSON endpoints

import { useState, useEffect, useMemo } from 'react'
import { computeDrawdown } from '../utils/drawdown'
import { MARKET_PULSE_INDICES, LIVE_INDEX_BASE } from '../config/indices'
import type { LiveIndexFile } from '../config/indices'

const BASE = import.meta.env.BASE_URL + 'data'

export function useJson<T>(path: string) {
  const [data, setData]   = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!path) return
    setLoading(true)
    setError(null)
    fetch(`${BASE}/${path}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [path])

  return { data, loading, error }
}

export function useMeta()              { return useJson<import('../types').Meta>('meta.json') }
export function useGlance(view: string){ return useJson<import('../types').GlanceData>(`glance_${view}.json`) }

/**
 * Market Pulse indices, read live from Supabase.
 *
 * One file per index (see config/indices.ts), fetched in parallel and assembled
 * into the same IndicesData shape the committed indices.json used to provide —
 * so MarketPulseBar and MarketPulse did not have to change.
 *
 * Two reasons this is worth the extra requests: each file already carries its
 * full history, so opening the chart needs no second fetch; and the files are
 * refreshed on their own schedule, so closes appear without a site rebuild.
 * Gzipped, the whole strip is ~80 KB.
 *
 * Falls back to the committed data/indices.json when the live path is
 * unavailable — which covers local `npm run dev` (no Netlify proxy) and a
 * Supabase outage. Without that, both would leave Market Pulse blank.
 */
export function useIndices() {
  type IndicesData = import('../types').IndicesData
  const [data, setData] = useState<IndicesData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const live = async (): Promise<IndicesData> => {
      const files = await Promise.all(
        MARKET_PULSE_INDICES.map(async ({ slug }) => {
          const r = await fetch(`${LIVE_INDEX_BASE}/${slug}.json`)
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${slug}`)
          return (await r.json()) as LiveIndexFile
        }),
      )
      return {
        // The strip labels itself with the freshest close it holds.
        as_of: files.reduce((a, f) => (f.date > a ? f.date : a), files[0].date),
        indices: files.map(f => ({
          index_id: f.index_id,
          index_name: f.index_name,
          latest_close: f.latest_close,
          date: f.date,
          change_1d: f.change_1d,
          change_1d_abs: f.change_1d_abs,
          sparkline: f.sparkline,
          history: f.history,
        })),
      }
    }

    const committed = async (): Promise<IndicesData> => {
      const r = await fetch(`${BASE}/indices.json`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as IndicesData
    }

    live()
      .catch(() => committed())
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false) } })

    return () => { cancelled = true }
  }, [])

  return { data, loading, error }
}

export function useCategoryTable(slug: string, view: string) {
  return useJson<import('../types').CategoryTableData>(`category_${slug}_${view}.json`)
}

export function useQuartiles(slug: string, mode: 'monthly' | 'quarterly' | 'annual') {
  return useJson<import('../types').QuartilesData>(`quartiles_${slug}_${mode}.json`)
}

export function useRisk(slug: string) {
  return useJson<import('../types').RiskData>(`risk_${slug}.json`)
}

/**
 * Underwater (drawdown) curve, derived in the browser from the fund's NAV series.
 *
 * The pipeline used to ship a pre-built drawdown/{code}.json for every fund —
 * 2,372 files, 303 MB, all recomputable from nav/{code}.json. The maths lives
 * in utils/drawdown.ts so it can be tested without React.
 */
export function useDrawdown(schemeCode: string) {
  const { data: nav, loading, error } =
    useJson<import('../types').NavSeries>(schemeCode ? `nav/${schemeCode}.json` : '')

  const data: import('../types').DrawdownData | null = useMemo(() => {
    if (!nav?.series?.length) return null
    return { scheme_code: nav.scheme_code, drawdown: computeDrawdown(nav.series) }
  }, [nav])

  return { data, loading, error }
}

// useNavSeries / useIndexSeries / useCategoryHistory used to live here but were
// never called — TrendFinder, BlendStudio, CategoryTrends and IndexChartModal
// each fetch those paths directly, because they need several files in parallel
// rather than the single-file shape this hook provides.
