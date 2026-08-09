import { describe, it, expect } from 'vitest'
import { getDiscardModel } from './discardPrompt'

describe('getDiscardModel', () => {
  it('stays out of the way when nothing would be lost', () => {
    expect(getDiscardModel({ subject: 'this deck setup', hasWork: false }).needsConfirm).toBe(false)
    expect(getDiscardModel().needsConfirm).toBe(false)
  })

  it('needs a subject to be worth asking about', () => {
    // Without one the message would read "Discard undefined?".
    expect(getDiscardModel({ hasWork: true }).needsConfirm).toBe(false)
  })

  it('names what is being discarded', () => {
    const model = getDiscardModel({ subject: 'this deck setup', hasWork: true })
    expect(model.message).toBe("Discard this deck setup? It hasn't been saved.")
    expect(model.discardVariant).toBe('danger')
  })

  it('lets the caller phrase the way out', () => {
    expect(getDiscardModel({ subject: 'x', hasWork: true }).keepLabel).toBe('Keep editing')
    expect(getDiscardModel({ subject: 'x', hasWork: true, keepLabel: 'Keep reviewing' }).keepLabel)
      .toBe('Keep reviewing')
  })
})
