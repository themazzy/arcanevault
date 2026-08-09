// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImportSourceStep from './ImportSourceStep'

afterEach(() => cleanup())

const renderStep = (props = {}) => {
  const onTextChange = vi.fn()
  const utils = render(
    <ImportSourceStep
      sources={['text', 'file', 'url']}
      tab="file"
      onTabChange={vi.fn()}
      text=""
      onTextChange={onTextChange}
      onUrlChange={vi.fn()}
      {...props}
    />
  )
  return { ...utils, onTextChange }
}

const drop = (file) => {
  const zone = screen.getByRole('button', { name: /Choose a file|File loaded/ })
  fireEvent.drop(zone, { dataTransfer: { files: file ? [file] : [] } })
  return zone
}

describe('the file drop target', () => {
  it('invites both a drop and a click', () => {
    renderStep()
    const zone = screen.getByRole('button', { name: /Choose a file/ })
    expect(zone.textContent).toMatch(/Drop a \.csv or \.txt here, or click to browse/)
  })

  it('reads a dropped file into the pasted text', async () => {
    const { onTextChange } = renderStep()
    drop(new File(['4 Sol Ring\n1 Island'], 'deck.txt', { type: 'text/plain' }))
    await waitFor(() => expect(onTextChange).toHaveBeenCalledWith('4 Sol Ring\n1 Island'))
  })

  it('refuses a file it cannot parse, and says which ones it takes', async () => {
    const { onTextChange } = renderStep()
    drop(new File(['nope'], 'collection.pdf', { type: 'application/pdf' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Use a .csv or .txt file.')
    expect(onTextChange).not.toHaveBeenCalled()
  })

  it('ignores a drop that carries no file', () => {
    const { onTextChange } = renderStep()
    drop(null)
    expect(onTextChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports what is loaded and stays droppable', () => {
    renderStep({ text: '4 Sol Ring\n\n1 Island' })
    const zone = screen.getByRole('button', { name: /File loaded/ })
    // Blank lines are not cards.
    expect(zone.textContent).toMatch(/2 lines ready/)
    expect(zone.textContent).toMatch(/drop another to replace it/)
  })
})

describe('the source tabs', () => {
  it('drives the sliding indicator from the active tab', () => {
    const { container } = renderStep({ tab: 'url' })
    const bar = container.querySelector('[role="tablist"]')
    expect(bar.style.getPropertyValue('--tab-count')).toBe('3')
    expect(bar.style.getPropertyValue('--tab-index')).toBe('2')
  })

  it('hides the bar when only one source is offered', () => {
    const { container } = renderStep({ sources: ['text'], tab: 'text' })
    expect(container.querySelector('[role="tablist"]')).toBeNull()
  })
})
