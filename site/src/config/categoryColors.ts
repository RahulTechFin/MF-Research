// src/config/categoryColors.ts — one colour per category, shared by every screen.
//
// WHY A SHARED MAP AND NOT assetClassColor EVERYWHERE
// Asset class alone gives three colours for 41 mutual fund categories and two for
// five SIF strategies, so "Hybrid Long-Short" and "Active Asset Allocator
// Long-Short" came out identical — which is exactly the pair a reader most needs
// to tell apart. Naming the SIF strategies individually fixes that, and the
// mutual fund desk keeps its asset-class colour because 41 distinct hues would
// be noise rather than information.
//
// Keyed by SLUG, never by position: a new strategy launching must not shift the
// colour of the ones already there.

import { assetClassColor } from '../utils/format'

const STRATEGY_COLOR: Record<string, string> = {
  // SIF — SEBI's seven investment strategies
  'equity-long-short':                 '#3B82F6',
  'equity-ex-top-100-long-short':      '#22D3EE',
  'sector-rotation-long-short':        '#A78BFA',
  'active-asset-allocator-long-short': '#F472B6',
  'hybrid-long-short':                 '#FBBF24',
  'debt-long-short':                   '#34D399',
  'sectoral-debt-long-short':          '#2DD4BF',
}

/**
 * The colour for a category. Falls back to its asset class, which is what every
 * mutual fund category uses.
 */
export function categoryColor(slug: string | undefined, assetClass?: string): string {
  return (slug && STRATEGY_COLOR[slug]) || assetClassColor(assetClass ?? '')
}

/** True when this category has a colour of its own rather than a shared one. */
export function hasOwnColor(slug: string | undefined): boolean {
  return !!slug && slug in STRATEGY_COLOR
}
