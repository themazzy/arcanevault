import { sb } from './supabase'

export async function fetchDeckCategories(deckId) {
  if (!deckId) return []
  const { data, error } = await sb
    .from('deck_categories')
    .select('*')
    .eq('deck_id', deckId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw error
  return data || []
}

export async function createDeckCategory(deckId, userId, name, sortOrder = 0) {
  const trimmedName = String(name || '').trim()
  if (!trimmedName) throw new Error('Category name is required.')

  const { data, error } = await sb
    .from('deck_categories')
    .insert({
      deck_id: deckId,
      user_id: userId,
      name: trimmedName,
      sort_order: sortOrder,
    })
    .select('*')
    .single()

  if (error) throw error
  return data
}

export async function renameDeckCategory(categoryId, name) {
  const trimmedName = String(name || '').trim()
  if (!trimmedName) throw new Error('Category name is required.')

  const { data, error } = await sb
    .from('deck_categories')
    .update({ name: trimmedName })
    .eq('id', categoryId)
    .select('*')
    .single()

  if (error) throw error
  return data
}

export async function deleteDeckCategory(categoryId) {
  const { error } = await sb
    .from('deck_categories')
    .delete()
    .eq('id', categoryId)

  if (error) throw error
}

export async function updateDeckCategoryOrder(rows) {
  if (!rows?.length) return []
  const updates = rows.map(row =>
    sb
      .from('deck_categories')
      .update({ sort_order: row.sort_order })
      .eq('id', row.id)
      .select('*')
      .single()
  )
  const results = await Promise.all(updates)
  const error = results.find(result => result.error)?.error
  if (error) throw error
  return results.map(result => result.data).filter(Boolean)
}

export async function setDeckCardCategory(deckCardId, categoryId) {
  const { data, error } = await sb
    .from('deck_cards')
    .update({ category_id: categoryId || null, updated_at: new Date().toISOString() })
    .eq('id', deckCardId)
    .select('*')
    .single()

  if (error) throw error
  return data
}

export async function resetDeckCategories(deckId) {
  const { error: clearError } = await sb
    .from('deck_cards')
    .update({ category_id: null, updated_at: new Date().toISOString() })
    .eq('deck_id', deckId)

  if (clearError) throw clearError

  const { error: deleteError } = await sb
    .from('deck_categories')
    .delete()
    .eq('deck_id', deckId)

  if (deleteError) throw deleteError
}
