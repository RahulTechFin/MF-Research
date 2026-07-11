// src/hooks/useData.ts — Data fetching hooks for all JSON endpoints

import { useState, useEffect } from 'react'

const BASE = import.meta.env.BASE_URL + 'data'

function useJson<T>(path: string) {
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
export function useIndices()           { return useJson<import('../types').IndicesData>('indices.json') }
export function useGlance(view: string){ return useJson<import('../types').GlanceData>(`glance_${view}.json`) }

export function useCategoryTable(slug: string, view: string) {
  return useJson<import('../types').CategoryTableData>(`category_${slug}_${view}.json`)
}

export function useMovers(slug: string) {
  return useJson<import('../types').MoversData>(`movers_${slug}.json`)
}

export function useQuartiles(slug: string, mode: 'quarterly' | 'annual') {
  return useJson<import('../types').QuartilesData>(`quartiles_${slug}_${mode}.json`)
}

export function useRisk(slug: string) {
  return useJson<import('../types').RiskData>(`risk_${slug}.json`)
}

export function useDrawdown(schemeCode: string) {
  return useJson<import('../types').DrawdownData>(`drawdown/${schemeCode}.json`)
}

export function useNavSeries(schemeCode: string) {
  return useJson<import('../types').NavSeries>(`nav/${schemeCode}.json`)
}

export function useIndexSeries(indexId: number) {
  return useJson<import('../types').IndexSeries>(`index/${indexId}.json`)
}

export function useCategoryHistory(slug: string) {
  return useJson<{ category_slug: string; series: [string, number][] }>(`category_history/${slug}.json`)
}
