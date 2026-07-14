import { describe, expect, it } from 'vitest'
import { getDiscardDialogModel } from './addCardDiscard'

describe('getDiscardDialogModel', () => {
  it('describes a queued-card discard with correct pluralization', () => {
    expect(getDiscardDialogModel({ queueCount: 2, hasProgress: true })).toEqual({
      message: "Discard 2 queued cards? This can't be undone.",
      keepLabel: 'Keep editing',
      discardLabel: 'Discard queue',
      discardVariant: 'danger',
    })
  })

  it('uses the singular label for one queued card', () => {
    expect(getDiscardDialogModel({ queueCount: 1, hasProgress: true }).message)
      .toBe("Discard 1 queued card? This can't be undone.")
  })

  it('describes an in-progress card when the queue is empty', () => {
    expect(getDiscardDialogModel({ queueCount: 0, hasProgress: true })).toEqual({
      message: "Discard your in-progress card? This can't be undone.",
      keepLabel: 'Keep editing',
      discardLabel: 'Discard',
      discardVariant: 'danger',
    })
  })

  it('preserves the untouched-modal close confirmation', () => {
    expect(getDiscardDialogModel({ queueCount: 0, hasProgress: false })).toEqual({
      message: 'Close without adding a card?',
      keepLabel: 'Cancel',
      discardLabel: 'Close',
      discardVariant: 'default',
    })
  })
})
