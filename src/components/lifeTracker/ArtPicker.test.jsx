// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const searchCardArt = vi.fn()
vi.mock('../../lib/cardSearch', () => ({
  MIN_ART_SEARCH_LENGTH: 3,
  searchCardArt: (...args) => searchCardArt(...args),
}))

const { default: ArtPicker } = await import('./ArtPicker')

const art = (key, faceName, url, isBack = false) => ({
  key, faceName, url, isBack, cardName: faceName,
})

beforeEach(() => { searchCardArt.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

const searchBox = () => screen.getByLabelText('Search card art')

const type = (value) => fireEvent.change(searchBox(), { target: { value } })

describe('styling contract', () => {
  it('gives the input a class, since SearchInput does not style it itself', () => {
    // Regression guard: SearchInput applies only the caller's className to the
    // <input>. Omitting it renders a bare white browser input with no border,
    // which looks broken but throws nothing.
    render(<ArtPicker value={null} onSelect={vi.fn()} />)
    expect(searchBox().className.trim()).not.toBe('')
  })
})

describe('searching', () => {
  it('does not search below the minimum term length', () => {
    // The search_card_art RPC needs three characters before the trigram index on
    // card_prints.name can produce candidates.
    vi.useFakeTimers()
    render(<ArtPicker value={null} onSelect={vi.fn()} />)
    type('so')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(searchCardArt).not.toHaveBeenCalled()
    expect(screen.getByText(/at least 3 characters/i)).toBeTruthy()
  })

  it('asks Supabase for distinct artworks after the debounce', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([art('1:0', 'Sol Ring', 'https://x/sol.jpg')])
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('sol ring')
    expect(searchCardArt).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(searchCardArt).toHaveBeenCalledTimes(1)
    expect(searchCardArt).toHaveBeenCalledWith('sol ring', { limit: 24 })
  })

  it('debounces a burst of typing into one request', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([])
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('sol')
    act(() => { vi.advanceTimersByTime(100) })
    type('sol r')
    act(() => { vi.advanceTimersByTime(100) })
    type('sol ri')
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(searchCardArt).toHaveBeenCalledTimes(1)
  })

  it('renders one option per artwork and reports the chosen crop', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([
      art('1:0', 'Sol Ring', 'https://x/sol.jpg'),
      art('2:0', 'Sol Ring', 'https://x/sol2.jpg'),
    ])
    const onSelect = vi.fn()
    render(<ArtPicker value={null} onSelect={onSelect} />)

    type('sol ring')
    await act(async () => { vi.advanceTimersByTime(350) })

    const options = screen.getAllByRole('button', { name: /use art from sol ring/i })
    expect(options).toHaveLength(2)
    fireEvent.click(options[1])
    expect(onSelect).toHaveBeenCalledWith('https://x/sol2.jpg', expect.objectContaining({ key: '2:0' }))
  })

  it('offers both faces of a double-faced card as separate art', async () => {
    // The RPC returns the back face as its own row; each is independently
    // pickable as a seat background.
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([
      art('9:0', 'Delver of Secrets', 'https://x/front.jpg'),
      art('9:1', 'Insectile Aberration', 'https://x/back.jpg', true),
    ])
    const onSelect = vi.fn()
    render(<ArtPicker value={null} onSelect={onSelect} />)

    type('delver')
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(screen.getByRole('button', { name: /use art from delver of secrets/i })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /use art from insectile aberration/i }))
    expect(onSelect).toHaveBeenCalledWith('https://x/back.jpg', expect.objectContaining({ isBack: true }))
  })

  it('drops a tile whose art 404s instead of showing a broken image', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([
      art('1:0', 'Live Art', 'https://x/live.jpg'),
      art('2:0', 'Dead Art', 'https://x/dead.jpg'),
    ])
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('sol ring')
    await act(async () => { vi.advanceTimersByTime(350) })

    const dead = screen.getByRole('button', { name: /use art from dead art/i }).querySelector('img')
    await act(async () => { fireEvent.error(dead) })

    expect(screen.queryByRole('button', { name: /use art from dead art/i })).toBeNull()
    expect(screen.getByRole('button', { name: /use art from live art/i })).toBeTruthy()
  })

  it('surfaces a lookup failure instead of showing an empty grid', async () => {
    vi.useFakeTimers()
    searchCardArt.mockRejectedValue(new Error('offline'))
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('sol ring')
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(screen.getByText(/could not load card art/i)).toBeTruthy()
  })

  it('says so when a real search matches nothing', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([])
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('zzzzzz')
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(screen.getByText(/no card art matches/i)).toBeTruthy()
  })

  it('ignores a slow response for a query the user has moved on from', async () => {
    vi.useFakeTimers()
    let resolveFirst
    searchCardArt
      .mockImplementationOnce(() => new Promise(r => { resolveFirst = r }))
      .mockResolvedValueOnce([art('2:0', 'Second', 'https://x/second.jpg')])

    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('first')
    await act(async () => { vi.advanceTimersByTime(350) })
    type('second')
    await act(async () => { vi.advanceTimersByTime(350) })

    // The first request lands last; its results must not replace the newer ones.
    await act(async () => { resolveFirst([art('1:0', 'First', 'https://x/first.jpg')]) })

    expect(screen.getByRole('button', { name: /use art from second/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /use art from first/i })).toBeNull()
  })

  it('clears results when the field is emptied', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([art('1:0', 'Sol Ring', 'https://x/sol.jpg')])
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('sol ring')
    await act(async () => { vi.advanceTimersByTime(350) })
    expect(screen.getByRole('button', { name: /use art from sol ring/i })).toBeTruthy()

    type('')
    expect(screen.queryByRole('button', { name: /use art from sol ring/i })).toBeNull()
  })
})

describe('current selection', () => {
  it('marks the option already in use', async () => {
    vi.useFakeTimers()
    searchCardArt.mockResolvedValue([art('1:0', 'Sol Ring', 'https://x/sol.jpg')])
    render(<ArtPicker value="https://x/sol.jpg" onSelect={vi.fn()} />)

    type('sol ring')
    await act(async () => { vi.advanceTimersByTime(350) })

    const option = screen.getByRole('button', { name: /use art from sol ring/i })
    expect(option.getAttribute('data-active')).toBe('true')
  })
})
