const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_BODY_BYTES = 50_000

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

  // The client builds the card lists in memory (it already holds the full deck)
  // and posts { commanders, main } — the same shape Commander Spellbook expects.
  // We sanitise to that exact shape before forwarding so we never relay arbitrary
  // client JSON upstream.
  const toCardList = (value: unknown) =>
    (Array.isArray(value) ? value : [])
      .map((entry) => {
        const name = entry && typeof entry === 'object'
          ? (entry as { card?: unknown }).card
          : undefined
        return { card: typeof name === 'string' ? name : '' }
      })
      .filter((entry) => entry.card)

  const src = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const upstreamBody = {
    commanders: toCardList(src.commanders),
    main: toCardList(src.main),
  }
  if (!upstreamBody.commanders.length && !upstreamBody.main.length) {
    return json({ error: 'A non-empty commanders or main list is required.' }, 400)
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
