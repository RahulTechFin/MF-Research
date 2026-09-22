// site/scripts/verify_blend.mjs — proves utils/blend.ts agrees with the engine.
//
// WHY THIS EXISTS
// utils/blend.ts breaks the single-source-of-truth rule on purpose: an analyst
// invents the portfolio in Blend Studio, so there is no finite set of answers
// the Python pipeline could precompute. The price of that exception is that the
// browser now holds a second copy of formulae the engine already owns, and a
// copy nobody checks is a copy that drifts.
//
// So this does two things:
//
//   A. PARITY. Reruns volatility, beta and both capture ratios over every fund
//      in several published risk_<slug>.json files and compares against what
//      engine/calculation_engine.py wrote. These must agree to the engine's own
//      rounding — not approximately, exactly. It has already earned its keep:
//      it caught volatility being measured on the fund's full month list while
//      beta used the fund/benchmark aligned window, which risk_metrics does not
//      do. Beta matched to four decimals and volatility was out by up to 28bp,
//      which is precisely the kind of half-right that eyeballing misses.
//
//   B. PROPERTIES. Facts about blending that must hold whatever the inputs:
//      a one-sleeve blend is that index, rebalancing frequency orders the way
//      compounding says it must, buy-and-hold drifts toward the winner while
//      daily rebalancing cannot drift at all, and the weight solver recovers
//      weights it was given.
//
// USAGE  (from site/)
//     node scripts/verify_blend.mjs
//
// Needs site/public/data populated — run the Python pipeline first. Exits
// non-zero on any failure, so it is safe to put in front of a deploy.

import fs from 'node:fs'
import path from 'node:path'
import esbuild from '../node_modules/esbuild/lib/main.js'

const DATA = path.resolve('public/data')
if (!fs.existsSync(DATA)) {
  console.error(`no data at ${DATA} — run the pipeline first`)
  process.exit(2)
}

const built = await esbuild.build({
  entryPoints: [path.resolve('src/utils/blend.ts')],
  bundle: true, format: 'esm', write: false, platform: 'node',
})
const B = await import('data:text/javascript;base64,'
  + Buffer.from(built.outputFiles[0].text).toString('base64'))

const J = p => JSON.parse(fs.readFileSync(p, 'utf8'))
let failures = 0

// ── A. parity with the Python engine ────────────────────────────────────────
//
// Tolerances are the engine's own rounding in risk_metrics: 6dp on volatility,
// 4dp on beta, 2dp on the capture ratios. Anything looser would hide a real
// divergence; anything tighter would fail on the rounding itself.
const TOL = { vol: 1e-6, beta: 1e-4, up: 0.01, down: 0.01 }

let checked = 0, matched = 0
const mismatches = []
for (const file of fs.readdirSync(DATA).filter(f => /^risk_.+\.json$/.test(f))) {
  const risk = J(path.join(DATA, file))
  const benchPath = path.join(DATA, 'index', `${risk.benchmark_id}.json`)
  if (!fs.existsSync(benchPath)) continue

  // The engine's window: trailing three years of monthly observations from as_of.
  const d = new Date(risk.as_of)
  d.setFullYear(d.getFullYear() - 3)
  const from = d.toISOString().slice(0, 10)
  const bench = B.clip(J(benchPath).series, from, risk.as_of)

  for (const f of risk.funds ?? []) {
    const navPath = path.join(DATA, 'nav', `${f.scheme_code}.json`)
    // A fund the engine declined to measure (fewer than 30 months) is not a
    // disagreement — there is nothing to compare against.
    if (!fs.existsSync(navPath) || f.std_annual == null || f.beta == null) continue
    const s = B.stats(B.clip(J(navPath).series, from, risk.as_of), bench)
    for (const [name, py, js] of [
      ['vol', f.std_annual, s.vol],
      ['beta', f.beta, s.beta],
      ['up', f.upside_capture, s.upCapture],
      ['down', f.downside_capture, s.downCapture],
    ]) {
      checked++
      if (py != null && js != null && Math.abs(py - js) <= TOL[name]) matched++
      else mismatches.push(`${file} ${f.scheme_code} ${name}: engine=${py} blend.ts=${js}`)
    }
  }
}
console.log(`A. engine parity ......... ${matched}/${checked} figures match`)
if (mismatches.length) {
  failures += mismatches.length
  mismatches.slice(0, 15).forEach(m => console.log(`     ${m}`))
  if (mismatches.length > 15) console.log(`     … and ${mismatches.length - 15} more`)
}

// ── B. properties that must hold on any input ──────────────────────────────
const t0 = Date.UTC(2019, 0, 1)
const N = 365 * 7
const straightLine = annual => {
  const s = []
  for (let i = 0; i <= N; i++) {
    s.push([new Date(t0 + i * 86400000).toISOString().slice(0, 10),
            100 * (1 + annual) ** (i / 365)])
  }
  return s
}
const eq = straightLine(0.14)
const db = straightLine(0.06)
const byId = { 1: eq, 2: db }
const mix = w => [
  { index_id: 1, index_name: 'EQ', weight: w },
  { index_id: 2, index_name: 'DB', weight: 100 - w },
]

let pass = 0, total = 0
const check = (name, cond) => {
  total++
  if (cond) pass++
  else { failures++; console.log(`     FAIL  ${name}`) }
}

check('a one-sleeve blend IS that index',
  Math.abs(B.stats(B.buildBlend(byId, mix(100), 'daily')).cagr - 0.14) < 1e-6)

// With the stronger sleeve compounding, letting weights drift can only help —
// so the frequencies must come out ordered. This is what catches a blend that
// silently rebalances daily whatever it was asked for.
check('rebalancing frequency orders as compounding requires',
  ['daily', 'monthly', 'quarterly', 'annual', 'none']
    .map(f => B.stats(B.buildBlend(byId, mix(65), f)).cagr)
    .every((v, i, a) => i === 0 || v >= a[i - 1] - 1e-12))

check('buy & hold ends overweight the winner',
  B.endingWeights(byId, mix(65), 'none')[1] > 65)
check('daily rebalancing cannot drift',
  Math.abs(B.endingWeights(byId, mix(65), 'daily')[1] - 65) < 1e-9)
check('a blend returns between its sleeves',
  (c => c > 0.06 && c < 0.14)(B.stats(B.buildBlend(byId, mix(65), 'daily')).cagr))
check('weights are normalised, not required to sum to 100',
  Math.abs(
    B.stats(B.buildBlend(byId, [{ index_id: 1, index_name: 'EQ', weight: 6.5 },
                                { index_id: 2, index_name: 'DB', weight: 3.5 }], 'daily')).cagr
    - B.stats(B.buildBlend(byId, mix(65), 'daily')).cagr) < 1e-9)
check('a zero-weight sleeve is ignored',
  Math.abs(B.stats(B.buildBlend(byId, mix(100), 'daily')).cagr - 0.14) < 1e-6)

for (const truth of [90, 65, 40, 10]) {
  const target = B.buildBlend(byId, mix(truth), 'monthly')
  const fit = B.fitWeights(target, [eq, db])
  check(`the solver recovers ${truth}:${100 - truth}`,
    fit != null && Math.abs(fit.weights[0] - truth) < 0.5)
}

check('the solver refuses fewer than 12 months',
  B.fitWeights(B.clip(B.buildBlend(byId, mix(65), 'daily'), '2019-01-01', '2019-06-30'),
               [eq, db]) === null)
check('no sleeves gives no blend', B.buildBlend(byId, [], 'daily').length === 0)
check('one point is not a series', B.stats([['2020-01-01', 100]]).cagr === null)
check('max drawdown is never positive',
  B.maxDrawdown(B.buildBlend(byId, mix(65), 'daily')) <= 0)

console.log(`B. blend properties ...... ${pass}/${total} hold`)

// ── C. the deeper analytics ────────────────────────────────────────────────
//
// These are the claims that would be most expensive to get wrong, because a
// table that adds up looks correct whether or not it is. Both decompositions
// are exact identities, so they are asserted to floating-point tolerance and
// not to a fuzzy "close enough".
const A = await import('data:text/javascript;base64,' + Buffer.from(
  (await esbuild.build({
    entryPoints: [path.resolve('src/utils/blendAnalytics.ts')],
    bundle: true, format: 'esm', write: false, platform: 'node',
  })).outputFiles[0].text).toString('base64'))

// Real index closes, so these run on the shape of an actual market rather than
// on a smooth curve that hides everything.
const realIds = [1, 11, 9]                     // NIFTY 50, GILT ETF, GOLD
const real = {}
for (const id of realIds) {
  const f = path.join(DATA, 'index', `${id}.json`)
  if (fs.existsSync(f)) real[id] = J(f).series
}
const haveReal = realIds.every(id => real[id]?.length)
const realSleeves = [
  { index_id: 1, index_name: 'NIFTY 50', weight: 55 },
  { index_id: 11, index_name: 'GILT ETF', weight: 30 },
  { index_id: 9, index_name: 'GOLD', weight: 15 },
]

let aPass = 0, aTotal = 0
const acheck = (name, cond) => {
  aTotal++
  if (cond) aPass++
  else { failures++; console.log(`     FAIL  ${name}`) }
}

if (!haveReal) {
  console.log('C. deep analytics ........ skipped (index 1/9/11 not published)')
} else {
  // ── the two decompositions must be identities ──
  for (const freq of ['daily', 'quarterly', 'none']) {
    const c = A.contributions(real, realSleeves, freq)
    acheck(`return contributions sum to total return (${freq})`,
      Math.abs(c.rows.reduce((a, r) => a + r.returnContribution, 0) - c.totalReturn) < 1e-9)
    acheck(`risk contributions sum to portfolio vol (${freq})`,
      c.totalVol != null
      && Math.abs(c.rows.reduce((a, r) => a + (r.riskContribution ?? 0), 0) - c.totalVol) < 1e-9)
    acheck(`risk shares sum to 100% (${freq})`,
      Math.abs(c.rows.reduce((a, r) => a + (r.riskShare ?? 0), 0) - 100) < 1e-6)
  }

  // ── and must agree with the blend they describe ──
  const built = B.stats(B.buildBlend(real, realSleeves, 'quarterly'))
  const contrib = A.contributions(real, realSleeves, 'quarterly')
  acheck('total return matches buildBlend', Math.abs(contrib.totalReturn - built.abs) < 1e-9)

  // Volatility is NOT asserted equal, and that is not a concession. Euler
  // decomposition describes a portfolio held at FIXED weights, while the path's
  // own volatility includes what drift between rebalances did, so the two
  // legitimately differ — by 30-70bp on this mix. What must hold is that they
  // are the same measurement of the same thing: an order-of-magnitude gap means
  // a bug. This band would have caught the GOLDBEES decimal glitch, which made
  // the daily-rebalanced path read 447% against a 9.6% covariance figure.
  acheck('decomposition vol is the same order as the realised path',
    contrib.totalVol != null && built.vol != null
    && Math.abs(contrib.totalVol - built.vol) / built.vol < 0.15)

  // ── correlation ──
  const cm = A.correlationMatrix(realSleeves.map(s => s.index_name),
    realSleeves.map(s => real[s.index_id]))
  acheck('correlation diagonal is 1', cm.rows.every((r, i) => Math.abs(r[i] - 1) < 1e-12))
  acheck('correlation is symmetric',
    cm.rows.every((r, i) => r.every((v, j) => Math.abs(v - cm.rows[j][i]) < 1e-12)))
  acheck('correlation is within [-1, 1]',
    cm.rows.every(r => r.every(v => v >= -1 - 1e-12 && v <= 1 + 1e-12)))

  // ── the frontier: with two sleeves it is the exact 1% curve, so a brute
  //    force sweep must not be able to beat the optimiser ──
  const two = realSleeves.slice(0, 2)
  const f = A.frontier(real, two, 'quarterly')
  acheck('frontier produced points', f.points.length > 50)
  acheck('min-variance is the lowest vol found',
    f.minVariance && f.points.every(p => p.vol >= f.minVariance.vol - 1e-9))
  acheck('max-Sharpe is the highest Sharpe found',
    f.maxSharpe && f.points.every(p => p.sharpe <= f.maxSharpe.sharpe + 1e-9))
  acheck('min-variance vol <= current vol',
    f.current && f.minVariance.vol <= f.current.vol + 1e-9)
  acheck('max-Sharpe Sharpe >= current Sharpe',
    f.current && f.maxSharpe.sharpe >= f.current.sharpe - 1e-9)
  acheck('frontier weights sum to 100',
    f.points.every(p => Math.abs(p.weights.reduce((a, w) => a + w, 0) - 100) < 1e-6))

  const f3 = A.frontier(real, realSleeves, 'quarterly')
  acheck('three-sleeve weights sum to 100',
    f3.points.every(p => Math.abs(p.weights.reduce((a, w) => a + w, 0) - 100) < 1e-6))
  acheck('three-sleeve min-variance beats its grid',
    f3.minVariance && f3.points.every(p => p.vol >= f3.minVariance.vol - 1e-9))

  // ── drawdown episodes ──
  const walk = B.buildBlend(real, realSleeves, 'quarterly')
  const eps = A.drawdownEpisodes(walk, 5)
  acheck('episodes are ordered worst first',
    eps.every((e, i) => i === 0 || e.depth >= eps[i - 1].depth))
  acheck('every depth is negative', eps.every(e => e.depth < 0))
  acheck('peak precedes trough', eps.every(e => e.peakDate <= e.troughDate))
  acheck('recovery follows trough where present',
    eps.every(e => e.recoveryDate === null || e.recoveryDate > e.troughDate))
  acheck('the worst episode equals maxDrawdown',
    eps.length === 0 || Math.abs(eps[0].depth - B.maxDrawdown(walk)) < 1e-12)
  acheck('at most one episode is still under water',
    eps.filter(e => e.underwater).length <= 1)

  // ── distribution ──
  const dist = A.distribution(walk, real[1])
  acheck('CVaR is at least as bad as VaR',
    dist.cvar95 != null && dist.var95 != null && dist.cvar95 <= dist.var95 + 1e-12)
  acheck('worst quarter <= best quarter', dist.worstQuarter <= dist.bestQuarter)
  acheck('hit rate is a share', dist.hitRate >= 0 && dist.hitRate <= 1)
  acheck('percentile is monotonic',
    A.percentile([1, 2, 3, 4, 5], 0.05) <= A.percentile([1, 2, 3, 4, 5], 0.95))

  // ── fees can only cost, and cost about what they say ──
  const gross = B.stats(walk)
  const net = B.stats(A.applyFee(walk, 1.0))
  acheck('a 1% fee lowers CAGR', net.cagr < gross.cagr)
  acheck('a 1% fee costs about 1% a year',
    Math.abs((gross.cagr - net.cagr) - 0.01) < 0.002)
  acheck('a zero fee changes nothing', A.applyFee(walk, 0) === walk)

  // ── rolling ──
  const roll = A.rolling(walk, real[1], 36, 'cagr')
  acheck('rolling produces points', roll.points.length > 0)
  acheck('rolling dates ascend',
    roll.points.every((p, i) => i === 0 || p.date > roll.points[i - 1].date))
  acheck('a window longer than the history yields nothing',
    A.rolling(walk, real[1], 10000, 'cagr').points.length === 0)

  // ── stress windows must never invent data ──
  const stress = A.stressTest(walk, real[1])
  acheck('stress windows are ordered dates', stress.every(r => r.from < r.to))
  acheck('stress diff is blend minus reference',
    stress.every(r => r.diff === null || Math.abs(r.diff - (r.blend - r.ref)) < 1e-12))

  // ── monthly grid ──
  const grid = A.monthlyGrid(walk)
  acheck('grid has 12 columns per year',
    grid.years.every(y => grid.cells[y].length === 12))
  acheck('grid years descend',
    grid.years.every((y, i) => i === 0 || y < grid.years[i - 1]))

  console.log(`C. deep analytics ........ ${aPass}/${aTotal} hold`)
}

console.log(failures ? `\nFAILED (${failures} problem(s))` : '\nOK')
process.exit(failures ? 1 : 0)
