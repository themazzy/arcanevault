// Collection value history — one snapshot row per user per day, written
// opportunistically when the Stats page computes totals. Storage cost is one
// tiny row/user/day, which is what makes a portfolio chart viable on the
// free tier (full per-card history would not be).

import { sb } from './supabase'

export function todayDateString(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

let recordedThisSession = false

export async function recordCollectionValueSnapshot(userId, { eur, usd, count }) {
  if (!userId || recordedThisSession) return false
  recordedThisSession = true
  const { error } = await sb.from('collection_value_snapshots').upsert({
    user_id: userId,
    snapshot_date: todayDateString(),
    total_eur: Math.round((eur ?? 0) * 100) / 100,
    total_usd: Math.round((usd ?? 0) * 100) / 100,
    card_count: count ?? 0,
  }, { onConflict: 'user_id,snapshot_date' })
  if (error) {
    recordedThisSession = false // let a later retry happen
    throw error
  }
  return true
}

export async function fetchValueHistory(userId, { days = 400 } = {}) {
  if (!userId) return []
  const since = new Date()
  since.setDate(since.getDate() - days)
  const { data, error } = await sb
    .from('collection_value_snapshots')
    .select('snapshot_date,total_eur,total_usd,card_count')
    .eq('user_id', userId)
    .gte('snapshot_date', todayDateString(since))
    .order('snapshot_date', { ascending: true })
  if (error) throw error
  return data || []
}

/**
 * Change vs the closest snapshot at least `daysAgo` days old.
 * Returns { abs, pct, sinceDate } or null when no old-enough snapshot exists.
 */
export function computeValueDelta(rows, currentValue, field, daysAgo, now = new Date()) {
  if (!rows?.length || currentValue == null) return null
  const cutoff = new Date(now)
  cutoff.setDate(cutoff.getDate() - daysAgo)
  const cutoffStr = todayDateString(cutoff)
  let baseline = null
  for (const row of rows) {
    if (row.snapshot_date <= cutoffStr) baseline = row
    else break
  }
  if (!baseline) return null
  const base = Number(baseline[field]) || 0
  const abs = currentValue - base
  const pct = base > 0 ? (abs / base) * 100 : null
  return { abs, pct, sinceDate: baseline.snapshot_date }
}
