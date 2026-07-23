import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { getPublicAppUrl } from '../lib/publicUrl'
import { Modal, Button } from './UI'

// Generates (or reuses) a public share link for a folder of any type
// (binder / deck / list). Wishlists additionally support collaborative
// check-off on the shared page — see get_shared_wishlist / toggle_wishlist_claim.
export default function ShareModal({ folder, onClose }) {
  const [token, setToken]     = useState(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied]   = useState(false)

  useEffect(() => {
    const load = async () => {
      const { data } = await sb.from('shared_folders').select('public_token').eq('folder_id', folder.id).maybeSingle()
      if (data) { setToken(data.public_token); setLoading(false); return }
      const { data: created } = await sb.from('shared_folders').insert({ folder_id: folder.id }).select().single()
      setToken(created?.public_token)
      setLoading(false)
    }
    load()
  }, [folder.id])

  const url = token ? getPublicAppUrl(`/share/${token}`) : ''

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard blocked — user can select manually */ }
  }

  return (
    <Modal onClose={onClose}>
      <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 16 }}>
        Share &ldquo;{folder.name}&rdquo;
      </h2>
      {loading ? <p style={{ color: 'var(--text-dim)' }}>Generating link…</p> : (
        <>
          <p style={{ color: 'var(--text-dim)', fontSize: '0.88rem', marginBottom: 12 }}>
            {folder.type === 'list'
              ? 'Signed-in viewers can see this wishlist and privately mark cards they plan to get for you:'
              : `Anyone with this link can view this ${folder.type} (read-only):`}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input readOnly value={url} style={{
              flex: 1, background: 'var(--s2)', border: '1px solid var(--s-border2)',
              borderRadius: 3, padding: '9px 12px', color: 'var(--text)', fontSize: '0.85rem', outline: 'none'
            }} />
            <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
        </>
      )}
    </Modal>
  )
}
