import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const MAX_BODY_BYTES    = 50_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS })
  }

  // guard against oversized payloads before forwarding
  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) {
    return json({ error: 'Request body too large.' }, 413)
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400)
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json({ error: 'Function is not configured.' }, 500)
  }

  const deckId = typeof body === 'object' && body && 'deck_id' in body
    ? String((body as { deck_id?: unknown }).deck_id || '')
    : ''
  if (!UUID_RE.test(deckId)) {
    return json({ error: 'A valid deck_id is required.' }, 400)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const { data: deckCards, error } = await supabase.rpc('get_deck_cards_for_view', { p_deck_id: deckId })
  if (error) {
    return json({ error: error.message }, 500)
  }
  const cards = Array.isArray(deckCards) ? deckCards : []
  if (!cards.length) {
    return json({ error: 'Deck not found.' }, 404)
  }

  const upstreamBody = {
    commanders: cards
      .filter((card) => card?.is_commander)
      .map((card) => ({ card: card.name }))
      .filter((entry) => entry.card),
    main: cards
      .filter((card) => !card?.is_commander && (card?.board === 'main' || !card?.board))
      .map((card) => ({ card: card.name }))
      .filter((entry) => entry.card),
  }

  try {
    const upstream = await fetch('https://backend.commanderspellbook.com/find-my-combos/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://commanderspellbook.com',
        'Referer': 'https://commanderspellbook.com/',
      },
      body: JSON.stringify(upstreamBody),
    })

    const data = await upstream.json()
    return json(data, upstream.status)
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
