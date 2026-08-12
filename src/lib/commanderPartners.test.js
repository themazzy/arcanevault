import { describe, it, expect } from 'vitest'
import { detectPartnerType, legalPartnerQuery, partnerHint } from './commanderPartners'

describe('detectPartnerType', () => {
  it('detects plain Partner', () => {
    const d = detectPartnerType({ oracle_text: 'Partner (You can have two commanders if both have partner.)' })
    expect(d).toEqual({ type: 'partner', label: 'Partner' })
  })

  it('detects Partner with [name] and extracts the name', () => {
    const d = detectPartnerType({
      oracle_text: "Partner with Toothy, Imaginary Friend (When this creature enters, target opponent...)",
    })
    expect(d.type).toBe('partner-with')
    expect(d.name).toBe('Toothy, Imaginary Friend')
  })

  it('detects Friends forever', () => {
    expect(detectPartnerType({ oracle_text: 'Friends forever (You can have two commanders if both have friends forever.)' }).type)
      .toBe('friends-forever')
  })

  it('detects Choose a Background', () => {
    expect(detectPartnerType({ oracle_text: 'Choose a Background (You can have a Background as a second commander.)' }).type)
      .toBe('choose-background')
  })

  it("detects Doctor's companion", () => {
    expect(detectPartnerType({ oracle_text: "Doctor's companion (You can have two commanders if the other is the Doctor.)" }).type)
      .toBe('doctor-companion')
  })

  it('detects a Time Lord Doctor by type line', () => {
    expect(detectPartnerType({ type_line: 'Legendary Creature — Time Lord Doctor', oracle_text: 'Whenever you draw...' }).type)
      .toBe('doctor')
  })

  it('detects a restricted Partner — group', () => {
    const d = detectPartnerType({ oracle_text: 'Partner — Father & Son (This creature can partner...)' })
    expect(d.type).toBe('partner-group')
    expect(d.group).toBe('Father & Son')
  })

  it('finds the partner keyword on a back face (MDFC/transform)', () => {
    const d = detectPartnerType({
      oracle_text: 'Flying',
      card_faces: [{ oracle_text: 'Flying' }, { oracle_text: 'Partner (You can have two commanders...)' }],
    })
    expect(d.type).toBe('partner')
  })

  it('returns null for a normal commander', () => {
    expect(detectPartnerType({ oracle_text: 'When this creature dies, draw a card.' })).toBeNull()
    expect(detectPartnerType(null)).toBeNull()
  })

  it('prefers "partner with" over generic partner when both words appear', () => {
    const d = detectPartnerType({ oracle_text: 'Partner with Pako, Arcane Retriever (reminder...)' })
    expect(d.type).toBe('partner-with')
  })
})

describe('legalPartnerQuery', () => {
  it('generic partner → is:partner is:commander, format-legal, self excluded', () => {
    const q = legalPartnerQuery({ type: 'partner' }, 'Reyhan, Last of the Abzan')
    expect(q).toContain('is:partner')
    expect(q).toContain('is:commander')
    expect(q).toContain('legal:commander')
    expect(q).toContain('-!"Reyhan, Last of the Abzan"')
  })

  it('choose-background → backgrounds, not is:commander', () => {
    const q = legalPartnerQuery({ type: 'choose-background' }, 'Wilson, Refined Grizzly')
    expect(q).toContain('type:background')
    expect(q).not.toContain('is:commander')
  })

  it('doctor-companion → Time Lord Doctors', () => {
    expect(legalPartnerQuery({ type: 'doctor-companion' }, 'X')).toContain('type:"time lord doctor"')
  })

  it("doctor → cards with doctor's companion", () => {
    expect(legalPartnerQuery({ type: 'doctor' }, 'X')).toContain('oracle:"doctor\'s companion"')
  })

  it('friends forever → oracle match', () => {
    expect(legalPartnerQuery({ type: 'friends-forever' }, 'X')).toContain('oracle:"friends forever"')
  })

  it('appends a typed name filter', () => {
    const q = legalPartnerQuery({ type: 'partner' }, 'X', 'tana')
    expect(q).toContain('name:"tana"')
  })

  // Scryfall's `is:partner` means "has a partner-STYLE ability", not "has plain
  // Partner": of the 228 commanders it returns, 95 pair only inside their own
  // mechanic. Offering those to a plain Partner commander offers an illegal
  // pairing, and the random-partner dice rolled from the same pool.
  describe('plain Partner excludes the other mechanics', () => {
    const q = legalPartnerQuery({ type: 'partner' }, 'Tymna the Weaver')

    it.each([
      ['Friends forever', '-oracle:"friends forever"'],
      ["Doctor's companion", '-oracle:"doctor\'s companion"'],
      ['Time Lord Doctors', '-type:"time lord doctor"'],
      ['Choose a Background', '-oracle:"choose a background"'],
      ['typed Partner — group', '-oracle:/partner[—-]/'],
    ])('excludes %s', (_label, term) => {
      expect(q).toContain(term)
    })

    // "Partner with [name]" cards DO have plain Partner (CR 702.124b), and
    // their text carries no dash after "partner", so the typed-group exclusion
    // leaves them in the pool.
    it('keeps "Partner with" cards in the pool', () => {
      const withQ = legalPartnerQuery({ type: 'partner-with', name: 'Toothy, Imaginary Friend' }, 'Pir')
      expect(withQ).toContain('is:partner')
      expect(withQ).toContain('-oracle:/partner[—-]/')
    })
  })

  // Typed partners pair only with the same group — the reminder text is "if
  // both have THIS ability". Ellie, Brick Master has 3 legal partners, not 227.
  describe('typed Partner — group', () => {
    it('searches the group, never the generic partner pool', () => {
      const q = legalPartnerQuery({ type: 'partner-group', group: 'Survivors' }, 'Ellie, Brick Master')
      expect(q).toContain('oracle:"partner—Survivors"')
      expect(q).not.toContain('is:partner')
      expect(q).toContain('-!"Ellie, Brick Master"')
    })

    // The group comes from the card's own text, so a group we have never heard
    // of still gets a correct query with no code change.
    it.each(['Survivors', 'Character select', 'Father & son'])('handles the %s group', group => {
      expect(legalPartnerQuery({ type: 'partner-group', group }, 'X'))
        .toContain(`oracle:"partner—${group}"`)
    })
  })

  it('returns null with no descriptor', () => {
    expect(legalPartnerQuery(null, 'X')).toBeNull()
  })
})

describe('partnerHint', () => {
  it('names the suggested pairing for partner-with', () => {
    expect(partnerHint({ type: 'partner-with', name: 'Toothy' })).toContain('Toothy')
  })
  it('is empty with no descriptor', () => {
    expect(partnerHint(null)).toBe('')
  })
})
