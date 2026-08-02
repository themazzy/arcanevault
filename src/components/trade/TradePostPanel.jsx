import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../Auth'
import { useSettings } from '../SettingsContext'
import { useToast } from '../ToastContext'
import { Button, EmptyState } from '../UI'
import { getPublicAppUrl } from '../../lib/publicUrl'
import { ensureTradeBinder } from '../../lib/tradeBinder'
import {
  getTradeSettings, getTradeBinderCards,
  respondToTradeProposal, cancelTradeProposal, completeTradeProposal,
} from '../../lib/tradePost'
import {
  deriveProposalSides, nextProposalAction, isProposalClosed, sortProposals, PROPOSAL_STAGES,
} from '../../lib/tradeProposals'
import TradePostWizard from './TradePostWizard'
import styles from './TradePostPanel.module.css'

// ── Owner: your Trade Post at a glance ───────────────────────────────────────
// Deliberately a summary, not a form. All the editing lives in TradePostWizard,
// because the settings are three unrelated concerns (availability, which cards,
// which wishlists) and stacking them in one column buried the wishlist picker
// under every card in the For Trade binder.
export function TradePostManager() {
  const { user } = useAuth()
  const { nickname } = useSettings()
  const toast = useToast()

  const [state, setState] = useState(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    if (!user?.id) return
    try {
      const binder = await ensureTradeBinder(user.id)
      const [{ trade_open, trade_wants }, binderCards] = await Promise.all([
        getTradeSettings(user.id),
        binder ? getTradeBinderCards(binder.id) : Promise.resolve([]),
      ])
      setState({ open: trade_open, wantCount: trade_wants.length, haveCount: binderCards.length })
    } catch {
      toast.error('Could not load your trade post.')
      setState({ open: false, wantCount: 0, haveCount: 0 })
    }
  }, [user?.id, toast])

  useEffect(() => { load() }, [load])

  const url = nickname ? getPublicAppUrl(`/trade/${encodeURIComponent(nickname)}`) : ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* clipboard unavailable — the field is selectable */ }
  }

  if (!state) return <EmptyState>Loading your trade post…</EmptyState>

  const live = state.open && !!nickname && state.haveCount > 0
  // What's missing, in the order the wizard asks for it.
  const blocker = !nickname ? 'Set a nickname to get a shareable link.'
    : !state.open ? 'You’re closed to trades — nobody can see your post.'
    : state.haveCount === 0 ? 'Your For Trade binder is empty, so there’s nothing to trade away.'
    : null

  return (
    <>
      <div className={styles.statusCard}>
        <div className={styles.statusHead}>
          <div className={styles.statusWho}>
            <span className={`${styles.statusDot}${live ? ' ' + styles.statusDotLive : ''}`} />
            <span className={styles.statusTitle}>{live ? 'Your trade post is live' : 'Your trade post isn’t live'}</span>
          </div>
          <Button size="sm" onClick={() => setWizardOpen(true)}>
            {live ? 'Edit' : 'Set up'}
          </Button>
        </div>

        {blocker && <div className={styles.statusBlocker}>{blocker}</div>}

        <div className={styles.statusStats}>
          <div className={styles.statusStat}>
            <span className={styles.statusNum}>{state.haveCount}</span>
            <span className={styles.statusLabel}>Trading away</span>
          </div>
          <div className={styles.statusStat}>
            <span className={styles.statusNum}>{state.wantCount}</span>
            <span className={styles.statusLabel}>Wishlists shown</span>
          </div>
        </div>

        {nickname && (
          <div className={styles.linkRow}>
            <input readOnly value={url} className={styles.linkInput} onFocus={e => e.target.select()} />
            <Button size="sm" variant="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            <a className={styles.previewLink} href={url} target="_blank" rel="noreferrer">Preview</a>
          </div>
        )}
      </div>

      {wizardOpen && (
        <TradePostWizard
          onClose={() => { setWizardOpen(false); load() }}
          onSaved={load}
        />
      )}
    </>
  )
}

// ── Proposals inbox: both directions ─────────────────────────────────────────
// The central UX point: accepting a proposal agrees to meet, it does not move
// cards. The stage strip makes that legible, and the only path to inventory is
// the explicit "Update my collection" hand-off into the Compare tab.

function ProposalCardList({ items }) {
  if (!items?.length) return <span className={styles.propEmpty}>Nothing listed</span>
  return (
    <span className={styles.propCards}>
      {items.map((c, i) => (
        <span key={i} className={styles.propChip}>
          {c.name}{c.foil ? ' ✦' : ''}{c.qty > 1 ? ` ×${c.qty}` : ''}
        </span>
      ))}
    </span>
  )
}

const STAGE_LABELS = [['pending', 'Proposed'], ['accepted', 'Accepted'], ['completed', 'Traded']]

function StageStrip({ status }) {
  if (isProposalClosed(status)) return null
  const reached = PROPOSAL_STAGES.indexOf(status)
  return (
    <div className={styles.stages} role="presentation">
      {STAGE_LABELS.map(([id, label], i) => (
        <span
          key={id}
          className={`${styles.stage}${i <= reached ? ' ' + styles.stageOn : ''}`}
        >
          <span className={styles.stageDot} />{label}
        </span>
      ))}
    </div>
  )
}

function relativeTime(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return ''
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function ProposalCard({ proposal, busy, onRespond, onCancel, onComplete, onSettle }) {
  const { give, receive } = deriveProposalSides(proposal)
  const action = nextProposalAction(proposal)
  const disabled = busy === proposal.id

  return (
    <div className={`${styles.proposal} ${styles['status_' + proposal.status]}`}>
      <div className={styles.propHead}>
        <div className={styles.propWho}>
          {/* Direction is a property of the row, not a tab you switch to. */}
          <span className={styles.propDir}>{proposal.is_owner ? 'From' : 'To'}</span>
          <strong>{proposal.counterpart || 'Someone'}</strong>
          <span className={styles.propTime}>{relativeTime(proposal.created_at)}</span>
        </div>
        <span className={`${styles.propStatus} ${styles['pill_' + proposal.status]}`}>
          {proposal.status === 'completed' ? 'traded' : proposal.status}
        </span>
      </div>

      <StageStrip status={proposal.status} />

      <div className={styles.propGrid}>
        <div>
          <span className={styles.propLabel}>You give</span>
          <ProposalCardList items={give} />
        </div>
        <div>
          <span className={styles.propLabel}>You receive</span>
          <ProposalCardList items={receive} />
        </div>
      </div>

      {proposal.note && <div className={styles.propNote}>“{proposal.note}”</div>}

      {action === 'respond' && (
        <div className={styles.propHint}>Accepting agrees to the trade — it doesn’t move any cards yet.</div>
      )}
      {action === 'complete' && (
        <div className={styles.propHint}>
          Once you’ve actually swapped the cards in person, mark it as traded.
          {proposal.their_settled ? ' They’ve already updated their collection.' : ''}
        </div>
      )}
      {action === 'settle' && (
        <div className={styles.propHint}>
          This trade is confirmed. Review it in Compare to apply it to your collection.
        </div>
      )}
      {action === 'done' && (
        <div className={styles.propDone}>✓ Applied to your collection.</div>
      )}

      {action !== 'none' && action !== 'done' && (
        <div className={styles.propActions}>
          {action === 'respond' && <>
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onRespond(proposal.id, 'declined')}>Decline</Button>
            <Button size="sm" disabled={disabled} onClick={() => onRespond(proposal.id, 'accepted')}>Accept</Button>
          </>}
          {action === 'cancel' && (
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onCancel(proposal.id)}>Withdraw</Button>
          )}
          {action === 'complete' && (
            <Button size="sm" disabled={disabled} onClick={() => onComplete(proposal.id)}>Mark as traded</Button>
          )}
          {action === 'settle' && (
            <Button size="sm" disabled={disabled} onClick={() => onSettle(proposal)}>Update my collection →</Button>
          )}
        </div>
      )}
    </div>
  )
}

export function ProposalsInbox({ data, setData }) {
  const toast = useToast()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(null)

  // Patch a row in whichever direction holds it.
  const run = async (id, fn, changes, message) => {
    setBusy(id)
    try {
      await fn()
      setData(prev => ({
        incoming: prev.incoming.map(p => p.id === id ? { ...p, ...changes } : p),
        outgoing: prev.outgoing.map(p => p.id === id ? { ...p, ...changes } : p),
      }))
      toast.success(message)
    } catch (e) {
      toast.error(e?.message || 'Could not update proposal.')
    } finally { setBusy(null) }
  }

  const onRespond = (id, status) => run(
    id,
    () => respondToTradeProposal(id, status),
    { status },
    status === 'accepted' ? 'Accepted — no cards moved yet.' : 'Proposal declined.',
  )

  const onCancel = (id) => run(
    id, () => cancelTradeProposal(id), { status: 'cancelled' }, 'Proposal withdrawn.',
  )

  const onComplete = (id) => run(
    id, () => completeTradeProposal(id), { status: 'completed' }, 'Marked as traded.',
  )

  const onSettle = (proposal) => navigate(`/trading?tab=compare&settle=${proposal.id}`)

  if (data === null) return <EmptyState>Loading proposals…</EmptyState>

  const rows = sortProposals(data.incoming, data.outgoing)
  if (!rows.length) {
    return (
      <EmptyState>
        No trade proposals yet. They’ll appear here when someone proposes a trade from your
        trade post, or when you propose one from theirs.
      </EmptyState>
    )
  }

  return (
    <div className={styles.propList}>
      {rows.map(p => (
        <ProposalCard
          key={p.id}
          proposal={p}
          busy={busy}
          onRespond={onRespond}
          onCancel={onCancel}
          onComplete={onComplete}
          onSettle={onSettle}
        />
      ))}
    </div>
  )
}
