// src/utils/format.ts — Shared formatting utilities

export function fmtPct(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${(v * 100).toFixed(decimals)}%`
}

export function fmtNum(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—'
  return v.toLocaleString('en-IN', { maximumFractionDigits: decimals })
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function retColor(v: number | null): string {
  if (v == null) return 'ret-nil'
  return v >= 0 ? 'ret-pos' : 'ret-neg'
}

export function heatmapClass(v: number | null): string {
  if (v == null) return ''
  const abs = Math.abs(v * 100)
  if (v > 0) {
    if (abs > 15) return 'heatmap-pos-hi'
    if (abs > 5)  return 'heatmap-pos-md'
    return 'heatmap-pos-lo'
  } else {
    if (abs > 15) return 'heatmap-neg-hi'
    if (abs > 5)  return 'heatmap-neg-md'
    return 'heatmap-neg-lo'
  }
}

export function quartilePillClass(q: number | null): string {
  if (q === 1) return 'q-pill q-pill-1'
  if (q === 2) return 'q-pill q-pill-2'
  if (q === 3) return 'q-pill q-pill-3'
  if (q === 4) return 'q-pill q-pill-4'
  return 'q-pill q-pill-nil'
}

export function assetClassColor(ac: string): string {
  const map: Record<string, string> = {
    Equity: 'var(--equity)',
    Hybrid: 'var(--hybrid)',
    Debt:   'var(--debt)',
    Other:  'var(--other)',
  }
  return map[ac] || 'var(--accent-a)'
}

export function assetClassTabClass(ac: string, active: boolean): string {
  const cls = active ? `tab-btn active ${ac.toLowerCase()}` : 'tab-btn'
  return cls
}

/**
 * Abbreviate a full AMC fund name into a short chart-legend label.
 * e.g. "HDFC Small Cap Fund - Regular Plan - Growth" → "HDFC Small Cap"
 */
export function shortFundName(name: string, maxLen = 24): string {
  if (!name) return name
  return name
    .replace(/\s*-\s*(Regular|Direct)\s*(Plan)?/gi, '')
    .replace(/\s*-\s*(Growth|Dividend|IDCW)(\s+Payout|\s+Reinvest(ment)?)?/gi, '')
    .replace(/\b(Regular|Direct|Growth|Dividend|IDCW|Payout|Reinvest(ment)?|Plan|Fund|Mutual\s+Fund|Scheme)\b/gi, '')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLen)
    .trim()
}
