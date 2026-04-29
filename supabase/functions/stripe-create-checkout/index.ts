import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? ''
const STRIPE_PREMIUM_PRICE_ID = Deno.env.get('STRIPE_PREMIUM_PRICE_ID') ?? ''
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://themazzy.github.io/arcanevault').replace(/\/$/, '')

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

function isAllowedRedirect(input: unknown, fallback: string) {
  if (typeof input !== 'string') return fallback
  try {
    const url = new URL(input)
    const site = new URL(SITE_URL)
    const isSiteUrl = url.origin === site.origin && url.pathname.startsWith(site.pathname)
    const isLocalDev = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    return isSiteUrl || isLocalDev ? input : fallback
  } catch {
    return fallback
  }
}

async function stripePost(path: string, params: URLSearchParams) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data?.error?.message || `Stripe request failed with status ${response.status}.`)
  }
  return data
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !STRIPE_SECRET_KEY || !STRIPE_PREMIUM_PRICE_ID) {
    return json({ error: 'Stripe checkout environment is incomplete.' }, 500)
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
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData.user) {
      return json({ error: 'Could not verify the current user.' }, 401)
    }

    const user = userData.user
    const { data: settings, error: settingsError } = await adminClient
      .from('user_settings')
      .select('premium, stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()
    if (settingsError) throw settingsError

    if (settings?.premium) {
      return json({ ok: true, alreadyUnlocked: true, url: `${SITE_URL}/settings` })
    }

    let customerId = settings?.stripe_customer_id || ''
    if (!customerId) {
      const customerParams = new URLSearchParams()
      if (user.email) customerParams.set('email', user.email)
      customerParams.set('metadata[user_id]', user.id)
      const customer = await stripePost('customers', customerParams)
      customerId = customer.id
      await adminClient.from('user_settings').upsert(
        {
          user_id: user.id,
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      )
    }

    const body = await req.json().catch(() => ({}))
    const successUrl = isAllowedRedirect(
      body?.successUrl,
      `${SITE_URL}/settings?premium_checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    )
    const cancelUrl = isAllowedRedirect(
      body?.cancelUrl,
      `${SITE_URL}/settings?premium_checkout=cancelled`,
    )

    const sessionParams = new URLSearchParams()
    sessionParams.set('mode', 'payment')
    sessionParams.set('customer', customerId)
    sessionParams.set('client_reference_id', user.id)
    sessionParams.set('success_url', successUrl)
    sessionParams.set('cancel_url', cancelUrl)
    sessionParams.set('line_items[0][price]', STRIPE_PREMIUM_PRICE_ID)
    sessionParams.set('line_items[0][quantity]', '1')
    sessionParams.set('metadata[user_id]', user.id)
    sessionParams.set('metadata[entitlement]', 'premium_themes')
    sessionParams.set('payment_intent_data[metadata][user_id]', user.id)
    sessionParams.set('payment_intent_data[metadata][entitlement]', 'premium_themes')

    const session = await stripePost('checkout/sessions', sessionParams)
    return json({ ok: true, id: session.id, url: session.url })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: 'Could not create Stripe Checkout session.', details: message }, 500)
  }
})
