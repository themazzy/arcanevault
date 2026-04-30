import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const ALLOWED_SETTINGS_KEYS = new Set([
  'premium',
  'theme',
  'oled_mode',
  'higher_contrast',
  'reduce_motion',
  'body_font',
  'font_size',
  'font_weight',
  'card_name_size',
  'grid_density',
  'price_source',
  'show_price',
  'default_sort',
  'default_grouping',
  'cache_ttl_h',
  'binder_sort',
  'deck_sort',
  'list_sort',
  'nickname',
  'anonymize_email',
  'keep_screen_awake',
  'show_sync_errors',
])

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

function cleanPatch(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (ALLOWED_SETTINGS_KEYS.has(key)) patch[key] = value
  }
  return patch
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'Supabase function environment is incomplete.' }, 500)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return json({ error: 'Missing authorization header.' }, 401)
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  try {
    const { data: actorData, error: actorError } = await userClient.auth.getUser()
    if (actorError || !actorData.user) {
      return json({ error: 'Could not verify the current admin user.' }, 401)
    }

    const { data: adminRow, error: adminError } = await adminClient
      .from('admin_users')
      .select('user_id')
      .eq('user_id', actorData.user.id)
      .eq('active', true)
      .maybeSingle()

    if (adminError || !adminRow) {
      return json({ error: 'Admin access required.' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    const targetUserId = typeof body?.user_id === 'string' ? body.user_id : ''
    const patch = cleanPatch(body?.patch)

    if (!targetUserId) {
      return json({ error: 'Missing target user id.' }, 400)
    }
    if (!Object.keys(patch).length) {
      return json({ error: 'No allowed settings fields were provided.' }, 400)
    }

    const { data, error } = await adminClient
      .from('user_settings')
      .upsert(
        {
          user_id: targetUserId,
          ...patch,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      )
      .select('*')
      .maybeSingle()

    if (error) throw error
    return json({ ok: true, settings: data })
  } catch (error) {
    return json({ error: 'Could not update user settings.', details: errorMessage(error) }, 500)
  }
})
