// src/components/HeroHeader.tsx — Gradient hero header with logo, navigation, theme toggle, and status

import { fmtDate } from '../utils/format'

interface Props {
  asOf: string | null
  activeTab: string
  onChangeTab: (tab: string) => void
  theme: 'light' | 'dark'
  onChangeTheme: (theme: 'light' | 'dark') => void
}

export default function HeroHeader({ asOf, activeTab, onChangeTab, theme, onChangeTheme }: Props) {
  const tabs = [
    { id: 'market-pulse', label: 'Market Pulse' },
    { id: 'category',     label: 'Market Trends' },
    { id: 'screener',     label: 'Fund Screener & Trend Finder' },
    { id: 'quartile',     label: 'Quartile Ranking' },
    { id: 'rolling',      label: 'Rolling & P2P' },
    { id: 'risk',         label: 'Risk Lab 🔒' },
    { id: 'blend',        label: 'Blend Studio' },
  ]

  return (
    <header className="hero-gradient fixed top-0 left-0 right-0 z-50 border-b" style={{ borderColor: 'var(--line)' }}>
      {/* Top row: Logo + Title + Controls */}
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 py-2.5 flex items-center justify-between gap-2">

        {/* Left: Armstrong logo — fully visible on white pill */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <div
            className="flex items-center justify-center rounded-md shrink-0 bg-white"
            style={{
              padding: '2px 6px',
              height: 36,
              border: '1px solid rgba(255,255,255,0.3)',
              boxShadow: '0 1px 6px rgba(0,0,0,0.18)',
            }}
          >
            <img
              src="/logo.jpg"
              alt="Armstrong Capital Logo"
              className="h-6 sm:h-7 w-auto"
              style={{ objectFit: 'contain', display: 'block' }}
            />
          </div>
          <div className="leading-tight">
            <div
              className="font-display font-bold tracking-wide text-white text-xs sm:text-sm"
              style={{ letterSpacing: '0.03em' }}
            >
              MF RESEARCH CENTER
            </div>
            <div className="hidden md:block text-[9px] text-white/50" style={{ letterSpacing: '0.03em' }}>
              For Internal Research Use Only
            </div>
          </div>
        </div>

        {/* Right: Data badge + Theme toggle + Internal badge */}
        <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
          {asOf && (
            <div
              className="text-[10px] sm:text-xs flex items-center gap-1 px-2 py-1 rounded-full text-white"
              style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}
            >
              <span className="text-cyan-400">●</span>
              <span className="hidden sm:inline">As of </span>{fmtDate(asOf)}
            </div>
          )}

          <button
            onClick={() => onChangeTheme(theme === 'light' ? 'dark' : 'light')}
            className="theme-toggle-btn text-[10px] sm:text-xs text-white px-2 py-1 rounded"
            style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)' }}
            title="Toggle theme"
          >
            <span className="hidden sm:inline">{theme === 'light' ? '🌙 Dark' : '☀️ Light'}</span>
            <span className="sm:hidden">{theme === 'light' ? '🌙' : '☀️'}</span>
          </button>

          <span className="badge-internal hidden sm:inline-flex text-[9px]">🔒 INTERNAL</span>
        </div>
      </div>

      {/* Bottom row: Nav tabs */}
      <nav className="max-w-screen-2xl mx-auto px-4 sm:px-6 pb-1 flex items-center gap-1 overflow-x-auto nav-tabs scrollbar-none">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => onChangeTab(t.id)}
            className={`nav-tab ${activeTab === t.id ? 'active' : ''}`}
            style={{
              color: activeTab === t.id ? 'var(--accent-a)' : 'rgba(255,255,255,0.7)',
              fontSize: '11px',
              padding: '6px 10px',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </header>
  )
}
