// src/hooks/useAdmin.ts — admin unlock for the shared-link setup.
//
// WHERE THE PASSWORD LIVES
// The plaintext appears nowhere in this project. What exists is a PBKDF2-SHA256
// verifier (210,000 iterations, random 16-byte salt) supplied at build time via
// VITE_ADMIN_VERIFIER, which is set in site/.env.local — a gitignored file — and
// in Netlify's environment variables. Nothing about the password is committed.
//
// WHAT THIS CANNOT DO
// The site is static, so the check runs in the visitor's browser and the
// verifier is therefore present in the deployed JavaScript. PBKDF2 at 210k
// iterations makes each guess cost real work, so brute force is impractical —
// but that is not the same as a secret held on a server. Nor does it protect
// the data: /data/risk_large-cap.json is a static file and stays fetchable
// regardless of this gate. When the separation has to be genuine, deploy the
// team with `npm run build:team`, which never ships the restricted sections or
// their JSON at all.
//
// FAIL-CLOSED
// If VITE_ADMIN_VERIFIER is absent or malformed, unlocking is disabled outright
// rather than falling back to a default — a missing secret must lock people
// out, never let them in.

import { useCallback, useEffect, useState } from 'react'

const RAW_VERIFIER = (import.meta.env.VITE_ADMIN_VERIFIER as string | undefined) ?? ''

// Backed explicitly by ArrayBuffer: WebCrypto's BufferSource rejects the
// SharedArrayBuffer-compatible default that Uint8Array infers.
type Bytes = Uint8Array<ArrayBuffer>

type Verifier = { iterations: number; salt: Bytes; hash: Bytes }

function b64ToBytes(b64: string): Bytes {
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Parse "iterations:saltB64:hashB64". Returns null if anything is off.
 *
 * The separator is a colon rather than "$" because Vite pipes .env files
 * through dotenv-expand, which reads $name as a variable reference and expands
 * it to an empty string. A $-separated verifier reached the bundle with its
 * salt silently deleted, so parsing failed and the unlock did nothing at all —
 * no error, no clue. Base64 never contains a colon, so this is unambiguous.
 */
function parseVerifier(raw: string): Verifier | null {
  const parts = raw.split(':')
  if (parts.length !== 3) return null
  const iterations = Number(parts[0])
  if (!Number.isFinite(iterations) || iterations < 1000) return null
  try {
    return { iterations, salt: b64ToBytes(parts[1]), hash: b64ToBytes(parts[2]) }
  } catch {
    return null
  }
}

const VERIFIER = parseVerifier(RAW_VERIFIER)

/** False when no valid verifier was built in — the unlock UI is then hidden. */
export const ADMIN_CONFIGURED = VERIFIER !== null

/** Compare without early exit, so timing does not leak how much matched. */
function constantTimeEqual(a: Bytes, b: Bytes): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function verify(password: string, v: Verifier): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: v.salt, iterations: v.iterations, hash: 'SHA-256' },
    key,
    v.hash.length * 8,
  )
  return constantTimeEqual(new Uint8Array(bits) as Bytes, v.hash)
}

const STORAGE_KEY = 'mfrc_admin'

export function useAdmin() {
  // sessionStorage, not localStorage: the unlock lasts for the tab only, so a
  // shared machine does not stay unlocked once the window is closed.
  const [isAdmin, setIsAdmin] = useState(
    () => ADMIN_CONFIGURED && sessionStorage.getItem(STORAGE_KEY) === '1',
  )

  useEffect(() => {
    if (isAdmin) sessionStorage.setItem(STORAGE_KEY, '1')
    else sessionStorage.removeItem(STORAGE_KEY)
  }, [isAdmin])

  const unlock = useCallback(async (password: string): Promise<boolean> => {
    if (!VERIFIER) return false
    let ok = false
    try {
      ok = await verify(password, VERIFIER)
    } catch {
      ok = false
    }
    if (ok) setIsAdmin(true)
    return ok
  }, [])

  const lock = useCallback(() => setIsAdmin(false), [])

  return { isAdmin, unlock, lock }
}
