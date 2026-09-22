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

/**
 * Which band of the market an index describes.
 *
 * Market Pulse shows these as two labelled groups. The split is editorial, not
 * technical: a broad index answers "how did the market do", a sectoral one
 * answers "which part of it did", and reading them off one undifferentiated
 * grid of eighteen cards makes neither question easy to ask.
 */
export type IndexGroup = 'broad' | 'sectoral'

export interface MarketPulseIndex {
  id: number
  slug: string
  group: IndexGroup
}

/**
 * In render order, within each group — this is the order the Market Pulse cards
 * appear in.
 *
 * NIFTY BANK is deliberately left in `broad`. It is a sector by construction,
 * but it has been read as a market barometer here since the first version, and
 * moving it would change what a reader thinks the top row means. It can be
 * reclassified in one line if that turns out to be the wrong call.
 */
export const MARKET_PULSE_INDICES: readonly MarketPulseIndex[] = [
  { id: 1, slug: 'nifty-50',           group: 'broad' },
  { id: 2, slug: 'sensex',             group: 'broad' },
  { id: 3, slug: 'nifty-100',          group: 'broad' },
  { id: 6, slug: 'nifty-midcap-150',   group: 'broad' },
  { id: 7, slug: 'nifty-smallcap-250', group: 'broad' },
  { id: 4, slug: 'nifty-bank',         group: 'broad' },
  { id: 5, slug: 'nifty-500',          group: 'broad' },
  { id: 9, slug: 'gold-goldbees',      group: 'broad' },

  // ── Sectoral ─────────────────────────────────────────────────────────────
  // Awaiting the benchmark list. Each one added here needs the same three
  // lists to agree as any other index — see the header of this file — plus a
  // gradient in INDEX_META in sections/MarketPulse.tsx so its card is not
  // rendered in the fallback blue.
]

/** Group headings and the accent each group's rule is drawn in. */
export const MARKET_PULSE_GROUPS: readonly {
  key: IndexGroup
  label: string
  gradient: [string, string]
}[] = [
  { key: 'broad',    label: 'Broader Market', gradient: ['#22D3EE', '#1d4ed8'] },
  { key: 'sectoral', label: 'Sectoral',       gradient: ['#F59E0B', '#F472B6'] },
]

/**
 * The group an index belongs to, by id.
 *
 * Anything unclassified falls to `broad` rather than disappearing. The strip has
 * two sources — the live bucket, ordered by the list above, and the committed
 * indices.json fallback, which is ordered by the build — so a card must never
 * depend on its position in the array to be shown.
 */
export function indexGroup(id: number): IndexGroup {
  return MARKET_PULSE_INDICES.find(i => i.id === id)?.group ?? 'broad'
}

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
