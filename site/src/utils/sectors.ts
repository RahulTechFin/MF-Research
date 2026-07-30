// src/utils/sectors.ts — sub-categories for the Sectoral/Thematic bucket.
//
// AMFI files ~250 funds under the single category "Sectoral/Thematic", which is
// too coarse to compare within: a pharma fund and a defence fund are not peers.
// SEBI publishes no sub-category and the API gives nothing beyond the scheme
// name, so the theme is inferred from that name.
//
// THE BACKEND IS NOW AUTHORITATIVE.
// scripts/sectors.py holds the same rules and build_json stamps each fund with a
// `sector` field, because the pipeline has to know a fund's sector to rank it
// within that sector. Read it with sectorOf() below, which prefers the stamped
// value and only classifies locally when the field is absent — i.e. against JSON
// built before this change. Two live implementations of a 25-rule ordered match
// would drift, and a fund showing as Healthcare in one section and Other in
// another is the kind of bug nobody reports.
//
// If you change a rule here, change scripts/sectors.py to match.
//
// RULE ORDER IS THE LOGIC. First match wins, so the specific comes before the
// general — 'infra' is tested before 'energy' so "Power & Infra" reads as
// Infrastructure, and ESG is tested before the factor rule because the AMCs
// "quant" and "Quantum" would otherwise make every one of their funds look like
// a quant strategy.

/** Sentinel for "no sub-filter" — not a real sector. */
export const ALL_SECTORS = 'All Sectors'

/** The AMFI category slug these sub-categories apply to. */
export const SECTORAL_THEMATIC_SLUG = 'sectoral-thematic'

const FIN         = 'Financial Services & Banking'
const HEALTH      = 'Healthcare & Pharma'
const TECH        = 'Technology & Telecom'
const INFRA       = 'Infrastructure & Realty'
const CONSUMPTION = 'Consumption & FMCG'
const ENERGY      = 'Energy & Utilities'
const METAL       = 'Metal & Commodities'
const SERVICES    = 'Services & Exports'
const RURAL       = 'Rural & Agri'
const TOURISM     = 'Tourism & Hospitality'
const PSE         = 'PSE & CPSE'
const MNC         = 'MNC'
const CONGLOM     = 'Conglomerate'
const INTL        = 'International & Global'
const MANUF       = 'Manufacturing'
const CYCLE       = 'Business Cycle'
const INNOV       = 'Innovation'
const QUANT       = 'Quant & Factor'
const ESG         = 'ESG & Ethical'
const SPECIAL     = 'Special Opportunities'
const IPO         = 'IPO & Recently Listed'
const THEME_OTHER = 'Thematic - Other (Defence, Railways, Auto)'
const OTHER       = 'Other Sectoral / Thematic'

const has = (n: string, ...tokens: string[]) => tokens.some(t => n.includes(t))

/** Ordered; first match wins. */
const RULES: [sector: string, test: (n: string) => boolean][] = [
  [FIN,         n => has(n, 'bank', 'finan', 'fsi', 'pru bank')],
  [HEALTH,      n => has(n, 'healthcare', 'pharma', 'health', 'medical', 'biotech')],
  [TECH,        n => has(n, 'tech', 'it ', 'digital', 'telecom', 'software', 'internet')],
  [INFRA,       n => has(n, 'infra', 'realty', 'housing', 'real estate', 'construct')],
  [CONSUMPTION, n => has(n, 'consumption', 'fmcg', 'consumer', 'retail', 'brand')],
  [PSE,         n => has(n, 'pse', 'psu', 'public sector')],
  [MNC,         n => has(n, 'mnc', 'multinational')],
  [METAL,       n => has(n, 'metal', 'commodit', 'resource', 'material')],
  [ENERGY,      n => has(n, 'energy', 'power', 'utility', 'utilities')],
  [THEME_OTHER, n => has(n, 'defence', 'railway', 'transport', 'mobility', 'auto')],

  // Everything below was previously swept into OTHER — nearly half the bucket,
  // which made the filter useless. These rules sit after the ten above so no
  // fund that already had a theme can change theme.
  [TECH,     n => has(n, 'teck')],                          // quant Teck Fund
  [INFRA,    n => has(n, 't.i.g.e.r', 'build india')],      // infra funds by acronym
  [METAL,    n => has(n, 'comma')],                         // SBI COMMA Fund
  [RURAL,    n => has(n, 'rural', 'agri')],
  [MANUF,    n => has(n, 'manufactur', 'make in india')],
  [CYCLE,    n => has(n, 'business cycle')],
  [CONGLOM,  n => has(n, 'conglomerate')],
  [SERVICES, n => has(n, 'export', 'service')],
  [INTL,     n => has(n, 'international', 'global', 'overseas', 'asian', 'china',
                          'japan', 'taiwan', 'europe', 'emerging market', 'nasdaq',
                          'world', 'bluechip equity', ' us ')],
  // Before QUANT: "QUANTUM ESG Best in Class" and "quant ESG Integration" are
  // ESG mandates whose AMC name merely happens to contain "quant".
  [ESG,      n => has(n, 'esg', 'sustainab', 'responsib', 'ethical')],
  [INNOV,    n => has(n, 'innovat', 'pioneer')],
  // \bquant\b, so the AMC "Quantum" does not read as a quant strategy.
  [QUANT,    n => /\bquant\b/.test(n) || has(n, 'quantamental', 'factor', 'momentum',
                                                'minimum variance', 'quality',
                                                'best-in-class', 'best in class', 'alpha')],
  [TOURISM,  n => has(n, 'tourism', 'travel', 'hotel', 'leisure')],
  [SPECIAL,  n => has(n, 'opportunit', 'special situation')],
  [IPO,      n => has(n, 'ipo')],
]

/** Which sub-category a Sectoral/Thematic fund belongs to, from its name. */
export function getSectorOfFund(name: string): string {
  const n = name.toLowerCase()
  for (const [sector, test] of RULES) if (test(n)) return sector
  return OTHER
}

/**
 * Canonical dropdown order — real sectors, then ownership/structure themes,
 * then strategy themes, with the catch-all last.
 */
export const SECTORS: readonly string[] = [
  ALL_SECTORS,
  FIN, HEALTH, TECH, INFRA, CONSUMPTION, ENERGY, METAL, SERVICES, RURAL, TOURISM,
  PSE, MNC, CONGLOM, INTL,
  MANUF, CYCLE, INNOV, QUANT, ESG, SPECIAL, IPO, THEME_OTHER,
  OTHER,
]

/** A fund carrying enough to determine its sector. */
export interface SectorBearing {
  scheme_name: string
  /** Stamped by build_json for sectoral-thematic funds. */
  sector?: string
}

/**
 * A fund's sector — the backend's answer when it sent one, else classify here.
 *
 * Always use this rather than getSectorOfFund() at a call site: the stamped
 * value is the one the quartiles were actually computed against, so trusting it
 * keeps the label and the ranking consistent even if the rules ever diverge.
 */
export function sectorOf(fund: SectorBearing): string {
  return fund.sector ?? getSectorOfFund(fund.scheme_name)
}

/**
 * Dropdown options for a set of funds, in canonical order, with counts and empty
 * sectors dropped. Listing all 23 every time offered options that matched
 * nothing — the count tells you whether a sector is worth opening.
 *
 * Accepts funds rather than names so it can honour the stamped sector. A caller
 * holding only names can pass `names.map(scheme_name => ({ scheme_name }))`.
 */
export function sectorOptions(funds: readonly SectorBearing[]): { sector: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const f of funds) {
    const s = sectorOf(f)
    counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  return [
    { sector: ALL_SECTORS, count: funds.length },
    ...SECTORS.filter(s => s !== ALL_SECTORS && counts.has(s))
              .map(s => ({ sector: s, count: counts.get(s)! })),
  ]
}
