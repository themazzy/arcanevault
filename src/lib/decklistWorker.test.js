import { describe, it, expect } from 'vitest'
// Pure decklist helpers used by the deckloom-og Cloudflare Worker. Imported
// here (rather than tested in cloudflare/) because vitest's include is scoped
// to src/**, but Vite transforms the import fine.
import {
  extractDecklistDeckId,
  renderDecklistText,
} from '../../cloudflare/og-worker/decklist.js'

const DECK_ID = '4c9f5a1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b'

describe('extractDecklistDeckId', () => {
  it('reads a UUID from /api/decklist/<id>', () => {
    expect(extractDecklistDeckId(`https://deckloom.app/api/decklist/${DECK_ID}`)).toBe(DECK_ID)
  })
  it('accepts the .txt suffix', () => {
    expect(extractDecklistDeckId(`https://deckloom.app/api/decklist/${DECK_ID}.txt`)).toBe(DECK_ID)
  })
  it('rejects non-UUID ids (nothing but a UUID may reach the RPC)', () => {
    expect(extractDecklistDeckId('https://deckloom.app/api/decklist/not-a-uuid.txt')).toBe(null)
    expect(extractDecklistDeckId('https://deckloom.app/api/decklist/')).toBe(null)
    expect(extractDecklistDeckId(`https://deckloom.app/api/decklist/${DECK_ID}/extra`)).toBe(null)
    expect(extractDecklistDeckId(`https://deckloom.app/api/decklist/${DECK_ID}x.txt`)).toBe(null)
  })
  it('ignores query strings', () => {
    expect(extractDecklistDeckId(`https://deckloom.app/api/decklist/${DECK_ID}.txt?cachebust=1`)).toBe(DECK_ID)
  })
})

describe('renderDecklistText', () => {
  const row = (name, opts = {}) => ({ name, qty: 1, board: 'main', is_commander: false, ...opts })

  it('renders plain qty+name lines with commander in its own section', () => {
    const text = renderDecklistText([
      row('Sol Ring'),
      row('Arcane Signet'),
      row("Atraxa, Praetors' Voice", { is_commander: true }),
    ])
    expect(text).toBe(
      '1 Arcane Signet\n' +
      '1 Sol Ring\n' +
      '\n' +
      '// Commander\n' +
      "1 Atraxa, Praetors' Voice\n"
    )
  })

  it('merges duplicate names across printings and sums quantities', () => {
    const text = renderDecklistText([
      row('Lightning Bolt', { qty: 2 }),
      row('Lightning Bolt', { qty: 1, foil: true }),
    ])
    expect(text).toBe('3 Lightning Bolt\n')
  })

  it('puts sideboard cards under // Sideboard and omits the maybeboard', () => {
    const text = renderDecklistText([
      row('Mountain', { qty: 20 }),
      row('Pyroblast', { board: 'side', qty: 2 }),
      row('Wishclaw Talisman', { board: 'maybe' }),
    ])
    expect(text).toBe(
      '20 Mountain\n' +
      '\n' +
      '// Sideboard\n' +
      '2 Pyroblast\n'
    )
  })

  it('renders Attractions in their own supplementary section', () => {
    const text = renderDecklistText([
      row('Mountain', { qty: 20 }),
      row('Balloon Stand', { board: 'attraction' }),
    ])
    expect(text).toBe('20 Mountain\n\n// Attractions\n1 Balloon Stand\n')
  })

  it('tolerates malformed rows and empty input', () => {
    expect(renderDecklistText([])).toBe('\n')
    expect(renderDecklistText(null)).toBe('\n')
    expect(renderDecklistText([row(''), { qty: 3 }, null, row('Sol Ring', { qty: 0 })])).toBe('1 Sol Ring\n')
  })

  it('renders a commander-only deck without leading blank lines', () => {
    const text = renderDecklistText([row('Krenko, Mob Boss', { is_commander: true })])
    expect(text).toBe('// Commander\n1 Krenko, Mob Boss\n')
  })
})
