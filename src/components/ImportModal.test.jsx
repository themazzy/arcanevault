// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const resolveImportEntries = vi.fn()
const fetchPaperPrintings = vi.fn()
const ensureCardPrints = vi.fn()

vi.mock('../lib/supabase', () => ({ sb: { from: () => { throw new Error('unexpected supabase call') } } }))
vi.mock('../lib/scryfall', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchScryfallBatch: vi.fn(),
  fetchScryfallNamed: vi.fn(),
}))
vi.mock('../lib/db', () => ({
  putCards: vi.fn(), putDeckAllocations: vi.fn(), putFolderCards: vi.fn(), putFolders: vi.fn(),
}))
vi.mock('../lib/wishlistSync', () => ({
  removeAcquiredFromWishlists: vi.fn(() => Promise.resolve({ removedIds: [] })),
  findOwnedCardNames: vi.fn(() => Promise.resolve(new Set())),
}))
vi.mock('../lib/cardPrints', () => ({
  ensureCardPrints: (...args) => ensureCardPrints(...args),
  getCardPrint: () => null,
  withCardPrint: (row) => row,
}))
vi.mock('../lib/deckBuilderApi', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchPaperPrintings: (...args) => fetchPaperPrintings(...args),
}))
vi.mock('../lib/importFlow', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveImportEntries: (...args) => resolveImportEntries(...args),
}))

const { default: ImportModal } = await import('./ImportModal')

const BINDER = { id: 'binder-1', name: 'Main Binder', type: 'binder', description: null }

const matchedRow = (name, overrides = {}) => ({
  name, qty: 1, foil: false, status: 'matched', exactPrinting: true,
  resolvedName: name, resolvedSetCode: 'm10', resolvedCollectorNumber: '155',
  sfCard: { id: `sf-${name}`, name, set: 'm10', collector_number: '155' },
  ...overrides,
})

/** A promise plus the handles to settle it later. */
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const renderModal = (props = {}) => render(
  <ImportModal
    userId="user-1"
    folderType="binder"
    folders={[BINDER]}
    defaultFolderId={BINDER.id}
    onClose={vi.fn()}
    onSaved={vi.fn()}
    {...props}
  />
)

const importButton = () => screen.getByRole('button', { name: /^Import \d+ cards/ })

beforeEach(() => {
  resolveImportEntries.mockReset()
  fetchPaperPrintings.mockReset()
  ensureCardPrints.mockReset()
  // Modal measures its own height; jsdom has no ResizeObserver.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('parsing the pasted text', () => {
  it('explains itself when nothing parses instead of doing nothing', () => {
    renderModal()
    // A Manabox header with no data rows behind it — parses cleanly, yields
    // nothing, and looks perfectly plausible to whoever pasted it.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Name,Set code,Quantity' } })
    fireEvent.click(screen.getByRole('button', { name: 'Parse' }))

    expect(screen.getByRole('alert').textContent).toMatch(/No cards found/i)
    // Still on the input step — nothing was silently accepted.
    expect(screen.getByRole('button', { name: 'Parse' })).toBeTruthy()
    expect(resolveImportEntries).not.toHaveBeenCalled()
  })

  it('clears the message once the text changes', () => {
    renderModal()
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'Name,Set code,Quantity' } })
    fireEvent.click(screen.getByRole('button', { name: 'Parse' }))
    expect(screen.queryByRole('alert')).toBeTruthy()

    fireEvent.change(box, { target: { value: '1 Sol Ring' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('resolving', () => {
  it('disables the per-row printing editor until matching finishes', async () => {
    const pending = deferred()
    resolveImportEntries.mockReturnValue(pending.promise)
    renderModal({ initialText: '1 Sol Ring' })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit' }).disabled).toBe(true))

    await act(async () => { pending.resolve([matchedRow('Sol Ring')]) })
    expect(screen.getByRole('button', { name: 'Edit' }).disabled).toBe(false)
    expect(fetchPaperPrintings).not.toHaveBeenCalled()
  })

  it('drops a superseded resolve so it cannot overwrite the newer parse', async () => {
    const first = deferred()
    const second = deferred()
    resolveImportEntries.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    renderModal({ initialText: '1 Sol Ring' })
    await waitFor(() => expect(resolveImportEntries).toHaveBeenCalledTimes(1))

    // Go back, paste something else, and parse again while the first run is
    // still in flight.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '1 Island' } })
    fireEvent.click(screen.getByRole('button', { name: 'Parse' }))
    await waitFor(() => expect(resolveImportEntries).toHaveBeenCalledTimes(2))

    await act(async () => { second.resolve([matchedRow('Island')]) })
    await act(async () => { first.resolve([matchedRow('Sol Ring')]) })

    expect(screen.getByText('Island')).toBeTruthy()
    expect(screen.queryByText('Sol Ring')).toBeNull()
  })
})

describe('the preview list', () => {
  const missingRow = (name) => ({
    name, qty: 1, foil: false, status: 'missing', sfCard: null,
    resolvedName: name, reason: 'No Scryfall match',
  })

  it('floats unresolved rows above clean ones', async () => {
    resolveImportEntries.mockResolvedValue([
      matchedRow('Sol Ring'), matchedRow('Island'), missingRow('Blargle Fizz'),
    ])
    renderModal({ initialText: '1 Sol Ring\n1 Island\n1 Blargle Fizz' })
    await waitFor(() => expect(importButton().disabled).toBe(false))

    const text = document.body.textContent
    expect(text.indexOf('Blargle Fizz')).toBeLessThan(text.indexOf('Sol Ring'))
  })

  it('states the outcome in one line rather than a grid of numbers', async () => {
    resolveImportEntries.mockResolvedValue([
      matchedRow('Sol Ring', { qty: 4 }), missingRow('Blargle Fizz'),
    ])
    renderModal({ initialText: '4 Sol Ring\n1 Blargle Fizz' })

    await waitFor(() =>
      expect(screen.getByText(/4 cards · 2 unique · 1 unresolved, will be skipped/)).toBeTruthy())
  })

  it('demotes a printing detail shared by every row into a footnote', async () => {
    resolveImportEntries.mockResolvedValue([matchedRow('Sol Ring'), matchedRow('Island')])
    renderModal({ initialText: '1 Sol Ring\n1 Island' })

    await waitFor(() => expect(screen.getByText(/all matched/)).toBeTruthy())
    expect(screen.getByText('exact prints')).toBeTruthy()
  })
})

describe('guarding against an accidental dismiss', () => {
  const overlayClick = () => {
    // The overlay is the dialog's parent; Modal ignores clicks that bubble from
    // inside the panel, so the event has to originate on the overlay itself.
    const overlay = document.querySelector('[role="dialog"]').parentElement
    fireEvent.click(overlay)
  }

  it('closes straight away when nothing has been typed', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    overlayClick()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks before binning a pasted list', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '4 Lightning Bolt' } })

    overlayClick()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/Discard the list you pasted/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('textbox').value).toBe('4 Lightning Bolt')
  })

  it('closes once the discard is confirmed', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '4 Lightning Bolt' } })
    overlayClick()

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('asks before binning a review, counting the matched rows', async () => {
    const onClose = vi.fn()
    resolveImportEntries.mockResolvedValue([matchedRow('Sol Ring'), matchedRow('Island')])
    renderModal({ initialText: '1 Sol Ring\n1 Island', onClose })
    await waitFor(() => expect(importButton().disabled).toBe(false))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/2 rows are matched and ready/i)).toBeTruthy()
  })
})

describe('committing the import', () => {
  it('cannot be dismissed while the write is in flight', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    resolveImportEntries.mockResolvedValue([matchedRow('Sol Ring')])
    // Hold the import open at the first write.
    ensureCardPrints.mockReturnValue(new Promise(() => {}))

    renderModal({ initialText: '1 Sol Ring', onClose, onSaved })
    await waitFor(() => expect(importButton().disabled).toBe(false))

    await act(async () => { fireEvent.click(importButton()) })
    expect(screen.getByRole('progressbar')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('runs onSaved when the finished import is dismissed with Escape', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    resolveImportEntries.mockResolvedValue([matchedRow('Sol Ring')])
    ensureCardPrints.mockRejectedValue(new Error('card_prints unavailable'))

    renderModal({ initialText: '1 Sol Ring', onClose, onSaved })
    await waitFor(() => expect(importButton().disabled).toBe(false))

    await act(async () => { fireEvent.click(importButton()) })
    await waitFor(() => expect(screen.getByText(/issue found during import/i)).toBeTruthy())

    // Escape on the done step used to close without telling the parent, so the
    // caller never invalidated its caches.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onSaved).toHaveBeenCalledWith(BINDER.id)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('runs onSaved exactly once when the Done button is used', async () => {
    const onClose = vi.fn()
    const onSaved = vi.fn()
    resolveImportEntries.mockResolvedValue([matchedRow('Sol Ring')])
    ensureCardPrints.mockRejectedValue(new Error('card_prints unavailable'))

    renderModal({ initialText: '1 Sol Ring', onClose, onSaved })
    await waitFor(() => expect(importButton().disabled).toBe(false))
    await act(async () => { fireEvent.click(importButton()) })

    const done = await screen.findByRole('button', { name: 'Done' })
    fireEvent.click(done)
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
