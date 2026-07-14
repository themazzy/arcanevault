// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useComboCardImage } from './useComboCardImage'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useComboCardImage', () => {
  it('keeps images keyed to the requested card when names change', async () => {
    const images = {
      'Deck View Alpha': 'https://example.test/alpha.jpg',
      'Deck View Beta': 'https://example.test/beta.jpg',
    }
    const fetchMock = vi.fn(async url => {
      const name = new URL(url).searchParams.get('exact')
      return {
        ok: true,
        json: async () => ({ image_uris: { normal: images[name] } }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result, rerender } = renderHook(
      ({ name }) => useComboCardImage(name, null),
      { initialProps: { name: 'Deck View Alpha' } },
    )
    await waitFor(() => expect(result.current).toBe(images['Deck View Alpha']))

    rerender({ name: 'Deck View Beta' })
    await waitFor(() => expect(result.current).toBe(images['Deck View Beta']))

    rerender({ name: 'Deck View Alpha' })
    await waitFor(() => expect(result.current).toBe(images['Deck View Alpha']))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
