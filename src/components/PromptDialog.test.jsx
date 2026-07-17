// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PromptDialog from './PromptDialog'

// PromptDialog was rewritten onto the Modal primitive; verify the prompt flow
// still works end to end (it previously borrowed DeckBuilder's now-deleted CSS).
describe('PromptDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const baseState = { title: 'New Category', placeholder: 'Category name', submitLabel: 'Add', resolve: () => {} }

  it('shows the title and prefilled value', () => {
    render(<PromptDialog state={{ ...baseState, initialValue: 'Ramp' }} onCancel={vi.fn()} onSubmit={vi.fn()} />)
    expect(screen.getByText('New Category')).toBeTruthy()
    expect(screen.getByRole('textbox').value).toBe('Ramp')
  })

  it('submits the trimmed value via the submit button', () => {
    const onSubmit = vi.fn()
    render(<PromptDialog state={baseState} onCancel={vi.fn()} onSubmit={onSubmit} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Removal  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(onSubmit).toHaveBeenCalledWith('Removal')
  })

  it('submits on Enter and cancels on empty submit', () => {
    const onSubmit = vi.fn(); const onCancel = vi.fn()
    render(<PromptDialog state={baseState} onCancel={onCancel} onSubmit={onSubmit} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter' })       // empty -> cancels
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Lands' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('Lands')
  })

  it('cancels via the Cancel button', () => {
    const onCancel = vi.fn()
    render(<PromptDialog state={baseState} onCancel={onCancel} onSubmit={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
