// og-deck — serves rich Open Graph / Twitter Card previews for shared decks.
//
// Why this exists: deckloom.app is a static SPA on GitHub Pages. Link crawlers
// (facebookexternalhit, Discordbot, …) don't run JavaScript, so they only ever
// see the bare <meta> tags in the shipped index.html — producing an ugly, empty
// preview. This function is what deck share links point at instead:
//   - Crawler  → HTML with deck-specific OG tags + commander art image
//   - Human    → 302 redirect to https://deckloom.app/d/<id> (the real SPA page)
//
// Deck metadata comes from the SECURITY DEFINER RPC `get_deck_og_meta`, which
// returns null for any deck that is not public — so private decks never leak.

import { extractDeckId, isCrawler, renderOgHtml, deckPublicUrl, DeckOgMeta } from './og.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

async function fetchDeckMeta(deckId: string): Promise<DeckOgMeta | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_deck_og_meta`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: ANON_KEY,
        Authorization: `Bearer ${ANON_KEY}`,
      },
      body: JSON.stringify({ p_deck_id: deckId }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data && typeof data === 'object' ? (data as DeckOgMeta) : null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  const deckId = extractDeckId(req.url)

  // No id at all → just send people to the app home.
  if (!deckId) {
    return Response.redirect('https://deckloom.app/', 302)
  }

  const target = deckPublicUrl(deckId)

  // Real browsers go straight to the SPA. Only crawlers get the OG HTML.
  if (!isCrawler(req.headers.get('user-agent'))) {
    return Response.redirect(target, 302)
  }

  const meta = await fetchDeckMeta(deckId)
  const html = renderOgHtml(deckId, meta)

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Let crawlers (and their caches) hold the preview for a while.
      'Cache-Control': 'public, max-age=600, s-maxage=600',
    },
  })
})
