// src/components/AdminUnlockModal.tsx — password dialog opened from the logo.
//
// The entry point is deliberately unlabelled: clicking the Armstrong mark opens
// this, so the team never sees an "Admin" button inviting them to try. On a
// correct password the viewer stays exactly where they are and the extra tabs
// simply appear — no navigation, no reload.

import { useEffect, useRef, useState } from 'react'
import {
  ADMIN_MAINTENANCE, ADMIN_MAINTENANCE_BODY, ADMIN_MAINTENANCE_TITLE,
} from '../config/maintenance'

interface Props {
  open: boolean
  onClose: () => void
  onUnlock: (password: string) => Promise<boolean>
}

export default function AdminUnlockModal({ open, onClose, onUnlock }: Props) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const [checking, setChecking] = useState(false)
  const [shake, setShake] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset whenever the dialog is reopened.
  useEffect(() => {
    if (open) {
      setPassword('')
      setError(false)
      setChecking(false)
      // Nothing to focus while the failure card is showing, and stealing focus
      // to an input that is not there throws.
      if (ADMIN_MAINTENANCE) return
      // Wait for the entry transition before focusing, or the page jumps.
      const t = setTimeout(() => inputRef.current?.focus(), 80)
      return () => clearTimeout(t)
    }
  }, [open])

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!password || checking) return
    setChecking(true)
    const ok = await onUnlock(password)
    setChecking(false)
    if (ok) {
      onClose()
    } else {
      setError(true)
      setShake(true)
      setTimeout(() => setShake(false), 420)
      inputRef.current?.select()
    }
  }

  return (
    <div
      className="admin-modal-backdrop"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label="Administrator sign in"
    >
      <div className={`admin-modal-card ${shake ? 'admin-modal-shake' : ''}`}>
        <button className="admin-modal-close" onClick={onClose} aria-label="Close">×</button>

        <div className="admin-modal-badge">
          <img src="/logo.jpg" alt="" className="admin-modal-logo" />
        </div>

        {/* TEMPORARY — see config/maintenance.ts. Set ADMIN_MAINTENANCE to
            false and the password form below returns exactly as it was; nothing
            about it has been changed or removed. */}
        {ADMIN_MAINTENANCE ? (
          <>
            <div className="admin-modal-title">{ADMIN_MAINTENANCE_TITLE}</div>
            <div className="admin-modal-sub">{ADMIN_MAINTENANCE_BODY}</div>
            <button type="button" className="admin-modal-submit" onClick={onClose}
                    style={{ marginTop: 18 }}>
              Close
            </button>
          </>
        ) : (
        <>
        <div className="admin-modal-title">Administrator Access</div>
        <div className="admin-modal-sub">
          Enter the password to unlock the full research suite.
        </div>

        <form onSubmit={submit} className="admin-modal-form">
          <div className={`admin-modal-field ${error ? 'has-error' : ''}`}>
            <span className="admin-modal-field-icon">🔒</span>
            <input
              ref={inputRef}
              type="password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(false) }}
              placeholder="Password"
              autoComplete="current-password"
              spellCheck={false}
            />
          </div>

          <div className="admin-modal-error" aria-live="polite">
            {error ? 'Incorrect password — please try again.' : ''}
          </div>

          <button type="submit" className="admin-modal-submit" disabled={!password || checking}>
            {checking ? 'Verifying…' : 'Unlock'}
          </button>
        </form>
        </>
        )}

        <div className="admin-modal-foot">🔒 Internal research use only</div>
      </div>
    </div>
  )
}
