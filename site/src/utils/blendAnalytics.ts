// src/utils/blendAnalytics.ts — the deeper analysis behind Blend Studio.
//
// Split from blend.ts to keep that file to the primitives (build a blend,
// measure a series). Everything here answers a question ABOUT a portfolio
// rather than constructing one: where the risk sits, what the mix could have
// been, how stable the answer is, and how it behaved when things went wrong.
//
// TWO RULES THAT DECIDE EVERY CHOICE BELOW
//
//  1. DECOMPOSITIONS MUST ADD UP. A contribution table whose parts do not sum
//     to the whole is worse than no table, because it looks authoritative. Both
//     decompositions here are exact identities, not approximations, and
//     scripts/verify_blend.mjs asserts the sums:
//       * return contributions sum to the portfolio's total return
//       * risk contributions sum to the portfolio's volatility (Euler's
//         homogeneous-function identity, which holds because volatility is
//         homogeneous of degree one in the weights)
//
//  2. RISK IS MEASURED MONTHLY, PATH IS MEASURED DAILY. Volatility, beta,
//     covariance and correlation come from monthly returns, matching
//     engine/calculation_engine.py so a figure here agrees with Risk Lab.
//     Drawdown and the growth path use every daily close, because a drawdown
//     that only samples month-ends misses the trough — March 2020 bottomed on
//     the 23rd and recovered before month end.
//
// Optimisers are deterministic. An analyst who runs the same fit twice and gets
// two answers cannot use either, so there is no randomness anywhere in here.

import {
  buildBlend, clip, commonDates, monthEnds, monthlyReturns, stats, RISK_FREE,
} from './blend'
import type { Rebalance, Series, Sleeve } from './blend'

const SQRT12 = Math.sqrt(12)

// ── small statistics helpers ────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

/** Sample standard deviation (n−1), as the engine uses. */
export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

/** Population covariance, matching risk_metrics' beta. */
function covar(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (!n) return 0
  const ma = mean(a.slice(-n))
  const mb = mean(b.slice(-n))
  let s = 0
  for (let i = 0; i < n; i++) s += (a[a.length - n + i] - ma) * (b[b.length - n + i] - mb)
  return s / n
}

/**
 * The p-th percentile of a sample, by linear interpolation.
 *
 * Historical, not parametric: a normal-distribution VaR on Indian equity months
 * understates the tail badly, and the sample is right there.
 */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const i = (s.length - 1) * p
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo)
}

// ── correlation ─────────────────────────────────────────────────────────────

export interface CorrelationMatrix {
  labels: string[]
  /** rows[i][j] — symmetric, unit diagonal, null where there is too little overlap. */
  rows: (number | null)[][]
  months: number
}

/**
 * Monthly-return correlation between every pair of sleeves.
 *
 * The whole case for a multi-sleeve blend rests on these numbers: two sleeves
 * correlated at 0.95 are one sleeve wearing two labels, and no weighting of
 * them will diversify anything.
 */
export function correlationMatrix(labels: string[], seriesList: Series[]): CorrelationMatrix {
  const rets = seriesList.map(monthlyReturns)
  const n = rets.length ? Math.min(...rets.map(r => r.length)) : 0
  const aligned = rets.map(r => r.slice(-n))
  const rows: (number | null)[][] = []
  for (let i = 0; i < aligned.length; i++) {
    rows.push([])
    for (let j = 0; j < aligned.length; j++) {
      if (n < 6) { rows[i].push(i === j ? 1 : null); continue }
      if (i === j) { rows[i].push(1); continue }
      const vi = covar(aligned[i], aligned[i])
      const vj = covar(aligned[j], aligned[j])
      rows[i].push(vi && vj ? covar(aligned[i], aligned[j]) / Math.sqrt(vi * vj) : null)
    }
  }
  return { labels, rows, months: n }
}

// ── where the return and the risk came from ─────────────────────────────────

export interface Contribution {
  index_id: number
  label: string
  /** Target share of the portfolio, percent. */
  weight: number
  /** The sleeve's own total return over the window. */
  ownReturn: number | null
  /** Share of the portfolio's total return that came from this sleeve. */
  returnContribution: number | null
  /** Annualised volatility of the sleeve on its own. */
  ownVol: number | null
  /** This sleeve's share of portfolio volatility — these sum to it exactly. */
  riskContribution: number | null
  /** The same as a percentage of total risk. */
  riskShare: number | null
  /** Risk share minus capital share: where the mix is more concentrated than it looks. */
  riskVsWeight: number | null
}

/**
 * Return and risk, attributed to each sleeve.
 *
 * RETURN uses the exact arithmetic identity: on each day a sleeve adds
 * w_i,t × r_i,t of the portfolio's value, so summing (value at t−1) × w × r over
 * the window and dividing by the starting value gives contributions that add up
 * to the portfolio's total return to the last decimal. Weights are read from
 * the simulated unit counts rather than the target, so a drifting buy-and-hold
 * portfolio attributes its later years to the weights it actually had.
 *
 * RISK uses Euler decomposition on the monthly covariance matrix: sleeve i's
 * contribution is w_i × (Σw)_i ÷ σ_p, and Σᵢ of that is exactly σ_p. This is
 * where a "conservative" blend usually surprises its owner — 25% equity next to
 * 75% gilt is routinely 60–70% of the risk, because the equity sleeve is several
 * times more volatile.
 */
export function contributions(
  seriesById: Record<number, Series>,
  sleeves: Sleeve[],
  freq: Rebalance,
  from?: string,
  to?: string,
): { rows: Contribution[]; totalReturn: number | null; totalVol: number | null } {
  const live = sleeves.filter(s => s.weight > 0 && seriesById[s.index_id]?.length)
  const target = live.reduce((a, s) => a + s.weight, 0)
  if (!live.length || target <= 0) return { rows: [], totalReturn: null, totalVol: null }

  const dates = clip(
    commonDates(live.map(s => seriesById[s.index_id])).map(d => [d, 0] as [string, number]),
    from, to,
  ).map(([d]) => d)
  if (dates.length < 2) return { rows: [], totalReturn: null, totalVol: null }

  const maps = new Map(live.map(s => [s.index_id, new Map(seriesById[s.index_id])]))
  const shares = Object.fromEntries(live.map(s => [s.index_id, s.weight / target]))

  // Replay the portfolio, accumulating each sleeve's rupee contribution.
  let units: Record<number, number> = {}
  let last: Record<number, number> = {}
  const gained: Record<number, number> = {}
  for (const s of live) {
    const c = maps.get(s.index_id)!.get(dates[0])!
    last[s.index_id] = c
    units[s.index_id] = (100 * shares[s.index_id]) / c
    gained[s.index_id] = 0
  }
  let value = 100
  let key = periodKeyOf(dates[0], freq)

  for (let i = 1; i < dates.length; i++) {
    const d = dates[i]
    let next = 0
    for (const s of live) {
      const c = maps.get(s.index_id)!.get(d) ?? last[s.index_id]
      // Exactly what this sleeve added to the portfolio today.
      gained[s.index_id] += units[s.index_id] * (c - last[s.index_id])
      last[s.index_id] = c
      next += units[s.index_id] * c
    }
    value = next

    if (freq === 'daily') {
      for (const s of live) units[s.index_id] = (value * shares[s.index_id]) / last[s.index_id]
    } else if (freq !== 'none') {
      const k = periodKeyOf(d, freq)
      if (k !== key) {
        key = k
        for (const s of live) units[s.index_id] = (value * shares[s.index_id]) / last[s.index_id]
      }
    }
  }

  const totalReturn = value / 100 - 1

  // Risk, from the monthly covariance of the sleeves over the same window.
  const sleeveMonthly = live.map(s => monthlyReturns(clip(seriesById[s.index_id], from, to)))
  const n = Math.min(...sleeveMonthly.map(r => r.length))
  let totalVol: number | null = null
  const mcr: Record<number, number | null> = {}
  if (n >= 6) {
    const R = sleeveMonthly.map(r => r.slice(-n))
    const w = live.map(s => shares[s.index_id])
    const cov: number[][] = R.map(a => R.map(b => covar(a, b)))
    // (Σw)_i
    const sw = cov.map(row => row.reduce((a, c, j) => a + c * w[j], 0))
    const varP = w.reduce((a, wi, i) => a + wi * sw[i], 0)
    const sigmaMonthly = varP > 0 ? Math.sqrt(varP) : 0
    totalVol = sigmaMonthly * SQRT12
    live.forEach((s, i) => {
      mcr[s.index_id] = sigmaMonthly ? (w[i] * sw[i] / sigmaMonthly) * SQRT12 : null
    })
  } else {
    for (const s of live) mcr[s.index_id] = null
  }

  const rows: Contribution[] = live.map(s => {
    const own = clip(seriesById[s.index_id], dates[0], dates[dates.length - 1])
    const ownStats = stats(own)
    const rc = mcr[s.index_id]
    const riskShare = rc != null && totalVol ? (rc / totalVol) * 100 : null
    return {
      index_id: s.index_id,
      label: s.index_name,
      weight: shares[s.index_id] * 100,
      ownReturn: ownStats.abs,
      returnContribution: gained[s.index_id] / 100,
      ownVol: ownStats.vol,
      riskContribution: rc,
      riskShare,
      riskVsWeight: riskShare != null ? riskShare - shares[s.index_id] * 100 : null,
    }
  })
  return { rows, totalReturn, totalVol }
}

/** Duplicated from blend.ts, which keeps it private. */
function periodKeyOf(iso: string, freq: Rebalance): string {
  const [y, m] = iso.split('-')
  if (freq === 'monthly') return `${y}-${m}`
  if (freq === 'quarterly') return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`
  if (freq === 'annual') return y
  return ''
}

// ── the opportunity set ─────────────────────────────────────────────────────

export interface FrontierPoint {
  /** Percent, in sleeve order. */
  weights: number[]
  vol: number
  cagr: number
  sharpe: number
}

export interface Frontier {
  points: FrontierPoint[]
  current: FrontierPoint | null
  minVariance: FrontierPoint | null
  maxSharpe: FrontierPoint | null
  months: number
}

/**
 * Every mix of these sleeves that the window allows, and the notable ones.
 *
 * With two sleeves this is the exact curve, stepped 1% at a time — 101 points,
 * no optimiser needed and no approximation to argue about. With three or more,
 * an exhaustive grid explodes, so the cloud is a deterministic lattice (a fixed
 * 5% simplex grid, capped) and the two optimal points are solved for properly.
 *
 * Return is the blend's realised CAGR over the window, NOT the weighted average
 * of sleeve CAGRs: those differ once rebalancing is in play, and it is the
 * realised path the analyst is being asked to accept.
 */
export function frontier(
  seriesById: Record<number, Series>,
  sleeves: Sleeve[],
  freq: Rebalance,
  from?: string,
  to?: string,
): Frontier {
  const live = sleeves.filter(s => seriesById[s.index_id]?.length)
  const k = live.length
  const empty: Frontier = {
    points: [], current: null, minVariance: null, maxSharpe: null, months: 0,
  }
  if (k < 2) return empty

  const measure = (weights: number[]): FrontierPoint | null => {
    const mix = live.map((s, i) => ({ ...s, weight: weights[i] }))
    const b = buildBlend(seriesById, mix, freq, from, to)
    if (b.length < 2) return null
    const st = stats(b)
    if (st.cagr == null || st.vol == null || !st.vol) return null
    return {
      weights: weights.map(w => w * 100),
      vol: st.vol,
      cagr: st.cagr,
      sharpe: (st.cagr - RISK_FREE) / st.vol,
    }
  }

  const grids: number[][] = []
  if (k === 2) {
    for (let i = 0; i <= 100; i++) grids.push([i / 100, 1 - i / 100])
  } else {
    // A 5% lattice over the simplex, enumerated in fixed order so the cloud is
    // identical run to run.
    const step = 0.05
    const steps = Math.round(1 / step)
    const walk = (depth: number, left: number, acc: number[]) => {
      if (grids.length > 4000) return
      if (depth === k - 1) { grids.push([...acc, left * step]); return }
      for (let i = 0; i <= left; i++) walk(depth + 1, left - i, [...acc, i * step])
    }
    walk(0, steps, [])
  }

  const points = grids.map(measure).filter((p): p is FrontierPoint => p !== null)
  if (!points.length) return empty

  const target = live.reduce((a, s) => a + s.weight, 0)
  const current = target > 0 ? measure(live.map(s => s.weight / target)) : null

  const minVariance = points.reduce((a, p) => (p.vol < a.vol ? p : a), points[0])
  const gridBestSharpe = points.reduce((a, p) => (p.sharpe > a.sharpe ? p : a), points[0])

  // Refine both around the grid winner, so a 1% or 5% lattice is not the answer.
  const refine = (seed: FrontierPoint, better: (a: FrontierPoint, b: FrontierPoint) => boolean) => {
    let best = seed
    let span = k === 2 ? 0.01 : 0.05
    for (let round = 0; round < 6; round++) {
      span /= 2
      let improved = false
      for (let i = 0; i < k; i++) {
        for (const sign of [1, -1]) {
          const w = best.weights.map(v => v / 100)
          w[i] += sign * span
          if (w[i] < 0 || w[i] > 1) continue
          // Take the step out of the others in proportion, keeping the simplex.
          const rest = w.reduce((a, v, j) => (j === i ? a : a + v), 0)
          if (rest <= 0) continue
          const scale = (1 - w[i]) / rest
          for (let j = 0; j < k; j++) if (j !== i) w[j] *= scale
          const cand = measure(w)
          if (cand && better(cand, best)) { best = cand; improved = true }
        }
      }
      if (!improved) break
    }
    return best
  }

  return {
    points,
    current,
    minVariance: refine(minVariance, (a, b) => a.vol < b.vol),
    maxSharpe: refine(gridBestSharpe, (a, b) => a.sharpe > b.sharpe),
    months: stats(buildBlend(seriesById, live, freq, from, to)).months,
  }
}

/** The lowest-volatility mix on the frontier that still reaches `targetVol`. */
export function closestToVol(f: Frontier, targetVol: number): FrontierPoint | null {
  if (!f.points.length) return null
  return f.points.reduce((a, p) =>
    Math.abs(p.vol - targetVol) < Math.abs(a.vol - targetVol) ? p : a, f.points[0])
}

// ── stability over time ─────────────────────────────────────────────────────

export interface RollingPoint {
  date: string
  blend: number | null
  ref: number | null
}

/**
 * A measure recomputed on every rolling window, so the analyst sees whether a
 * single headline number was typical or a one-off.
 *
 * Stepped by month-end, which is what the measures are built on anyway. A
 * 3-year rolling CAGR over a 5-year window gives 25 observations — thin, and the
 * caller should say so, which is why the count is returned.
 */
export function rolling(
  blend: Series,
  ref: Series,
  windowMonths: number,
  metric: 'cagr' | 'vol' | 'excess' | 'te' | 'beta',
): { points: RollingPoint[]; windowMonths: number } {
  const bEnds = monthEnds(blend)
  const points: RollingPoint[] = []
  if (bEnds.length <= windowMonths) return { points, windowMonths }

  for (let i = windowMonths; i < bEnds.length; i++) {
    const from = bEnds[i - windowMonths][0]
    const date = bEnds[i][0]
    const bWin = clip(blend, from, date)
    const rWin = clip(ref, from, date)
    if (bWin.length < 2) { points.push({ date, blend: null, ref: null }); continue }

    if (metric === 'cagr') {
      const bs = stats(bWin)
      const rs = rWin.length >= 2 ? stats(rWin) : null
      points.push({ date, blend: bs.cagr, ref: rs?.cagr ?? null })
    } else if (metric === 'vol') {
      const bs = stats(bWin)
      const rs = rWin.length >= 2 ? stats(rWin) : null
      points.push({ date, blend: bs.vol, ref: rs?.vol ?? null })
    } else if (metric === 'excess') {
      const bs = stats(bWin)
      const rs = rWin.length >= 2 ? stats(rWin) : null
      points.push({
        date,
        blend: bs.cagr != null && rs?.cagr != null ? bs.cagr - rs.cagr : null,
        ref: 0,
      })
    } else {
      // Tracking error and beta need the pair, so they have no reference line.
      const st = stats(bWin, rWin)
      points.push({
        date,
        blend: metric === 'te' ? st.trackingError : st.beta,
        ref: metric === 'beta' ? 1 : 0,
      })
    }
  }
  return { points, windowMonths }
}

// ── drawdown, properly ──────────────────────────────────────────────────────

export interface Episode {
  peakDate: string
  troughDate: string
  depth: number
  recoveryDate: string | null
  /** Peak to trough. */
  fallDays: number
  /** Trough to recovery, null while still under water. */
  recoveryDays: number | null
  underwater: boolean
}

/**
 * The deepest distinct falls in the window, worst first.
 *
 * Distinct matters: a naive scan reports the same 2020 crash five times at
 * slightly different depths. An episode runs from a high-water mark to the day
 * that mark is regained, so each one is counted once, and the last may still be
 * open — which is the single most useful fact on the list, because an unrecovered
 * drawdown is a live position, not history.
 *
 * Daily closes, deliberately. Month-ends would have missed the 23 March 2020
 * bottom entirely.
 */
export function drawdownEpisodes(series: Series, topN = 5): Episode[] {
  if (series.length < 3) return []
  const out: Episode[] = []
  let peak = series[0][1]
  let peakDate = series[0][0]
  let trough = peak
  let troughDate = peakDate
  let open = false

  const close = (recoveryDate: string | null) => {
    if (!open || peak <= 0) return
    out.push({
      peakDate, troughDate,
      depth: trough / peak - 1,
      recoveryDate,
      fallDays: Math.round((Date.parse(troughDate) - Date.parse(peakDate)) / 86400000),
      recoveryDays: recoveryDate
        ? Math.round((Date.parse(recoveryDate) - Date.parse(troughDate)) / 86400000)
        : null,
      underwater: recoveryDate === null,
    })
    open = false
  }

  for (const [d, v] of series) {
    if (v >= peak) {
      close(d)                       // regaining the old peak ends the episode
      peak = v; peakDate = d; trough = v; troughDate = d
    } else {
      open = true
      if (v < trough) { trough = v; troughDate = d }
    }
  }
  close(null)                        // whatever is still open ends unrecovered

  return out.sort((a, b) => a.depth - b.depth).slice(0, topN)
}

// ── shape of the returns ────────────────────────────────────────────────────

export interface Distribution {
  months: number
  skew: number | null
  excessKurtosis: number | null
  /** Historical 95% monthly VaR — the loss a bad month in twenty reaches. */
  var95: number | null
  /** Mean of the worst 5% of months. Always at least as bad as VaR. */
  cvar95: number | null
  bestQuarter: number | null
  worstQuarter: number | null
  /** Share of months the blend beat the reference. */
  hitRate: number | null
  longestRun: number
  longestDrought: number
}

export function distribution(series: Series, ref?: Series): Distribution {
  const m = monthlyReturns(series)
  const n = m.length
  const out: Distribution = {
    months: n, skew: null, excessKurtosis: null, var95: null, cvar95: null,
    bestQuarter: null, worstQuarter: null, hitRate: null,
    longestRun: 0, longestDrought: 0,
  }
  if (n < 3) return out

  const mu = mean(m)
  const sd = stdev(m)
  if (sd) {
    // Sample skewness and EXCESS kurtosis (normal = 0), the convention a reader
    // expects when a number is labelled kurtosis in a factsheet.
    out.skew = (n / ((n - 1) * (n - 2)))
      * m.reduce((a, x) => a + ((x - mu) / sd) ** 3, 0)
    const g2 = m.reduce((a, x) => a + ((x - mu) / sd) ** 4, 0) / n - 3
    out.excessKurtosis = g2
  }

  out.var95 = percentile(m, 0.05)
  if (out.var95 != null) {
    const tail = m.filter(x => x <= out.var95!)
    out.cvar95 = tail.length ? mean(tail) : out.var95
  }

  // Quarters from the daily path, so a quarter is a quarter and not three
  // month-end returns multiplied together across a gap.
  const byQ = new Map<string, Series>()
  for (const p of series) {
    const [y, mo] = p[0].split('-')
    const q = `${y}-Q${Math.floor((Number(mo) - 1) / 3) + 1}`
    if (!byQ.has(q)) byQ.set(q, [])
    byQ.get(q)!.push(p)
  }
  const qKeys = [...byQ.keys()].sort()
  const qRets: number[] = []
  for (let i = 1; i < qKeys.length; i++) {
    const prev = byQ.get(qKeys[i - 1])!
    const cur = byQ.get(qKeys[i])!
    const open = prev[prev.length - 1][1]
    if (open > 0) qRets.push(cur[cur.length - 1][1] / open - 1)
  }
  if (qRets.length) {
    out.bestQuarter = Math.max(...qRets)
    out.worstQuarter = Math.min(...qRets)
  }

  let run = 0, drought = 0
  for (const r of m) {
    if (r > 0) { run++; out.longestRun = Math.max(out.longestRun, run); drought = 0 }
    else { drought++; out.longestDrought = Math.max(out.longestDrought, drought); run = 0 }
  }

  if (ref && ref.length >= 2) {
    const b = monthlyReturns(ref)
    const k = Math.min(n, b.length)
    if (k >= 6) {
      const f = m.slice(-k)
      const g = b.slice(-k)
      out.hitRate = f.filter((x, i) => x > g[i]).length / k
    }
  }
  return out
}

/** Year × month grid of returns, for a heatmap. */
export function monthlyGrid(series: Series): {
  years: string[]
  cells: Record<string, (number | null)[]>
} {
  const ends = monthEnds(series)
  const cells: Record<string, (number | null)[]> = {}
  for (let i = 1; i < ends.length; i++) {
    const [d, v] = ends[i]
    const prev = ends[i - 1][1]
    const y = d.slice(0, 4)
    const mi = Number(d.slice(5, 7)) - 1
    if (!cells[y]) cells[y] = new Array(12).fill(null)
    // Only a genuinely consecutive month is that month's return; a gap in the
    // series would otherwise be booked as one enormous move.
    const prevDate = ends[i - 1][0]
    const consecutive =
      (Number(y) * 12 + mi) - (Number(prevDate.slice(0, 4)) * 12 + Number(prevDate.slice(5, 7)) - 1) === 1
    if (consecutive && prev > 0) cells[y][mi] = v / prev - 1
  }
  return { years: Object.keys(cells).sort().reverse(), cells }
}

// ── how it behaved when it mattered ─────────────────────────────────────────

export interface StressWindow {
  label: string
  note: string
  from: string
  to: string
}

/**
 * Episodes worth checking any Indian multi-asset portfolio against.
 *
 * These are CALENDAR WINDOWS, chosen for what happened in them and stated as
 * dates so nothing is inferred: the row shows what the portfolio did between
 * those two dates and no claim is made about cause. A window with no data in
 * the current range is dropped by the caller rather than shown as a zero.
 */
export const STRESS_WINDOWS: StressWindow[] = [
  { label: 'Taper tantrum', note: 'Rupee and rates shock',
    from: '2013-05-22', to: '2013-09-03' },
  { label: 'China / oil selloff', note: 'Global growth scare',
    from: '2015-08-01', to: '2016-02-29' },
  { label: 'Demonetisation', note: 'Domestic liquidity shock',
    from: '2016-11-08', to: '2017-03-31' },
  { label: 'NBFC / credit crisis', note: 'IL&FS default and after',
    from: '2018-09-01', to: '2019-03-31' },
  { label: 'COVID crash', note: 'Fastest drawdown on record',
    from: '2020-01-14', to: '2020-03-23' },
  { label: 'COVID recovery', note: 'Trough to new high',
    from: '2020-03-24', to: '2021-01-31' },
  { label: '2022 rate shock', note: 'Global tightening, bonds and equity together',
    from: '2022-01-01', to: '2022-06-30' },
]

export interface StressRow {
  label: string
  note: string
  from: string
  to: string
  blend: number | null
  ref: number | null
  /** Blend minus reference. */
  diff: number | null
}

export function stressTest(blend: Series, ref: Series, windows = STRESS_WINDOWS): StressRow[] {
  const move = (s: Series, from: string, to: string): number | null => {
    const w = clip(s, from, to)
    if (w.length < 2 || w[0][1] <= 0) return null
    // Require most of the window to be present, so a portfolio whose history
    // starts halfway through COVID does not report a partial fall as the whole.
    const asked = Date.parse(to) - Date.parse(from)
    const got = Date.parse(w[w.length - 1][0]) - Date.parse(w[0][0])
    if (asked > 0 && got / asked < 0.8) return null
    return w[w.length - 1][1] / w[0][1] - 1
  }
  return windows
    .map(win => {
      const b = move(blend, win.from, win.to)
      const r = move(ref, win.from, win.to)
      return {
        ...win, blend: b, ref: r,
        diff: b != null && r != null ? b - r : null,
      }
    })
    .filter(r => r.blend != null || r.ref != null)
}

// ── cost ────────────────────────────────────────────────────────────────────

/**
 * Charge a continuous annual fee against a series.
 *
 * A blend of index closes has no expense ratio, no tracking difference and no
 * cash drag, so comparing one to a real fund's category average flatters the
 * blend. Netting off a fee is the only way that comparison becomes fair, and it
 * is applied continuously — daily at (1+fee)^(days/365) — rather than once a
 * year, because that is how a TER is actually deducted from a NAV.
 */
export function applyFee(series: Series, annualFeePct: number): Series {
  if (!annualFeePct || series.length < 2) return series
  const fee = annualFeePct / 100
  const t0 = Date.parse(series[0][0])
  return series.map(([d, v]) => {
    // Zero years elapsed on day one, so the first point is untouched and the
    // series still starts where it started.
    const years = (Date.parse(d) - t0) / (365 * 86400000)
    return [d, v * (1 - fee) ** years] as [string, number]
  })
}
