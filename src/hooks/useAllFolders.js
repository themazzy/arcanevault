import { useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import { getLocalFolders, putFolders } from '../lib/db'

/**
 * Every folder the user owns — the source for destination pickers (the "Move
 * to" dialog, CardDetail's folder list).
 *
 * IDB seeds the first paint, then Supabase refreshes and heals the cache.
 * Reading IDB alone was a bug: nothing guarantees the local `folders` store is
 * populated in a given session, so the Move dialog could show "No binders yet"
 * on an account with plenty of them. IDB is a first-paint cache here, not a
 * source of truth (see CLAUDE.md — the app is not offline-first).
 *
 * Returns `[folders, setFolders]`; callers append locally after creating a
 * folder from inside a picker.
 */
export function useAllFolders(userId) {
  const [folders, setFolders] = useState([])

  useEffect(() => {
    if (!userId) { setFolders([]); return }
    let cancelled = false
    // A slow IDB read must not clobber a network response that already landed.
    let remoteLanded = false

    getLocalFolders(userId)
      .then(rows => {
        if (cancelled || remoteLanded || !rows?.length) return
        setFolders(rows)
      })
      .catch(() => {})

    sb.from('folders')
      // user_id is selected so the write-through rows stay reachable via the
      // store's user_id index — without it they are invisible to getLocalFolders.
      .select('id,user_id,name,type,description,updated_at')
      .eq('user_id', userId)
      .order('name')
      .then(({ data, error }) => {
        if (cancelled || error || !data) return
        remoteLanded = true
        setFolders(data)
        putFolders(data).catch(() => {})
      })

    return () => { cancelled = true }
  }, [userId])

  return [folders, setFolders]
}
