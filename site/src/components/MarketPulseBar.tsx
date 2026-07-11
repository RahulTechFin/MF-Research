// src/components/MarketPulseBar.tsx — Compact index strip shown at the top of section pages
// Clicking any card opens the IndexChartModal

import { useState } from 'react'
import ReactECharts from 'echarts-for-react'
import { useIndices } from '../hooks/useData'
import { fmtNum, fmtPct } from '../utils/format'
import IndexChartModal from './IndexChartModal'

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
      min: Math.min(...values) * 0.997,
      max: Math.max(...values) * 1.003,
    },
    series: [{
      type: 'line', data: values, smooth: true, showSymbol: false,
      lineStyle: { color, width: 1.5 },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: color + '55' },
            { offset: 1, color: color + '00' },
          ],
        },
      },
    }],
  }
  return <ReactECharts option={option} style={{ height: 28, width: '100%' }} />
}

interface IndexInfo { index_id: number; index_name: string }

export default function MarketPulseBar() {
  const { data, loading } = useIndices()
  const [modalIndex, setModalIndex] = useState<IndexInfo | null>(null)

  const allIndices: IndexInfo[] = data?.indices.map(i => ({
    index_id: i.index_id,
    index_name: i.index_name,
  })) ?? []

  return (
    <>
      <div className="px-6 py-3" style={{ background: 'var(--bg-base)' }}>
        <div className="max-w-screen-2xl mx-auto">
          {/* Label */}
          <div
            className="text-xs font-semibold uppercase mb-2 tracking-widest"
            style={{ color: 'var(--text-low)', letterSpacing: '0.12em' }}
          >
            Live Market
          </div>

          {/* Cards grid */}
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))' }}
          >
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <div
                    key={i}
                    className="rounded-xl p-3"
                    style={{ border: '1px solid var(--line)', background: 'var(--bg-card)' }}
                  >
                    <div className="skeleton w-16 h-2.5 mb-2 rounded" />
                    <div className="skeleton w-20 h-4 mb-1.5 rounded" />
                    <div className="skeleton w-12 h-2.5 rounded" />
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
                      className="rounded-xl p-3 relative overflow-hidden transition-all duration-150 hover:scale-[1.02] hover:shadow-lg cursor-pointer group"
                      style={{
                        border: `1px solid ${g2}28`,
                        background: `linear-gradient(140deg, var(--bg-card) 0%, ${g1}14 60%, ${g2}10 100%)`,
                      }}
                      title={`Click to view ${idx.index_name} chart`}
                    >
                      {/* Accent top line */}
                      <div
                        className="absolute top-0 left-0 right-0"
                        style={{ height: 2, background: `linear-gradient(90deg, ${g1}, ${g2})` }}
                      />

                      {/* Hover hint */}
                      <div
                        className="absolute top-1.5 right-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ color: g2 }}
                      >📈</div>

                      {/* Index name */}
                      <div
                        className="text-xs font-semibold truncate mb-1 mt-0.5"
                        style={{ color: g2, fontSize: 10, letterSpacing: '0.04em' }}
                      >
                        {idx.index_name}
                      </div>

                      {/* Value + Change */}
                      <div className="flex items-baseline justify-between gap-1 mb-1.5">
                        <div
                          className="font-display font-bold"
                          style={{ fontSize: 14, color: 'var(--text-hi)', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}
                        >
                          {fmtNum(idx.latest_close, 0)}
                        </div>
                        <div
                          className="font-semibold"
                          style={{ fontSize: 10, color: changeColor, whiteSpace: 'nowrap' }}
                        >
                          {isUp ? '▲' : '▼'} {fmtPct(idx.change_1d)}
                        </div>
                      </div>

                      {/* Sparkline */}
                      <Sparkline data={idx.sparkline} color={sparkColor} />
                    </div>
                  )
                })}
          </div>
        </div>
      </div>

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
