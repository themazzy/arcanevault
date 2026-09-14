import { describe, it, expect } from 'vitest'
import { ALERT_DEFAULTS, alertsFor, indexOwned, parseAlertKey, windowCutoff } from './priceAlerts'

// The ingest stores movers for the whole catalogue at a floor of >=10% and
// >=0.50. Everything a given user sees is this filter, run locally against the
// collection they already have — so these are the rules that decide whether an
// alert is worth reading.

const move = (over = {}) => ({
  scryfall_id: 'sid-1',
  move_date: '2026-09-14',
  currency: 'eur',
  finish: 'normal',
  price_from: 10,
  price_to: 13,
  delta: 3,
  pct: 30,
  ...over,
})

const owned = cards => indexOwned(cards)
const ONE = [{ scryfall_id: 'sid-1', foil: false, qty: 1, name: 'Test Card' }]

describe('indexOwned', () => {
  it('keys on printing AND finish', () => {
    // A foil copy is a different price series; alerting its owner about the
    // non-foil move would be news about a card they do not hold.
    const idx = owned([
      { scryfall_id: 'sid-1', foil: false, qty: 1, name: 'A' },
      { scryfall_id: 'sid-1', foil: true, qty: 2, name: 'A' },
    ])
    expect(idx.get('sid-1:normal').qty).toBe(1)
    expect(idx.get('sid-1:foil').qty).toBe(2)
  })

  it('sums copies split across binders', () => {
    const idx = owned([
      { scryfall_id: 'sid-1', foil: false, qty: 2, name: 'A' },
      { scryfall_id: 'sid-1', foil: false, qty: 3, name: 'A' },
    ])
    expect(idx.get('sid-1:normal').qty).toBe(5)
  })

  it('ignores rows with no printing id', () => {
    expect(indexOwned([{ foil: false, qty: 1 }]).size).toBe(0)
    expect(indexOwned(null).size).toBe(0)
  })
})

describe('alertsFor', () => {
  it('reports a move on a card the user owns', () => {
    expect(alertsFor([move()], owned(ONE), ALERT_DEFAULTS)).toHaveLength(1)
  })

  it('says nothing about cards the user does not own', () => {
    expect(alertsFor([move({ scryfall_id: 'other' })], owned(ONE), ALERT_DEFAULTS)).toHaveLength(0)
  })

  it('does not alert a non-foil owner about the foil move', () => {
    expect(alertsFor([move({ finish: 'foil' })], owned(ONE), ALERT_DEFAULTS)).toHaveLength(0)
  })

  it('respects the percentage threshold', () => {
    const small = move({ price_to: 11.5, delta: 1.5, pct: 15 })
    expect(alertsFor([small], owned(ONE), { ...ALERT_DEFAULTS, price_alert_pct: 20 })).toHaveLength(0)
    expect(alertsFor([small], owned(ONE), { ...ALERT_DEFAULTS, price_alert_pct: 10 })).toHaveLength(1)
  })

  it('respects the money threshold, which is what stops penny-card noise', () => {
    // 2c -> 3c is +50% and no information. 6,751 printings cleared 10% on one
    // measured day; only 60 also cleared 0.50.
    const penny = move({ price_from: 0.02, price_to: 0.03, delta: 0.01, pct: 50 })
    expect(alertsFor([penny], owned(ONE), ALERT_DEFAULTS)).toHaveLength(0)
  })

  it('reports drops as well as rises', () => {
    const drop = move({ price_to: 7, delta: -3, pct: -30 })
    const [alert] = alertsFor([drop], owned(ONE), ALERT_DEFAULTS)
    expect(alert.delta).toBe(-3)
  })

  it('only reads the currency matching the price source', () => {
    // A Cardmarket user has no use for a dollar move, and counting both would
    // double every alert for a card priced by two marketplaces.
    const both = [move(), move({ currency: 'usd', delta: 4, pct: 40 })]
    expect(alertsFor(both, owned(ONE), ALERT_DEFAULTS, 'cardmarket_trend')).toHaveLength(1)
    expect(alertsFor(both, owned(ONE), ALERT_DEFAULTS, 'cardmarket_trend')[0].currency).toBe('eur')
    expect(alertsFor(both, owned(ONE), ALERT_DEFAULTS, 'tcgplayer_market')[0].currency).toBe('usd')
  })

  it('scales the move by how many copies are held', () => {
    const four = owned([{ scryfall_id: 'sid-1', foil: false, qty: 4, name: 'A' }])
    expect(alertsFor([move()], four, ALERT_DEFAULTS)[0].holdingDelta).toBe(12)
  })

  it('ranks by effect on the collection, not by percentage', () => {
    // 12% on four copies of a staple beats 40% on one bulk rare.
    const staple = move({ scryfall_id: 'staple', price_from: 25, price_to: 28, delta: 3, pct: 12 })
    const bulk = move({ scryfall_id: 'bulk', price_from: 5, price_to: 7, delta: 2, pct: 40 })
    const idx = owned([
      { scryfall_id: 'staple', foil: false, qty: 4, name: 'Staple' },
      { scryfall_id: 'bulk', foil: false, qty: 1, name: 'Bulk' },
    ])
    expect(alertsFor([bulk, staple], idx, { ...ALERT_DEFAULTS, price_alert_pct: 10 })
      .map(a => a.scryfall_id)).toEqual(['staple', 'bulk'])
  })

  it('gives each alert a key that dedupes per card per day', () => {
    const [alert] = alertsFor([move()], owned(ONE), ALERT_DEFAULTS)
    expect(alert.key).toBe('price:sid-1:2026-09-14:normal')
  })

  it('falls back to the defaults when settings are missing', () => {
    expect(alertsFor([move()], owned(ONE), {})).toHaveLength(1)
  })
})

describe('windowCutoff', () => {
  const now = new Date('2026-09-14T12:00:00Z')

  it('includes today for a one-day window', () => {
    expect(windowCutoff(1, now)).toBe('2026-09-14')
  })

  it('counts back inclusively', () => {
    expect(windowCutoff(7, now)).toBe('2026-09-08')
  })

  it('never asks for a zero or negative window', () => {
    expect(windowCutoff(0, now)).toBe('2026-09-14')
  })
})

// ── Deep links ──────────────────────────────────────────────────────────────
// Both the bell and the Movers panel link to /collection?card=<id>&foil=<0|1>.
// The first version omitted the finish and Collection had no handler at all, so
// clicking an alert dropped the reader on the collection with no indication of
// which card the notification had been about.

describe('parseAlertKey', () => {
  it('round-trips the key an alert is built with', () => {
    const [alert] = alertsFor([move({ finish: 'foil' })],
      indexOwned([{ scryfall_id: 'sid-1', foil: true, qty: 1, name: 'A' }]), ALERT_DEFAULTS)
    expect(parseAlertKey(alert.key)).toEqual({
      scryfall_id: 'sid-1', move_date: '2026-09-14', finish: 'foil',
    })
  })

  it('carries the finish, so a foil alert opens the foil copy', () => {
    // Owning both finishes of one printing is common, and they are separate
    // price series — landing on the wrong one misrepresents the alert.
    expect(parseAlertKey('price:sid-1:2026-09-14:foil').finish).toBe('foil')
    expect(parseAlertKey('price:sid-1:2026-09-14:normal').finish).toBe('normal')
  })

  it('returns null for anything malformed rather than throwing', () => {
    // A stale key from an older format must not break the whole bell.
    for (const bad of ['', null, 'price:sid-1', 'price:sid-1:2026-09-14:gilded', 'other:a:b:c']) {
      expect(parseAlertKey(bad)).toBe(null)
    }
  })
})
