import { describe, it, expect } from 'vitest'
import { getImportDiscardModel } from './importDiscard'

describe('getImportDiscardModel', () => {
  it('lets an untouched modal close with no prompt', () => {
    expect(getImportDiscardModel().needsConfirm).toBe(false)
    expect(getImportDiscardModel({ hasText: false, reviewing: false }).needsConfirm).toBe(false)
  })

  it('guards a pasted list that has not been parsed yet', () => {
    const model = getImportDiscardModel({ hasText: true })
    expect(model.needsConfirm).toBe(true)
    expect(model.message).toMatch(/pasted/i)
    expect(model.keepLabel).toBe('Keep editing')
    expect(model.discardVariant).toBe('danger')
  })

  it('guards a review in progress and counts the matched rows', () => {
    const model = getImportDiscardModel({ reviewing: true, rowCount: 247 })
    expect(model.needsConfirm).toBe(true)
    expect(model.message).toContain('247 rows')
    expect(model.keepLabel).toBe('Keep reviewing')
  })

  it('agrees the verb with a single row', () => {
    expect(getImportDiscardModel({ reviewing: true, rowCount: 1 }).message).toContain('1 row is matched')
    expect(getImportDiscardModel({ reviewing: true, rowCount: 2 }).message).toContain('2 rows are matched')
  })

  it('still guards a review with no rows left', () => {
    const model = getImportDiscardModel({ reviewing: true, rowCount: 0 })
    expect(model.needsConfirm).toBe(true)
    expect(model.message).toMatch(/nothing has been saved/i)
  })

  it('prefers the review wording over the pasted-text wording', () => {
    const model = getImportDiscardModel({ reviewing: true, rowCount: 3, hasText: true })
    expect(model.keepLabel).toBe('Keep reviewing')
  })
})
