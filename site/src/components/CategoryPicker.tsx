// src/components/CategoryPicker.tsx — pick a category, in its own colour.
//
// WHY THIS EXISTS
// Every analysis screen splits categories into a row of "main" tabs plus a
// dropdown for the rest, and the main-tab list is a hardcoded set of MUTUAL FUND
// category names. On the SIF desk not one name matches, so all five strategies
// fell into the dropdown and the screen opened with a control reading
// "-- Other Categories --" and nothing else. Every category equally buried.
//
// So: when a desk's categories match none of those names, it gets this instead —
// every category visible, each in its own colour, no dropdown. Legible up to
// about a dozen, which is why the mutual fund desk with 41 keeps its tabs and
// dropdown untouched.

import { categoryColor } from '../config/categoryColors'

export interface PickerCategory {
  slug: string
  category_name: string
  asset_class: string
  fund_count?: number
}

interface Props {
  cats: PickerCategory[]
  active: string
  onChange: (slug: string) => void
}

export default function CategoryPicker({ cats, active, onChange }: Props) {
  if (cats.length === 0) return null

  return (
    <div className="cat-picker">
      {cats.map(c => {
        const colour = categoryColor(c.slug, c.asset_class)
        const on = c.slug === active
        return (
          <button
            key={c.slug}
            type="button"
            onClick={() => onChange(c.slug)}
            aria-current={on ? 'true' : undefined}
            className={on ? 'cat-chip active' : 'cat-chip'}
            style={{
              // The colour carries the state, so an inactive chip shows only its
              // dot and a hairline — enough to identify it without competing with
              // the one that is selected.
              borderColor: on ? colour : 'var(--line)',
              background: on ? `${colour}1f` : 'var(--bg-raised)',
              color: on ? colour : 'var(--text-mid)',
              boxShadow: on ? `inset 3px 0 0 ${colour}` : undefined,
            }}
          >
            <span className="cat-dot" style={{ background: colour }} aria-hidden="true" />
            <span className="cat-label">{c.category_name}</span>
            {c.fund_count != null && (
              <span className="cat-n" style={{ color: on ? colour : 'var(--text-low)' }}>
                {c.fund_count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
