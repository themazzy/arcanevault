import { describe, expect, it, vi } from 'vitest'
import { commitFolderRename } from './folderRename'

function harness(overrides = {}) {
  const calls = { names: [] }
  const setName = vi.fn(n => calls.names.push(n))
  const rename = vi.fn(async () => {})
  const invalidate = vi.fn()
  const notifySuccess = vi.fn()
  const notifyError = vi.fn()

  const run = (args = {}) => commitFolderRename({
    folderId: 'f1',
    currentName: 'Old Deck',
    nextName: 'New Deck',
    rename,
    setName,
    invalidate,
    notifySuccess,
    notifyError,
    ...overrides,
    ...args,
  })

  return { run, setName, rename, invalidate, notifySuccess, notifyError, calls }
}

describe('commitFolderRename', () => {
  it('writes the trimmed name and refreshes the folders cache', async () => {
    const h = harness()
    expect(await h.run({ nextName: '  New Deck  ' })).toBe('renamed')

    expect(h.rename).toHaveBeenCalledWith('f1', 'New Deck')
    expect(h.setName).toHaveBeenCalledWith('New Deck')
    expect(h.invalidate).toHaveBeenCalledTimes(1)
    expect(h.notifySuccess).toHaveBeenCalledWith('New Deck')
    expect(h.notifyError).not.toHaveBeenCalled()
  })

  it('updates the title before the write returns, not after', async () => {
    // The rename feels instant because the local name is set optimistically.
    // If this ever became await-then-set, the title would lag the round trip.
    const order = []
    const h = harness({
      setName: vi.fn(() => order.push('setName')),
      rename: vi.fn(async () => { order.push('rename') }),
    })
    await h.run()
    expect(order).toEqual(['setName', 'rename'])
  })

  it('invalidates only after a successful write', async () => {
    const order = []
    const h = harness({
      rename: vi.fn(async () => { order.push('rename') }),
      invalidate: vi.fn(() => order.push('invalidate')),
    })
    await h.run()
    expect(order).toEqual(['rename', 'invalidate'])
  })

  describe('does nothing worth doing', () => {
    it.each([
      ['an unchanged name', { nextName: 'Old Deck' }],
      ['a name that only differs by surrounding space', { nextName: '  Old Deck  ' }],
      ['an empty name', { nextName: '' }],
      ['a whitespace-only name', { nextName: '   ' }],
      ['a null name', { nextName: null }],
      ['no folder id', { folderId: null }],
    ])('skips %s', async (_label, args) => {
      const h = harness()
      expect(await h.run(args)).toBe('skipped')

      expect(h.rename).not.toHaveBeenCalled()
      expect(h.setName).not.toHaveBeenCalled()
      expect(h.invalidate).not.toHaveBeenCalled()
      expect(h.notifySuccess).not.toHaveBeenCalled()
    })
  })

  describe('when the write fails', () => {
    const boom = () => Promise.reject(new Error('duplicate name'))

    it('puts the old name back', async () => {
      const h = harness({ rename: vi.fn(boom) })
      expect(await h.run()).toBe('failed')
      expect(h.calls.names).toEqual(['New Deck', 'Old Deck'])
    })

    it('does not invalidate or claim success', async () => {
      const h = harness({ rename: vi.fn(boom) })
      await h.run()
      expect(h.invalidate).not.toHaveBeenCalled()
      expect(h.notifySuccess).not.toHaveBeenCalled()
    })

    it('surfaces the server message, and falls back when there is none', async () => {
      const withMessage = harness({ rename: vi.fn(boom) })
      await withMessage.run()
      expect(withMessage.notifyError).toHaveBeenCalledWith('duplicate name')

      const bare = harness({ rename: vi.fn(() => Promise.reject(new Error())) })
      await bare.run()
      expect(bare.notifyError).toHaveBeenCalledWith('Rename failed.')
    })
  })

  it('never touches a folder object, because it is never given one', async () => {
    // The bug this replaced was `folder.name = trimmed` on a shared prop. The
    // signature takes an id and two strings, so there is nothing to mutate —
    // this pins that shape rather than the symptom.
    const folder = Object.freeze({ id: 'f1', name: 'Old Deck' })
    const h = harness()
    expect(await h.run({ folderId: folder.id })).toBe('renamed')
    expect(folder.name).toBe('Old Deck')
  })

  it('works without the optional notifiers', async () => {
    const h = harness({ invalidate: undefined, notifySuccess: undefined, notifyError: undefined })
    await expect(h.run()).resolves.toBe('renamed')
  })
})
