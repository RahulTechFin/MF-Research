// src/config/profile.ts — which sections each audience sees.
//
// TWO MECHANISMS LIVE HERE, for two different needs.
//
// 1. RUNTIME ADMIN GATE (the default, one shared link)
//    Everyone opens the same URL and lands on the team view. Entering the admin
//    password reveals the rest. Convenient, and one deployment to maintain.
//
//    Understand what this does and does not do: it hides the UI, not the data.
//    The site is static, so every file under /data is deployed and reachable by
//    URL, and the password check runs in the browser. Treat it as "keep the
//    team focused", NOT as "the team cannot read Risk Lab".
//
// 2. BUILD-TIME SPLIT (npm run build:team)
//    For the sealed version. The team bundle omits the restricted sections
//    entirely and scripts/prune_data.mjs deletes their JSON from dist/, so the
//    files are never deployed. Use this when the separation has to be real.
//    Both mechanisms coexist: a team build simply never shows the unlock.

export type Profile = 'admin' | 'team'

/** Build profile. 'team' physically excludes the admin sections. */
export const PROFILE: Profile =
  (import.meta.env.VITE_PROFILE as Profile) === 'team' ? 'team' : 'admin'

/** True when this build even contains the admin sections. */
const BUILD_HAS_ADMIN = PROFILE === 'admin'

// sections.json is the single source of truth, shared with
// scripts/prune_data.mjs so the UI and the data allowlist cannot drift apart.
// To let the team see another tab, move its id into publicSections there.
import sectionConfig from './sections.json'

// The desk registry. Type-only in the other direction, so there is no runtime
// import cycle between these two files.
import { productById } from './products'
import type { ProductId } from './products'

/** Sections everyone sees, no password needed. */
export const PUBLIC_SECTIONS: readonly string[] = sectionConfig.publicSections

/** Sections that require the admin password. */
export const ADMIN_SECTIONS: readonly string[] = sectionConfig.adminSections

export type SectionId =
  | 'market-pulse' | 'quartile'
  | 'category' | 'screener' | 'rolling' | 'risk' | 'blend' | 'watchlist'

/**
 * Per-section build-time flags.
 *
 * These are plain constants, so in a team build they fold to `false` and Rollup
 * drops both the JSX branch and the section component it references. Guarding
 * with a function call instead would defeat that — the bundler cannot evaluate
 * a call, so the component would stay in the bundle.
 *
 * Pair them with isEnabled() at the call site:
 *   {BUILD_SECTIONS.risk && isEnabled('risk', isAdmin) && <RiskLab />}
 *      ^ compiled out in a team build   ^ password gate in an admin build
 */
export const BUILD_SECTIONS = {
  category: BUILD_HAS_ADMIN,
  screener: BUILD_HAS_ADMIN,
  rolling:  BUILD_HAS_ADMIN,
  risk:     BUILD_HAS_ADMIN,
  blend:    BUILD_HAS_ADMIN,
} as const

// Spread-a-conditional-array so a team build never emits the admin labels.
const ALL_TABS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: 'market-pulse' as const, label: 'Market Pulse' },
  ...(BUILD_HAS_ADMIN
    ? [
        { id: 'category' as const, label: 'Market Trends' },
        { id: 'screener' as const, label: 'Fund Screener & Trend Finder' },
      ]
    : []),
  { id: 'quartile' as const, label: 'Quartile Ranking' },
  { id: 'watchlist' as const, label: 'Fund Signals' },
  ...(BUILD_HAS_ADMIN
    ? [
        { id: 'rolling' as const, label: 'Rolling & P2P' },
        { id: 'risk' as const,    label: 'Risk Lab 🔒' },
        { id: 'blend' as const,   label: 'Blend Studio' },
      ]
    : []),
]

function isPublic(id: SectionId): boolean {
  return PUBLIC_SECTIONS.includes(id)
}

/** Can this section be shown, given the build and the current unlock state? */
export function isEnabled(id: string, isAdmin: boolean): boolean {
  const section = id as SectionId
  if (isPublic(section)) return true
  return BUILD_HAS_ADMIN && isAdmin
}

/**
 * Tabs to render right now, for one desk.
 *
 * Two independent filters, and they mean different things. `excludes` is what
 * the desk does not HAVE — SIF has no Market Pulse and no Blend Studio, so those
 * tabs are absent rather than locked. isEnabled is the password gate on what a
 * desk does have.
 */
export function visibleTabs(isAdmin: boolean, product: ProductId = 'mf') {
  const excluded = productById(product).excludes
  return ALL_TABS.filter(t => isEnabled(t.id, isAdmin) && !excluded.includes(t.id))
}

/**
 * Where a desk lands, and where it falls back to when a remembered tab is no
 * longer allowed. Derived from the tab list rather than hard-coded, so a desk
 * that excludes its way past the default still opens on something real.
 */
export function defaultTab(product: ProductId = 'mf', isAdmin = false): SectionId {
  const tabs = visibleTabs(isAdmin, product)
  if (tabs.some(t => t.id === DEFAULT_TAB)) return DEFAULT_TAB
  return tabs[0]?.id ?? DEFAULT_TAB
}

/** Is `tab` a real tab on this desk, for this viewer? */
export function tabAllowed(tab: string, isAdmin: boolean, product: ProductId): boolean {
  return visibleTabs(isAdmin, product).some(t => t.id === tab)
}

/** Whether to offer the unlock control at all. */
export const CAN_UNLOCK = BUILD_HAS_ADMIN

/** Landing tab, and the fallback when a saved tab is no longer permitted. */
export const DEFAULT_TAB: SectionId = 'market-pulse'

/**
 * Whether this build offers any desk other than Mutual Fund.
 *
 * A plain constant for the same reason BUILD_SECTIONS is one: in a team build it
 * folds to false and Rollup drops ProductRail, SifDashboard and everything they
 * import. Confirmed against dist-team -- none of their strings survive.
 *
 * TWO THINGS DO SURVIVE, and neither is a leak worth chasing. The PRODUCTS
 * registry stays, because productById() is called at runtime to title the
 * freeze row, so a team bundle still contains the words "SIF RESEARCH CENTER".
 * And the rail's CSS stays, because the handwritten stylesheet is not purged --
 * only Tailwind's own utilities are. Class names and a desk label, with no code
 * to render them. If the mere name has to be absent, drop the entry from
 * PRODUCTS behind the same flag.
 */
export const BUILD_HAS_PRODUCTS = BUILD_HAS_ADMIN
