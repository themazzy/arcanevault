const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS })
  }

  try {
    const body = await req.json()

    const upstream = await fetch('https://backend.commanderspellbook.com/find-my-combos/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://commanderspellbook.com',
        'Referer': 'https://commanderspellbook.com/',
      },
      body: JSON.stringify(body),
    })

    const data = await upstream.json()

    return new Response(JSON.stringify(data), {
      status: upstream.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
})
