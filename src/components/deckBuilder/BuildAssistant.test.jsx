// @vitest-environment jsdom
//
// BuildAssistant.jsx is ~3,400 lines and had no test of any kind. That is not a
// policy — 30-odd other components are tested — it just never got one, and the
// gap is sharper than it looks: a JSX parse error in this file passed the whole
// suite and was caught only by `npm run build`. Nothing here tries to exercise
// the assistant's behaviour (that lives in deckBuildAssistant / cutBench /
// buildAssistantPasses, which are pure and tested directly). It exists so the
// module is compiled, imported and mounted by the test run, which is what turns
// a syntax error, a bad import, or a hook-order violation into a failing test.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// jsdom implements neither of these, and the assistant uses both for layout
// (centering the active stepper node, measuring the grid). Absent, mounting
// throws for reasons that have nothing to do with the component.
beforeAll(() => {
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || function scrollIntoView() {}
})

// The assistant reaches for Supabase, EDHREC and the combo API on mount. None of
// that is under test here, so it is stubbed to the shapes the component reads
// rather than mocked call-by-call.
vi.mock('../../lib/supabase', () => ({
  sb: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
    auth: { getSession: async () => ({ data: { session: null } }) },
  },
}))
vi.mock('../../lib/deckBuilderApi', async importOriginal => ({
  ...(await importOriginal()),
  fetchEdhrec: async () => null,
}))

afterEach(cleanup)

const COMMANDER = {
  name: 'Korvold, Fae-Cursed King',
  color_identity: ['B', 'R', 'G'],
  type_line: 'Legendary Creature — Dragon Noble',
  oracle_text: 'Whenever you sacrifice a permanent, put a +1/+1 counter on Korvold and draw a card.',
  cmc: 5,
}

describe('BuildAssistant', () => {
  it('imports and exposes the component', async () => {
    const mod = await import('./BuildAssistant')
    expect(typeof mod.BuildAssistant).toBe('function')
  })

  it('mounts without a commander and asks for one', async () => {
    const { BuildAssistant } = await import('./BuildAssistant')
    render(<BuildAssistant userId="u1" commander={null} deckCards={[]} onClose={() => {}} />)
    // Whatever the empty state says, mounting must not throw and must render.
    expect(document.body.textContent.trim().length).toBeGreaterThan(0)
  })

  it('mounts with a commander and a deck', async () => {
    const { BuildAssistant } = await import('./BuildAssistant')
    const deckCards = [
      { id: 'cmd', name: COMMANDER.name, is_commander: true, qty: 1 },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `c${i}`, name: `Card ${i}`, qty: 1, cmc: i % 6,
        type_line: 'Creature — Human', oracle_text: 'Sacrifice a creature: draw a card.',
      })),
    ]
    render(
      <BuildAssistant
        userId="u1"
        commander={COMMANDER}
        deckCards={deckCards}
        onClose={() => {}}
        onAddCard={() => {}}
        onAddCards={() => {}}
        onRemoveCard={() => {}}
        onRemoveCards={() => {}}
      />,
    )
    expect(await screen.findByText(/build|assistant|commander|loading/i, {}, { timeout: 3000 })).toBeTruthy()
  })
})
