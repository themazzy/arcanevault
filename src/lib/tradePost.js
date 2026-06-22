import { sb } from './supabase'

// Client wrappers for the Trade Post RPCs + the two user_settings fields that
// drive it (trade_open opt-in flag, trade_wants = featured wishlist folder ids).
// These two columns are managed directly here rather than through SettingsContext,
// which only round-trips a fixed set of preference columns.

export async function getTradeSettings(userId) {
  if (!userId) return { trade_open: false, trade_wants: [] }
  const { data } = await sb
    .from('user_settings')
    .select('trade_open, trade_wants')
    .eq('user_id', userId)
    .maybeSingle()
  return {
    trade_open: !!data?.trade_open,
    trade_wants: Array.isArray(data?.trade_wants) ? data.trade_wants : [],
  }
}

export async function setTradeSettings(userId, patch) {
  if (!userId) return
  const { error } = await sb
    .from('user_settings')
    .update(patch)
    .eq('user_id', userId)
  if (error) throw error
}

// Load the cards in the For Trade binder with their per-card trade options
// (any-version toggle + note), joined to display fields. Flat queries — never
// the nested folder_cards(cards(*)) select, which silently returns empty.
export async function getTradeBinderCards(folderId) {
  if (!folderId) return []
  const { data: fc } = await sb
    .from('folder_cards')
    .select('id, card_id, qty, trade_any_version, trade_note')
    .eq('folder_id', folderId)
  if (!fc?.length) return []
  const ids = fc.map(r => r.card_id)
  const { data: cards } = await sb
    .from('owned_cards_view')
    .select('id, name, set_code, collector_number, foil, image_uri')
    .in('id', ids)
  const byId = Object.fromEntries((cards || []).map(c => [c.id, c]))
  return fc
    .map(r => ({
      folderCardId: r.id,
      cardId: r.card_id,
      qty: r.qty,
      anyVersion: !!r.trade_any_version,
      note: r.trade_note || '',
      ...(byId[r.card_id] || {}),
    }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
}

// Patch the trade options on one For Trade placement (folder_cards row).
export async function setTradeCardOptions(folderCardId, patch) {
  if (!folderCardId) return
  const { error } = await sb.from('folder_cards').update(patch).eq('id', folderCardId)
  if (error) throw error
}

// Public read of someone's trade post. Returns null if no such user, or
// { open:false, nickname } when they aren't accepting trades.
export async function getTradePost(username) {
  const { data, error } = await sb.rpc('get_trade_post', { p_username: username })
  if (error) throw error
  return data
}

export async function proposeTrade(ownerUsername, { requested, offered, note }) {
  const { data, error } = await sb.rpc('propose_trade', {
    p_owner_username: ownerUsername,
    p_requested: requested || [],
    p_offered: offered || [],
    p_note: note || null,
  })
  if (error) throw error
  return data // proposal id
}

export async function getTradeProposals() {
  const { data, error } = await sb.rpc('get_trade_proposals')
  if (error) throw error
  return Array.isArray(data) ? data : []
}

export async function respondToTradeProposal(id, status) {
  const { error } = await sb.rpc('respond_to_trade_proposal', { p_id: id, p_status: status })
  if (error) throw error
}

export async function cancelTradeProposal(id) {
  const { error } = await sb.rpc('cancel_trade_proposal', { p_id: id })
  if (error) throw error
}
