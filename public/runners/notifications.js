/**
 * Background notification check.
 *
 * Runs in @capacitor/background-runner's own JS context — NOT the WebView. It
 * has no DOM, no IndexedDB and no access to app code, only `CapacitorKV`,
 * `CapacitorNotifications` and `fetch`. Everything it needs is mirrored into KV
 * by src/lib/backgroundAlerts.js while the app is open.
 *
 * It covers the two families that can occur while the app is CLOSED:
 *
 *   price moves  — read from card_price_moves, which is public reference data,
 *                  so the anon key alone is enough.
 *   social       — likes, comments, follows and trade activity, written by
 *                  server triggers. These live behind RLS, so they come from
 *                  get_notification_digest(device key), which resolves the key
 *                  to its owner. The runner deliberately holds NO session: an
 *                  access token expires within the hour, and refreshing one
 *                  independently would rotate the refresh token and could sign
 *                  the user out of the app itself.
 *
 * milestones, announcements and price alerts written by the app are excluded by
 * the digest — those only exist because the app was running and already showed
 * them.
 *
 * Plain JS in public/ so Vite copies it verbatim. It is never part of the module
 * graph and must not import anything.
 */

addEventListener('checkNotifications', async (resolve) => {
  try {
    const cfg = readConfig()
    if (!cfg) return resolve()

    const priced = await findPriceMoves(cfg)
    const social = await findSocial(cfg)
    if (!priced.length && !social.length) return resolve()

    notify(priced, social, cfg.symbol)

    if (priced.length) remember(cfg.seen, priced)
    if (social.length) setKV('bgSince', social[0].created_at)
    resolve()
  } catch (e) {
    // Resolve, never reject: a rejected task tells Android the work failed and
    // it may back the schedule off. A flaky network should simply wait for the
    // next window.
    resolve()
  }
})

function readConfig() {
  const url = kv('bgUrl')
  const key = kv('bgKey')
  // A watchlist is optional: someone with no cards still wants to hear about a
  // comment on their deck.
  if (!url || !key) return null

  return {
    url: url,
    key: key,
    currency: kv('bgCurrency') || 'eur',
    symbol: kv('bgSymbol') || '€',
    minPct: Number(kv('bgMinPct') || 20),
    minValue: Number(kv('bgMinValue') || 1),
    days: Number(kv('bgDays') || 7),
    notifyKey: kv('bgNotifyKey'),
    since: kv('bgSince'),
    watch: toSet(kv('bgWatch')),
    seen: toSet(kv('bgSeen')),
  }
}

async function findPriceMoves(cfg) {
  if (!cfg.watch.size) return []

  const endpoint = cfg.url
    + '/rest/v1/card_price_moves'
    + '?select=scryfall_id,move_date,currency,finish,price_to,delta,pct'
    + '&move_date=gte.' + isoDaysAgo(cfg.days)

  const moves = await getJson(endpoint, { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key })
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
  return fresh
}

async function findSocial(cfg) {
  if (!cfg.notifyKey) return []

  const res = await fetch(cfg.url + '/rest/v1/rpc/get_notification_digest', {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_key: cfg.notifyKey, p_since: cfg.since || null }),
  })
  if (!res.ok) return []
  const rows = await res.json()
  return Array.isArray(rows) ? rows : []
}

const VERB = {
  like: 'liked your deck',
  comment: 'commented on your deck',
  follow: 'started following you',
  trade_proposal: 'sent you a trade proposal',
  trade_response: 'updated a trade with you',
}

function notify(priced, social, symbol) {
  const total = priced.length + social.length
  let title
  let body

  if (social.length && !priced.length) {
    const top = social[0]
    title = social.length === 1
      ? (top.actor_name || 'Someone') + ' ' + (VERB[top.type] || 'interacted')
      : social.length + ' new notifications'
    body = social.length === 1
      ? (top.deck_name || 'Open DeckLoom to see')
      : summarise(social)
  } else if (priced.length && !social.length) {
    const first = priced[0].move
    const rose = first.delta > 0
    title = priced.length === 1
      ? 'A card you own ' + (rose ? 'rose ' : 'fell ') + Math.abs(first.pct).toFixed(0) + '%'
      : priced.length + ' cards moved in price'
    // No card names here: resolving them is a second query in a context meant
    // to stay cheap, so the figure leads and the app fills in the name.
    body = priced.length === 1
      ? (rose ? 'Now ' : 'Down to ') + symbol + Math.abs(first.price_to).toFixed(2)
      : 'Open DeckLoom to see which'
  } else {
    title = total + ' updates in DeckLoom'
    body = priced.length + (priced.length === 1 ? ' price move' : ' price moves')
      + ' and ' + social.length + (social.length === 1 ? ' notification' : ' notifications')
  }

  CapacitorNotifications.schedule([{
    id: hash(priced.map(p => p.key).join('|') + '#' + social.map(s => s.created_at).join('|')),
    title: title,
    body: body,
    scheduleAt: new Date(Date.now() + 1000),
  }])
}

function summarise(social) {
  const counts = {}
  for (let i = 0; i < social.length; i++) {
    const t = social[i].type
    counts[t] = (counts[t] || 0) + 1
  }
  const parts = []
  for (const t in counts) parts.push(counts[t] + ' ' + label(t, counts[t]))
  return parts.join(', ')
}

function label(type, n) {
  const plural = n === 1 ? '' : 's'
  if (type === 'like') return 'like' + plural
  if (type === 'comment') return 'comment' + plural
  if (type === 'follow') return 'follow' + plural
  return 'trade update' + plural
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers: headers })
  if (!res.ok) return []
  const body = await res.json()
  return Array.isArray(body) ? body : []
}

function kv(name) {
  try {
    const entry = CapacitorKV.get(name)
    return entry && entry.value ? entry.value : ''
  } catch (e) {
    return ''
  }
}

function setKV(name, value) {
  try {
    CapacitorKV.set(name, String(value))
  } catch (e) {
    // Losing the marker only risks repeating a notification once.
  }
}

function toSet(blob) {
  const set = new Set()
  const parts = String(blob || '').split('\n')
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

/** Keeps the seen-set from growing without bound across runs. */
function remember(seen, fresh) {
  for (let i = 0; i < fresh.length; i++) seen.add(fresh[i].key)
  const all = Array.from(seen)
  setKV('bgSeen', all.slice(Math.max(0, all.length - 400)).join('\n'))
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
