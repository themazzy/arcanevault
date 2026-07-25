// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sfGet = vi.fn()
vi.mock('../../lib/scryfall', () => ({ sfGet: (...args) => sfGet(...args) }))

const { default: ArtPicker } = await import('./ArtPicker')

const card = (id, name, art) => ({ id, name, image_uris: { art_crop: art } })

beforeEach(() => { sfGet.mockReset() })
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
  it('does not search on a single character', () => {
    vi.useFakeTimers()
    render(<ArtPicker value={null} onSelect={vi.fn()} />)
    type('s')
    act(() => { vi.advanceTimersByTime(1000) })
    expect(sfGet).not.toHaveBeenCalled()
  })

  it('asks Scryfall for distinct artworks after the debounce', async () => {
    vi.useFakeTimers()
    sfGet.mockResolvedValue({ data: [card('1', 'Sol Ring', 'https://x/sol.jpg')] })
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('sol ring')
    expect(sfGet).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(sfGet).toHaveBeenCalledTimes(1)
    const url = sfGet.mock.calls[0][0]
    expect(url).toContain('unique=art')
    expect(url).toContain(encodeURIComponent('sol ring'))
  })

  it('debounces a burst of typing into one request', async () => {
    vi.useFakeTimers()
    sfGet.mockResolvedValue({ data: [] })
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('so')
    act(() => { vi.advanceTimersByTime(100) })
    type('sol')
    act(() => { vi.advanceTimersByTime(100) })
    type('sol r')
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(sfGet).toHaveBeenCalledTimes(1)
  })

  it('renders one option per artwork and reports the chosen crop', async () => {
    vi.useFakeTimers()
    sfGet.mockResolvedValue({
      data: [card('1', 'Sol Ring', 'https://x/sol.jpg'), card('2', 'Sol Ring', 'https://x/sol2.jpg')],
    })
    const onSelect = vi.fn()
    render(<ArtPicker value={null} onSelect={onSelect} />)

    type('sol ring')
    await act(async () => { vi.advanceTimersByTime(350) })

    const options = screen.getAllByRole('button', { name: /use art from sol ring/i })
    expect(options).toHaveLength(2)
    fireEvent.click(options[1])
    expect(onSelect).toHaveBeenCalledWith('https://x/sol2.jpg', expect.objectContaining({ id: '2' }))
  })

  it('reads art off the front face of a double-faced card', async () => {
    vi.useFakeTimers()
    sfGet.mockResolvedValue({
      data: [{
        id: '9', name: 'Delver of Secrets',
        card_faces: [{ image_uris: { art_crop: 'https://x/front.jpg' } }, { image_uris: {} }],
      }],
    })
    const onSelect = vi.fn()
    render(<ArtPicker value={null} onSelect={onSelect} />)

    type('delver')
    await act(async () => { vi.advanceTimersByTime(350) })

    fireEvent.click(screen.getByRole('button', { name: /use art from delver of secrets/i }))
    expect(onSelect).toHaveBeenCalledWith('https://x/front.jpg', expect.anything())
  })

  it('drops cards with no art rather than rendering a broken tile', async () => {
    vi.useFakeTimers()
    sfGet.mockResolvedValue({
      data: [{ id: '1', name: 'No Art' }, card('2', 'Has Art', 'https://x/a.jpg')],
    })
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('thing')
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(screen.queryByRole('button', { name: /use art from no art/i })).toBeNull()
    expect(screen.getByRole('button', { name: /use art from has art/i })).toBeTruthy()
  })

  it('surfaces a reachability failure instead of showing an empty grid', async () => {
    vi.useFakeTimers()
    sfGet.mockResolvedValue(null)
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('sol ring')
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(screen.getByText(/could not reach scryfall/i)).toBeTruthy()
  })

  it('says so when a real search matches nothing', async () => {
    vi.useFakeTimers()
    sfGet.mockResolvedValue({ data: [] })
    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('zzzzzz')
    await act(async () => { vi.advanceTimersByTime(350) })

    expect(screen.getByText(/no card art matches/i)).toBeTruthy()
  })

  it('ignores a slow response for a query the user has moved on from', async () => {
    vi.useFakeTimers()
    let resolveFirst
    sfGet
      .mockImplementationOnce(() => new Promise(r => { resolveFirst = r }))
      .mockResolvedValueOnce({ data: [card('2', 'Second', 'https://x/second.jpg')] })

    render(<ArtPicker value={null} onSelect={vi.fn()} />)

    type('first')
    await act(async () => { vi.advanceTimersByTime(350) })
    type('second')
    await act(async () => { vi.advanceTimersByTime(350) })

    // The first request lands last; its results must not replace the newer ones.
    await act(async () => { resolveFirst({ data: [card('1', 'First', 'https://x/first.jpg')] }) })

    expect(screen.getByRole('button', { name: /use art from second/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /use art from first/i })).toBeNull()
  })

  it('clears results when the field is emptied', async () => {
    vi.useFakeTimers()
    sfGet.mockResolvedValue({ data: [card('1', 'Sol Ring', 'https://x/sol.jpg')] })
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
    sfGet.mockResolvedValue({ data: [card('1', 'Sol Ring', 'https://x/sol.jpg')] })
    render(<ArtPicker value="https://x/sol.jpg" onSelect={vi.fn()} />)

    type('sol ring')
    await act(async () => { vi.advanceTimersByTime(350) })

    const option = screen.getByRole('button', { name: /use art from sol ring/i })
    expect(option.getAttribute('data-active')).toBe('true')
  })
})
