// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Modal, ResponsiveMenu } from './UI'

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
