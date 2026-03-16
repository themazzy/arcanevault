/**
 * Foreign exchange rate layer.
 * Uses frankfurter.app — free, no API key, ECB data, updated daily.
 *
 * Rates are cached in IDB for 6 hours.
 * Falls back to a hardcoded approximate rate if fetch fails.
 */

import { getMeta, setMeta } from './db'

const CACHE_KEY    = 'fx_rates'
const CACHE_TS_KEY = 'fx_rates_updated_at'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000  // 6 hours
const FALLBACK_EUR_TO_USD = 1.08          // rough fallback

// In-memory rates for the session
let _rates = null  // e.g. { USD: 1.08, EUR: 1 } (always relative to EUR)

// ── Load from IDB ─────────────────────────────────────────────────────────────
async function loadFromIDB() {
  try {
    const ts    = await getMeta(CACHE_TS_KEY)
    const rates = await getMeta(CACHE_KEY)
    if (!rates || !ts) return null
    if (Date.now() - ts > CACHE_TTL_MS) return null
    return rates
  } catch { return null }
}

// ── Fetch fresh rates ─────────────────────────────────────────────────────────
async function fetchRates() {
  try {
    // Get EUR→USD, USD→EUR from Frankfurter
    const res = await fetch('https://api.frankfurter.app/latest?from=EUR&to=USD')
    if (!res.ok) return null
    const data = await res.json()
    const rates = { EUR: 1, ...data.rates }
    await setMeta(CACHE_KEY, rates)
    await setMeta(CACHE_TS_KEY, Date.now())
    console.log(`[FX] rates updated: EUR→USD ${rates.USD}`)
    return rates
  } catch (e) {
    console.warn('[FX] fetch failed, using fallback rate:', e.message)
    return null
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function loadFxRates() {
  if (_rates) return _rates
  const cached = await loadFromIDB()
  if (cached) { _rates = cached; return _rates }
  const fresh = await fetchRates()
  _rates = fresh || { EUR: 1, USD: FALLBACK_EUR_TO_USD }
  return _rates
}

export function getFxRates() {
  return _rates || { EUR: 1, USD: FALLBACK_EUR_TO_USD }
}

/**
 * Convert a value from one currency to another.
 * @param {number} value
 * @param {string} fromCurrency  'EUR' | 'USD' | 'TIX'
 * @param {string} toCurrency    'EUR' | 'USD'
 * @returns {number}
 */
export function convertCurrency(value, fromCurrency, toCurrency) {
  if (!value) return null
  if (fromCurrency === toCurrency) return value
  if (fromCurrency === 'TIX') return null  // MTGO tix don't convert to real money

  const rates = getFxRates()
  // All rates are relative to EUR
  const inEur  = fromCurrency === 'EUR' ? value : value / (rates[fromCurrency] || 1)
  const result = toCurrency   === 'EUR' ? inEur  : inEur * (rates[toCurrency]  || 1)
  return result
}

export async function refreshFxRates() {
  _rates = null
  const fresh = await fetchRates()
  _rates = fresh || { EUR: 1, USD: FALLBACK_EUR_TO_USD }
  return _rates
}

export function getFxAgeMs() {
  // Synchronous — reads from cached IDB meta timestamp if available
  return getMeta(CACHE_TS_KEY).then(ts => ts ? Date.now() - ts : null).catch(() => null)
}
