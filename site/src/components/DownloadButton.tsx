// src/components/DownloadButton.tsx — export the table you are looking at.
//
// The spec is built LAZILY, by calling `build` on click rather than on every
// render. A screener export is 2,000 rows across 20 columns; assembling that on
// each keystroke of the name filter would be wasted work for a button most
// visits never press.
//
// `build` returning null means there is nothing to export yet — still loading,
// or a category with no funds. The button then renders disabled with a reason
// rather than downloading an empty file.

import { useState } from 'react'
import { downloadWorkbook } from '../utils/xlsx'
import type { SheetSpec } from '../utils/xlsx'

interface Props {
  build: () => SheetSpec | null
  /** Shown next to the icon. Kept short — this sits in a row of controls. */
  label?: string
  /** Why it is unavailable, when build() returns null. */
  disabledHint?: string
}

export default function DownloadButton({ build, label = 'Download',
                                         disabledHint }: Props) {
  const [state, setState] = useState<'idle' | 'done' | 'empty'>('idle')

  const onClick = () => {
    const spec = build()
    if (!spec || spec.rows.length === 0) {
      setState('empty')
      setTimeout(() => setState('idle'), 2200)
      return
    }
    downloadWorkbook(spec)
    setState('done')
    setTimeout(() => setState('idle'), 2200)
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`download-btn${state === 'done' ? ' done' : ''}`}
      title={state === 'empty'
        ? (disabledHint ?? 'Nothing to export yet')
        : 'Download this table as an Excel workbook (.xlsx)'}
    >
      {state === 'done' ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      )}
      <span>
        {state === 'done' ? 'Downloaded' : state === 'empty' ? 'No data' : label}
      </span>
    </button>
  )
}
