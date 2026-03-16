// supabase/functions/daily-snapshot/index.ts
// Deploy with: supabase functions deploy daily-snapshot
// Schedule in Dashboard: SQL Editor → run the cron setup below

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// Fetch all users who have cards
async function getUsers() {
  const { data } = await sb.from('cards').select('user_id').limit(1000)
  return [...new Set(data?.map(r => r.user_id) || [])]
}

// Fetch Scryfall prices in batches
async function fetchBatchPrices(identifiers: any[]) {
  const res = await fetch('https://api.scryfall.com/cards/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifiers: identifiers.slice(0, 75) })
  })
  if (!res.ok) return {}
  const data = await res.json()
  const map: Record<string, number> = {}
  for (const card of data.data || []) {
    const key = `${card.set}-${card.collector_number}`
    const price = card.foil
      ? parseFloat(card.prices?.eur_foil || card.prices?.usd_foil || '0')
      : parseFloat(card.prices?.eur || card.prices?.usd || '0')
    map[key] = price || 0
  }
  return map
}

async function snapshotUser(userId: string) {
  const { data: cards } = await sb.from('cards').select('*').eq('user_id', userId)
  if (!cards?.length) return

  // Check if already snapshotted today
  const today = new Date().toISOString().slice(0, 10)
  const { data: existing } = await sb.from('price_snapshots')
    .select('id')
    .eq('user_id', userId)
    .gte('taken_at', today + 'T00:00:00Z')
    .maybeSingle()
  if (existing) return

  // Fetch prices in batches
  let priceMap: Record<string, number> = {}
  for (let i = 0; i < cards.length; i += 75) {
    const batch = cards.slice(i, i + 75)
    const identifiers = batch.map(c => ({ set: c.set_code, collector_number: c.collector_number }))
    const batchMap = await fetchBatchPrices(identifiers)
    priceMap = { ...priceMap, ...batchMap }
    if (i + 75 < cards.length) await new Promise(r => setTimeout(r, 150))
  }

  // Calculate total value
  let totalValue = 0
  for (const card of cards) {
    const key = `${card.set_code}-${card.collector_number}`
    const price = priceMap[key] || 0
    totalValue += price * card.qty
  }

  await sb.from('price_snapshots').insert({
    user_id: userId,
    value_eur: parseFloat(totalValue.toFixed(2))
  })
}

Deno.serve(async () => {
  try {
    const users = await getUsers()
    for (const userId of users) {
      await snapshotUser(userId)
    }
    return new Response(JSON.stringify({ ok: true, users: users.length }), {
      headers: { 'Content-Type': 'application/json' }
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 })
  }
})
