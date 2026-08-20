// src/components/FundSearch.tsx — Ctrl+S fund-name search.
//
// Ctrl+S (Cmd+S on a Mac) is the browser's Save Page shortcut, so the handler
// calls preventDefault. That is a deliberate override of a native shortcut,
// chosen because the owner asked for that key; Escape closes and nothing else on
// the page is captured.
//
// NAMES ONLY, by design. The index carries a fund's name, AMC and category and
// nothing numeric: returns and ranks change daily and already have one publisher
// in the category tables, so repeating them here would create a second source
// that could disagree with the first.

import { useEffect, useMemo, useRef, useState } from 'react'
import { dataUrl } from '../config/dataPaths'

export interface FundHit {
  code: string
  name: string
  amc: string | null
  slug: string
  category: string
  asset_class: string
}

interface Props {
  /** Called with the chosen fund so the screener can jump to it. */
  onPick: (hit: FundHit) => void
}

const MAX_RESULTS = 40

/** Fold case and collapse punctuation so "hdfc midcap" matches "HDFC Mid-Cap". */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export default function FundSearch({ onPick }: Props) {
  const [open, setOpen] = useState(false)
  const [funds, setFunds] = useState<FundHit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Open on Ctrl+S / Cmd+S, close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        setOpen(v => !v)
        return
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Fetch the index the first time the box is opened, not on page load: it is
  // a few hundred KB and most sessions never search.
  useEffect(() => {
    if (!open || funds || error) return
    fetch(dataUrl('funds_index.json'))
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(d => setFunds(d.funds as FundHit[]))
      .catch(e => setError(String(e.message ?? e)))
  }, [open, funds, error])

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else { setQuery(''); setCursor(0) }
  }, [open])

  const results = useMemo(() => {
    if (!funds) return []
    const q = norm(query)
    if (!q) return []
    const terms = q.split(' ')
    // Every term must appear somewhere in the name or AMC, so "axis small" and
    // "small axis" both find the same fund.
    const scored = funds
      .map(f => ({ f, hay: norm(`${f.name} ${f.amc ?? ''}`) }))
      .filter(({ hay }) => terms.every(t => hay.includes(t)))
      // A name that starts with the query is almost always the one meant.
      .sort((a, b) => {
        const aStart = a.hay.startsWith(terms[0]) ? 0 : 1
        const bStart = b.hay.startsWith(terms[0]) ? 0 : 1
        return aStart - bStart || a.f.name.length - b.f.name.length
      })
    return scored.slice(0, MAX_RESULTS).map(s => s.f)
  }, [funds, query])

  useEffect(() => { setCursor(0) }, [query])

  if (!open) return null

  const choose = (hit: FundHit) => {
    onPick(hit)
    setOpen(false)
  }

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => Math.min(c + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => Math.max(c - 1, 0))
    } else if (e.key === 'Enter' && results[cursor]) {
      e.preventDefault()
      choose(results[cursor])
    }
  }

  return (
    <div onClick={() => setOpen(false)}
         style={{ position: 'fixed', inset: 0, zIndex: 200,
                  background: 'rgba(0,0,0,0.55)', display: 'flex',
                  alignItems: 'flex-start', justifyContent: 'center',
                  paddingTop: '10vh' }}>
      <div onClick={e => e.stopPropagation()}
           style={{ width: 'min(680px, 92vw)', background: 'var(--bg-card)',
                    border: '1px solid var(--line)', borderRadius: 12,
                    boxShadow: '0 24px 60px rgba(0,0,0,0.45)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10,
                      padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
               stroke="var(--text-low)" strokeWidth="2">
            <circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search a fund by name…"
            style={{ flex: 1, background: 'transparent', border: 'none',
                     outline: 'none', color: 'var(--text-hi)', fontSize: 15 }}
          />
          <kbd style={{ fontSize: 10, color: 'var(--text-low)',
                        border: '1px solid var(--line)', borderRadius: 4,
                        padding: '2px 5px' }}>Esc</kbd>
        </div>

        <div style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          {error && (
            <div style={{ padding: 16, fontSize: 13, color: 'var(--loss)' }}>
              Could not load the fund list ({error}).
            </div>
          )}
          {!error && !funds && (
            <div style={{ padding: 16, fontSize: 13, color: 'var(--text-low)' }}>
              Loading fund names…
            </div>
          )}
          {funds && !query && (
            <div style={{ padding: 16, fontSize: 13, color: 'var(--text-low)' }}>
              {funds.length.toLocaleString()} funds. Start typing a name —
              try “small cap” or “hdfc”.
            </div>
          )}
          {funds && query && results.length === 0 && (
            <div style={{ padding: 16, fontSize: 13, color: 'var(--text-low)' }}>
              No fund name matches “{query}”.
            </div>
          )}
          {results.map((f, i) => (
            <button
              key={f.code}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(f)}
              style={{ display: 'flex', width: '100%', textAlign: 'left',
                       alignItems: 'center', gap: 12, padding: '9px 14px',
                       background: i === cursor ? 'var(--bg-raised)' : 'transparent',
                       border: 'none', cursor: 'pointer',
                       borderLeft: `3px solid ${i === cursor ? 'var(--accent-a)' : 'transparent'}` }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13,
                             color: 'var(--text-hi)', overflow: 'hidden',
                             textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.name}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-low)',
                             whiteSpace: 'nowrap' }}>
                {f.asset_class} · {f.category}
              </span>
            </button>
          ))}
        </div>

        <div style={{ padding: '7px 14px', borderTop: '1px solid var(--line)',
                      fontSize: 10, color: 'var(--text-low)',
                      display: 'flex', gap: 14 }}>
          <span>↑↓ move</span><span>↵ open in the screener</span>
          <span style={{ marginLeft: 'auto' }}>Ctrl+S toggles this</span>
        </div>
      </div>
    </div>
  )
}
