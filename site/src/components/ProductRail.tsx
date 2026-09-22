// src/components/ProductRail.tsx — the left slide-out desk switcher.
//
// HOW IT OPENS
// On hover. Rest the pointer on the handle and the panel slides out; move away
// and it closes again. No click needed, and nothing is dimmed — the page behind
// stays exactly as it was, because this is a hover affordance rather than a
// modal. Clicking the handle PINS it open, which is what makes it usable on a
// touch screen and from the keyboard, where there is no hover to speak of.
//
// The handle travels with the panel, sitting flush against its edge, so the
// arrow always reads as the panel's own pull-tab. Both carry the same
// enter/leave handlers: they touch, so the pointer moves from one to the other
// without ever leaving the pair, and a short close delay covers the seam.
//
// WHY IT MEASURES THE HEADER
// The freeze row is a fixed element whose height changes with the breakpoint. A
// hard-coded offset left a strip of page background between the header and the
// panel at some widths, so the panel looked detached. A ResizeObserver keeps
// --rail-top equal to the real header height instead.

import { useEffect, useRef, useState } from 'react'
import { PRODUCTS, productById } from '../config/products'
import type { ProductId } from '../config/products'

/** Grace period on leave, so crossing the handle/panel seam cannot flicker. */
const CLOSE_DELAY_MS = 180

interface Props {
  product: ProductId
  onChange: (id: ProductId) => void
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

export default function ProductRail({ product, onChange }: Props) {
  const current = productById(product)

  // Two independent reasons to be open. Hover is the everyday one; pinned is for
  // click, touch and keyboard, and it survives the pointer leaving.
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const open = hovered || pinned

  const closeTimer = useRef<number | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const enter = () => {
    cancelClose()
    setHovered(true)
  }

  const leave = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => {
      setHovered(false)
      closeTimer.current = null
    }, CLOSE_DELAY_MS)
  }

  useEffect(() => cancelClose, [])

  // Keep the panel hanging directly off the bottom of the freeze row, whatever
  // height that row happens to be at this breakpoint.
  useEffect(() => {
    const header = document.getElementById('app-header')
    if (!header) return
    const apply = () => document.documentElement.style.setProperty(
      '--rail-top', `${header.offsetHeight}px`,
    )
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(header)
    return () => ro.disconnect()
  }, [])

  // Escape unpins; Ctrl+B pins, for anyone who would rather not use the pointer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (pinned || hovered)) {
        cancelClose()
        setPinned(false)
        setHovered(false)
        return
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        const next = !pinned
        setPinned(next)
        if (next) {
          // Only a deliberate keyboard open moves focus. Doing it on hover would
          // yank the caret out of whatever the user was actually typing in.
          requestAnimationFrame(() =>
            panelRef.current?.querySelector<HTMLButtonElement>('.rail-item')?.focus())
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pinned, hovered])

  const pick = (id: ProductId) => {
    onChange(id)
    cancelClose()
    setPinned(false)
    setHovered(false)
  }

  return (
    <>
      <button
        type="button"
        className={open ? 'rail-handle open' : 'rail-handle'}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={enter}
        onClick={() => setPinned(p => !p)}
        aria-expanded={open}
        aria-controls="product-rail"
        aria-label={open ? 'Close the desk switcher' : 'Switch research desk'}
        title={`${current.name} desk — hover to switch`}
      >
        <Chevron className="rail-chev" />
        <span className="rail-handle-code">{current.code}</span>
      </button>

      <aside
        id="product-rail"
        ref={panelRef}
        className={open ? 'rail-panel open' : 'rail-panel'}
        aria-label="Research desks"
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
        <div className="rail-eyebrow">Research Desks</div>

        {PRODUCTS.map(p => {
          const active = p.id === product
          return (
            <button
              key={p.id}
              type="button"
              className={active ? 'rail-item active' : 'rail-item'}
              onClick={() => pick(p.id)}
              aria-current={active ? 'page' : undefined}
              title={active ? `${p.name} — you are here` : `Open the ${p.name} desk`}
            >
              <span
                className="rail-icon"
                style={{ background: `linear-gradient(135deg, ${p.gradient[0]}, ${p.gradient[1]})` }}
                aria-hidden="true"
              >
                {p.icon}
              </span>
              <span className="rail-text">
                <span className="rail-name">{p.name}</span>
                <span className="rail-blurb">{p.blurb}</span>
              </span>
              {/* A dot for the desk you are in, an arrow for one you can go to —
                  so the row says which it is without relying on colour alone. */}
              {active
                ? <span className="rail-dot" aria-hidden="true" />
                : <Chevron className="rail-go" />}
              {!p.ready && <span className="rail-tag">SHELL</span>}
            </button>
          )
        })}

        <div className="rail-foot">
          Click the tab to keep this open · <kbd>Ctrl</kbd>+<kbd>S</kbd> fund search
        </div>
      </aside>
    </>
  )
}
