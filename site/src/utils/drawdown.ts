// src/utils/drawdown.ts — Underwater (drawdown) curve, derived from NAVs.
//
// The pipeline used to ship a pre-built drawdown/{code}.json for every fund:
// 2,372 files, 303 MB, three quarters of the entire published payload, rebuilt
// and committed daily. Every value in it is a pure function of the fund's NAV
// series, which is already published as nav/{code}.json — so it is computed
// here on demand instead.
//
// This is a direct port of engine/calculation_engine.py::drawdown_series
// (window='full'). Verified against all 2,372 previously generated files:
// 3,895,467 points, 0 mismatches (max delta 5.0e-05, exactly half the 4 dp
// quantisation step those files were stored at).
//
// Kept free of React so it can be tested standalone.

import type { DrawdownPoint } from '../types'

/**
 * Build the daily underwater curve from a NAV series.
 *
 * Reads the same full NAV history that risk_metrics() uses for max_drawdown,
 * so the chart and the Risk Lab table always agree.
 */
export function computeDrawdown(series: [string, number][]): DrawdownPoint[] {
  if (!series.length) return []

  let runningPeak = series[0][1]
  let minDrawdown = 0
  let troughDate: string | null = null

  const result: DrawdownPoint[] = series.map(([date, nav]) => {
    if (nav > runningPeak) runningPeak = nav
    const dd = nav / runningPeak - 1
    if (dd < minDrawdown) {
      minDrawdown = dd
      troughDate = date
    }
    // Full precision. The pipeline rounded to 4 dp purely to keep 303 MB of
    // JSON down; computing here has no such constraint, and the chart formats
    // to 2 dp for display anyway. Note dd is exactly 0 at every new peak
    // (runningPeak is updated first), so the is_recovery test below is safe.
    return {
      date,
      drawdown_pct: dd * 100,
      is_trough: false,
      is_recovery: false,
    }
  })

  if (troughDate !== null) {
    for (const r of result) r.is_trough = r.date === troughDate

    // First date at or after the trough where the fund is back to its peak.
    let foundTrough = false
    for (const r of result) {
      if (r.date === troughDate) foundTrough = true
      if (foundTrough && r.drawdown_pct >= 0) {
        r.is_recovery = true
        break
      }
    }
  }

  return result
}
