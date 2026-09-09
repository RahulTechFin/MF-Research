// src/hooks/useTableSort.ts — click a column heading to sort by it.
//
// ONE RULE THAT MATTERS MORE THAN THE REST: MISSING VALUES SINK.
// A null return is not a small return. Sorting a screener descending must not
// float twelve funds with no 3-year history to the top just because null happens
// to compare low, and sorting ascending must not do the same at the other end.
// So nulls are always pushed to the bottom, whichever direction is active, and
// the direction only orders the values that exist.
//
// Three states per column, not two: descending, ascending, then off. "Off"
// restores whatever order the section published — usually rank — and getting
// back to it should not require a page refresh.

import { useCallback, useMemo, useState } from 'react'

export type SortDir = 'asc' | 'desc'

export interface TableSort {
  key: string | null
  dir: SortDir
  /** Cycle this column: desc -> asc -> off. */
  toggle: (key: string) => void
  /** Props for a heading cell, so every table gets the same affordance. */
  headerProps: (key: string) => {
    className: string
    onClick: () => void
    onKeyDown: (e: React.KeyboardEvent) => void
    role: 'button'
    tabIndex: 0
    'aria-sort': 'ascending' | 'descending' | 'none'
    title: string
  }
  /** The caret to render inside the heading. */
  caret: (key: string) => string
}

export function useTableSort(initial?: { key: string; dir?: SortDir }): TableSort {
  const [key, setKey] = useState<string | null>(initial?.key ?? null)
  const [dir, setDir] = useState<SortDir>(initial?.dir ?? 'desc')

  const toggle = useCallback((k: string) => {
    if (k !== key) {
      // A fresh column starts descending: for returns and scores the interesting
      // end is the top, and one click should get there.
      setKey(k)
      setDir('desc')
      return
    }
    if (dir === 'desc') {
      setDir('asc')
      return
    }
    setKey(null)
    setDir('desc')
  }, [key, dir])

  const headerProps = useCallback((k: string) => {
    const on = k === key
    return {
      className: `sortable${on ? ' sorted' : ''}`,
      onClick: () => toggle(k),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(k) }
      },
      role: 'button' as const,
      tabIndex: 0 as const,
      'aria-sort': (on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none') as
        'ascending' | 'descending' | 'none',
      title: on
        ? (dir === 'desc' ? 'Sorted highest first — click for lowest first'
                          : 'Sorted lowest first — click to clear')
        : 'Click to sort by this column',
    }
  }, [key, dir, toggle])

  const caret = useCallback((k: string) => {
    if (k !== key) return '▾'
    return dir === 'desc' ? '▼' : '▲'
  }, [key, dir])

  return { key, dir, toggle, headerProps, caret }
}

/**
 * Apply a sort. `get` reads the value for a column from a row.
 *
 * Returns the input untouched when no column is active, so the section's own
 * published order — which is usually meaningful — is the resting state rather
 * than something the user has to recreate.
 */
export function sortRows<T>(rows: T[], sort: { key: string | null; dir: SortDir },
                            get: (row: T, key: string) => unknown): T[] {
  if (!sort.key) return rows
  const k = sort.key
  const sign = sort.dir === 'asc' ? 1 : -1

  // A copy: mutating the caller's array would fight React's change detection.
  return [...rows].sort((ra, rb) => {
    const a = get(ra, k)
    const b = get(rb, k)
    const aEmpty = a === null || a === undefined || a === ''
    const bEmpty = b === null || b === undefined || b === ''
    // Missing sinks in BOTH directions — see the note at the top of the file.
    if (aEmpty && bEmpty) return 0
    if (aEmpty) return 1
    if (bEmpty) return -1
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign
    return String(a).localeCompare(String(b), undefined, { numeric: true }) * sign
  })
}
