// src/App.tsx — Main application: manages tabbed page router and light/dark theme

import { useState, useEffect } from 'react'
import HeroHeader       from './components/HeroHeader'
import MarketPulseBar   from './components/MarketPulseBar'
import MarketPulse      from './sections/MarketPulse'
import CategorySnapshot from './sections/CategorySnapshot'
import CategoryTrends   from './sections/CategoryTrends'
import FundScreener     from './sections/FundScreener'
import TrendFinder      from './sections/TrendFinder'
import QuartileRanking  from './sections/QuartileRanking'
import RollingP2P       from './sections/RollingP2P'
import RiskLab          from './sections/RiskLab'
import BlendStudio      from './sections/BlendStudio'
import { useMeta }      from './hooks/useData'

function StatusPage() {
  const { data: meta } = useMeta()
  return (
    <div className="min-h-screen flex items-center justify-center p-8" style={{ background: 'var(--bg-base)' }}>
      <div className="card p-8 max-w-lg w-full">
        <div className="font-display font-bold text-lg mb-4" style={{ color: 'var(--accent-a)' }}>
          📊 Platform Status
        </div>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-mid)' }}>Data as of:</span>
            <span>{meta?.as_of ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-mid)' }}>Categories:</span>
            <span>{meta?.categories.length ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-mid)' }}>Benchmarks:</span>
            <span>{meta?.benchmarks.length ?? '—'}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-mid)' }}>Risk-free rate:</span>
            <span>{meta ? `${(meta.risk_free_rate * 100).toFixed(1)}% p.a.` : '—'}</span>
          </div>
          <div className="flex justify-between">
            <span style={{ color: 'var(--text-mid)' }}>Last generated:</span>
            <span className="text-xs">{meta?.generated ?? '—'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const { data: meta } = useMeta()

  // Routing and Theme state persisted in LocalStorage
  const [activeTab, setActiveTab] = useState(() => localStorage.getItem('mfrc_active_tab') || 'market-pulse')
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('mfrc_theme') as 'light' | 'dark') || 'dark')
  
  // Shared state for category comparison chart
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  
  // Shared state for fund comparison chart (Trend Finder)
  const [selectedFunds, setSelectedFunds] = useState<string[]>([])

  const handleToggleCategory = (slug: string) => {
    setSelectedCategories(prev => {
      if (prev.includes(slug)) {
        return prev.filter(s => s !== slug)
      } else {
        if (prev.length >= 5) return prev
        return [...prev, slug]
      }
    })
  }

  const handleToggleFund = (code: string) => {
    setSelectedFunds(prev => {
      if (prev.includes(code)) {
        return prev.filter(c => c !== code)
      } else {
        if (prev.length >= 5) return prev
        return [...prev, code]
      }
    })
  }

  useEffect(() => {
    localStorage.setItem('mfrc_active_tab', activeTab)
  }, [activeTab])

  useEffect(() => {
    localStorage.setItem('mfrc_theme', theme)
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Simple hash-based routing for /status page
  const [isStatus, setIsStatus] = useState(window.location.pathname === '/status')
  useEffect(() => {
    const handler = () => setIsStatus(window.location.pathname === '/status')
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  if (isStatus) return <StatusPage />

  return (
    <div className="min-h-screen transition-colors duration-150" style={{ background: 'var(--bg-base)', color: 'var(--text-hi)' }}>
      {/* Hero header — fixed, always visible */}
      <HeroHeader
        asOf={meta?.as_of ?? null}
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        theme={theme}
        onChangeTheme={setTheme}
      />

      {/* Main page content area (offset by 120px to clear the fixed top bar) */}
      <main className="pt-[120px] pb-12">
        {activeTab === 'market-pulse' && (
          <MarketPulse />
        )}

        {activeTab === 'category' && (
          <>
            <MarketPulseBar />
            <CategorySnapshot
              selectedCategories={selectedCategories}
              onToggleCategory={handleToggleCategory}
            />
            <div className="my-6 border-b" style={{ borderColor: 'var(--line)', opacity: 0.4 }} />
            <CategoryTrends
              selectedCategories={selectedCategories}
            />
          </>
        )}

        {activeTab === 'screener' && (
          <>
            <MarketPulseBar />
            <FundScreener
              selectedFunds={selectedFunds}
              onToggleFund={handleToggleFund}
            />
            <div className="my-6 border-b" style={{ borderColor: 'var(--line)', opacity: 0.4 }} />
            <TrendFinder
              selectedFunds={selectedFunds}
              onToggleFund={handleToggleFund}
            />
          </>
        )}

        {activeTab === 'quartile' && (
          <>
            <MarketPulseBar />
            <QuartileRanking />
          </>
        )}

        {activeTab === 'rolling' && (
          <RollingP2P />
        )}

        {activeTab === 'risk' && (
          <RiskLab />
        )}

        {activeTab === 'blend' && (
          <BlendStudio />
        )}
      </main>

      {/* Footer — P10 internal-use notice */}
      <footer className="site-footer">
        🔒 Mutual Fund Research Center — For Internal Research Use Only. Not for distribution.
        <br />
        <span style={{ opacity: 0.6 }}>
          Data sources: AMFI (navs), Yahoo Finance (indices) — for internal research purposes only.
          · <a href="/status" style={{ color: 'var(--accent-a)', textDecoration: 'none' }} onClick={e => { e.preventDefault(); window.history.pushState({}, '', '/status'); setIsStatus(true) }}>Status</a>
        </span>
      </footer>
    </div>
  )
}
