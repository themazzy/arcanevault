import { describe, it, expect, vi, beforeEach } from 'vitest'

// The phone notification is a summary, not a copy of the bell. What it says
// with one mover versus several is the whole design, so that is what is pinned.

const native = { value: true }
vi.mock('./nativeAuth', () => ({ isNativeApp: () => native.value }))

const scheduled = []
const perm = { display: 'granted' }
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: perm.display }),
    requestPermissions: async () => ({ display: perm.display }),
    createChannel: async () => {},
    schedule: async payload => { scheduled.push(payload) },
  },
}))

const { notifyPriceAlerts, nativeNotificationsSupported } = await import('./nativeNotifications')

const alert = (over = {}) => ({
  key: 'price:sid-1:2026-09-14:normal',
  scryfall_id: 'sid-1',
  name: 'Rhystic Study',
  finish: 'normal',
  price_to: 13,
  delta: 3,
  pct: 30,
  qty: 1,
  ...over,
})

const lastSent = () => scheduled[scheduled.length - 1].notifications[0]

describe('notifyPriceAlerts', () => {
  beforeEach(() => { scheduled.length = 0; native.value = true; perm.display = 'granted' })

  it('names the card when a single one moved', async () => {
    expect(await notifyPriceAlerts([alert()])).toBe(true)
    expect(lastSent().title).toBe('Rhystic Study rose 30%')
    expect(lastSent().body).toContain('€13.00')
  })

  it('summarises rather than sending one notification per card', async () => {
    // Three cards moving should be one glanceable buzz, not three.
    const many = [alert(), alert({ key: 'k2', scryfall_id: 's2', name: 'Sol Ring' }),
      alert({ key: 'k3', scryfall_id: 's3', name: 'Mana Crypt' })]
    await notifyPriceAlerts(many)
    expect(scheduled).toHaveLength(1)
    expect(lastSent().title).toBe('3 cards moved in price')
    expect(lastSent().body).toContain('Sol Ring')
  })

  it('says fell, not rose, on a drop', async () => {
    await notifyPriceAlerts([alert({ delta: -3, pct: -30, price_to: 7 })])
    expect(lastSent().title).toContain('fell')
    expect(lastSent().body).toContain('Down to')
  })

  it('uses the currency it is given', async () => {
    await notifyPriceAlerts([alert()], { symbol: '$' })
    expect(lastSent().body).toContain('$13.00')
  })

  it('carries the deep link only when there is one card to open', async () => {
    await notifyPriceAlerts([alert({ finish: 'foil' })])
    expect(lastSent().extra).toEqual({ scryfall_id: 'sid-1', finish: 'foil' })

    await notifyPriceAlerts([alert(), alert({ key: 'k2', scryfall_id: 's2' })])
    expect(lastSent().extra).toEqual({})
  })

  it('gives the same batch the same id, so a repeat replaces rather than stacks', async () => {
    await notifyPriceAlerts([alert()])
    const first = lastSent().id
    await notifyPriceAlerts([alert()])
    expect(lastSent().id).toBe(first)
    expect(Number.isInteger(first)).toBe(true)
    expect(first).toBeLessThan(2147483647)
  })

  it('stays silent on the web, where the plugin has no implementation', async () => {
    native.value = false
    expect(nativeNotificationsSupported()).toBe(false)
    expect(await notifyPriceAlerts([alert()])).toBe(false)
    expect(scheduled).toHaveLength(0)
  })

  it('stays silent when the OS permission was refused', async () => {
    perm.display = 'denied'
    expect(await notifyPriceAlerts([alert()])).toBe(false)
    expect(scheduled).toHaveLength(0)
  })

  it('does nothing for an empty batch', async () => {
    expect(await notifyPriceAlerts([])).toBe(false)
  })
})
