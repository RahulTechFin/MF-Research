// src/components/ComingFunds.tsx — what a table says when its category holds no
// funds yet, and what it says when the fetch genuinely failed.
//
// WHY THIS IS A COMPONENT AND NOT THREE COPIES
// The engine only writes a category file where it actually found schemes, so a
// category with nothing launched under it has NO FILE AT ALL. Every tab reading
// a per-category file therefore has to tell three outcomes apart — absent,
// broken, and present-but-too-short — and three sections had each grown their
// own version of that test with its own wording, so a reader moving between
// tabs got a different answer to the same question.
//
// THE 400 IS NOT DEFENSIVE PADDING
// Supabase Storage answers a missing object with 404 in a public bucket but 400
// in a private one. The SIF desk's bucket is private, so its debt categories
// come back 400 while its equity ones return 200 — measured, not assumed.
// scripts/supabase_store.py treats the same pair as "absent" for this reason.
// Matching only 404 would show a red failure where the honest answer is that
// nothing has launched yet.
//
// Renders no wrapper of its own: each section already has a padded, centred
// container holding its other empty states, and nesting a second one inside it
// only shifts the text off centre.

/** True when the fetch failed because the file is not there. */
export function isAbsent(error: string | null | undefined): boolean {
  return !!error && /\b(404|400)\b/.test(error)
}

export default function ComingFunds({ error, subject, failedLabel }: {
  error: string | null | undefined
  /**
   * What this tab would have done with the funds — "rank", "measure", "show".
   * Reads as "there is nothing to <subject>".
   */
  subject: string
  /** Named in the failure line: "Could not load <failedLabel>." */
  failedLabel: string
}) {
  if (isAbsent(error)) {
    return (
      <>
        <div style={{ color: 'var(--text-hi)', marginBottom: 4, fontWeight: 600 }}>
          Coming Funds
        </div>
        <div className="text-xs">
          No scheme has been launched under this category yet, so there is nothing
          to {subject}. It will appear here as soon as one is.
        </div>
      </>
    )
  }
  return (
    <>
      <div style={{ color: 'var(--loss)', marginBottom: 4 }}>
        Could not load {failedLabel}.
      </div>
      <div className="text-xs">{error ?? 'no data returned'}</div>
    </>
  )
}
