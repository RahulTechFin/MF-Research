import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Dev mirrors what netlify.toml does in production. Required, not a nicety:
// site/public/data is no longer committed, so a fresh clone has no local data and
// `npm run dev` would 404 on every request without this.
const SUPABASE_PUBLIC = 'https://qhxofgrntftnxqdhottd.supabase.co/storage/v1/object/public'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/data': {
        target: 'https://qhxofgrntftnxqdhottd.supabase.co/storage/v1/object/public/MF%20Data',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/data/, ''),
      },
      '/live/indices': {
        target: SUPABASE_PUBLIC + '/Indicies%20Data',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/live\/indices/, ''),
      },
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
