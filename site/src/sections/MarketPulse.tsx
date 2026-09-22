// src/sections/MarketPulse.tsx — Section 1: Market Pulse index grid + clickable chart modal

import { useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { useIndices } from '../hooks/useData'
import { MARKET_PULSE_GROUPS, indexGroup } from '../config/indices'
import { fmtNum, fmtPct } from '../utils/format'
import IndexChartModal from '../components/IndexChartModal'

const INDEX_META: Record<string, { gradient: [string, string] }> = {
  'NIFTY 50':           { gradient: ['#1d4ed8', '#22D3EE'] },
  'SENSEX':             { gradient: ['#7c3aed', '#F472B6'] },
  'NIFTY 100':          { gradient: ['#1565c0', '#38BDF8'] },
  'NIFTY MIDCAP 150':   { gradient: ['#0f766e', '#14B8A6'] },
  'NIFTY SMALLCAP 250': { gradient: ['#065f46', '#34D399'] },
  'NIFTY BANK':         { gradient: ['#4338ca', '#818CF8'] },
  'NIFTY 500':          { gradient: ['#0369a1', '#7DD3FC'] },
  'GOLD (GOLDBEES)':    { gradient: ['#92400e', '#F59E0B'] },
}

function Sparkline({ data, color }: { data: [string, number][]; color: string }) {
  if (!data || data.length < 2) return null
  const values = data.map(d => d[1])
  const option = {
    animation: false,
    grid: { top: 0, bottom: 0, left: 0, right: 0 },
    xAxis: { type: 'category', show: false, data: data.map(d => d[0]) },
    yAxis: {
      type: 'value', show: false,
      min: Math.min(...values) * 0.995,
      max: Math.max(...values) * 1.005,
    },
    series: [{
      type: 'line', data: values, smooth: true, showSymbol: false,
      lineStyle: { color, width: 2 },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: color + '60' },
            { offset: 1, color: color + '00' },
          ],
        },
      },
    }],
  }
  return <ReactECharts option={option} style={{ height: 48, width: '100%' }} />
}

interface IndexInfo { index_id: number; index_name: string }

/** One published index, as useIndices hands it over. */
type LiveIndex = NonNullable<ReturnType<typeof useIndices>['data']>['indices'][number]

/**
 * A group heading with a half-coloured rule under it.
 *
 * The rule is deliberately short and fades out rather than running the width of
 * the page: a full-width divider reads as "everything below this belongs to a
 * new part of the dashboard", which is not true here — both groups are Market
 * Pulse. A stub of colour marks the group without cutting the section in two.
 */
function GroupHeading({ label, gradient, count }: {
  label: string
  gradient: [string, string]
  count: number | null
}) {
  const [g1, g2] = gradient
  return (
    <div className="mb-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <div className="font-display font-bold" style={{ fontSize: 13, color: g1,
             letterSpacing: '0.06em', textTransform: 'uppercase' }}>
          {label}
        </div>
        {count != null && (
          <span className="tabnum px-1.5 rounded" style={{ fontSize: 10, fontWeight: 700,
                color: g2, background: `${g2}1A` }}>
            {count}
          </span>
        )}
      </div>
      <div style={{
        height: 3, width: 180, maxWidth: '45%', marginTop: 6, borderRadius: 999,
        background: `linear-gradient(90deg, ${g1} 0%, ${g2} 55%, transparent 100%)`,
      }} />
    </div>
  )
}

function IndexCard({ idx, onOpen }: { idx: LiveIndex; onOpen: () => void }) {
  const meta = INDEX_META[idx.index_name]
  const [g1, g2] = meta?.gradient ?? ['#1d4ed8', '#22D3EE']
  const isUp = (idx.change_1d ?? 0) >= 0
  const sparkColor = isUp ? '#34D399' : '#F87171'
  const changeColor = isUp ? 'var(--gain)' : 'var(--loss)'

  return (
    <div
      onClick={onOpen}
      className="rounded-xl p-4 relative overflow-hidden transition-all duration-150 hover:scale-[1.03] hover:shadow-xl cursor-pointer group"
      style={{
        border: `1px solid ${g2}30`,
        background: `linear-gradient(140deg, var(--bg-card) 0%, ${g1}16 60%, ${g2}12 100%)`,
      }}
      title={`Click to view ${idx.index_name} chart`}
    >
      {/* Accent gradient top border */}
      <div
        className="absolute top-0 left-0 right-0"
        style={{ height: 2, background: `linear-gradient(90deg, ${g1}, ${g2})` }}
      />

      {/* Click hint */}
      <div
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 text-xs"
        style={{ color: g2 }}
      >
        📈
      </div>

      {/* Index name */}
      <div
        className="text-xs font-semibold truncate mb-1.5 mt-0.5"
        style={{ color: g2, letterSpacing: '0.04em' }}
      >
        {idx.index_name}
      </div>

      {/* Value */}
      <div
        className="font-display font-bold count-up"
        style={{
          fontSize: 22,
          color: 'var(--text-hi)',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
          marginBottom: 4,
        }}
      >
        {fmtNum(idx.latest_close, 0)}
      </div>

      {/* Change badge */}
      <div
        className="inline-flex items-center gap-1 text-xs font-semibold mb-2 px-1.5 py-0.5 rounded"
        style={{
          color: changeColor,
          background: isUp ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
          fontSize: 11,
        }}
      >
        {isUp ? '▲' : '▼'} {fmtPct(idx.change_1d)} today
      </div>

      {/* Sparkline */}
      <Sparkline data={idx.sparkline} color={sparkColor} />
    </div>
  )
}

const GRID_STYLE = { gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' } as const

function CardSkeleton() {
  return (
    <div className="rounded-xl p-4"
         style={{ border: '1px solid var(--line)', background: 'var(--bg-card)', height: 140 }}>
      <div className="skeleton w-20 h-3 mb-2.5 rounded" />
      <div className="skeleton w-28 h-6 mb-2 rounded" />
      <div className="skeleton w-16 h-3 mb-3 rounded" />
      <div className="skeleton w-full h-8 rounded" />
    </div>
  )
}

export default function MarketPulse() {
  const { data, loading } = useIndices()
  const [modalIndex, setModalIndex] = useState<IndexInfo | null>(null)

  const allIndices: IndexInfo[] = data?.indices.map(i => ({
    index_id: i.index_id,
    index_name: i.index_name,
  })) ?? []

  return (
    <>
      <section id="market-pulse" className="px-6 py-6 max-w-screen-2xl mx-auto">
        <div className="section-header">Market Pulse</div>

        <div className="space-y-6">
          {MARKET_PULSE_GROUPS.map(g => {
            // Grouped by index identity, not by array position: the live bucket
            // and the committed fallback order their cards differently.
            const items = (data?.indices ?? []).filter(
              i => indexGroup(i.index_id) === g.key,
            )
            const isBroad = g.key === 'broad'
            // Only the broad group has a known card count to reserve space for.
            const skeletons = loading && isBroad ? 8 : 0

            return (
              <div key={g.key}>
                <GroupHeading label={g.label} gradient={g.gradient}
                              count={loading && isBroad ? null : items.length} />

                {skeletons > 0 ? (
                  <div className="grid gap-3" style={GRID_STYLE}>
                    {Array.from({ length: skeletons }).map((_, i) => <CardSkeleton key={i} />)}
                  </div>
                ) : items.length ? (
                  <div className="grid gap-3" style={GRID_STYLE}>
                    {items.map(idx => (
                      <IndexCard
                        key={idx.index_id}
                        idx={idx}
                        onOpen={() => setModalIndex({
                          index_id: idx.index_id, index_name: idx.index_name,
                        })}
                      />
                    ))}
                  </div>
                ) : (
                  // An empty group says so. A group heading with nothing under it
                  // reads as a failed fetch, which is the one thing it is not.
                  <div className="rounded-xl px-4 py-6 text-xs text-center"
                       style={{ border: '1px dashed var(--line)', color: 'var(--text-low)' }}>
                    No sectoral benchmarks are wired up yet. They are added the same
                    way as the broader-market indices — one entry in
                    <span className="font-mono" style={{ fontSize: 11 }}> config/indices.ts </span>
                    and the matching index in the daily refresh.
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* Index Chart Modal */}
      {modalIndex && (
        <IndexChartModal
          initial={modalIndex}
          allIndices={allIndices}
          onClose={() => setModalIndex(null)}
        />
      )}
    </>
  )
}
