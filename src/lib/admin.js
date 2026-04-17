import { sb } from './supabase'

export async function isCurrentUserAdmin(userId) {
  if (!userId) return false
  const { data, error } = await sb
    .from('admin_users')
    .select('user_id')
    .eq('user_id', userId)
    .eq('active', true)
    .maybeSingle()

  if (error) return false
  return !!data
}
