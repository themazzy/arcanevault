import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuth } from '../components/Auth'
import { useToast } from '../components/ToastContext'
import { EmptyState, Button } from '../components/UI'
import { getTradePost, proposeTrade } from '../lib/tradePost'
import { CloseIcon, AddIcon } from '../icons'
import styles from './Trade.module.css'

// Public, per-user Trade Post at /trade/:username. Anyone can view the owner's
// "haves" (cards in their For Trade binder) and "wants" (featured wishlists).
// Signed-in viewers (other than the owner) can submit a trade proposal.

function eur(value) {
  if (value == null) return null
  return `€${Number(value).toFixed(2)}`
}

function cardKey(c) {
  return `${c.scryfall_id || `${c.set_code}-${c.collector_number}`}-${c.foil ? 'f' : 'n'}`
}

function CardTile({ card, selectable, selected, onToggle }) {
  return (
    <button
      type="button"
      className={`${styles.card}${selected ? ' ' + styles.cardSelected : ''}${selectable ? ' ' + styles.cardSelectable : ''}`}
      onClick={selectable ? onToggle : undefined}
      title={card.name}
      disabled={!selectable}
    >
      {card.image_uri
        ? <img className={styles.cardImg} src={card.image_uri} alt="" loading="lazy" />
        : <div className={styles.cardImgEmpty}><span>{card.name}</span></div>}
      <div className={styles.cardInfo}>
        <span className={styles.cardName}>{card.name}{card.foil ? ' ✦' : ''}</span>
        <span className={styles.cardMeta}>
          {(card.set_code || '').toUpperCase()} {card.qty > 1 ? `· ×${card.qty}` : ''}
          {card.price != null ? ` · ${eur(card.price)}` : ''}
        </span>
      </div>
      {selectable && <span className={styles.cardCheck}>{selected ? '✓' : '+'}</span>}
    </button>
  )
}

export default function TradePage() {
  const { username } = useParams()
  const { user } = useAuth()
  const toast = useToast()

  const [post, setPost] = useState(undefined) // undefined = loading, null = not found
  const [error, setError] = useState('')

  const [requested, setRequested] = useState(() => new Set())
  const [offered, setOffered] = useState([])      // free-form entries: { id, name }
  const [offerDraft, setOfferDraft] = useState('')
  const [note, setNote] = useState('')
  const [composing, setComposing] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const decodedUsername = decodeURIComponent(username || '')

  useEffect(() => {
    let cancelled = false
    setPost(undefined)
    setError('')
    getTradePost(decodedUsername)
      .then(data => { if (!cancelled) setPost(data ?? null) })
      .catch(() => { if (!cancelled) { setPost(null); setError('Could not load this trade post.') } })
    return () => { cancelled = true }
  }, [decodedUsername])

  const haves = post?.haves || []
  const wants = post?.wants || []

  const toggleRequested = (card) => {
    const key = cardKey(card)
    setRequested(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const addOffer = () => {
    const name = offerDraft.trim()
    if (!name) return
    setOffered(prev => [...prev, { id: `${Date.now()}-${prev.length}`, name }])
    setOfferDraft('')
  }

  const requestedCards = useMemo(
    () => haves.filter(c => requested.has(cardKey(c))),
    [haves, requested]
  )

  const canSubmit = !submitting && (requestedCards.length > 0 || offered.length > 0)

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await proposeTrade(decodedUsername, {
        requested: requestedCards.map(c => ({
          name: c.name, set_code: c.set_code, collector_number: c.collector_number,
          scryfall_id: c.scryfall_id, foil: c.foil,
        })),
        offered: offered.map(o => ({ name: o.name })),
        note,
      })
      toast.success('Trade proposal sent.')
      setRequested(new Set())
      setOffered([])
      setNote('')
      setComposing(false)
    } catch (e) {
      toast.error(e?.message || 'Could not send proposal.')
    } finally {
      setSubmitting(false)
    }
  }

  if (post === undefined) return <div className={styles.page}><EmptyState>Loading trade post…</EmptyState></div>

  if (post === null) {
    return (
      <div className={styles.page}>
        <EmptyState>
          {error || `No trade post found for “${decodedUsername}”.`}
        </EmptyState>
      </div>
    )
  }

  if (post.open === false) {
    return (
      <div className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>{post.nickname}</h1>
        </div>
        <EmptyState>{post.nickname} isn’t open to trades right now.</EmptyState>
      </div>
    )
  }

  const canPropose = !!user

  return (
    <div className={styles.page} style={post.accent ? { '--trade-accent': post.accent } : undefined}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Trade post</div>
          <h1 className={styles.title}>{post.nickname}</h1>
          <Link className={styles.profileLink} to={`/profile/${encodeURIComponent(post.nickname)}`}>View profile →</Link>
        </div>
        {canPropose && !composing && (
          <Button onClick={() => setComposing(true)}>Propose a trade</Button>
        )}
      </div>

      {composing && (
        <div className={styles.composer}>
          <div className={styles.composerHead}>
            <strong>Propose a trade to {post.nickname}</strong>
            <button className={styles.iconBtn} onClick={() => setComposing(false)} aria-label="Cancel"><CloseIcon size={14} /></button>
          </div>
          <p className={styles.composerHint}>
            Tap cards under <em>{post.nickname}’s haves</em> to request them, list what you’d give, add a note, then send.
          </p>
          <div className={styles.composerRow}>
            <span className={styles.composerLabel}>You want ({requestedCards.length})</span>
            <span className={styles.composerChips}>
              {requestedCards.length
                ? requestedCards.map(c => <span key={cardKey(c)} className={styles.chip}>{c.name}{c.foil ? ' ✦' : ''}</span>)
                : <span className={styles.composerEmpty}>Tap cards below to add.</span>}
            </span>
          </div>
          <div className={styles.composerRow}>
            <span className={styles.composerLabel}>You give ({offered.length})</span>
            <span className={styles.composerChips}>
              {offered.map(o => (
                <span key={o.id} className={styles.chip}>
                  {o.name}
                  <button className={styles.chipX} onClick={() => setOffered(prev => prev.filter(x => x.id !== o.id))} aria-label="Remove"><CloseIcon size={10} /></button>
                </span>
              ))}
            </span>
          </div>
          <div className={styles.offerAdd}>
            <input
              className={styles.offerInput}
              placeholder="Card you’d offer…"
              value={offerDraft}
              onChange={e => setOfferDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOffer() } }}
              maxLength={120}
            />
            <button className={styles.offerAddBtn} onClick={addOffer} aria-label="Add offered card"><AddIcon size={14} /></button>
          </div>
          <textarea
            className={styles.noteInput}
            placeholder="Add a note (optional)…"
            value={note}
            onChange={e => setNote(e.target.value)}
            maxLength={500}
            rows={2}
          />
          <div className={styles.composerActions}>
            <Button variant="secondary" onClick={() => setComposing(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!canSubmit}>{submitting ? 'Sending…' : 'Send proposal'}</Button>
          </div>
        </div>
      )}

      {!user && (
        <div className={styles.signInNote}>Sign in to propose a trade.</div>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Trading away <span className={styles.count}>{haves.length}</span></h2>
        {haves.length
          ? <div className={styles.grid}>
              {haves.map(c => (
                <CardTile
                  key={cardKey(c)}
                  card={c}
                  selectable={composing}
                  selected={requested.has(cardKey(c))}
                  onToggle={() => toggleRequested(c)}
                />
              ))}
            </div>
          : <EmptyState>No cards listed for trade yet.</EmptyState>}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Looking for <span className={styles.count}>{wants.length}</span></h2>
        {wants.length
          ? <div className={styles.grid}>
              {wants.map(c => <CardTile key={cardKey(c)} card={c} />)}
            </div>
          : <EmptyState>No wants listed.</EmptyState>}
      </section>
    </div>
  )
}
