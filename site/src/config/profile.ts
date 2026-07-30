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

/** Tabs to render right now. */
export function visibleTabs(isAdmin: boolean) {
  return ALL_TABS.filter(t => isEnabled(t.id, isAdmin))
}

/** Whether to offer the unlock control at all. */
export const CAN_UNLOCK = BUILD_HAS_ADMIN

/** Landing tab, and the fallback when a saved tab is no longer permitted. */
export const DEFAULT_TAB: SectionId = 'market-pulse'
