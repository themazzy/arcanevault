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

// ── Deck import proxy (deckloom.app/api/import/<source>/<id>) ────────────────
// Archidekt / Moxfield / MTGGoldfish deck APIs are CORS-restricted, so the
// builder's import-by-URL feature only worked through the Vite dev proxy.
// Strict source + id validation — this must never become an open proxy.
const IMPORT_SOURCES = {
  archidekt: { upstream: id => `https://archidekt.com/api/decks/${id}/`, idRe: /^\d{1,10}$/, type: 'application/json; charset=utf-8' },
  moxfield:  { upstream: id => `https://api.moxfield.com/v2/decks/all/${id}`, idRe: /^[A-Za-z0-9_-]{1,40}$/, type: 'application/json; charset=utf-8' },
  goldfish:  { upstream: id => `https://www.mtggoldfish.com/deck/download/${id}`, idRe: /^\d{1,10}$/, type: 'text/plain; charset=utf-8' },
}

async function handleImport(request) {
  const match = new URL(request.url).pathname.match(/^\/api\/import\/([a-z]+)\/([^/]+)$/)
  const source = match ? IMPORT_SOURCES[match[1]] : null
  const id = match?.[2]
  if (!source || !source.idRe.test(id)) {
    return new Response('bad import request', {
      status: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  }
  const upstream = await fetch(source.upstream(id), {
    headers: {
      'User-Agent': 'DeckLoom deck importer (+https://deckloom.app)',
      'Accept': 'application/json, text/plain, */*',
    },
  })
  const body = await upstream.text()
  return new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': source.type,
      'Access-Control-Allow-Origin': '*',
      // Imports should be fresh; a short cache only absorbs double-clicks.
      'Cache-Control': 'public, max-age=60',
    },
  })
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname
    if (pathname === '/api/rss') return handleRss(request)
    if (pathname.startsWith('/api/import/')) return handleImport(request)

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
