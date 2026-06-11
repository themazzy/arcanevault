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
