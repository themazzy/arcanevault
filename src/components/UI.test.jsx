// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmModal, Modal, ResponsiveMenu } from './UI'

describe('shared UI ref-sensitive behavior', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('Modal Escape handling uses the latest close callback and setting', () => {
    const firstClose = vi.fn()
    const latestClose = vi.fn()
    const { rerender } = render(
      <Modal onClose={firstClose} closeOnEscape>
        <button type="button">Inside</button>
      </Modal>,
    )

    rerender(
      <Modal onClose={latestClose} closeOnEscape={false}>
        <button type="button">Inside</button>
      </Modal>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(firstClose).not.toHaveBeenCalled()
    expect(latestClose).not.toHaveBeenCalled()

    rerender(
      <Modal onClose={latestClose} closeOnEscape>
        <button type="button">Inside</button>
      </Modal>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(latestClose).toHaveBeenCalledOnce()
  })

  it('ResponsiveMenu closes from the non-passive touch backdrop handler', () => {
    vi.useFakeTimers()
    render(
      <ResponsiveMenu
        title="Test menu"
        trigger={({ toggle }) => <button onClick={toggle}>Open test menu</button>}
      >
        {({ close }) => <button onClick={close}>Menu action</button>}
      </ResponsiveMenu>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open test menu' }))
    const backdrop = screen.getByRole('button', { name: 'Close Test menu' })
    fireEvent.touchStart(backdrop)

    act(() => {
      vi.advanceTimersByTime(220)
    })
    expect(screen.queryByRole('button', { name: 'Menu action' })).toBe(null)
  })
})

// ConfirmModal replaced window.confirm() and two hand-rolled overlays. Its
// promise-based callers (Builder/DeckBuilder) resolve false on cancel and true
// on confirm, so both paths must fire exactly once.
describe('ConfirmModal', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      disconnect() {}
    })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('fires onConfirm and onClose from their own buttons', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(<ConfirmModal message="Delete it?" onConfirm={onConfirm} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('omits the heading when title is null', () => {
    // Builder/DeckBuilder pass title={null} — their dialogs are message-only.
    const { container } = render(<ConfirmModal title={null} message="No heading" onConfirm={vi.fn()} onClose={vi.fn()} />)
    expect(container.querySelector('h3')).toBe(null)
    expect(screen.getByText('No heading')).toBeTruthy()
  })

  it('renders a node message without nesting <p> inside <p>', () => {
    render(
      <ConfirmModal
        title={null}
        message={['one', 'two'].map((p, i) => <p key={i}>{p}</p>)}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    )
    // Invalid nesting would make the browser/jsdom re-parent these.
    expect(screen.getByText('one').closest('p').parentElement.tagName).toBe('DIV')
    expect(screen.getByText('two')).toBeTruthy()
  })

  it('disables both actions while busy', () => {
    render(<ConfirmModal message="x" busy onConfirm={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Working…' }).disabled).toBe(true)
  })
})
