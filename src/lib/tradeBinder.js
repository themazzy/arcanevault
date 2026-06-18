import { sb } from './supabase'

// The "For Trade" binder is a normal binder folder flagged in its description
// meta. Cards placed in it stay part of the owned collection (folder_cards),
// they're just the set the user is offering up for trade on their Trade Post.
// It is protected in the UI: it can't be renamed, deleted, or moved to a group.

export const TRADE_BINDER_NAME = 'For Trade'

export function isTradeBinder(folder) {
  if (!folder || folder.type !== 'binder') return false
  try { return JSON.parse(folder.description || '{}').isTradeBinder === true } catch { return false }
}

// Find the user's protected trade binder, creating it on first use.
export async function ensureTradeBinder(userId) {
  if (!userId) return null
  const { data: existing } = await sb
    .from('folders')
    .select('id,name,type,description,updated_at')
    .eq('user_id', userId)
    .eq('type', 'binder')

  const found = (existing || []).find(isTradeBinder)
  if (found) return found

  const { data: created, error } = await sb
    .from('folders')
    .insert({
      user_id: userId,
      type: 'binder',
      name: TRADE_BINDER_NAME,
      description: JSON.stringify({ isTradeBinder: true }),
    })
    .select('id,name,type,description,updated_at')
    .single()
  if (error) throw error
  return created
}
