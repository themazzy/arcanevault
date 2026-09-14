/**
 * Background price-alert check.
 *
 * Runs in @capacitor/background-runner's own JS context — NOT the WebView. It
 * has no DOM, no IndexedDB and no access to app code, only `CapacitorKV`,
 * `CapacitorNotifications` and `fetch`. Everything it needs is therefore
 * mirrored into KV by src/lib/backgroundAlerts.js while the app is open.
 *
 * It reads card_price_moves directly with the anon key, which works because
 * that table is deliberately public reference data — no session, no refresh
 * token, nothing to expire in a context that may not run for days.
 *
 * WHY A WATCHLIST RATHER THAN THE WHOLE COLLECTION: the KV store is backed by
 * SharedPreferences and this collection has 12,359 distinct printings. Only the
 * ones that could plausibly clear the money threshold are mirrored — measured
 * 2026-09-14, 3,651 of them are worth 0.50 or more — which is a 70% cut for no
 * loss, since a card has to be worth roughly the threshold to move by it.
 *
 * This file is plain JS in public/ so Vite copies it verbatim; it is never part
 * of the module graph and must not import anything.
 */

addEventListener('checkPriceMoves', async (resolve, reject) => {
  try {
    const cfg = readConfig()
    if (!cfg) return resolve()

    const cutoff = isoDaysAgo(cfg.days)
    const moves = await fetchMoves(cfg, cutoff)
    if (!moves.length) return resolve()

    const fresh = []
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]
      if (m.currency !== cfg.currency) continue
      if (Math.abs(m.pct) < cfg.minPct) continue
      if (Math.abs(m.delta) < cfg.minValue) continue
      if (!cfg.watch.has(watchKey(m.scryfall_id, m.finish))) continue

      const key = 'price:' + m.scryfall_id + ':' + m.move_date + ':' + m.finish
      if (cfg.seen.has(key)) continue
      fresh.push({ key: key, move: m })
    }
    if (!fresh.length) return resolve()

    notify(fresh, cfg.symbol)
    remember(cfg.seen, fresh)
    resolve()
  } catch (err) {
    // Rejecting marks the task failed and Android may back off scheduling it.
    // A transient network failure should just wait for the next window.
    resolve()
  }
})

function readConfig() {
  const url = kv('bgUrl')
  const key = kv('bgKey')
  const watch = kv('bgWatch')
  if (!url || !key || !watch) return null

  return {
    url: url,
    key: key,
    currency: kv('bgCurrency') || 'eur',
    symbol: kv('bgSymbol') || '€',
    minPct: Number(kv('bgMinPct') || 20),
    minValue: Number(kv('bgMinValue') || 1),
    days: Number(kv('bgDays') || 7),
    watch: toSet(watch),
    seen: toSet(kv('bgSeen') || ''),
  }
}

function kv(name) {
  try {
    const entry = CapacitorKV.get(name)
    return entry && entry.value ? entry.value : ''
  } catch (e) {
    return ''
  }
}

function toSet(blob) {
  const set = new Set()
  const parts = String(blob).split('\n')
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) set.add(parts[i])
  }
  return set
}

/** Must match watchKey() in src/lib/backgroundAlerts.js. */
function watchKey(scryfallId, finish) {
  return String(scryfallId).slice(0, 16) + (finish === 'foil' ? 'f' : 'n')
}

function isoDaysAgo(days) {
  const ms = Date.now() - (Math.max(1, days) - 1) * 86400000
  return new Date(ms).toISOString().slice(0, 10)
}

async function fetchMoves(cfg, cutoff) {
  const endpoint = cfg.url
    + '/rest/v1/card_price_moves'
    + '?select=scryfall_id,move_date,currency,finish,price_to,delta,pct'
    + '&move_date=gte.' + cutoff
  const res = await fetch(endpoint, {
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
  })
  if (!res.ok) return []
  const body = await res.json()
  return Array.isArray(body) ? body : []
}

function notify(fresh, symbol) {
  const first = fresh[0].move
  const rose = first.delta > 0
  const money = v => symbol + Math.abs(v).toFixed(2)

  const title = fresh.length === 1
    ? 'A card you own ' + (rose ? 'rose ' : 'fell ') + Math.abs(first.pct).toFixed(0) + '%'
    : fresh.length + ' cards moved in price'

  // The runner has no card names — card_prints is a separate query and this
  // context is meant to be cheap — so the body leads with the figure and the
  // app supplies names when it is opened.
  const body = fresh.length === 1
    ? (rose ? 'Now ' : 'Down to ') + money(first.price_to)
    : 'Open DeckLoom to see which'

  CapacitorNotifications.schedule([{
    id: hash(fresh.map(f => f.key).join('|')),
    title: title,
    body: body,
    scheduleAt: new Date(Date.now() + 1000),
  }])
}

/** Keeps the seen-set from growing without bound across runs. */
function remember(seen, fresh) {
  for (let i = 0; i < fresh.length; i++) seen.add(fresh[i].key)
  const all = Array.from(seen)
  const trimmed = all.slice(Math.max(0, all.length - 400))
  try {
    CapacitorKV.set('bgSeen', trimmed.join('\n'))
  } catch (e) {
    // Losing the seen-set only risks a duplicate notification later.
  }
}

/** Deterministic 32-bit, for a stable notification id per batch. */
function hash(input) {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h << 5) - h + input.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h) % 2147483647
}
