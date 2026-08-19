// src/utils/returns.ts — returns computed in the browser from a NAV series.
//
// WHY THIS EXISTS AT ALL
// engine/calculation_engine.py is the single source of truth and says so: no
// formula is to be re-implemented elsewhere. That rule holds for everything the
// pipeline can precompute — and it precomputes a great deal, which is why the
// dashboard mostly just reads numbers.
//
// Point-to-Point cannot be precomputed. The user picks any two dates, so there is
// no finite set of answers to ship. The only alternatives were a server (there
// isn't one — the site is static) or leaving the section as the placeholder it had
// been. So the arithmetic lives here, deliberately and in one small file, reading
// the same nav/<code>.json the pipeline reads.
//
// utils/drawdown.ts is the same pattern for the same reason.
//
// KEEPING IT HONEST
// The resolution rules below mirror engine.calculation_engine exactly:
//
//   SEARCH_WINDOW      10 calendar days; past that, no value is resolved
//   nearest-previous   latest point on or before the target
//   nearest-next       earliest point on or after the target
//   <= 366 days        simple return
//   >  366 days        CAGR over the ACTUAL resolved day count, not the nominal one
//
// tests/returns.spec.ts pins these against values produced by the Python engine.

/** A NAV or index series as published: [date, value], oldest first. */
export type Series = [string, number][]

/** Matches SEARCH_WINDOW in engine/calculation_engine.py. */
export const SEARCH_WINDOW_DAYS = 10

const MS_PER_DAY = 86400000

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / MS_PER_DAY)
}

export interface Resolved { date: string; value: number }

/**
 * Latest point on or before `target`, or null if the nearest is more than
 * SEARCH_WINDOW_DAYS away — the same refusal the engine makes, so a fund that
 * stopped reporting does not silently borrow a stale value.
 *
 * Binary search: a category can hold 300 funds of ~4,000 points each, and a
 * linear scan per lookup is felt.
 */
export function nearestPrevious(series: Series, target: string): Resolved | null {
  let lo = 0
  let hi = series.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (series[mid][0] <= target) { best = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  if (best < 0) return null
  const [d, v] = series[best]
  if (Math.abs(daysBetween(d, target)) > SEARCH_WINDOW_DAYS) return null
  return { date: d, value: v }
}

/** Earliest point on or after `target`, subject to the same window. */
export function nearestNext(series: Series, target: string): Resolved | null {
  let lo = 0
  let hi = series.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (series[mid][0] >= target) { best = mid; hi = mid - 1 } else { lo = mid + 1 }
  }
  if (best < 0) return null
  const [d, v] = series[best]
  if (Math.abs(daysBetween(d, target)) > SEARCH_WINDOW_DAYS) return null
  return { date: d, value: v }
}

export interface PeriodReturn {
  ret: number | null
  cagr: number | null
  startDate: string | null
  endDate: string | null
  days: number | null
}

const EMPTY: PeriodReturn = {
  ret: null, cagr: null, startDate: null, endDate: null, days: null,
}

/**
 * Return between two dates the user chose.
 *
 * The start resolves FORWARD and the end BACKWARD, so the window never reaches
 * outside what was asked for. That differs from a named calendar period — a
 * month or a quarter starts at the PREVIOUS period's close, because otherwise
 * the day the period opens belongs to neither period and the figures stop adding
 * up. Here there is no adjacent period to belong to: "from 1 January" means from
 * 1 January, and quietly using 31 December would be a surprise.
 *
 * Both resolved dates are returned so the screen can show what was actually
 * measured rather than what was typed.
 */
export function pointToPoint(series: Series, start: string, end: string): PeriodReturn {
  if (!series?.length || !start || !end || start >= end) return EMPTY
  const s = nearestNext(series, start)
  const e = nearestPrevious(series, end)
  if (!s || !e || s.date >= e.date || s.value <= 0) return EMPTY

  const days = daysBetween(s.date, e.date)
  const ret = e.value / s.value - 1
  // Annualise only beyond a year, matching the engine. Annualising a 3-month
  // return would quadruple a quarter's noise and read as a forecast.
  const cagr = days > 366 ? Math.pow(e.value / s.value, 365 / days) - 1 : null
  return { ret, cagr, startDate: s.date, endDate: e.date, days }
}

/** Trailing periods, matching TRAILING_PERIODS in the engine. */
export const TRAILING: Record<string, number> = {
  '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, '5Y': 60, '10Y': 120,
}

function subtractMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const total = (y * 12 + (m - 1)) - months
  const ny = Math.floor(total / 12)
  const nm = total % 12
  // Clamp, so 31 March minus one month is 28/29 February rather than rolling over.
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  const nd = Math.min(d, lastDay)
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`
}

/**
 * Trailing return ending at `anchor`, mirroring engine trailing_return: end is
 * the latest value on or before the anchor, start is the latest on or before the
 * anchor minus the period, and anything over a year is annualised.
 */
export function trailingFrom(series: Series, anchor: string, period: string): PeriodReturn {
  const months = TRAILING[period]
  if (!months || !series?.length) return EMPTY
  const e = nearestPrevious(series, anchor)
  if (!e) return EMPTY
  const s = nearestPrevious(series, subtractMonths(e.date, months))
  if (!s || s.value <= 0 || s.date >= e.date) return EMPTY

  const days = daysBetween(s.date, e.date)
  const ratio = e.value / s.value
  const simple = months <= 12
  return {
    ret: simple ? ratio - 1 : Math.pow(ratio, 365 / days) - 1,
    cagr: simple ? null : Math.pow(ratio, 365 / days) - 1,
    startDate: s.date,
    endDate: e.date,
    days,
  }
}

/** Equal-weighted mean of the values that exist, or null. Mirrors category_average. */
export function average(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x))
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
