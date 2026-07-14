// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComboCardThumb } from './combos'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ComboCardThumb image cache', () => {
  it('restores a cached image when a thumbnail returns to an earlier card name', async () => {
    const imageByName = {
      'Ref Test Alpha': 'https://example.test/alpha.jpg',
      'Ref Test Beta': 'https://example.test/beta.jpg',
    }
    const fetchMock = vi.fn(async url => {
      const name = new URL(url).searchParams.get('exact')
      return {
        ok: true,
        json: async () => ({ image_uris: { large: imageByName[name] } }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { rerender } = render(<ComboCardThumb name="Ref Test Alpha" inDeck />)
    await waitFor(() => expect(screen.getByRole('img', { name: 'Ref Test Alpha' }).src).toBe(imageByName['Ref Test Alpha']))

    rerender(<ComboCardThumb name="Ref Test Beta" inDeck />)
    await waitFor(() => expect(screen.getByRole('img', { name: 'Ref Test Beta' }).src).toBe(imageByName['Ref Test Beta']))

    rerender(<ComboCardThumb name="Ref Test Alpha" inDeck />)
    await waitFor(() => expect(screen.getByRole('img', { name: 'Ref Test Alpha' }).src).toBe(imageByName['Ref Test Alpha']))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('retries a failed image request on a later mount', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, json: async () => null }))
    vi.stubGlobal('fetch', fetchMock)

    const first = render(<ComboCardThumb name="Ref Test Retry" inDeck />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    first.unmount()

    render(<ComboCardThumb name="Ref Test Retry" inDeck />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })
})
