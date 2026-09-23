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
import Watchlist        from './sections/Watchlist'
import SifUniverse      from './sections/SifUniverse'
import FundSearch       from './components/FundSearch'
import ProductRail      from './components/ProductRail'
import type { FundHit } from './components/FundSearch'
import { useMeta }      from './hooks/useData'
import { useAdmin, isUnlockedNow } from './hooks/useAdmin'
import { isEnabled, BUILD_SECTIONS, BUILD_HAS_PRODUCTS, defaultTab, tabAllowed } from './config/profile'
import { productById, isProductId, tabStorageKey,
         PRODUCT_STORAGE_KEY, DEFAULT_PRODUCT } from './config/products'
import { setDataRoot } from './config/dataPaths'
import type { ProductId } from './config/products'

/** The desk to open on load. Non-admins are always on the default desk. */
function initialProduct(): ProductId {
  const saved = localStorage.getItem(PRODUCT_STORAGE_KEY)
  if (!BUILD_HAS_PRODUCTS || !isUnlockedNow()) return DEFAULT_PRODUCT
  return isProductId(saved) ? saved : DEFAULT_PRODUCT
}

/**
 * The tab to open on a given desk. Each desk keeps its own last-viewed tab, so
 * switching desks and coming back does not land you somewhere unrelated. The old
 * single-desk key is read as a fallback so this deploy does not reset anyone.
 */
function initialTab(p: ProductId): string {
  const saved = localStorage.getItem(tabStorageKey(p))
    ?? (p === DEFAULT_PRODUCT ? localStorage.getItem('mfrc_active_tab') : null)
  const admin = isUnlockedNow()
  return saved && tabAllowed(saved, admin, p) ? saved : defaultTab(p, admin)
}

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
  const { isAdmin, unlock, lock } = useAdmin()

  // Which research desk is open, and whether its rail is showing.
  const [product, setProduct] = useState<ProductId>(initialProduct)
  const desk = productById(product)

  // DURING RENDER, not in an effect. Every section fetches inside its own effect,
  // which runs after this, so the root is already correct by the time any request
  // goes out. An effect here would fire after the children's and the first
  // request of a desk switch would go to the previous desk's tree.
  setDataRoot(desk.dataPrefix || 'data')

  // Routing and Theme state persisted in LocalStorage.
  const [activeTab, setActiveTab] = useState(() => initialTab(initialProduct()))

  // One guard for both ways a tab can stop being valid: locking while sitting on
  // an admin tab, and switching to a desk that does not have that tab at all.
  // Either would leave the page blank, so fall back to something real.
  useEffect(() => {
    if (!tabAllowed(activeTab, isAdmin, product)) {
      setActiveTab(defaultTab(product, isAdmin))
    }
  }, [isAdmin, product, activeTab])

  // The desk switcher is admin-only for now, so locking has to close it too —
  // otherwise a persisted 'sif' would survive the lock and show the scaffold.
  useEffect(() => {
    if (!isAdmin && product !== DEFAULT_PRODUCT) setProduct(DEFAULT_PRODUCT)
  }, [isAdmin, product])

  useEffect(() => {
    localStorage.setItem(PRODUCT_STORAGE_KEY, product)
  }, [product])
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('mfrc_theme') as 'light' | 'dark') || 'dark')
  
  // Shared state for category comparison chart
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  
  // Shared state for fund comparison chart (Trend Finder)
  const [selectedFunds, setSelectedFunds] = useState<string[]>([])

  // The fund chosen from the Ctrl+S search. Held here because the search box is
  // global while the table that has to react to it is inside the screener tab.
  const [focusFund, setFocusFund] = useState<FundHit | null>(null)

  const handlePickFund = (hit: FundHit) => {
    // Switching tab first, so the screener is mounted by the time it reads the
    // focus and scrolls to it.
    setActiveTab('screener')
    setFocusFund(hit)
  }

  /**
   * Move to another desk.
   *
   * The selections are cleared on the way out. A scheme code or category slug
   * belongs to one desk's universe and means nothing in the other, so carrying
   * them across would chart funds that are not there — the same class of bug as
   * a chart holding onto its old category after the category changed.
   */
  const handleChangeProduct = (next: ProductId) => {
    if (next === product) return
    setProduct(next)
    const saved = localStorage.getItem(tabStorageKey(next))
    setActiveTab(saved && tabAllowed(saved, isAdmin, next)
      ? saved
      : defaultTab(next, isAdmin))
    setSelectedCategories([])
    setSelectedFunds([])
    setFocusFund(null)
  }

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
    localStorage.setItem(tabStorageKey(product), activeTab)
    // Switching tabs while scrolled halfway down used to drop you into the
    // middle of the next section. Jump — not smooth-scroll, which fights the
    // fade and takes longer than the transition itself.
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [activeTab, product])

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
      {/* Ctrl+S fund search. Scoped to the desk that has a fund index — on a desk
          still awaiting its data it would search the wrong universe. */}
      {desk.ready && <FundSearch onPick={handlePickFund} />}

      {/* The desk switcher: a handle against the left edge, below the freeze row.
          Admin-only for now. A team build drops the component and the SIF
          scaffold outright -- verified, neither appears in dist-team's JS. */}
      {BUILD_HAS_PRODUCTS && isAdmin && (
        <ProductRail product={product} onChange={handleChangeProduct} />
      )}

      {/* Hero header — fixed, always visible */}
      <HeroHeader
        asOf={meta?.as_of ?? null}
        product={product}
        activeTab={activeTab}
        onChangeTab={setActiveTab}
        theme={theme}
        onChangeTheme={setTheme}
        isAdmin={isAdmin}
        onUnlock={unlock}
        onLock={lock}
      />

      {/* Main page content area (offset by 120px to clear the fixed top bar).
          The key makes React remount on a tab change, which replays the
          .view-enter animation so switching sections fades in rather than
          snapping. */}
      <main key={`${product}:${activeTab}`} className="pt-[120px] pb-12 view-enter">
        {desk.ready && (<>
        {activeTab === 'market-pulse' && (
          <MarketPulse />
        )}

        {BUILD_SECTIONS.category && isEnabled('category', isAdmin) && activeTab === 'category' && (
          <>
            {/* Live Market first, so the day's context is read before anything
                is compared against it. */}
            <MarketPulseBar />
            {/* The SIF register sits between the two: it says WHICH schemes exist
                and how their plan was established, which is what makes the
                averages below it interpretable. Everything after it is the same
                component the mutual fund desk uses, over the same engine — the
                only difference is which tree dataBase() points at. */}
            {BUILD_HAS_PRODUCTS && product === 'sif' && <SifUniverse />}
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

        {BUILD_SECTIONS.screener && isEnabled('screener', isAdmin) && activeTab === 'screener' && (
          <>
            <MarketPulseBar />
            <FundScreener
              selectedFunds={selectedFunds}
              onToggleFund={handleToggleFund}
              focusFund={focusFund}
              onFocusHandled={() => setFocusFund(null)}
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

        {activeTab === 'watchlist' && (
          <>
            <MarketPulseBar />
            <Watchlist />
          </>
        )}

        {BUILD_SECTIONS.rolling && isEnabled('rolling', isAdmin) && activeTab === 'rolling' && (
          <RollingP2P />
        )}

        {BUILD_SECTIONS.risk && isEnabled('risk', isAdmin) && activeTab === 'risk' && (
          <RiskLab />
        )}

        </>)}
      </main>

      {/* Footer — P10 internal-use notice */}
      <footer className="site-footer">
        🔒 {desk.footerName} — For Internal Research Use Only. Not for distribution.
        <br />
        <span style={{ opacity: 0.6 }}>
          Data sources: {desk.sources} — for internal research purposes only.
          · <a href="/status" style={{ color: 'var(--accent-a)', textDecoration: 'none' }} onClick={e => { e.preventDefault(); window.history.pushState({}, '', '/status'); setIsStatus(true) }}>Status</a>
        </span>
      </footer>
    </div>
  )
}
