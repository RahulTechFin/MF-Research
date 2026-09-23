/**
 * prune_data.mjs — Delete restricted JSON from a team build's dist/.
 *
 * Removing a section from the React bundle hides it, but every file under
 * public/data is copied into dist/ and served as a static asset. Without this
 * step a team member could still fetch /data/risk_large-cap.json and read the
 * whole Risk Lab dataset. So the team build ships only the data its two
 * sections actually read; everything else is deleted before deploy.
 *
 * Keep the allowlist in sync with SECTIONS in src/config/profile.ts.
 *
 * Usage:  node scripts/prune_data.mjs dist team
 */

import fs from 'fs'
import path from 'path'

const distDir = process.argv[2] ?? 'dist'
const profile = process.argv[3] ?? 'admin'

if (profile === 'admin') {
  console.log('[prune] admin build — keeping all data')
  process.exit(0)
}

// DATA PRUNING NO LONGER APPLIES.
//
// The JSON used to be committed and copied into dist/, so a team build had to
// delete the restricted files or a team member could fetch them by URL. The data
// now lives in a public Supabase bucket that netlify.toml proxies, so there is
// nothing in dist/ to delete -- and nothing a build could hide, since every file
// in that bucket is readable by URL regardless of which profile was built.
//
// A missing directory is therefore the expected state, not an error. The bundle
// fingerprint check further down still matters and still runs: it is what catches
// VITE_PROFILE not being set to "team".
const dataDir = path.join(distDir, 'data')
const hasData = fs.existsSync(dataDir)
if (!hasData) {
  console.log('[prune] no dist/data — data is served from Supabase, nothing to prune')
  console.log('[prune] NOTE: bucket objects are public, so a team build cannot')
  console.log('[prune]       hide restricted data. Use bucket policies for that.')
}

// The allowlist is DERIVED from src/config/sections.json — the same file the
// app reads. Hard-coding it here once meant a tab could be made public without
// its data being shipped (or worse, hidden while its data stayed deployed).
const config = JSON.parse(
  fs.readFileSync(new URL('../src/config/sections.json', import.meta.url), 'utf8')
)

const ALLOW = config.publicSections.flatMap(id => {
  const patterns = config.dataFiles[id]
  if (!patterns) {
    console.error(`[prune] ERROR: sections.json lists "${id}" as public but has no dataFiles entry`)
    process.exit(1)
  }
  return patterns.map(p => new RegExp(p))
})

console.log(`[prune] public sections: ${config.publicSections.join(', ')}`)

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/**
 * Delete with retries. On Windows, OneDrive and antivirus routinely hold a
 * transient lock on freshly written files and unlink throws EBUSY/EPERM.
 */
function unlinkWithRetry(file, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      fs.unlinkSync(file)
      return true
    } catch (err) {
      if (i === attempts || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) {
        return false
      }
      // Busy-wait briefly; this script is synchronous by design.
      const until = Date.now() + i * 120
      while (Date.now() < until) { /* spin */ }
    }
  }
  return false
}

const all = walk(dataDir)
let kept = 0
let removedCount = 0
let removedBytes = 0
const failed = []

for (const full of all) {
  const rel = path.relative(dataDir, full).replace(/\\/g, '/')
  if (ALLOW.some(rx => rx.test(rel))) {
    kept++
    continue
  }
  const size = fs.statSync(full).size
  if (unlinkWithRetry(full)) {
    removedBytes += size
    removedCount++
  } else {
    failed.push(rel)
  }
}

// Drop directories the removals emptied.
for (const dir of walk_dirs(dataDir).reverse()) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch { /* not empty, or already gone */ }
}

function walk_dirs(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const full = path.join(dir, entry.name)
      out.push(full, ...walk_dirs(full))
    }
  }
  return out
}

if (hasData) {
  console.log(
    `[prune] team build — kept ${kept} files, removed ${removedCount} ` +
    `(${(removedBytes / 1024 / 1024).toFixed(1)} MB of restricted data)`
  )
}

if (hasData && kept === 0) {
  console.error('[prune] ERROR: everything was removed — the allowlist is wrong')
  process.exit(1)
}

// Final audit. Anything restricted still on disk would be deployed and served,
// so a survivor is a data leak, not a warning — fail the build.
const survivors = walk(dataDir)
  .map(f => path.relative(dataDir, f).replace(/\\/g, '/'))
  .filter(rel => !ALLOW.some(rx => rx.test(rel)))

if (survivors.length) {
  console.error(
    `[prune] FATAL: ${survivors.length} restricted file(s) could not be removed ` +
    `and would be deployed:`
  )
  for (const s of survivors.slice(0, 10)) console.error(`          ${s}`)
  if (failed.length) {
    console.error('[prune] These were locked by another process (OneDrive, antivirus).')
    console.error('[prune] Close anything reading site/dist and rebuild.')
  }
  process.exit(1)
}

console.log(`[prune] verified — no restricted files remain in ${dataDir}`)

// ── fail-closed check on the JS bundle ──────────────────────────────────────
// The profile comes from VITE_PROFILE via .env.team. If that file goes missing
// the flag defaults to 'admin' and every section compiles in, while this script
// still prunes the data because it reads the profile from argv. The result is a
// team site advertising Risk Lab. Catch that here rather than
// discovering it in production.
// Derived from adminSections, so promoting a tab to public automatically stops
// this check flagging its label. 'Sortino' is added as an internals canary —
// it appears only inside Risk Lab's own code, never in a tab label.
const RESTRICTED_FINGERPRINTS = [
  ...config.adminSections.map(id => config.labels[id]).filter(Boolean),
  'Sortino',
]

const assetsDir = path.join(distDir, 'assets')
const bundleText = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir)
      .filter(f => f.endsWith('.js'))
      .map(f => fs.readFileSync(path.join(assetsDir, f), 'utf8'))
      .join('\n')
  : ''

const leaked = RESTRICTED_FINGERPRINTS.filter(s => bundleText.includes(s))
if (leaked.length) {
  console.error('[prune] FATAL: the team bundle still contains restricted sections:')
  for (const s of leaked) console.error(`          "${s}"`)
  console.error('[prune] VITE_PROFILE was probably not set to "team".')
  console.error('[prune] Check that site/.env.team exists and is committed.')
  process.exit(1)
}

console.log(`[prune] verified — bundle contains no restricted sections`)
