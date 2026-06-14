import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { getDeckSocial, setDeckLike, getDeckComments, postComment, deleteComment } from '../../lib/community'
import { CloseIcon } from '../../icons'
import styles from './DeckSocial.module.css'

function timeAgo(iso) {
  const d = new Date(iso)
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24); if (days < 30) return `${days}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Compact like button + count for the deck header.
export function DeckLikeButton({ deckId, user }) {
  const [social, setSocial] = useState(null)   // { like_count, viewer_liked, ... }
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    getDeckSocial(deckId).then(s => { if (alive) setSocial(s) }).catch(() => {})
    return () => { alive = false }
  }, [deckId])

  const toggle = useCallback(async () => {
    if (!user || !social || busy) return
    const next = !social.viewer_liked
    setBusy(true)
    setSocial(s => ({ ...s, viewer_liked: next, like_count: Math.max(0, (s.like_count || 0) + (next ? 1 : -1)) }))
    try { await setDeckLike(deckId, user.id, next) }
    catch { setSocial(s => ({ ...s, viewer_liked: !next, like_count: Math.max(0, (s.like_count || 0) + (next ? -1 : 1)) })) }
    finally { setBusy(false) }
  }, [user, social, busy, deckId])

  if (!social) return null
  const count = social.like_count || 0
  return (
    <button
      className={`${styles.likeBtn} ${social.viewer_liked ? styles.likeBtnOn : ''}`}
      onClick={toggle}
      disabled={!user || busy}
      title={user ? (social.viewer_liked ? 'Unlike' : 'Like') : 'Sign in to like'}
      aria-pressed={social.viewer_liked}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"
        fill={social.viewer_liked ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
      </svg>
      <span>{count}</span>
    </button>
  )
}

// Full comments section for the bottom of the deck page.
export function DeckComments({ deckId, user }) {
  const [comments, setComments] = useState(null)   // null = loading
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    getDeckComments(deckId).then(setComments).catch(() => setComments([]))
  }, [deckId])
  useEffect(() => { load() }, [load])

  const submit = async (e) => {
    e.preventDefault()
    const body = draft.trim()
    if (!body || !user || busy) return
    setBusy(true)
    try {
      await postComment(deckId, user.id, body)
      setDraft('')
      load()
    } catch { /* surfaced by disabled state; keep draft */ }
    finally { setBusy(false) }
  }

  const remove = async (id) => {
    const prev = comments
    setComments(cs => cs.filter(c => c.id !== id))
    try { await deleteComment(id) }
    catch { setComments(prev) }
  }

  const count = comments?.length ?? 0
  return (
    <section className={styles.comments}>
      <div className={styles.commentsHead}>
        <span className={styles.commentsTitle}>Comments</span>
        <span className={styles.commentsCount}>{count}</span>
      </div>

      {user ? (
        <form className={styles.composer} onSubmit={submit}>
          <textarea
            className={styles.composerInput}
            value={draft}
            onChange={e => setDraft(e.target.value.slice(0, 2000))}
            placeholder="Add a comment…"
            rows={2}
            maxLength={2000}
          />
          <div className={styles.composerFoot}>
            <span className={styles.composerCount}>{draft.length}/2000</span>
            <button className={styles.composerBtn} disabled={!draft.trim() || busy}>{busy ? 'Posting…' : 'Post'}</button>
          </div>
        </form>
      ) : (
        <div className={styles.signedOut}>
          <Link to="/login" className={styles.signInLink}>Sign in</Link> to join the conversation.
        </div>
      )}

      {comments === null ? (
        <div className={styles.commentsEmpty}>Loading…</div>
      ) : comments.length === 0 ? (
        <div className={styles.commentsEmpty}>No comments yet. Be the first!</div>
      ) : (
        <ul className={styles.commentList}>
          {comments.map(c => (
            <li key={c.id} className={styles.comment}>
              <div className={styles.commentTop}>
                {c.username
                  ? <Link to={`/profile/${encodeURIComponent(c.username)}`} className={styles.commentAuthor}>{c.username}</Link>
                  : <span className={styles.commentAuthor}>Player</span>}
                <span className={styles.commentTime}>{timeAgo(c.created_at)}</span>
                {c.can_delete && (
                  <button className={styles.commentDelete} onClick={() => remove(c.id)} title="Delete comment" aria-label="Delete comment">
                    <CloseIcon size={12} />
                  </button>
                )}
              </div>
              <div className={styles.commentBody}>{c.body}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
