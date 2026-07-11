// src/sections/MarketPulse.tsx — Section 1: Market Pulse index grid + clickable chart modal

import { useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { useIndices } from '../hooks/useData'
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

        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}
        >
          {loading
            ? Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-xl p-4"
                  style={{ border: '1px solid var(--line)', background: 'var(--bg-card)', height: 140 }}
                >
                  <div className="skeleton w-20 h-3 mb-2.5 rounded" />
                  <div className="skeleton w-28 h-6 mb-2 rounded" />
                  <div className="skeleton w-16 h-3 mb-3 rounded" />
                  <div className="skeleton w-full h-8 rounded" />
                </div>
              ))
            : data?.indices.map(idx => {
                const meta = INDEX_META[idx.index_name]
                const [g1, g2] = meta?.gradient ?? ['#1d4ed8', '#22D3EE']
                const isUp = (idx.change_1d ?? 0) >= 0
                const sparkColor = isUp ? '#34D399' : '#F87171'
                const changeColor = isUp ? 'var(--gain)' : 'var(--loss)'

                return (
                  <div
                    key={idx.index_id}
                    onClick={() => setModalIndex({ index_id: idx.index_id, index_name: idx.index_name })}
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
