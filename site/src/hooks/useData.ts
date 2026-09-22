// src/hooks/useData.ts — Data fetching hooks for all JSON endpoints

import { useState, useEffect, useMemo } from 'react'
import { computeDrawdown } from '../utils/drawdown'
import { MARKET_PULSE_INDICES, LIVE_INDEX_BASE } from '../config/indices'
import type { LiveIndexFile } from '../config/indices'
import { dataBase, MARKET_BASE, categoryPath, navPath } from '../config/dataPaths'

/**
 * Fetch one JSON file from the data bucket.
 *
 * `path` is either a bucket-relative path, or a function returning a promise of
 * one. The function form exists because a category-scoped path has to wait for
 * manifest.json before it is even known; keeping that inside this hook means the
 * twenty-odd callers never deal with it.
 *
 * `key` identifies the request for the effect's dependency list, since a
 * function identity changes on every render and cannot be compared.
 */
export function useJson<T>(path: string | (() => Promise<string>), key?: string,
                          base?: string) {
  const [data, setData]   = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const dep = typeof path === 'string' ? path : (key ?? '')

  useEffect(() => {
    if (!dep) return
    let cancelled = false
    setLoading(true)
    setError(null)
    // DROP THE PREVIOUS FILE'S CONTENT. It belongs to the file we just stopped
    // asking for, and every caller renders `loading ? skeleton : data ? table`,
    // so anything left here is shown under the NEW heading.
    //
    // That is how clicking a SIF debt strategy listed another strategy's funds:
    // its category file does not exist, the fetch 400s, `error` is set — and the
    // stale `data` was still truthy, so the table branch won. The reader saw a
    // full table of equity funds titled "Debt Long-Short Fund", and the
    // "Coming Funds" state below it was unreachable.
    //
    // Clearing costs a skeleton flash on every category change, where before the
    // old numbers stayed on screen a moment longer. That trade is not close: one
    // is a redraw, the other is the wrong fund list under the right name.
    setData(null)

    const resolve = typeof path === 'string' ? Promise.resolve(path) : path()
    resolve
      // `base` overrides the desk root for files that are shared between desks.
      // Only the index series needs it; everything else is desk-scoped.
      .then(p => fetch(`${base ?? dataBase()}/${p}`))
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(d => { if (!cancelled) { setData(d); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(e.message); setLoading(false) } })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep])

  return { data, loading, error }
}

export function useMeta()              { return useJson<import('../types').Meta>('meta.json') }
export function useGlance(view: string){ return useJson<import('../types').GlanceData>(`glance_${view}.json`) }

/**
 * Market Pulse indices — WHICHEVER SOURCE IS FRESHER.
 *
 * Two sources publish the same 8 indices on different schedules:
 *
 *   live      /live/indices/{slug}.json  — proxied to Supabase, refreshed by
 *             update_indices.yml on its own cron. No rebuild needed, and each
 *             file carries its full history so opening the chart costs nothing.
 *   committed data/indices.json          — written by the nightly NAV run and
 *             deployed with the site.
 *
 * BOTH are fetched and the newer `date` wins. An earlier version preferred live
 * unconditionally, which broke exactly as you would expect: the indices job was
 * not running (its Supabase secrets were unset), so Supabase sat at 2026-07-29
 * while the repo had 2026-07-31 — and because the stale fetch still returned
 * 200, nothing fell back. Market Pulse showed two-day-old closes next to
 * fund data from today.
 *
 * Comparing dates makes it self-healing in both directions: if the indices job
 * stops, the nightly build carries the strip; if the nightly build is delayed,
 * the live files carry it. The extra request is ~7 KB gzipped.
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
      const r = await fetch(`${MARKET_BASE}/indices.json`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return (await r.json()) as IndicesData
    }

    // Settled, not all: one source failing must not sink the other. Local
    // `npm run dev` has no Netlify proxy, so `live` always rejects there.
    Promise.allSettled([live(), committed()])
      .then(([liveRes, commRes]) => {
        if (cancelled) return
        const ok = [liveRes, commRes]
          .filter((r): r is PromiseFulfilledResult<IndicesData> => r.status === 'fulfilled')
          .map(r => r.value)
          .filter(d => d?.indices?.length)

        if (!ok.length) {
          const why = [liveRes, commRes]
            .map(r => (r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : ''))
            .filter(Boolean)
            .join('; ')
          setError(why || 'no index data available')
          setLoading(false)
          return
        }

        // Freshest wins. Compare the newest close each source actually holds
        // rather than its as_of label, which the committed file stamps with the
        // build date and would therefore always look newer.
        const newest = (d: IndicesData) =>
          d.indices.reduce((a, i) => (i.date > a ? i.date : a), '')
        ok.sort((a, b) => (newest(b) < newest(a) ? -1 : 1))
        setData(ok[0])
        setLoading(false)
      })

    return () => { cancelled = true }
  }, [])

  return { data, loading, error }
}

export function useCategoryTable(slug: string, view: string) {
  return useJson<import('../types').CategoryTableData>(
    () => categoryPath(slug, `category_${view}.json`), `cat:${slug}:${view}`)
}

export function useQuartiles(slug: string, mode: 'monthly' | 'quarterly' | 'annual') {
  return useJson<import('../types').QuartilesData>(
    () => categoryPath(slug, `quartiles_${mode}.json`), `q:${slug}:${mode}`)
}

export function useRisk(slug: string) {
  return useJson<import('../types').RiskData>(
    () => categoryPath(slug, 'risk.json'), `risk:${slug}`)
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
    useJson<import('../types').NavSeries>(
      () => navPath(schemeCode), schemeCode ? `nav:${schemeCode}` : '')

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

/**
 * NAV series for many funds at once, from the same nav/<code>.json the pipeline
 * writes — no new data file, no second source.
 *
 * Concurrency is capped because a category can hold 300+ funds and firing 300
 * requests at once gets them queued by the browser anyway, while making the
 * first result arrive later than it needs to. Eight in flight keeps the table
 * filling steadily.
 *
 * Partial results are returned as they arrive, so a big category renders
 * progressively instead of showing nothing for several seconds. A fund whose
 * file is missing is simply absent from the map rather than failing the batch.
 */
export function useNavSeriesMany(codes: string[]) {
  type Series = [string, number][]
  const [series, setSeries] = useState<Record<string, Series>>({})
  const [loaded, setLoaded] = useState(0)
  const [loading, setLoading] = useState(false)

  // Codes arrive as a fresh array every render; key on the contents.
  const key = codes.join(',')

  useEffect(() => {
    if (!codes.length) { setSeries({}); setLoaded(0); setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setSeries({})
    setLoaded(0)

    const CONCURRENCY = 8
    const queue = [...codes]
    const out: Record<string, Series> = {}
    let done = 0

    const worker = async () => {
      while (!cancelled) {
        const code = queue.shift()
        if (!code) return
        try {
          const path = await navPath(code)
          const r = await fetch(`${dataBase()}/${path}`)
          if (r.ok) {
            const d = await r.json()
            if (d?.series?.length) out[code] = d.series as Series
          }
        } catch {
          /* a missing fund is omitted, not fatal */
        }
        done++
        if (!cancelled && (done % 10 === 0 || done === codes.length)) {
          setSeries({ ...out })
          setLoaded(done)
        }
      }
    }

    Promise.all(Array.from({ length: Math.min(CONCURRENCY, codes.length) }, worker))
      .then(() => {
        if (cancelled) return
        setSeries({ ...out })
        setLoaded(codes.length)
        setLoading(false)
      })

    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return { series, loaded, total: codes.length, loading }
}

/**
 * One index's full series, for the benchmark comparison.
 *
 * READS THE SHARED MARKET ROOT, never the desk root. The 36 benchmark series are
 * published once and only under the mutual fund tree, because the same NIFTY 500
 * has to mean the same thing on every desk — the SIF publish deliberately drops
 * its own copies rather than duplicating them into a second bucket.
 *
 * This was the one index consumer that reached the data through useJson rather
 * than a direct fetch, so it was missed when the two roots were separated. The
 * effect was narrow and easy to overlook: on the SIF desk every request became
 * /sif/data/index/<id>.json, which does not exist, so Rolling & Point-to-Point
 * had no benchmark line, no benchmark return, and a blank vs-Benchmark column,
 * while every other screen looked fine.
 */
export function useIndexSeries(indexId: number | null) {
  return useJson<{ index_id: number; index_name: string; series: [string, number][] }>(
    indexId ? `index/${indexId}.json` : '',
    indexId ? `index:${indexId}` : '',
    MARKET_BASE,
  )
}
