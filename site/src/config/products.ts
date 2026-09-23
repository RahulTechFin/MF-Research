// src/config/products.ts — the research desks the dashboard can show.
//
// A "desk" is a whole product line: its own universe of funds, its own data, its
// own landing tab. The left rail switches between them. Everything else — the
// tabs, the tables, the maths — is shared, because the calculations do not care
// whether a NAV came from a mutual fund or a specialized investment fund.
//
// WHAT A DESK OWNS
//   headerTitle   the freeze-row title, e.g. "SIF RESEARCH CENTER"
//   excludes      tabs this desk does not have AT ALL (not hidden — absent)
//   dataPrefix    where its JSON lives under /data. See the note below.
//   ready         false while only the shell exists, so the tabs render their
//                 scaffold instead of silently reading another desk's numbers
//
// ADDING A DESK
// Append an entry. The rail, the tab list, the freeze row and the footer all
// read from here, so there is nothing else to touch until it needs data.
//
// ON dataPrefix — READ BEFORE WIRING DATA
// Every fetch resolves through DATA_BASE in dataPaths.ts, which is a single
// constant, so pointing a desk at its own tree is a small change. It is NOT
// done yet, deliberately: an empty prefix on SIF would make it read the mutual
// fund files and present them as SIF, which is worse than showing nothing. The
// scaffold (`ready: false`) is what keeps that from happening by accident.

import type { SectionId } from './profile'

export type ProductId = 'mf' | 'sif'

export interface Product {
  id: ProductId
  /** Rail label. */
  name: string
  /** Two or three letters for the closed rail handle. */
  code: string
  /** Freeze-row title. */
  headerTitle: string
  /** Footer wording. */
  footerName: string
  /** One line under the name in the rail. */
  blurb: string
  icon: string
  /** Icon tile gradient — [from, to]. */
  gradient: [string, string]
  /** Tabs this desk does not have. */
  excludes: readonly SectionId[]
  /** Footer data-source credit. */
  sources: string
  /** Where its JSON lives under /data. Empty means the bucket root. */
  dataPrefix: string
  /** True once real data is wired; false renders the structure scaffold. */
  ready: boolean
}

export const PRODUCTS: readonly Product[] = [
  {
    id: 'mf',
    name: 'Mutual Fund',
    code: 'MF',
    headerTitle: 'MF RESEARCH CENTER',
    footerName: 'Mutual Fund Research Center',
    blurb: 'Regular plan · Growth option',
    icon: '📈',
    gradient: ['#1d4ed8', '#22D3EE'],
    excludes: [],
    sources: 'AMFI (navs), Yahoo Finance (indices)',
    dataPrefix: '',
    ready: true,
  },
  {
    id: 'sif',
    name: 'SIF',
    code: 'SIF',
    headerTitle: 'SIF RESEARCH CENTER',
    footerName: 'SIF Research Center',
    blurb: 'Specialized Investment Funds',
    icon: '🧭',
    gradient: ['#7c3aed', '#F472B6'],
    // Market Pulse is not part of this desk. The Live Market
    // strip is a separate component and DOES appear here, as on the MF desk.
    excludes: ['market-pulse'],
    sources: 'AMFI SIF NAVs, Yahoo Finance (indices)',
    // Served by the /sif proxy, which attaches the key the private bucket needs.
    dataPrefix: 'sif/data',
    ready: true,
  },
]

export const DEFAULT_PRODUCT: ProductId = 'mf'

export const PRODUCT_STORAGE_KEY = 'mfrc_product'

const BY_ID = new Map(PRODUCTS.map(p => [p.id, p]))

/** Never returns undefined: an unknown id falls back to the default desk. */
export function productById(id: string | null | undefined): Product {
  return BY_ID.get((id ?? '') as ProductId) ?? BY_ID.get(DEFAULT_PRODUCT)!
}

export function isProductId(v: string | null | undefined): v is ProductId {
  return !!v && BY_ID.has(v as ProductId)
}

/**
 * The desk that is open, for callers outside React.
 *
 * App owns this state and persists it on every change, so this read is accurate.
 * It exists for things that are not components and cannot take a prop — chiefly
 * naming an exported file and labelling its header block. Deliberately not used
 * for anything that changes what is rendered; a stale read here would only mean a
 * mislabelled download, never a wrong number.
 */
export function currentDesk(): Product {
  try {
    return productById(localStorage.getItem(PRODUCT_STORAGE_KEY))
  } catch {
    return productById(DEFAULT_PRODUCT)
  }
}

/** LocalStorage key for a desk's last-viewed tab — each desk remembers its own. */
export function tabStorageKey(id: ProductId): string {
  return `mfrc_tab_${id}`
}
