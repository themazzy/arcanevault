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
import { extractDecklistDeckId, renderDecklistText } from './decklist.js'

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

// ── Article thumbnail proxy (deckloom.app/api/og-image?url=<article-url>) ────
// MTGGoldfish and MTG Arena Zone's feeds carry no image data at all (no
// enclosure, no media:*, no inline <img> in the description) — the only place
// a thumbnail exists is the article page's own og:image meta tag. Strict host
// allow-list — this must never become an open proxy/SSRF vector.
const OG_IMAGE_ALLOWED_HOSTS = new Set([
  'www.mtggoldfish.com',
  'mtggoldfish.com',
  'edhrec.com',
  'www.edhrec.com',
  'mtgazone.com',
  'www.mtgazone.com',
])

async function handleOgImage(request) {
  const raw = new URL(request.url).searchParams.get('url')
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  let target = null
  try { target = raw ? new URL(raw) : null } catch { target = null }
  if (!target || target.protocol !== 'https:' || !OG_IMAGE_ALLOWED_HOSTS.has(target.hostname)) {
    return new Response(JSON.stringify({ image: null }), { status: 400, headers })
  }
  try {
    const upstream = await fetch(target.toString(), {
      headers: { 'User-Agent': 'DeckLoom RSS fetcher (+https://deckloom.app)' },
      // Article art never changes after publish — cache the scrape for a day.
      cf: { cacheTtl: 86400, cacheEverything: true },
    })
    const html = await upstream.text()
    const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    const image = match?.[1] && /^https?:\/\//.test(match[1]) ? match[1] : null
    return new Response(JSON.stringify({ image }), {
      status: 200,
      headers: { ...headers, 'Cache-Control': 'public, max-age=86400, s-maxage=86400' },
    })
  } catch {
    return new Response(JSON.stringify({ image: null }), { status: 502, headers })
  }
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

// ── Raw decklist (deckloom.app/api/decklist/<deck-id>.txt) ───────────────────
// Plain-text decklist for third-party integrations (Tabletop Simulator deck
// importers etc.) that can't run the SPA's JS. Backed by the same public-gated
// SECURITY DEFINER RPC as DeckView — private decks return 404, never cards.
async function handleDecklist(request, env) {
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  const deckId = extractDecklistDeckId(request.url)
  if (!deckId) return new Response('bad decklist request', { status: 400, headers })
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/get_deck_cards_for_view`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_deck_id: deckId }),
    })
    if (!res.ok) return new Response('deck lookup failed', { status: 502, headers })
    const rows = await res.json()
    // The RPC returns [] for missing AND private decks alike — both are 404.
    if (!Array.isArray(rows) || rows.length === 0) {
      return new Response('deck not found', { status: 404, headers })
    }
    return new Response(renderDecklistText(rows), {
      status: 200,
      headers: { ...headers, 'Cache-Control': 'public, max-age=300' },
    })
  } catch {
    return new Response('deck lookup failed', { status: 502, headers })
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

// ── Recommander.cards proxy (deckloom.app/api/recommend) ─────────────────────
// recommander.cards returns deck-aware recommendations but sends no CORS
// headers, so browser calls from the SPA are blocked and must be proxied. It's
// a JSON POST, so we also answer the browser's preflight. Body is sanitised and
// bounded — this must never become an open proxy.
const RECOMMANDER_URL = 'https://api.recommander.cards/public-release/api/decks/recommend/top'
const CORS_JSON = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }

function recommendPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
}

async function handleRecommend(request) {
  if (request.method === 'OPTIONS') return recommendPreflight()
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: CORS_JSON })

  let payload = null
  try { payload = await request.json() } catch { /* invalid body handled below */ }
  const commander = payload?.commander
  if (!commander || typeof commander !== 'string') {
    return new Response(JSON.stringify({ result_code: 'error_invalid_cards', data: null }), { status: 400, headers: CORS_JSON })
  }
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null)
  const body = {
    card_format: ['name', 'oracle_id', 'scryfall_id'].includes(payload.card_format) ? payload.card_format : 'name',
    commander: str(commander, 200),
    partner: str(payload.partner, 200),
    deck: Array.isArray(payload.deck)
      ? payload.deck.filter(s => typeof s === 'string').slice(0, 200).map(s => s.slice(0, 200))
      : [],
  }
  try {
    const upstream = await fetch(RECOMMANDER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'DeckLoom recommender (+https://deckloom.app)',
      },
      body: JSON.stringify(body),
    })
    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      // Short edge cache absorbs repeated builds for the same deck snapshot.
      headers: { ...CORS_JSON, 'Cache-Control': 'public, max-age=120' },
    })
  } catch {
    return new Response(JSON.stringify({ result_code: 'error_backend_downstream', data: null }), { status: 502, headers: CORS_JSON })
  }
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname
    if (pathname === '/api/rss') return handleRss(request)
    if (pathname === '/api/og-image') return handleOgImage(request)
    if (pathname === '/api/recommend') return handleRecommend(request)
    if (pathname.startsWith('/api/import/')) return handleImport(request)
    if (pathname.startsWith('/api/decklist/')) return handleDecklist(request, env)

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
