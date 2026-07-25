// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const searchCardArt = vi.fn()
vi.mock('../lib/cardSearch', () => ({
  MIN_ART_SEARCH_LENGTH: 3,
  searchCardArt: (...args) => searchCardArt(...args),
}))

const { default: CardArtPicker } = await import('./CardArtPicker')

const art = (key, faceName, url, isBack = false) => ({ key, faceName, url, isBack, cardName: faceName })

beforeEach(() => {
  searchCardArt.mockReset()
  // Modal measures its own height; jsdom has no ResizeObserver.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const searchBox = () => screen.getByLabelText('Search card art')
const type = (value) => fireEvent.change(searchBox(), { target: { value } })

const renderPicker = (props = {}) =>
  render(<CardArtPicker onSelect={vi.fn()} onClose={vi.fn()} {...props} />)

describe('searching', () => {
  it('does not search below the minimum term length', () => {
    vi.useFakeTimers()
    renderPicker()
    type('de')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(searchCardArt).not.toHaveBeenCalled()
    expect(screen.getByText(/at least 3 characters/i)).toBeTruthy()
  })

  it('searches after the debounce and renders each artwork', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([
      art('a:0', 'Delver of Secrets', 'https://img/front.jpg'),
      art('a:1', 'Insectile Aberration', 'https://img/back.jpg', true),
    ])
    renderPicker()
    type('delver')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    expect(searchCardArt).toHaveBeenCalledWith('delver', { limit: 24 })
    expect(screen.getByText('Delver of Secrets')).toBeTruthy()
    expect(screen.getByText('Insectile Aberration')).toBeTruthy()
  })

  it('marks the back face of a double-faced card', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([
      art('a:0', 'Delver of Secrets', 'https://img/front.jpg'),
      art('a:1', 'Insectile Aberration', 'https://img/back.jpg', true),
    ])
    renderPicker()
    type('delver')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    // Only the reverse side is badged — otherwise the two tiles look like two
    // unrelated cards that happen to share a name.
    expect(screen.getAllByText('Back')).toHaveLength(1)
  })

  it('hands the chosen art URL to onSelect', async () => {
    vi.useFakeTimers()
    const onSelect = vi.fn()
    searchCardArt.mockResolvedValue([art('a:1', 'Insectile Aberration', 'https://img/back.jpg', true)])
    renderPicker({ onSelect })
    type('delver')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    fireEvent.click(screen.getByText('Insectile Aberration').closest('button'))
    expect(onSelect).toHaveBeenCalledWith('https://img/back.jpg', expect.objectContaining({ isBack: true }))
  })
})

describe('retired printings', () => {
  it('drops a tile whose art 404s instead of showing a broken image', async () => {
    // card_prints outlives Scryfall deletions until the next sync notices, so a
    // stored art_crop_uri can 404.
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([
      art('a:0', 'Live Art', 'https://img/live.jpg'),
      art('b:0', 'Dead Art', 'https://img/dead.jpg'),
    ])
    renderPicker()
    type('delver')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    const dead = screen.getByText('Dead Art').closest('button').querySelector('img')
    await act(async () => { fireEvent.error(dead) })

    expect(screen.queryByText('Dead Art')).toBeNull()
    expect(screen.getByText('Live Art')).toBeTruthy()
  })
})

describe('failure messages', () => {
  it('says nothing matched instead of leaving the grid blank', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([])
    renderPicker()
    type('qqqzzz')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(screen.getByText(/no card art matches/i)).toBeTruthy()
  })

  it('reports a lookup failure separately from an empty result', async () => {
    vi.useFakeTimers()
    searchCardArt.mockRejectedValue(new Error('offline'))
    renderPicker()
    type('delver')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(screen.getByText(/could not load card art/i)).toBeTruthy()
  })

  it('clears results and messages when the term is emptied', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([art('a:0', 'Delver of Secrets', 'https://img/front.jpg')])
    renderPicker()
    type('delver')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(screen.getByText('Delver of Secrets')).toBeTruthy()

    type('')
    expect(screen.queryByText('Delver of Secrets')).toBeNull()
  })
})

describe('out-of-order responses', () => {
  it('ignores a slow response for a term the user has moved on from', async () => {
    vi.useFakeTimers()
    let resolveFirst
    searchCardArt
      .mockImplementationOnce(() => new Promise(res => { resolveFirst = res }))
      .mockResolvedValueOnce([art('b:0', 'Bolt Bend', 'https://img/bolt.jpg')])

    renderPicker()
    type('delver')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    type('bolt bend')
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })

    await act(async () => {
      resolveFirst([art('a:0', 'Delver of Secrets', 'https://img/front.jpg')])
    })

    expect(screen.getByText('Bolt Bend')).toBeTruthy()
    expect(screen.queryByText('Delver of Secrets')).toBeNull()
  })
})
