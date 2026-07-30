// src/config/indices.ts — the 8 Market Pulse indices, served live from Supabase.
//
// Each index is one file in the Supabase bucket, holding its identity, latest
// close, 1-day move, a 30-point sparkline and its full 6-year daily history.
// scripts/update_indices.py refreshes them every weekday evening, so Market
// Pulse shows the day's closes without a rebuild or a deploy.
//
// The path below is proxied by netlify.toml to the public bucket. It is
// deliberately NOT under /data/index/, which BlendStudio and TrendFinder use for
// the committed series of all 36 benchmarks — proxying that would break them.
//
// TO ADD A NINTH INDEX, three lists must agree:
//   1. this file
//   2. scripts/index_store.py           STRIP
//   3. scripts/build_json.py            STRIP_INDICES
// update_indices.py refuses to run if 2 and 3 disagree.

export const LIVE_INDEX_BASE = '/live/indices'

/** In render order — this is the order the Market Pulse strip appears in. */
export const MARKET_PULSE_INDICES: readonly { id: number; slug: string }[] = [
  { id: 1, slug: 'nifty-50' },
  { id: 2, slug: 'sensex' },
  { id: 3, slug: 'nifty-100' },
  { id: 6, slug: 'nifty-midcap-150' },
  { id: 7, slug: 'nifty-smallcap-250' },
  { id: 4, slug: 'nifty-bank' },
  { id: 5, slug: 'nifty-500' },
  { id: 9, slug: 'gold-goldbees' },
]

/** Shape of one published index file. */
export interface LiveIndexFile {
  index_id: number
  index_name: string
  slug: string
  as_of: string
  date: string
  latest_close: number
  change_1d: number | null
  change_1d_abs: number | null
  sparkline: [string, number][]
  history: [string, number][]
}
