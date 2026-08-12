// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider, useToast, formatToastMessage } from './ToastContext'

afterEach(cleanup)

function ActionToastHarness({ onUndo }) {
  const { showToast } = useToast()
  return (
    <button
      type="button"
      onClick={() => showToast('Removed Sol Ring.', {
        actionLabel: 'Undo',
        onAction: onUndo,
        duration: 6500,
      })}
    >
      Remove
    </button>
  )
}

describe('ToastProvider actions', () => {
  it('runs the action and dismisses the toast', () => {
    const onUndo = vi.fn()
    render(
      <ToastProvider>
        <ActionToastHarness onUndo={onUndo} />
      </ToastProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(onUndo).toHaveBeenCalledOnce()
    expect(screen.queryByText('Removed Sol Ring.')).toBeNull()
  })

  it('allows explicit dismissal of an actionable toast', () => {
    render(
      <ToastProvider>
        <ActionToastHarness onUndo={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText('Removed Sol Ring.')).toBeNull()
  })

  // Bottom-bar clearance is deliberately NOT a per-toast option — it comes from
  // whichever bar is mounted. See bottomBarClearance.test.js.
  it('takes no placement option', () => {
    render(
      <ToastProvider>
        <ActionToastHarness onUndo={vi.fn()} />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(screen.getByRole('status').className).not.toMatch(/raised|above-/i)
  })
})

describe('formatToastMessage', () => {
  it('finishes an unpunctuated message with a full stop', () => {
    expect(formatToastMessage('Profile saved')).toBe('Profile saved.')
  })

  it('leaves a message that already ends in terminal punctuation alone', () => {
    // Idempotent, so a call site whose literal reads as a finished sentence
    // does not end up with two stops.
    expect(formatToastMessage('Deck renamed.')).toBe('Deck renamed.')
    expect(formatToastMessage('Really?')).toBe('Really?')
    expect(formatToastMessage('Done!')).toBe('Done!')
    expect(formatToastMessage('Loading…')).toBe('Loading…')
  })

  it('does not double-punctuate an interpolated error that came punctuated', () => {
    // The whole reason this is centralized: what a thrown error ends with is
    // not knowable at the call site.
    expect(formatToastMessage('Rename failed: duplicate key.')).toBe('Rename failed: duplicate key.')
    expect(formatToastMessage('Rename failed: duplicate key')).toBe('Rename failed: duplicate key.')
  })

  it('trims trailing whitespace before deciding', () => {
    expect(formatToastMessage('Saved 3 cards to Rares  ')).toBe('Saved 3 cards to Rares.')
    expect(formatToastMessage('Saved. ')).toBe('Saved.')
  })

  it('punctuates after a closing quote or bracket', () => {
    expect(formatToastMessage('Created "Vault"')).toBe('Created "Vault".')
    expect(formatToastMessage('Saved (3 cards)')).toBe('Saved (3 cards).')
  })

  it('leaves empty and non-string input alone rather than emitting a bare dot', () => {
    expect(formatToastMessage('')).toBe('')
    expect(formatToastMessage('   ')).toBe('')
    expect(formatToastMessage(null)).toBe('')
    expect(formatToastMessage(undefined)).toBe('')
  })
})

describe('ToastProvider copy', () => {
  function Harness({ message }) {
    const { showToast } = useToast()
    return <button type="button" onClick={() => showToast(message)}>Fire</button>
  }

  it('renders the house-style message, not the raw literal', () => {
    render(
      <ToastProvider>
        <Harness message="Profile saved" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Fire' }))
    expect(screen.getByText('Profile saved.')).toBeTruthy()
  })

  it('shows nothing for a whitespace-only message', () => {
    render(
      <ToastProvider>
        <Harness message="   " />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Fire' }))
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).toBeNull()
  })
})
