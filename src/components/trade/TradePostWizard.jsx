import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { sb } from '../../lib/supabase'
import { useAuth } from '../Auth'
import { useSettings } from '../SettingsContext'
import { useToast } from '../ToastContext'
import { Button, Modal, EmptyState, SearchInput } from '../UI'
import CardImg from '../CardImg'
import { isGroupFolder } from '../../lib/collectionFetchers'
import { getPublicAppUrl } from '../../lib/publicUrl'
import { ensureTradeBinder } from '../../lib/tradeBinder'
import {
  getTradeSettings, setTradeSettings,
  getTradeBinderCards, setTradeCardOptions,
} from '../../lib/tradePost'
import { CheckIcon, EditIcon } from '../../icons'
import styles from './TradePostWizard.module.css'

// Guided setup for a Trade Post, modelled on the deck Build Assistant: a node
// stepper with one concern per step. The previous single-page version stacked
// availability, every card in the For Trade binder, and the wishlist picker in
// one column — so choosing which wishlists to feature meant scrolling past a
// hundred card rows to reach them. Each of those is now its own step.

const STEPS = [
  { id: 'availability', label: 'Availability' },
  { id: 'haves', label: 'Trading away' },
  { id: 'wants', label: 'Looking for' },
  { id: 'share', label: 'Share' },
]

export default function TradePostWizard({ onClose, onSaved }) {
  const { user } = useAuth()
  const { nickname } = useSettings()
  const toast = useToast()

  const [stepIndex, setStepIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [wantIds, setWantIds] = useState([])
  const [wishlists, setWishlists] = useState([])
  const [haves, setHaves] = useState([])
  const [haveQuery, setHaveQuery] = useState('')
  const [editingNote, setEditingNote] = useState(null)
  const [copied, setCopied] = useState(false)
  const stepperRef = useRef(null)

  useEffect(() => {
    if (!user?.id) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const binder = await ensureTradeBinder(user.id)
        const [{ trade_open, trade_wants }, listRes, binderCards] = await Promise.all([
          getTradeSettings(user.id),
          sb.from('folders').select('id,name,type,description').eq('user_id', user.id).eq('type', 'list'),
          binder ? getTradeBinderCards(binder.id) : Promise.resolve([]),
        ])
        if (cancelled) return
        const lists = (listRes.data || []).filter(f => !isGroupFolder(f))

        // Per-list item counts, so the wishlist step shows what each contains
        // instead of a bare name. One HEAD count each — there are only ever a
        // handful of wishlists, and a single .in() select would silently cap at
        // 1000 rows.
        const counts = await Promise.all(lists.map(l =>
          sb.from('list_items')
            .select('id', { count: 'exact', head: true })
            .eq('folder_id', l.id)
            .then(r => r.count ?? 0)
            .catch(() => 0)
        ))
        if (cancelled) return

        setOpen(trade_open)
        setWantIds(trade_wants)
        setWishlists(lists.map((l, i) => ({ ...l, itemCount: counts[i] })))
        setHaves(binderCards)
      } catch {
        if (!cancelled) toast.error('Could not load your trade post.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [user?.id, toast])

  // Keep the active node in view when the stepper overflows on narrow screens.
  useEffect(() => {
    const el = stepperRef.current?.querySelector('[aria-current="step"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [stepIndex])

  const persist = useCallback(async (patch) => {
    try {
      await setTradeSettings(user.id, patch)
      onSaved?.()
    } catch {
      toast.error('Could not save trade settings.')
    }
  }, [user?.id, toast, onSaved])

  const toggleOpen = async () => {
    const next = !open
    setOpen(next)
    await persist({ trade_open: next })
  }

  const toggleWant = async (id) => {
    const next = wantIds.includes(id) ? wantIds.filter(x => x !== id) : [...wantIds, id]
    setWantIds(next)
    await persist({ trade_wants: next })
  }

  const saveNote = (folderCardId, note) => {
    setHaves(prev => prev.map(h => h.folderCardId === folderCardId ? { ...h, note } : h))
    setEditingNote(null)
    setTradeCardOptions(folderCardId, { trade_note: note || null })
      .catch(() => toast.error('Could not save the note.'))
  }

  const url = nickname ? getPublicAppUrl(`/trade/${encodeURIComponent(nickname)}`) : ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard unavailable — the field is selectable */ }
  }

  const filteredHaves = useMemo(() => {
    const q = haveQuery.trim().toLowerCase()
    if (!q) return haves
    return haves.filter(h =>
      `${h.name || ''} ${h.set_code || ''} ${h.collector_number || ''}`.toLowerCase().includes(q))
  }, [haves, haveQuery])

  const done = useMemo(() => ({
    availability: open && !!nickname,
    haves: haves.length > 0,
    wants: wantIds.length > 0,
    share: false,
  }), [open, nickname, haves.length, wantIds.length])

  const step = STEPS[stepIndex]
  const live = open && !!nickname && haves.length > 0

  return (
    <Modal
      onClose={onClose}
      // Every step persists as it changes, so closing costs nothing — except a
      // trade note mid-edit, which is the one thing worth holding the door for.
      closeOnOverlay={!editingNote}
      className={styles.modal}
      contentClassName={styles.modalContent}
    >
      <div className={styles.body}>
        <div className={styles.header}>
          <span className={styles.title}>Trade Post</span>
          <span className={`${styles.liveChip}${live ? ' ' + styles.liveChipOn : ''}`}>
            {live ? 'Live' : open ? 'Incomplete' : 'Closed'}
          </span>
        </div>

        {/* Node stepper — step links, not tabs. */}
        <nav className={styles.stepper} ref={stepperRef} aria-label="Trade post setup steps">
          {STEPS.map((s, i) => {
            const isDone = done[s.id]
            const active = i === stepIndex
            const isLast = s.id === 'share'
            return (
              <button
                key={s.id}
                type="button"
                className={`${styles.node}${active ? ' ' + styles.nodeActive : ''}${isDone ? ' ' + styles.nodeDone : ''}`}
                onClick={() => setStepIndex(i)}
                aria-current={active ? 'step' : undefined}
              >
                <span className={styles.nodeRow}>
                  <span className={`${styles.connector}${i === 0 ? ' ' + styles.connectorHidden : ''}${done[STEPS[i - 1]?.id] ? ' ' + styles.connectorFill : ''}`} />
                  <span className={styles.dot}>
                    {isDone ? <CheckIcon size={12} /> : <span className={styles.dotNum}>{isLast ? '★' : i + 1}</span>}
                  </span>
                  <span className={`${styles.connector}${i === STEPS.length - 1 ? ' ' + styles.connectorHidden : ''}${isDone ? ' ' + styles.connectorFill : ''}`} />
                </span>
                <span className={styles.nodeLabel}>{s.label}</span>
              </button>
            )
          })}
        </nav>

        <div className={styles.main}>
          {loading ? (
            <EmptyState>Loading your trade post…</EmptyState>
          ) : step.id === 'availability' ? (
            <>
              <p className={styles.stepDesc}>
                While you’re open, anyone with your link can see what you’ll trade away and what you want,
                and signed-in visitors can send you proposals.
              </p>
              <button
                type="button"
                className={`${styles.bigToggle}${open ? ' ' + styles.bigToggleOn : ''}`}
                aria-pressed={open}
                onClick={toggleOpen}
              >
                <span className={styles.toggleTrack}><span className={styles.knob} /></span>
                <span className={styles.toggleText}>
                  <span className={styles.toggleTitle}>{open ? 'Open to trades' : 'Closed'}</span>
                  <span className={styles.toggleSub}>
                    {open
                      ? 'Your post is visible to anyone with the link.'
                      : 'Visitors see “not open to trades right now”.'}
                  </span>
                </span>
              </button>

              {!nickname && (
                <div className={styles.warnBox}>
                  You need a nickname before your post has a shareable address.{' '}
                  <Link to="/settings" className={styles.inlineLink}>Set one in Settings →</Link>
                </div>
              )}
            </>
          ) : step.id === 'haves' ? (
            <>
              <p className={styles.stepDesc}>
                These are the exact copies in your <strong>For Trade</strong> binder — a specific printing and
                finish out of your collection. Add or remove them in Binders; here you can leave a note about
                condition or language.
              </p>
              <div className={styles.stepBar}>
                {/* SearchInput puts `className` on a bare <input> with no base
                    styles — the field look and the flex sizing are separate. */}
                <SearchInput
                  wrapClassName={styles.stepSearchWrap}
                  className={styles.stepSearchInput}
                  value={haveQuery}
                  onChange={e => setHaveQuery(e.target.value)}
                  onClear={() => setHaveQuery('')}
                  placeholder={`Filter ${haves.length} card${haves.length === 1 ? '' : 's'}…`}
                />
                <Link className={styles.manageLink} to="/binders">Manage in Binders →</Link>
              </div>

              {!haves.length ? (
                <EmptyState>
                  Your For Trade binder is empty. Add owned cards to it in Binders and they’ll be listed here.
                </EmptyState>
              ) : !filteredHaves.length ? (
                <EmptyState>No cards match “{haveQuery}”.</EmptyState>
              ) : (
                <div className={styles.haveList}>
                  {filteredHaves.map(h => (
                    <div key={h.folderCardId} className={styles.haveRow}>
                      {h.image_uri
                        ? <CardImg className={styles.haveThumb} url={h.image_uri} forceTier="small" loading="lazy" />
                        : <div className={styles.haveThumbEmpty} />}
                      <div className={styles.haveMain}>
                        <div className={styles.haveName}>{h.name || 'Card'}{h.foil ? ' ✦' : ''}</div>
                        <div className={styles.haveSet}>
                          {(h.set_code || '').toUpperCase()} #{h.collector_number}{h.qty > 1 ? ` · ×${h.qty}` : ''}
                        </div>
                        {editingNote === h.folderCardId ? (
                          <input
                            className={styles.haveNote}
                            autoFocus
                            defaultValue={h.note}
                            maxLength={160}
                            placeholder="Condition, language…"
                            onBlur={e => saveNote(h.folderCardId, e.target.value.trim())}
                            onKeyDown={e => {
                              if (e.key === 'Enter') e.currentTarget.blur()
                              if (e.key === 'Escape') setEditingNote(null)
                            }}
                          />
                        ) : h.note ? (
                          <button type="button" className={styles.noteText} onClick={() => setEditingNote(h.folderCardId)}>
                            “{h.note}”
                          </button>
                        ) : null}
                      </div>
                      {editingNote !== h.folderCardId && !h.note && (
                        <button
                          type="button"
                          className={styles.noteBtn}
                          onClick={() => setEditingNote(h.folderCardId)}
                          title="Add a note"
                        >
                          <EditIcon size={12} /> Note
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : step.id === 'wants' ? (
            <>
              <p className={styles.stepDesc}>
                Pick the wishlists to show on your post. Everything in them becomes your public “looking for” list.
              </p>
              {!wishlists.length ? (
                <EmptyState>
                  You have no wishlists yet. <Link to="/lists" className={styles.inlineLink}>Create one →</Link>
                </EmptyState>
              ) : (
                <div className={styles.wishGrid}>
                  {wishlists.map(w => {
                    const on = wantIds.includes(w.id)
                    return (
                      <button
                        key={w.id}
                        type="button"
                        className={`${styles.wishCard}${on ? ' ' + styles.wishCardOn : ''}`}
                        aria-pressed={on}
                        onClick={() => toggleWant(w.id)}
                      >
                        <span className={styles.wishCheck}>{on ? <CheckIcon size={12} /> : null}</span>
                        <span className={styles.wishMain}>
                          <span className={styles.wishName}>{w.name}</span>
                          <span className={styles.wishCount}>
                            {w.itemCount} card{w.itemCount === 1 ? '' : 's'}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <p className={styles.stepDesc}>
                {live
                  ? 'Your post is live. Share this link — anyone can view it, and signed-in visitors can propose a trade.'
                  : 'Your post isn’t live yet. Finish the steps above and it becomes visible at this address.'}
              </p>

              <div className={styles.summary}>
                <div className={styles.summaryRow}>
                  <span>Status</span><strong>{open ? 'Open to trades' : 'Closed'}</strong>
                </div>
                <div className={styles.summaryRow}>
                  <span>Trading away</span><strong>{haves.length} card{haves.length === 1 ? '' : 's'}</strong>
                </div>
                <div className={styles.summaryRow}>
                  <span>Wishlists featured</span><strong>{wantIds.length}</strong>
                </div>
              </div>

              {nickname ? (
                <div className={styles.linkRow}>
                  <input readOnly value={url} className={styles.linkInput} onFocus={e => e.target.select()} />
                  <Button size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
                  <a className={styles.previewLink} href={url} target="_blank" rel="noreferrer">Preview</a>
                </div>
              ) : (
                <div className={styles.warnBox}>
                  Set a nickname to get a shareable link.{' '}
                  <Link to="/settings" className={styles.inlineLink}>Settings →</Link>
                </div>
              )}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <Button
            variant="ghost"
            disabled={stepIndex === 0}
            onClick={() => setStepIndex(i => Math.max(0, i - 1))}
          >
            Back
          </Button>
          <div className={styles.footerSpacer} />
          {stepIndex < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => setStepIndex(i => i + 1)}>
              Next: {STEPS[stepIndex + 1].label}
            </Button>
          ) : (
            <Button variant="primary" onClick={onClose}>Done</Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
