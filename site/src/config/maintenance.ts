// src/config/maintenance.ts — temporary switches, each one line to undo.
//
// Everything in this file exists to be turned off again. Nothing else should
// read these flags except the one component named beside each, so removing a
// switch is a search for its name and nothing more.

/**
 * Show a generic failure instead of the administrator password dialog.
 *
 * CURRENTLY OFF. The administrator entry point — the Armstrong logo in the
 * header — opens the password dialog normally, on localhost and on the live
 * site alike.
 *
 * TO TURN THE BLOCK BACK ON, set this to one of:
 *
 *     true                      everywhere, including localhost
 *     import.meta.env.PROD      deployed only; localhost keeps the dialog
 *
 * That is the whole change. The dialog is untouched and has never been
 * modified — this only decides which of its two faces is rendered — so
 * flipping the value and deploying is all it takes, in either direction.
 *
 * Vite folds the value to a literal at build time, so the losing branch is
 * removed from the bundle rather than merely skipped: with the block off the
 * deployed JavaScript contains no "Something went wrong" card, and with it on
 * the bundle contains no password form for anyone to find in View Source.
 *
 * ONE THING THE BLOCK DOES NOT DO, worth remembering before relying on it: a
 * tab that was ALREADY unlocked stays unlocked until it is closed, because the
 * unlock lives in that tab's sessionStorage and this flag does not reach back
 * into it.
 *
 * And it is a UI gate, not a security boundary — it never was one. The section
 * JSON under /data stays fetchable by anyone who knows the URL, exactly as
 * described in src/hooks/useAdmin.ts. When the separation has to be real, the
 * team build (`npm run build:team`) is the mechanism: it never ships the
 * restricted sections or their data at all.
 */
export const ADMIN_MAINTENANCE = false

/** Wording shown while ADMIN_MAINTENANCE is on. */
export const ADMIN_MAINTENANCE_TITLE = 'Something went wrong'
export const ADMIN_MAINTENANCE_BODY =
  'We could not complete this request. Please try again later.'
