import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// Dev mirrors what netlify.toml does in production. Required, not a nicety:
// site/public/data is no longer committed, so a fresh clone has no local data and
// `npm run dev` would 404 on every request without this.
const SUPABASE_PUBLIC = 'https://noclpcmacjuqhjlqekcr.supabase.co/storage/v1/object/public'

// LOCAL DATA WINS OVER THE BUCKET.
// The proxy used to be unconditional, so a locally built dataset was invisible:
// `npm run dev` kept serving whatever was last published and the dashboard's "as
// of" date never moved, however many times the pipeline was run. Now a request is
// only forwarded when the file is genuinely absent locally, so a fresh build shows
// up immediately and a clean clone still works.
//
// Populate the local copy with the layout the site expects (NOT the engine's flat
// output — see publish_data.write_local_tree):
//     MF_OUTPUT_DIR=build/data-flat python scripts/daily_run.py
//     MF_OUTPUT_DIR=build/data-flat python scripts/publish_data.py --to-dir site/public/data
const LOCAL_DATA = path.resolve(__dirname, 'public', 'data')

// ── The SIF bucket ──────────────────────────────────────────────────────────
//
// Unlike "MF Data" and "Indicies Data", the SIF bucket is PRIVATE: it answers
// nothing without the service key. So this proxy does what the other two do not
// have to -- it attaches the key itself.
//
// The key is read from the repository-root .env (gitignored) and used only here,
// inside the dev server, which is Node. It is never referenced from src/, so it
// cannot reach the browser and it is not in the production bundle: `server.proxy`
// is dev-only configuration. The browser only ever sees /sif/*.
//
// PRODUCTION STILL NEEDS A DECISION. A netlify.toml redirect cannot add an
// Authorization header, so the deployed site needs either a Netlify Function
// doing what this proxy does, or the bucket made public like the other two.
// Until then the SIF desk has data on localhost and not on Netlify.
function repoEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const i = t.indexOf('=')
      if (i < 0) continue
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    /* no .env -- the SIF proxy is simply not registered below */
  }
  return { ...out, ...(process.env as Record<string, string>) }
}

const ENV = repoEnv()
const SIF_KEY = ENV.SUPABASE_SERVICE_KEY || ''
const SIF_BUCKET = ENV.SUPABASE_SIF_BUCKET || 'SIF Data'
const SUPABASE_ROOT = (ENV.SUPABASE_URL || 'https://noclpcmacjuqhjlqekcr.supabase.co')
  .replace(/\/+$/, '')

const sifProxy = SIF_KEY
  ? {
      '/sif': {
        target: `${SUPABASE_ROOT}/storage/v1/object/${encodeURIComponent(SIF_BUCKET)}`,
        changeOrigin: true,
        headers: { apikey: SIF_KEY, Authorization: `Bearer ${SIF_KEY}` },
        rewrite: (p: string) => p.replace(/^\/sif/, ''),
      },
    }
  : {}

if (!SIF_KEY) {
  console.warn('[vite] SUPABASE_SERVICE_KEY not found in ../.env — the SIF desk '
             + 'will have no data. The MF desk is unaffected.')
}

function serveLocalIfPresent(prefix: string, root: string) {
  return (req: { url?: string }) => {
    const url = req.url ?? ''
    const rel = decodeURIComponent(url.slice(prefix.length).split('?')[0])
    // Refuse to climb out of the data directory.
    const target = path.resolve(root, '.' + (rel.startsWith('/') ? rel : '/' + rel))
    if (!target.startsWith(root)) return undefined
    try {
      if (fs.statSync(target).isFile()) return url   // returning the url serves it locally
    } catch {
      /* not present — fall through to the proxy */
    }
    return undefined
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/data': {
        target: 'https://noclpcmacjuqhjlqekcr.supabase.co/storage/v1/object/public/MF%20Data',
        changeOrigin: true,
        bypass: serveLocalIfPresent('/data', LOCAL_DATA),
        rewrite: (p) => p.replace(/^\/data/, ''),
      },
      '/live/indices': {
        target: SUPABASE_PUBLIC + '/Indicies%20Data',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/live\/indices/, ''),
      },
      ...sifProxy,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          charts: ['echarts', 'echarts-for-react'],
          table:  ['@tanstack/react-table'],
        },
      },
    },
  },
})
