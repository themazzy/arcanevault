// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider, useToast } from './ToastContext'

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
        placement: 'above-mobile-toolbar',
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

  it('raises an actionable toast and allows explicit dismissal', () => {
    render(
      <ToastProvider>
        <ActionToastHarness onUndo={vi.fn()} />
      </ToastProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

    expect(screen.getByRole('status').className).toContain('toastStackRaised')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByText('Removed Sol Ring.')).toBeNull()
  })
})
