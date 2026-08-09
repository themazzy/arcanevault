// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DeckFilterSearchInput from './DeckFilterSearchInput'

afterEach(cleanup)

// The real host: DeckBuilder owns the committed query and feeds it back in as
// `value`. The clear bug only reproduces with that round trip, because it was
// the value-sync effect early-returning on an already-matching ref.
function Host({ onCommit }) {
  const [query, setQuery] = useState('')
  return (
    <>
      <DeckFilterSearchInput
        value={query}
        onCommit={next => { setQuery(next); onCommit?.(next) }}
      />
      <output data-testid="committed">{query}</output>
    </>
  )
}

describe('DeckFilterSearchInput', () => {
  it('clears both the committed query and the visible text when the X is pressed', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<Host onCommit={onCommit} />)

    const input = screen.getByRole('textbox', { name: 'Search cards in this deck' })
    await user.type(input, 'counter')
    await waitFor(() => expect(screen.getByTestId('committed').textContent).toBe('counter'))

    await user.click(screen.getByRole('button', { name: 'Clear search' }))

    // Both halves matter: the list unfiltering while the box kept its text was
    // the reported bug, and it looked like "clear does nothing".
    await waitFor(() => expect(screen.getByTestId('committed').textContent).toBe(''))
    expect(input.value).toBe('')
    expect(onCommit).toHaveBeenLastCalledWith('')
  })

  it('keeps the box usable after a clear', async () => {
    const user = userEvent.setup()
    render(<Host />)

    const input = screen.getByRole('textbox', { name: 'Search cards in this deck' })
    await user.type(input, 'bolt')
    await waitFor(() => expect(screen.getByTestId('committed').textContent).toBe('bolt'))
    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    await waitFor(() => expect(input.value).toBe(''))

    await user.type(input, 'ramp')
    expect(input.value).toBe('ramp')
    await waitFor(() => expect(screen.getByTestId('committed').textContent).toBe('ramp'))
  })

  it('debounces typing into a single committed query', async () => {
    const user = userEvent.setup()
    const onCommit = vi.fn()
    render(<Host onCommit={onCommit} />)

    await user.type(screen.getByRole('textbox', { name: 'Search cards in this deck' }), 'sol')
    await waitFor(() => expect(onCommit).toHaveBeenCalled())
    // Per-keystroke commits re-rendered the whole builder; that's what the
    // draft/commit split exists to prevent.
    expect(onCommit.mock.calls.length).toBeLessThan(3)
    expect(onCommit).toHaveBeenLastCalledWith('sol')
  })

  it('reflects a clear initiated by the host', async () => {
    // DeckBuilder resets the query itself when revealing a warning's card.
    function ExternalHost() {
      const [query, setQuery] = useState('counter')
      return (
        <>
          <DeckFilterSearchInput value={query} onCommit={setQuery} />
          <button onClick={() => setQuery('')}>reset</button>
        </>
      )
    }
    const user = userEvent.setup()
    render(<ExternalHost />)

    const input = screen.getByRole('textbox', { name: 'Search cards in this deck' })
    expect(input.value).toBe('counter')
    await user.click(screen.getByRole('button', { name: 'reset' }))
    await waitFor(() => expect(input.value).toBe(''))
  })
})
