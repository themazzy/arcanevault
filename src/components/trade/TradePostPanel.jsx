import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { sb } from '../../lib/supabase'
import { useAuth } from '../Auth'
import { useSettings } from '../SettingsContext'
import { useToast } from '../ToastContext'
import { Button, EmptyState } from '../UI'
import { isGroupFolder } from '../../lib/collectionFetchers'
import { getPublicAppUrl } from '../../lib/publicUrl'
import { ensureTradeBinder } from '../../lib/tradeBinder'
import {
  getTradeSettings, setTradeSettings,
  getTradeBinderCards, setTradeCardOptions,
  getTradeProposals, respondToTradeProposal,
} from '../../lib/tradePost'
import styles from './TradePostPanel.module.css'

// ── Owner: manage your Trade Post (opt-in, featured wishlists, share link) ────
export function TradePostManager() {
  const { user } = useAuth()
  const { nickname } = useSettings()
  const toast = useToast()

  const [open, setOpen] = useState(false)
  const [wantIds, setWantIds] = useState([])
  const [wishlists, setWishlists] = useState([])
  const [haves, setHaves] = useState([])
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)

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
        setOpen(trade_open)
        setWantIds(trade_wants)
        setWishlists((listRes.data || []).filter(f => !isGroupFolder(f)))
        setHaves(binderCards)
      } catch {
        if (!cancelled) toast.error('Could not load your trade post.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [user?.id, toast])

  const updateHave = (folderCardId, patch, dbPatch) => {
    setHaves(prev => prev.map(h => h.folderCardId === folderCardId ? { ...h, ...patch } : h))
    setTradeCardOptions(folderCardId, dbPatch).catch(() => toast.error('Could not save card option.'))
  }

  const persist = useCallback(async (patch) => {
    try { await setTradeSettings(user.id, patch) }
    catch { toast.error('Could not save trade settings.') }
  }, [user?.id, toast])

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

  const url = nickname ? getPublicAppUrl(`/trade/${encodeURIComponent(nickname)}`) : ''
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch {}
  }

  if (loading) return <EmptyState>Loading your trade post…</EmptyState>

  return (
    <div className={styles.panel}>
      <div className={styles.intro}>
        Your trade post is a public page showing the cards you’ll trade away (your <strong>For Trade</strong> binder)
        and the cards you want (your featured wishlists). Signed-in viewers can send you trade proposals.
      </div>

      {/* Opt-in */}
      <div className={styles.row}>
        <div>
          <div className={styles.rowTitle}>Open to trades</div>
          <div className={styles.rowSub}>When off, your trade link shows “not open to trades”.</div>
        </div>
        <button
          type="button"
          className={`${styles.toggle}${open ? ' ' + styles.toggleOn : ''}`}
          aria-pressed={open}
          onClick={toggleOpen}
        ><span className={styles.knob} /></button>
      </div>

      {/* Share link */}
      <div className={styles.block}>
        <div className={styles.blockLabel}>Your trade link</div>
        {nickname ? (
          <div className={styles.linkRow}>
            <input readOnly value={url} className={styles.linkInput} onFocus={e => e.target.select()} />
            <Button size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            <a className={styles.previewLink} href={url} target="_blank" rel="noreferrer">Preview</a>
          </div>
        ) : (
          <div className={styles.rowSub}>Set a nickname in Settings to get a shareable trade link.</div>
        )}
      </div>

      {/* Haves */}
      <div className={styles.block}>
        <div className={styles.haveHead}>
          <div className={styles.blockLabel}>Trading away ({haves.length})</div>
          <Link className={styles.manageLink} to="/binders">Add / remove in Binders →</Link>
        </div>
        {haves.length ? (
          <div className={styles.haveList}>
            {haves.map(h => (
              <div key={h.folderCardId} className={styles.haveRow}>
                {h.image_uri
                  ? <img className={styles.haveThumb} src={h.image_uri} alt="" loading="lazy" />
                  : <div className={styles.haveThumbEmpty} />}
                <div className={styles.haveMain}>
                  <div className={styles.haveName}>{h.name || 'Card'}{h.foil ? ' ✦' : ''}</div>
                  <div className={styles.haveSet}>
                    {(h.set_code || '').toUpperCase()} #{h.collector_number}{h.qty > 1 ? ` · ×${h.qty}` : ''}
                  </div>
                  <input
                    className={styles.haveNote}
                    placeholder="Add a note (condition, language…)"
                    defaultValue={h.note}
                    maxLength={160}
                    onBlur={e => {
                      const note = e.target.value.trim()
                      if (note !== h.note) updateHave(h.folderCardId, { note }, { trade_note: note || null })
                    }}
                  />
                </div>
                <label className={styles.anyToggle} title="Trade any printing of this card">
                  <input
                    type="checkbox"
                    checked={h.anyVersion}
                    onChange={e => updateHave(h.folderCardId, { anyVersion: e.target.checked }, { trade_any_version: e.target.checked })}
                  />
                  <span>Any version</span>
                </label>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.rowSub}>
            Your <strong>For Trade</strong> binder is empty. Add owned cards to it in Binders to list them here.
          </div>
        )}
      </div>

      {/* Wants */}
      <div className={styles.block}>
        <div className={styles.blockLabel}>Featured wants</div>
        {wishlists.length ? (
          <div className={styles.wishlist}>
            {wishlists.map(w => (
              <label key={w.id} className={styles.wishItem}>
                <input type="checkbox" checked={wantIds.includes(w.id)} onChange={() => toggleWant(w.id)} />
                <span>{w.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <div className={styles.rowSub}>You have no wishlists yet. Create one to feature it here.</div>
        )}
      </div>
    </div>
  )
}

// ── Owner: incoming trade proposals ──────────────────────────────────────────
function ProposalCardList({ items }) {
  if (!items?.length) return <span className={styles.propEmpty}>—</span>
  return (
    <span className={styles.propCards}>
      {items.map((c, i) => <span key={i} className={styles.propChip}>{c.name}{c.foil ? ' ✦' : ''}</span>)}
    </span>
  )
}

export function ProposalsInbox() {
  const toast = useToast()
  const [proposals, setProposals] = useState(null)
  const [busy, setBusy] = useState(null)

  const load = useCallback(() => {
    getTradeProposals().then(setProposals).catch(() => setProposals([]))
  }, [])
  useEffect(() => { load() }, [load])

  const respond = async (id, status) => {
    setBusy(id)
    try {
      await respondToTradeProposal(id, status)
      setProposals(prev => prev.map(p => p.id === id ? { ...p, status } : p))
      toast.success(status === 'accepted' ? 'Proposal accepted.' : 'Proposal declined.')
    } catch (e) {
      toast.error(e?.message || 'Could not update proposal.')
    } finally { setBusy(null) }
  }

  if (proposals === null) return <EmptyState>Loading proposals…</EmptyState>
  if (!proposals.length) return <EmptyState>No trade proposals yet. They’ll appear here when someone proposes a trade from your trade post.</EmptyState>

  return (
    <div className={styles.inbox}>
      {proposals.map(p => (
        <div key={p.id} className={`${styles.proposal} ${styles['status_' + p.status]}`}>
          <div className={styles.propHead}>
            <strong>{p.proposer_name || 'Someone'}</strong>
            <span className={styles.propStatus}>{p.status}</span>
          </div>
          <div className={styles.propGrid}>
            <div><span className={styles.propLabel}>They want</span><ProposalCardList items={p.requested} /></div>
            <div><span className={styles.propLabel}>They offer</span><ProposalCardList items={p.offered} /></div>
          </div>
          {p.note && <div className={styles.propNote}>“{p.note}”</div>}
          {p.status === 'pending' && (
            <div className={styles.propActions}>
              <Button size="sm" variant="secondary" disabled={busy === p.id} onClick={() => respond(p.id, 'declined')}>Decline</Button>
              <Button size="sm" disabled={busy === p.id} onClick={() => respond(p.id, 'accepted')}>Accept</Button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
