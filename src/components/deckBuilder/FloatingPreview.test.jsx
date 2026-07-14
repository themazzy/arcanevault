// @vitest-environment jsdom

import { createRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FloatingPreview } from './FloatingPreview'

afterEach(cleanup)

describe('FloatingPreview', () => {
  it('uses the latest pointer position when images first become visible', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    const previewRef = createRef()
    const { container } = render(<FloatingPreview ref={previewRef} />)

    act(() => {
      previewRef.current.setPos(900, 700)
      previewRef.current.setImages(['https://example.test/card.jpg'])
    })

    expect(container.firstChild.style.left).toBe('660px')
    expect(container.firstChild.style.top).toBe(`${Math.max(16, 800 - (300 * (88 / 63)) - 16)}px`)

    act(() => {
      previewRef.current.setPos(100, 100)
    })
    expect(container.firstChild.style.left).toBe('116px')
    expect(container.firstChild.style.top).toBe('70px')

    act(() => {
      previewRef.current.clearImages()
    })
    act(() => {
      previewRef.current.setImages(['https://example.test/card-2.jpg'])
    })
    expect(container.firstChild.style.left).toBe('116px')
    expect(container.firstChild.style.top).toBe('70px')
  })
})
