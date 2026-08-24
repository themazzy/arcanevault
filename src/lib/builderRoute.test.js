import { describe, expect, it } from 'vitest'
import { clearNewDeckIntent, getBuilderIndexIntent, builderDeckIdFromPath } from './builderRoute'

describe('Builder index route intent', () => {
  it('opens the new-deck modal from the Home shortcut', () => {
    expect(getBuilderIndexIntent('?new=1')).toEqual({ pageTab: 'my', openNewDeck: true })
  })

  it('preserves unrelated query parameters when the modal closes', () => {
    expect(clearNewDeckIntent('?new=1&tab=browser')).toBe('?tab=browser')
  })
})

describe('Signed-out builder deck links', () => {
  const id = 'b29724b0-b79c-4cc0-b64b-dba7a5db17d8'

  it('recognises a shared builder deck URL', () => {
    expect(builderDeckIdFromPath(`/builder/${id}`)).toBe(id)
    expect(builderDeckIdFromPath(`/builder/${id}/`)).toBe(id)
    expect(builderDeckIdFromPath(`/builder/${id.toUpperCase()}`)).toBe(id.toUpperCase())
  })

  it('leaves every other private route on the login gate', () => {
    expect(builderDeckIdFromPath('/builder')).toBeNull()
    expect(builderDeckIdFromPath(`/builder/${id}/playtest`)).toBeNull()
    expect(builderDeckIdFromPath('/builder/not-a-uuid')).toBeNull()
    expect(builderDeckIdFromPath('/collection')).toBeNull()
    expect(builderDeckIdFromPath('')).toBeNull()
  })
})
