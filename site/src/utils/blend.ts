// src/utils/blend.ts — the maths behind Blend Studio.
//
// WHY THIS LIVES IN THE BROWSER
// engine/calculation_engine.py is the single source of truth and says no formula
// is to be re-implemented elsewhere. Blend Studio is the standing exception, for
// the same reason Point-to-Point is: the analyst invents the portfolio. Weights,
// sleeves and rebalancing frequency are chosen at the keyboard, so there is no
// finite set of answers the pipeline could precompute. Everything here is
// derived from the same index/<id>.json and category history.json files the
// pipeline publishes — no new data, no server.
//
// KEEPING IT HONEST
// Where the engine already defines a measure, the definition here is copied from
// it rather than reinvented, down to the choices that could reasonably go the
// other way:
//
//   * monthly returns take the LAST observation of each calendar month
//   * volatility is the SAMPLE standard deviation of monthly returns × √12
//   * Sharpe and Sortino divide CAGR − Rf (not mean return) by the annualised
//     deviation, so they agree with what Risk Lab shows for a fund
//   * beta uses POPULATION covariance and variance
//   * capture ratios compare geometrically annualised up-months and
//     down-months, not arithmetic means
//   * the risk-free rate is 6.5% a year, as risk_metrics defaults to
//
// A number that disagrees with Risk Lab for the same input is a bug in one of
// the two, and this file is the copy.

export type Series = [string, number][]

/** Matches risk_metrics(risk_free_rate=0.065) in the engine. */
export const RISK_FREE = 0.065

/** How often the blend is pulled back to its target weights. */
export type Rebalance = 'daily' | 'monthly' | 'quarterly' | 'annual' | 'none'

export const REBALANCE_LABELS: Record<Rebalance, string> = {
  daily: 'Daily',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
  none: 'Buy & hold',
}

export interface Sleeve {
  index_id: number
  index_name: string
  /** Percent, 0–100. */
  weight: number
}

// ── series plumbing ─────────────────────────────────────────────────────────

/** Dates present in every one of the given series, ascending. */
export function commonDates(all: Series[]): string[] {
  if (!all.length || all.some(s => !s?.length)) return []
  const sets = all.map(s => new Set(s.map(([d]) => d)))
  return [...sets[0]].filter(d => sets.every(x => x.has(d))).sort()
}

export function clip(series: Series, from?: string, to?: string): Series {
  return series.filter(([d]) => (!from || d >= from) && (!to || d <= to))
}

/** Rebase so the first point is 0%, expressed in percent. */
export function rebase(series: Series): Series {
  if (!series.length) return []
  const base = series[0][1]
  if (!base) return []
  return series.map(([d, v]) => [d, ((v / base) - 1) * 100])
}

/**
 * A rebalance boundary is a change of period, so the FIRST observation of each
 * new month/quarter/year is where weights are restored. Comparing period keys
 * rather than counting days keeps it right across holidays and short months.
 */
function periodKey(iso: string, freq: Rebalance): string {
  const [y, m] = iso.split('-')
  if (freq === 'monthly') return `${y}-${m}`
  if (freq === 'quarterly') return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`
  if (freq === 'annual') return y
  return ''
}

// ── the blend ───────────────────────────────────────────────────────────────

/**
 * Grow 100 units through the blend, honouring the rebalancing rule.
 *
 * Held as UNIT COUNTS per sleeve rather than as a weighted sum of daily
 * returns, because that is the only way "buy and hold" and "rebalanced
 * quarterly" can differ at all. The original version weighted each day's
 * returns, which silently means *daily* rebalancing — a real portfolio choice,
 * but one the screen was making on the analyst's behalf without saying so. Over
 * a five-year run through 2020 the gap between daily and buy-and-hold on a
 * 65:35 blend is percentage points, not rounding.
 *
 * A sleeve missing a close on a date carries its previous one, matching what the
 * blend would actually be worth that day.
 */
export function buildBlend(
  seriesById: Record<number, Series>,
  sleeves: Sleeve[],
  freq: Rebalance = 'daily',
  from?: string,
  to?: string,
): Series {
  const live = sleeves.filter(s => s.weight > 0 && seriesById[s.index_id]?.length)
  if (!live.length) return []

  const total = live.reduce((a, s) => a + s.weight, 0)
  if (total <= 0) return []

  const maps = new Map<number, Map<string, number>>(
    live.map(s => [s.index_id, new Map(seriesById[s.index_id])]),
  )
  const dates = clip(
    commonDates(live.map(s => seriesById[s.index_id])).map(d => [d, 0] as [string, number]),
    from, to,
  ).map(([d]) => d)
  if (dates.length < 2) return []

  // Units bought on day one, then held.
  const closeOn = (id: number, d: string) => maps.get(id)!.get(d)
  let last: Record<number, number> = {}
  let units: Record<number, number> = {}
  for (const s of live) {
    const c = closeOn(s.index_id, dates[0])!
    last[s.index_id] = c
    units[s.index_id] = (100 * (s.weight / total)) / c
  }

  const out: Series = [[dates[0], 100]]
  let key = periodKey(dates[0], freq)

  for (let i = 1; i < dates.length; i++) {
    const d = dates[i]
    let value = 0
    for (const s of live) {
      const c = closeOn(s.index_id, d) ?? last[s.index_id]
      last[s.index_id] = c
      value += units[s.index_id] * c
    }

    if (freq === 'daily') {
      // Constant weights: re-buy the target mix at every close.
      for (const s of live) units[s.index_id] = (value * (s.weight / total)) / last[s.index_id]
    } else if (freq !== 'none') {
      const k = periodKey(d, freq)
      if (k !== key) {
        key = k
        for (const s of live) units[s.index_id] = (value * (s.weight / total)) / last[s.index_id]
      }
    }

    out.push([d, value])
  }
  return out
}

/**
 * What each sleeve's weight has drifted to by the end of the window.
 *
 * Only interesting when nothing pulls it back — it is the answer to "what am I
 * actually holding now", which for a buy-and-hold equity/debt blend after a
 * strong equity run is not what was bought.
 */
export function endingWeights(
  seriesById: Record<number, Series>,
  sleeves: Sleeve[],
  freq: Rebalance,
  from?: string,
  to?: string,
): Record<number, number> {
  const live = sleeves.filter(s => s.weight > 0 && seriesById[s.index_id]?.length)
  const total = live.reduce((a, s) => a + s.weight, 0)
  if (!live.length || total <= 0) return {}
  if (freq === 'daily') {
    return Object.fromEntries(live.map(s => [s.index_id, (s.weight / total) * 100]))
  }

  const dates = clip(
    commonDates(live.map(s => seriesById[s.index_id])).map(d => [d, 0] as [string, number]),
    from, to,
  ).map(([d]) => d)
  if (dates.length < 2) return {}

  const maps = new Map(live.map(s => [s.index_id, new Map(seriesById[s.index_id])]))
  const first = dates[0]
  const lastD = dates[dates.length - 1]
  // Between rebalances a sleeve grows with its own index, so its ending share is
  // its opening share scaled by its own growth, renormalised.
  const anchor = freq === 'none' ? first : lastRebalanceBefore(dates, lastD, freq)
  const grown = live.map(s => {
    const a = maps.get(s.index_id)!.get(anchor)
    const b = maps.get(s.index_id)!.get(lastD)
    return { id: s.index_id, v: (s.weight / total) * (a && b ? b / a : 1) }
  })
  const sum = grown.reduce((a, g) => a + g.v, 0)
  return Object.fromEntries(grown.map(g => [g.id, sum ? (g.v / sum) * 100 : 0]))
}

function lastRebalanceBefore(dates: string[], upto: string, freq: Rebalance): string {
  let key = ''
  let anchor = dates[0]
  for (const d of dates) {
    if (d > upto) break
    const k = periodKey(d, freq)
    if (k !== key) { key = k; anchor = d }
  }
  return anchor
}

// ── returns ─────────────────────────────────────────────────────────────────

/** Last observation of each calendar month, as the engine does. */
export function monthEnds(series: Series): Series {
  const byMonth = new Map<string, [string, number]>()
  for (const p of series) byMonth.set(p[0].slice(0, 7), p)
  return [...byMonth.keys()].sort().map(k => byMonth.get(k)!)
}

export function monthlyReturns(series: Series): number[] {
  const ends = monthEnds(series)
  const out: number[] = []
  for (let i = 1; i < ends.length; i++) {
    const prev = ends[i - 1][1]
    if (prev > 0) out.push(ends[i][1] / prev - 1)
  }
  return out
}

/** Return for each calendar year in the window, plus how much of the year it covers. */
export function calendarYears(series: Series): {
  year: string; ret: number; partial: boolean
}[] {
  if (series.length < 2) return []
  const byYear = new Map<string, Series>()
  for (const p of series) {
    const y = p[0].slice(0, 4)
    if (!byYear.has(y)) byYear.set(y, [])
    byYear.get(y)!.push(p)
  }
  const years = [...byYear.keys()].sort()
  const out: { year: string; ret: number; partial: boolean }[] = []
  for (let i = 0; i < years.length; i++) {
    const rows = byYear.get(years[i])!
    // A year's return starts from the PREVIOUS year's close, otherwise the first
    // trading day of January belongs to no year and the figures do not add up.
    const prevYear = i > 0 ? byYear.get(years[i - 1])! : null
    const open = prevYear ? prevYear[prevYear.length - 1][1] : rows[0][1]
    const close = rows[rows.length - 1][1]
    if (!open) continue
    out.push({
      year: years[i],
      ret: close / open - 1,
      // The first year has no prior close to start from, and the last may still
      // be running; either way it is not a full calendar year.
      partial: (i === 0 && !prevYear) || (i === years.length - 1
        && rows[rows.length - 1][0].slice(5) < '12-25'),
    })
  }
  return out
}

// ── statistics ──────────────────────────────────────────────────────────────

export interface BlendStats {
  start: string | null
  end: string | null
  days: number | null
  abs: number | null
  cagr: number | null
  vol: number | null
  sharpe: number | null
  sortino: number | null
  maxDrawdown: number | null
  /** Only when a reference series is supplied. */
  beta: number | null
  alpha: number | null
  trackingError: number | null
  infoRatio: number | null
  correlation: number | null
  upCapture: number | null
  downCapture: number | null
  bestMonth: number | null
  worstMonth: number | null
  positiveMonths: number | null
  months: number
}

const EMPTY_STATS: BlendStats = {
  start: null, end: null, days: null, abs: null, cagr: null, vol: null,
  sharpe: null, sortino: null, maxDrawdown: null, beta: null, alpha: null,
  trackingError: null, infoRatio: null, correlation: null, upCapture: null,
  downCapture: null, bestMonth: null, worstMonth: null, positiveMonths: null,
  months: 0,
}

function stdevSample(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

/** Geometrically annualised, as the engine's capture ratios are. */
function geoAnnualised(rs: number[]): number | null {
  if (!rs.length) return null
  return rs.reduce((a, r) => a * (1 + r), 1) ** (12 / rs.length) - 1
}

export function maxDrawdown(series: Series): number | null {
  if (series.length < 2) return null
  let peak = series[0][1]
  let worst = 0
  for (const [, v] of series) {
    if (v > peak) peak = v
    if (peak > 0) worst = Math.min(worst, v / peak - 1)
  }
  return worst
}

/**
 * The full measure set for one series, optionally against a reference.
 *
 * `ref` must already be clipped to the same window; the relative measures pair
 * monthly observations positionally, which is only meaningful when both cover
 * the same months.
 */
export function stats(series: Series, ref?: Series): BlendStats {
  if (series.length < 2) return { ...EMPTY_STATS }
  const start = series[0][0]
  const end = series[series.length - 1][0]
  const days = Math.round((Date.parse(end) - Date.parse(start)) / 86400000)
  const abs = series[0][1] > 0 ? series[series.length - 1][1] / series[0][1] - 1 : null
  const cagr = abs != null && days > 366 ? (1 + abs) ** (365 / days) - 1 : abs

  // ALIGN FIRST, THEN MEASURE. risk_metrics truncates both month lists to their
  // common length before computing anything, so when the reference has fewer
  // months than the series every one of its figures describes the shorter
  // window. Measuring volatility on the full list and beta on the truncated one
  // put the two out of step: against large-cap's published risk.json that showed
  // up as volatility differing by up to 28bp while beta matched to four
  // decimals — the tell that only some of the numbers had been aligned.
  const refMonths = ref && ref.length >= 2 ? monthlyReturns(ref) : null
  const all = monthlyReturns(series)
  const n = refMonths ? Math.min(all.length, refMonths.length) : all.length
  const m = refMonths ? all.slice(-n) : all
  const sd = stdevSample(m)
  const vol = sd != null ? sd * Math.sqrt(12) : null

  const rfMonthly = (1 + RISK_FREE) ** (1 / 12) - 1
  const downside = m.map(r => Math.min(r - rfMonthly, 0))
  const sigmaD = m.length
    ? Math.sqrt(downside.reduce((a, d) => a + d * d, 0) / downside.length) * Math.sqrt(12)
    : 0

  const out: BlendStats = {
    ...EMPTY_STATS,
    start, end, days, abs, cagr, vol,
    sharpe: vol && cagr != null ? (cagr - RISK_FREE) / vol : null,
    sortino: sigmaD && cagr != null ? (cagr - RISK_FREE) / sigmaD : null,
    maxDrawdown: maxDrawdown(series),
    bestMonth: m.length ? Math.max(...m) : null,
    worstMonth: m.length ? Math.min(...m) : null,
    positiveMonths: m.length ? m.filter(r => r > 0).length / m.length : null,
    months: m.length,
  }

  // `ref` is named as well as `refMonths` so the compiler can narrow it for the
  // recursive call below; six months is the fewest worth pairing.
  if (!ref || !refMonths || n < 6) return out

  const f = m
  const g = refMonths.slice(-n)

  const fMean = f.reduce((a, x) => a + x, 0) / n
  const gMean = g.reduce((a, x) => a + x, 0) / n
  // Population covariance and variance, matching risk_metrics.
  const cov = f.reduce((a, x, i) => a + (x - fMean) * (g[i] - gMean), 0) / n
  const gVar = g.reduce((a, x) => a + (x - gMean) ** 2, 0) / n
  const fVar = f.reduce((a, x) => a + (x - fMean) ** 2, 0) / n
  out.beta = gVar ? cov / gVar : null
  out.correlation = gVar && fVar ? cov / Math.sqrt(gVar * fVar) : null

  const refStats = stats(ref)
  if (out.beta != null && cagr != null && refStats.cagr != null) {
    out.alpha = cagr - (RISK_FREE + out.beta * (refStats.cagr - RISK_FREE))
  }

  const active = f.map((x, i) => x - g[i])
  const te = stdevSample(active)
  out.trackingError = te != null ? te * Math.sqrt(12) : null
  if (out.trackingError && cagr != null && refStats.cagr != null) {
    out.infoRatio = (cagr - refStats.cagr) / out.trackingError
  }

  const upF = f.filter((_, i) => g[i] > 0)
  const upG = g.filter(x => x > 0)
  const dnF = f.filter((_, i) => g[i] < 0)
  const dnG = g.filter(x => x < 0)
  const uf = geoAnnualised(upF), ug = geoAnnualised(upG)
  const df = geoAnnualised(dnF), dg = geoAnnualised(dnG)
  out.upCapture = uf != null && ug ? (uf / ug) * 100 : null
  out.downCapture = df != null && dg ? (df / dg) * 100 : null
  return out
}

// ── the fit ─────────────────────────────────────────────────────────────────

export interface Fit {
  /** Percent, in the order the sleeves were passed in, summing to 100. */
  weights: number[]
  trackingError: number | null
  rSquared: number | null
  months: number
}

/**
 * The mix of the chosen sleeves that best explains a category's own history.
 *
 * This is the question a blend builder is really for. A category's mandate says
 * "65 to 80% equity"; what the funds in it have actually behaved like is a
 * different number, and it is recoverable by regressing the category's monthly
 * returns on the sleeves' — a returns-based style analysis, in Sharpe's sense.
 *
 * Constrained so the answer is a portfolio and not just a good fit: weights are
 * non-negative and sum to one. That rules out the closed-form least squares, so
 * this is projected gradient descent onto the simplex — a few hundred cheap
 * iterations over at most a few hundred months, and deterministic, which matters
 * because an analyst comparing two runs must not see two answers.
 *
 * It describes, it does not prescribe. A high R² says the mix tracked the
 * category over THIS window; it is not a claim about what the funds hold.
 */
export function fitWeights(target: Series, sleeveSeries: Series[]): Fit | null {
  const k = sleeveSeries.length
  if (k === 0 || target.length < 2) return null

  const y = monthlyReturns(target)
  const xs = sleeveSeries.map(monthlyReturns)
  const n = Math.min(y.length, ...xs.map(x => x.length))
  if (n < 12) return null            // a year of months is the least worth fitting

  const Y = y.slice(-n)
  const X = xs.map(x => x.slice(-n))

  let w = new Array(k).fill(1 / k)
  const project = (v: number[]) => {
    // Euclidean projection onto {w >= 0, sum w = 1}: sort, find the threshold,
    // clip. Standard, and exact rather than a normalise-and-hope.
    const u = [...v].sort((a, b) => b - a)
    let css = 0, rho = 0, theta = 0
    for (let i = 0; i < u.length; i++) {
      css += u[i]
      if (u[i] - (css - 1) / (i + 1) > 0) { rho = i + 1; theta = (css - 1) / (i + 1) }
    }
    return v.map(x => Math.max(0, x - theta))
  }

  // Step size from the data's own scale, so it converges for daily-ish or
  // monthly-ish magnitudes without tuning.
  const scale = X.reduce((a, x) => a + x.reduce((b, v) => b + v * v, 0), 0) / (n * k) || 1
  const step = 1 / (2 * scale * k)

  for (let it = 0; it < 800; it++) {
    const grad = new Array(k).fill(0)
    for (let t = 0; t < n; t++) {
      let pred = 0
      for (let j = 0; j < k; j++) pred += w[j] * X[j][t]
      const e = pred - Y[t]
      for (let j = 0; j < k; j++) grad[j] += (2 * e * X[j][t]) / n
    }
    w = project(w.map((x, j) => x - step * grad[j]))
  }

  const resid: number[] = []
  for (let t = 0; t < n; t++) {
    let pred = 0
    for (let j = 0; j < k; j++) pred += w[j] * X[j][t]
    resid.push(Y[t] - pred)
  }
  const yMean = Y.reduce((a, b) => a + b, 0) / n
  const ssTot = Y.reduce((a, v) => a + (v - yMean) ** 2, 0)
  const ssRes = resid.reduce((a, v) => a + v * v, 0)
  const te = stdevSample(resid)

  return {
    weights: w.map(v => v * 100),
    trackingError: te != null ? te * Math.sqrt(12) : null,
    rSquared: ssTot ? 1 - ssRes / ssTot : null,
    months: n,
  }
}
