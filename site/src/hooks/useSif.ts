// src/hooks/useSif.ts — the SIF desk's data.
//
// ONE FILE, ONE REQUEST. The whole desk is 30 funds and ~3,000 NAVs, so
// web/sif.json carries the categories, the fund sheet and every series together.
// Splitting it per screen would cost more in round trips than it saves in bytes.
//
// The path is /sif/*, proxied by vite.config.ts (dev) to the private "SIF Data"
// bucket with the service key attached server-side. The key is never in the
// browser. On Netlify the proxy does not exist yet, so this fetch fails there and
// the desk falls back to its scaffold rather than showing anything wrong.

import { useEffect, useState } from 'react'

export const SIF_BASE = '/sif'

export interface SifCategory {
  name: string
  slug: string
  asset_class: string
  order: number
  folder: string
  fund_count: number
}

export interface SifFund {
  scheme_code: string
  isin: string | null
  scheme_name: string
  amc: string
  category_name: string
  category_slug: string
  asset_class: string
  structure: string
  plan: string
  option: string
  plan_source: string
  latest_nav: number | null
  latest_nav_date: string | null
  history_first: string | null
  history_last: string | null
  history_points: number
}

export interface SifData {
  version: number
  generated: string
  as_of: string
  cap: string
  history: { first: string; last: string; days: number; rows: number }
  categories: SifCategory[]
  funds: SifFund[]
  navs: Record<string, [string, number][]>
}

// Shared across every SIF screen for the life of the page. Without this each
// mounted tab would pull the same 83 KB again.
let pending: Promise<SifData> | null = null

export function sifData(): Promise<SifData> {
  if (!pending) {
    pending = fetch(`${SIF_BASE}/web/sif.json`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<SifData>
      })
      .catch(err => {
        // Never cache a failure: a transient error would otherwise poison the
        // desk for the rest of the session.
        pending = null
        throw err
      })
  }
  return pending
}

export function useSif() {
  const [data, setData] = useState<SifData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    sifData()
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  return { data, loading, error }
}
