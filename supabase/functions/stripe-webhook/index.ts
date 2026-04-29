import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function hexToBytes(hex: string) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function timingSafeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false
  const left = hexToBytes(a)
  const right = hexToBytes(b)
  let diff = 0
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i]
  }
  return diff === 0
}

async function hmacSha256Hex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(signature)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function verifyStripeSignature(payload: string, signatureHeader: string | null) {
  if (!signatureHeader) throw new Error('Missing Stripe signature.')

  const parts = signatureHeader.split(',').reduce<Record<string, string[]>>((acc, part) => {
    const [key, value] = part.split('=')
    if (!key || !value) return acc
    acc[key] = [...(acc[key] || []), value]
    return acc
  }, {})

  const timestamp = parts.t?.[0]
  const signatures = parts.v1 || []
  if (!timestamp || signatures.length === 0) throw new Error('Malformed Stripe signature.')

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    throw new Error('Expired Stripe signature.')
  }

  const expected = await hmacSha256Hex(STRIPE_WEBHOOK_SECRET, `${timestamp}.${payload}`)
  if (!signatures.some(signature => timingSafeEqualHex(signature, expected))) {
    throw new Error('Invalid Stripe signature.')
  }
}

function stringOrNull(input: unknown) {
  return typeof input === 'string' && input ? input : null
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !STRIPE_WEBHOOK_SECRET) {
    return json({ error: 'Stripe webhook environment is incomplete.' }, 500)
  }

  const payload = await req.text()

  try {
    await verifyStripeSignature(payload, req.headers.get('stripe-signature'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: message }, 400)
  }

  const event = JSON.parse(payload)
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object || {}
      const userId = stringOrNull(session.metadata?.user_id || session.client_reference_id)
      const entitlement = stringOrNull(session.metadata?.entitlement)
      const paymentStatus = stringOrNull(session.payment_status)
      const mode = stringOrNull(session.mode)

      if (userId && entitlement === 'premium_themes' && mode === 'payment' && paymentStatus === 'paid') {
        const unlockedAt = new Date().toISOString()
        const amountTotal = typeof session.amount_total === 'number' ? session.amount_total : null
        const currency = stringOrNull(session.currency)
        const sessionId = stringOrNull(session.id)
        const customerId = stringOrNull(session.customer)
        const paymentIntentId = stringOrNull(session.payment_intent)

        if (sessionId) {
          await adminClient.from('premium_purchases').upsert(
            {
              stripe_checkout_session_id: sessionId,
              user_id: userId,
              stripe_customer_id: customerId,
              stripe_payment_intent_id: paymentIntentId,
              amount_total: amountTotal,
              currency,
              status: paymentStatus,
              raw_event_id: stringOrNull(event.id),
              purchased_at: unlockedAt,
            },
            { onConflict: 'stripe_checkout_session_id' },
          )
        }

        const { error } = await adminClient.from('user_settings').upsert(
          {
            user_id: userId,
            premium: true,
            stripe_customer_id: customerId,
            premium_unlocked_at: unlockedAt,
            premium_checkout_session_id: sessionId,
            updated_at: unlockedAt,
          },
          { onConflict: 'user_id' },
        )
        if (error) throw error
      }
    }

    return json({ received: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: 'Could not process Stripe webhook.', details: message }, 500)
  }
})
