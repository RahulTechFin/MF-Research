// src/types.ts — Shared TypeScript types matching the JSON contract (Appendix PB)

export interface Category {
  category_id: number
  asset_class: 'Equity' | 'Hybrid' | 'Debt' | 'Other'
  category_name: string
  slug: string
  display_order: number
  benchmark_id: number | null
  benchmark_name: string | null
}

export interface BenchmarkComponent {
  index_id: number
  weight: number
}

export interface Benchmark {
  index_id: number
  index_name: string
  ticker: string | null
  is_synthetic: boolean
  components: BenchmarkComponent[]
}

export interface Meta {
  as_of: string
  risk_free_rate: number
  categories: Category[]
  benchmarks: Benchmark[]
  generated: string
}

export interface IndexCard {
  index_id: number
  index_name: string
  latest_close: number
  date: string
  change_1d: number | null
  change_1d_abs: number | null
  sparkline: [string, number][]
  /**
   * Full daily history, present when the card came from the live Supabase files
   * (which carry it) and absent when it came from the committed indices.json
   * fallback. IndexChartModal uses it to skip a second fetch.
   */
  history?: [string, number][]
}

export interface IndicesData {
  as_of: string
  indices: IndexCard[]
}

export interface GlanceRow {
  period_type: 'trailing' | 'monthly' | 'quarterly' | 'annual'
  periods: (string | number)[]
  category_id: number
  asset_class: string
  category_name: string
  slug: string
  benchmark_id: number | null
  fund_count: number
  averages: Record<string, number | null>
  benchmark: Record<string, number | null>
}

export interface GlanceData {
  as_of: string
  view: string
  rows: GlanceRow[]
}

export interface FundRow {
  scheme_code: string
  scheme_name: string
  amc_name: string
  returns: Record<string, number | null>
}

export interface CategoryTableData {
  as_of: string
  view: string
  category_id: number
  category_name: string
  asset_class: string
  benchmark_id: number | null
  period_keys: string[]
  funds: FundRow[]
  category_avg: Record<string, number | null>
  benchmark: Record<string, number | null>
}

// MoverEntry / MoversData removed — movers_{slug}.json is no longer generated.
// Leaders & Laggards is computed in the browser from the category table that
// FundScreener has already loaded.

export interface QuartileFundRow {
  scheme_code: string
  scheme_name: string
  quartiles: (number | null)[]
  /**
   * The return each quartile was computed from — same index as `quartiles`.
   * Shown in the cell tooltip: a Q box on its own invites comparison against
   * whatever return is visible elsewhere (usually 1Y), and a fund can be top
   * for the year while bottom for the quarter.
   */
  returns?: (number | null)[]
  /** Stamped by build_json for sectoral/thematic funds only. */
  sector?: string
}

export interface ConsistencyEntry {
  scheme_code: string
  avg_quartile: number
  pct_q1: number
  history: (number | null)[]
}

export interface VolatilityEntry {
  scheme_code: string
  sigma: number
  best: number
  worst: number
}

export interface QuartilesData {
  as_of: string
  category_name: string
  mode: 'quarterly' | 'annual'
  period_labels: string[]
  funds: QuartileFundRow[]
  most_consistent: ConsistencyEntry[]
  most_volatile: VolatilityEntry[]
}

export interface RiskFundRow {
  scheme_code: string
  scheme_name: string
  std_annual: number | null
  sharpe: number | null
  sortino: number | null
  beta: number | null
  alpha: number | null
  max_drawdown: number | null
  recovery_days: number | null
  trough_date: string | null
  peak_date: string | null
  recovery_date: string | null
  upside_capture: number | null
  downside_capture: number | null
  composite_score: number | null
  fund_3y_cagr: number | null
  bench_3y_cagr: number | null
}

export interface RiskData {
  as_of: string
  category: string
  benchmark_id: number
  risk_free_rate: number
  funds: RiskFundRow[]
}

export interface DrawdownPoint {
  date: string
  drawdown_pct: number
  is_trough: boolean
  is_recovery: boolean
}

export interface DrawdownData {
  scheme_code: string
  drawdown: DrawdownPoint[]
}

export interface NavSeries {
  scheme_code: string
  series: [string, number][]
}

export type ViewType = 'trailing' | 'monthly' | 'quarterly' | 'annual'
export type AssetClass = 'Equity' | 'Hybrid' | 'Debt' | 'Other'
