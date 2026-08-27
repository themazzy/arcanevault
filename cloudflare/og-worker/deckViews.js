// Deck view counting for public shortlinks (deckloom.app/d/<id>).
//
// Runs on the pass-through path of the worker — i.e. on real human requests to
// a shared deck link — and increments aggregate counters through the
// `record_deck_view` RPC. Never blocks the response: the caller wraps this in
// ctx.waitUntil().
//
// Crawlers are excluded here rather than in the RPC, because the worker already
// has to classify them to decide whether to serve OG HTML, and a Discordbot
// unfurl is not a reader.

// A single person reloading or sharing a link with themselves shouldn't inflate
// the count. Cloudflare's edge cache is used as a cheap per-POP dedupe window;
// it is best-effort by design (a viewer hitting a different POP may recount).
export const VIEW_DEDUPE_TTL_S = 6 * 60 * 60

export function shouldCountDeckView({ method, userAgent, isCrawlerUa }) {
  if (method !== 'GET') return false
  if (isCrawlerUa) return false
  // A missing UA is nearly always automation, not a browser.
  if (!userAgent) return false
  return true
}

async function hashClientKey(value) {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// Cache keys must be absolute URLs. This host is never fetched — it exists only
// as a namespace for dedupe markers.
export function buildViewDedupeKey(deckId, clientHash) {
  return `https://deck-view-dedupe.deckloom.app/${encodeURIComponent(deckId)}/${clientHash}`
}

export async function recordDeckView(request, deckId, env) {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_ANON_KEY) return false

  try {
    const clientId =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      'unknown'
    const clientHash = await hashClientKey(`${clientId}|${request.headers.get('user-agent') || ''}`)
    const cacheKey = new Request(buildViewDedupeKey(deckId, clientHash), { method: 'GET' })
    const cache = caches.default

    if (await cache.match(cacheKey)) return false

    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_deck_view`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_deck_id: deckId }),
    })
    if (!res.ok) return false

    await cache.put(
      cacheKey,
      new Response('1', { headers: { 'Cache-Control': `max-age=${VIEW_DEDUPE_TTL_S}` } })
    )
    return true
  } catch {
    // View counting is never allowed to affect the response.
    return false
  }
}
