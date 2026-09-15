// src/config/maintenance.ts — temporary switches, each one line to undo.
//
// Everything in this file exists to be turned off again. Nothing else should
// read these flags except the one component named beside each, so removing a
// switch is a search for its name and nothing more.

/**
 * Show a generic failure instead of the administrator password dialog.
 *
 * TO TURN ADMIN ACCESS BACK ON: set this to false. That is the whole change —
 * rebuild and deploy, and the password dialog returns exactly as it was. The
 * dialog itself is untouched and still works; this only decides which of its two
 * faces is rendered.
 *
 * WHAT IT DOES AND DOES NOT DO
 * The administrator entry point is the Armstrong logo in the header. With this
 * on, clicking it opens a card reading "Something went wrong" and no password
 * can be entered, so nobody — including you — can unlock a new session.
 *
 * A tab that was ALREADY unlocked stays unlocked until it is closed, because
 * the unlock lives in that tab's sessionStorage and this flag does not reach
 * back into it. That is deliberate: forcing a logout would be a second
 * behaviour to remember and undo later. It is also harmless, since the only way
 * to get into that state is to have unlocked before the flag went on.
 *
 * This is a UI gate, not a security boundary — it never was one. The section
 * JSON under /data stays fetchable by anyone who knows the URL, exactly as
 * described in src/hooks/useAdmin.ts. When the separation has to be real, the
 * team build (`npm run build:team`) is the mechanism: it never ships the
 * restricted sections or their data at all.
 */
export const ADMIN_MAINTENANCE = true

/** Wording shown while ADMIN_MAINTENANCE is on. */
export const ADMIN_MAINTENANCE_TITLE = 'Something went wrong'
export const ADMIN_MAINTENANCE_BODY =
  'We could not complete this request. Please try again later.'
