// deckloom-og — Cloudflare Worker serving rich Open Graph previews for shared
// deck links, on the branded URL.
//
// Routed at deckloom.app/d/* (see wrangler.toml). GitHub Pages is a static
// host and link crawlers (facebookexternalhit, Discordbot, …) don't run JS,
// so without this they only see the generic <meta> tags in index.html.
//
//   - Crawler UA → 200 HTML with deck-specific OG tags + commander art
//   - Everyone else → transparent pass-through to the GitHub Pages origin
//     (the SPA), byte-for-byte what they'd get without the worker.
//
// Deck metadata comes from the SECURITY DEFINER RPC `get_deck_og_meta`, which
// returns null for any deck that is not public — private decks never leak.

import { extractDeckId, isCrawler, renderOgHtml } from './og.js'

// ── RSS proxy (deckloom.app/api/rss?feed=<url>) ──────────────────────────────
// The Home page news section needs CORS-free access to third-party RSS feeds;
// the free public proxies it used (corsproxy.io, codetabs) rot regularly.
// Strict allow-list — this must never become an open proxy.
const RSS_ALLOWED_FEEDS = new Set([
  'https://www.mtggoldfish.com/feed',
  'https://edhrec.com/articles/feed',
  'https://mtgazone.com/feed',
])

async function handleRss(request) {
  const feed = new URL(request.url).searchParams.get('feed')
  if (!feed || !RSS_ALLOWED_FEEDS.has(feed)) {
    return new Response('feed not allowed', {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  }
  const upstream = await fetch(feed, {
    headers: { 'User-Agent': 'DeckLoom RSS fetcher (+https://deckloom.app)' },
    cf: { cacheTtl: 900, cacheEverything: true },
  })
  const body = await upstream.text()
  return new Response(body, {
    status: upstream.ok ? 200 : 502,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      // Let the edge + browsers hold feeds for 15 minutes.
      'Cache-Control': 'public, max-age=900, s-maxage=900',
    },
  })
}

async function fetchDeckMeta(deckId, env) {
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_deck_og_meta`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_deck_id: deckId }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/api/rss') return handleRss(request)

    const deckId = request.method === 'GET' ? extractDeckId(request.url) : null

    if (!deckId || !isCrawler(request.headers.get('user-agent'))) {
      return fetch(request)
    }

    const meta = await fetchDeckMeta(deckId, env)
    return new Response(renderOgHtml(deckId, meta), {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Let crawlers (and their caches) hold the preview for a while.
        'Cache-Control': 'public, max-age=600, s-maxage=600',
      },
    })
  },
}
