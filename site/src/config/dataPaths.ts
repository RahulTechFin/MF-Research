// src/config/dataPaths.ts — where each data file lives.
//
// The data no longer ships inside the site. It lives in a public Supabase
// bucket, organised by asset class and category, and both the dev server and
// Netlify proxy /data/* to it — so every path below stays same-origin and needs
// no key and no CORS.
//
//     meta.json  indices.json  glance_<view>.json  watchlist_<mode>.json
//     manifest.json
//     index/<index_id>.json
//     equity/<slug>/  category_<view>.json  quartiles_<mode>.json
//                     rolling.json  risk.json  history.json
//                     nav/<scheme_code>.json
//     hybrid|debt|other/<slug>/  ...
//
// WHY A MANIFEST
// A category-scoped path needs the asset class of the slug, and a nav path needs
// the category of the fund. The app does not always have either: TrendFinder is
// handed fund codes with no category attached, and passing a slug down from the
// screener would couple two screens that are otherwise independent. manifest.json
// carries both lookups — ~20 KB gzipped, fetched once per session.

export const DATA_BASE = import.meta.env.BASE_URL + 'data'

interface Manifest {
  categories: Record<string, string>   // slug -> equity | hybrid | debt | other
  funds: Record<string, string>        // scheme_code -> "<asset-class>/<slug>"
}

// One in-flight request shared by every caller. Without this, the twenty-odd
// hooks that mount together would each fetch the manifest.
let pending: Promise<Manifest> | null = null

export function manifest(): Promise<Manifest> {
  if (!pending) {
    pending = fetch(`${DATA_BASE}/manifest.json`)
      .then(r => {
        if (!r.ok) throw new Error(`manifest HTTP ${r.status}`)
        return r.json() as Promise<Manifest>
      })
      .catch(err => {
        // Do not cache a failure: a transient error would otherwise poison every
        // later lookup for the life of the page.
        pending = null
        throw err
      })
  }
  return pending
}

/** Folder for a category, e.g. "equity/large-cap". */
export async function categoryDir(slug: string): Promise<string> {
  const m = await manifest()
  const ac = m.categories[slug]
  if (!ac) throw new Error(`unknown category "${slug}"`)
  return `${ac}/${slug}`
}

/** Full path to a category-scoped file, e.g. "equity/large-cap/risk.json". */
export async function categoryPath(slug: string, file: string): Promise<string> {
  return `${await categoryDir(slug)}/${file}`
}

/** Full path to one fund's NAV series. */
export async function navPath(schemeCode: string): Promise<string> {
  const m = await manifest()
  const dir = m.funds[schemeCode]
  if (!dir) throw new Error(`fund ${schemeCode} is not in the manifest`)
  return `${dir}/nav/${schemeCode}.json`
}

/** Absolute URL for a path inside the data bucket. */
export function dataUrl(path: string): string {
  return `${DATA_BASE}/${path}`
}
