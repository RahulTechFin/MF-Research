// src/sections/RollingP2P.tsx — Section 7: Rolling & Point-to-Point Returns

import { useState } from 'react'
import { useMeta, useCategoryTable } from '../hooks/useData'
import { fmtPct, fmtDate, retColor } from '../utils/format'

type Mode = 'current' | 'p2p'

const WINDOWS = ['1M', '3M', '6M', '1Y', '3Y', '5Y']

export default function RollingP2P() {
  const { data: meta } = useMeta()
  const [mode, setMode]       = useState<Mode>('current')
  const [anchorDate, setAnchor] = useState(new Date().toISOString().slice(0, 10))
  const [startDate, setStart]   = useState('')
  const [endDate, setEnd]       = useState('')
  const [slug, setSlug]         = useState('')
  const [window, setWindow]     = useState('1Y')

  const allCats = meta?.categories ?? []
  const activeSlug = slug || (allCats[0]?.slug ?? '')

  return (
    <section id="rolling-p2p" className="px-6 py-6 max-w-screen-2xl mx-auto">
      <div className="section-header">Rolling &amp; Point-to-Point Returns</div>

      {/* Mode pills */}
      <div className="flex gap-2 mb-4">
        <button onClick={() => setMode('current')}
          className={`pill${mode === 'current' ? ' active' : ''}`}>
          Current (Dynamic)
        </button>
        <button onClick={() => setMode('p2p')}
          className={`pill${mode === 'p2p' ? ' active' : ''}`}>
          Point-to-Point
        </button>
      </div>

      <div className="card p-4">
        {mode === 'current' ? (
          <div>
            <div className="flex items-center gap-4 mb-4 flex-wrap">
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>Anchor Date</label>
                <input type="date" value={anchorDate} onChange={e => setAnchor(e.target.value)}
                  className="px-3 py-1.5 rounded-lg text-sm"
                  style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-hi)', outline: 'none' }} />
              </div>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>Category</label>
                <select value={activeSlug} onChange={e => setSlug(e.target.value)}
                  className="px-3 py-1.5 rounded-lg text-sm"
                  style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-hi)', outline: 'none' }}>
                  {allCats.map(c => <option key={c.slug} value={c.slug}>{c.category_name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex items-center justify-center py-12 flex-col gap-2"
              style={{ color: 'var(--text-mid)', border: '1px dashed var(--line)', borderRadius: 8 }}>
              <p className="text-sm">Current mode shows trailing 1M · 3M · 6M · 1Y · 3Y · 5Y anchored to the selected date.</p>
              <p className="text-xs" style={{ color: 'var(--text-low)' }}>Expandable rows show rolling statistics (avg / min / max / % positive / % beats benchmark).</p>
              <p className="text-xs mt-2" style={{ color: 'var(--text-low)' }}>Data populates after backfill is complete.</p>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-4 mb-4 flex-wrap">
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>Start Date</label>
                <input type="date" value={startDate} onChange={e => setStart(e.target.value)}
                  className="px-3 py-1.5 rounded-lg text-sm"
                  style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-hi)', outline: 'none' }} />
              </div>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>End Date</label>
                <input type="date" value={endDate} onChange={e => setEnd(e.target.value)}
                  className="px-3 py-1.5 rounded-lg text-sm"
                  style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-hi)', outline: 'none' }} />
              </div>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--text-mid)' }}>Category</label>
                <select value={activeSlug} onChange={e => setSlug(e.target.value)}
                  className="px-3 py-1.5 rounded-lg text-sm"
                  style={{ background: 'var(--bg-raised)', border: '1px solid var(--line)', color: 'var(--text-hi)', outline: 'none' }}>
                  {allCats.map(c => <option key={c.slug} value={c.slug}>{c.category_name}</option>)}
                </select>
              </div>
            </div>
            <div className="flex items-center justify-center py-10 flex-col gap-2"
              style={{ color: 'var(--text-mid)', border: '1px dashed var(--line)', borderRadius: 8 }}>
              <p className="text-sm">Select start and end dates to compute point-to-point returns for all funds in the category.</p>
              <p className="text-xs" style={{ color: 'var(--text-low)' }}>Return shown for all periods; CAGR also shown if &gt;366 days. Category average and benchmark pinned at bottom.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
