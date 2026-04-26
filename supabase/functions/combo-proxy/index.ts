import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')     ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const MAX_BODY_BYTES    = 50_000

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

  // require a valid authenticated session
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'Missing authorization header.' }, 401)
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: { user }, error: authError } = await userClient.auth.getUser()
  if (authError || !user) {
    return json({ error: 'Not authenticated.' }, 401)
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

  try {
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
    return json(data, upstream.status)
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
