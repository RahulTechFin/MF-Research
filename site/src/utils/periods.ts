// src/utils/periods.ts — reading and ordering a period column key.
//
// build_json emits calendar columns OLDEST FIRST, with the running period last:
//
//   monthly    2025-08 … 2026-07, MTD
//   quarterly  Q3-2024 … Q2-2026, QTD
//   annual     2010 … 2025, YTD 2026
//
// Every table shows them the other way round -- latest on the left -- because
// that is the column a reader looks at first and it should not require scrolling
// to the far right of twelve months to find it. The reversal happens here rather
// than in the pipeline so the published files stay in their natural chronological
// order and nothing downstream has to know which way round they arrived.
//
// TRAILING IS NOT SORTED. 1M/3M/6M/12M/3Y/5Y/10Y is already shortest-to-longest,
// which is its own meaningful order, and periodRank cannot rank it anyway.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Chronological rank of a period column, newest highest.
 *
 * The running period (MTD / QTD / YTD) always ranks top: it is the most recent
 * thing on the row even though it is incomplete.
 */
export function periodRank(pk: string): number {
  if (pk === 'MTD' || pk === 'QTD' || pk.startsWith('YTD')) return Number.MAX_SAFE_INTEGER
  const m = /^(\d{4})-(\d{2})$/.exec(pk)
  if (m) return Number(m[1]) * 100 + Number(m[2])
  const q = /^Q([1-4])-(\d{4})$/.exec(pk)
  if (q) return Number(q[2]) * 100 + Number(q[1]) * 3
  const y = /^(\d{4})$/.exec(pk)
  if (y) return Number(y[1]) * 100
  return -1
}

/** Period keys in display order: latest first, except for trailing. */
export function orderPeriods(keys: readonly (string | number)[],
                             view: string): string[] {
  const out = keys.map(String)
  if (view === 'trailing') return out
  return out.sort((a, b) => periodRank(b) - periodRank(a))
}

const MONTH_FULL: Record<string, string> = {
  Jan: 'January', Feb: 'February', Mar: 'March',      Apr: 'April',
  May: 'May',     Jun: 'June',     Jul: 'July',       Aug: 'August',
  Sep: 'September', Oct: 'October', Nov: 'November',  Dec: 'December',
}

/** The calendar months a quarter actually covers. */
const QUARTER_MONTHS = ['Jan - Mar', 'Apr - Jun', 'Jul - Sep', 'Oct - Dec']

/**
 * A period label split into a heading and a smaller second line.
 *
 *   "Q4-2025"  -> { main: "Q4 2025",  sub: "(Oct - Dec 25)" }
 *   "2026-07"  -> { main: "Jul 2026" }
 *   "Aug-2025" -> { main: "August",   sub: "2025" }
 *   "2024"     -> { main: "2024" }
 *   "QTD"      -> { main: "QTD" }
 *
 * WHY A QUARTER GETS ITS MONTHS SPELT OUT
 * "Q4" is only obvious once you have decided whether the year is calendar or
 * fiscal — and in India the financial year runs April to March, so a reader can
 * reasonably take Q4 to mean Jan-Mar. Printing the months removes the question.
 * The quartile grid has always done this; every other table now does too.
 */
export function periodLabelParts(pk: string): { main: string; sub?: string } {
  const q = /^Q([1-4])[- ](\d{4})$/.exec(pk)
  if (q) {
    const idx = Number(q[1]) - 1
    return { main: `Q${q[1]} ${q[2]}`, sub: `(${QUARTER_MONTHS[idx]} ${q[2].slice(2)})` }
  }

  // "Aug-2025", the shape the quartile grid publishes for a month.
  const abbr = /^([A-Z][a-z]{2})-(\d{4})$/.exec(pk)
  if (abbr) return { main: MONTH_FULL[abbr[1]] ?? abbr[1], sub: abbr[2] }

  // "2026-07", the shape every other table publishes.
  const iso = /^(\d{4})-(\d{2})$/.exec(pk)
  if (iso) {
    const i = Number(iso[2]) - 1
    if (i >= 0 && i < 12) return { main: `${MONTHS[i]} ${iso[1]}` }
  }

  return { main: pk }
}
