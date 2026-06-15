import { useEffect, useMemo, useState } from 'react'
import { Modal, Button, ProgressBar } from '../UI'
import { CheckIcon } from '../../icons'
import { getLocalCards, getLocalCardPrints } from '../../lib/db'
import { getInstantCache } from '../../lib/scryfall'
import { fetchEdhrecCommander } from '../../lib/deckBuilderApi'
import {
  analyzeBuildPlan,
  enrichPlanWithEdhrec,
  coarseRole,
  ROLE_ORDER,
} from '../../lib/deckBuildAssistant'
import styles from './BuildAssistant.module.css'

// Guided "build from collection" wizard. Walks the user role-by-role (Ramp →
// Card Advantage → Removal → …), surfacing their owned color-legal cards first
// and EDHREC suggestions for what they don't own yet. Adding a card delegates
// to the parent's addCardToDeck (passed as onAddCard) — owned cards go in as
// full Scryfall objects, upgrades go in as EDHREC rec objects (deck_cards is
// intended contents, so not-owned cards are legitimately addable).

function roleNameSet(deckCards) {
  return new Set((deckCards || []).map(c => (c?.name || '').toLowerCase()).filter(Boolean))
}

// Live per-role counts from the actual deck contents (not just owned
// candidates) so the progress bars reflect everything in the deck.
function countByRole(deckCards, sfMap) {
  const counts = new Map(ROLE_ORDER.map(r => [r, 0]))
  for (const dc of deckCards || []) {
    if (dc?.is_commander) continue
    const sfCard = sfMap?.[dc?.scryfall_id] || null
    const role = coarseRole(dc, sfCard)
    counts.set(role, (counts.get(role) || 0) + (dc.qty || 1))
  }
  return counts
}

const SUMMARY_STEP = '__summary__'

// Mana-curve buckets for the summary step (top end collapses into "6+").
const CURVE_BUCKETS = [0, 1, 2, 3, 4, 5, 6]
function curveLabel(b) { return b === 6 ? '6+' : String(b) }

export function BuildAssistant({ userId, commander, deckCards = [], onAddCard, onAddToWishlist, onClose }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [plan, setPlan] = useState(null) // enriched plan (candidates + upgrades)
  const [sfMap, setSfMap] = useState({})
  const [stepIndex, setStepIndex] = useState(0)
  // Names the user added this session — instant feedback before the deckCards
  // prop round-trips back from the parent.
  const [addedNames, setAddedNames] = useState(() => new Set())
  const [wishlistedNames, setWishlistedNames] = useState(() => new Set())

  const hasCommander = !!commander?.name

  useEffect(() => {
    let cancelled = false
    if (!hasCommander) { setLoading(false); return }
    ;(async () => {
      try {
        setLoading(true)
        const [owned, prints, cache] = await Promise.all([
          getLocalCards(userId),
          getLocalCardPrints().catch(() => []),
          getInstantCache().catch(() => null),
        ])
        const map = cache || {}
        // Post-5d owned rows may lack scryfall_id; resolve it via card_prints so
        // classification (oracle/type from sfMap) and color-identity filtering
        // actually work. Without this, every card falls back to Synergy.
        const printById = new Map((prints || []).map(p => [p.id, p]))
        const ownedNorm = (owned || []).map(c => {
          if (c?.scryfall_id) return c
          const print = c?.card_print_id ? printById.get(c.card_print_id) : null
          return print?.scryfall_id ? { ...c, scryfall_id: print.scryfall_id } : c
        })
        const base = analyzeBuildPlan({
          commander,
          ownedCards: ownedNorm,
          sfMap: map,
          currentDeckCards: deckCards,
        })
        const enriched = await enrichPlanWithEdhrec(base, fetchEdhrecCommander)
        if (cancelled) return
        setSfMap(map)
        setPlan(enriched)
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to analyze your collection.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // Re-run only when the commander identity changes — not on every deck edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, commander?.name, (commander?.color_identity || []).join('')])

  // Live counts derived from the current deck (recomputes as cards are added).
  const liveCounts = useMemo(() => countByRole(deckCards, sfMap), [deckCards, sfMap])
  const deckNames = useMemo(() => roleNameSet(deckCards), [deckCards])

  const steps = useMemo(() => [...ROLE_ORDER, SUMMARY_STEP], [])
  const currentRoleName = steps[stepIndex]
  const onSummary = currentRoleName === SUMMARY_STEP
  const roleData = onSummary ? null : (plan?.roles?.find(r => r.role === currentRoleName) || null)

  const isAdded = name => addedNames.has(name.toLowerCase()) || deckNames.has(name.toLowerCase())
  const isWishlisted = name => wishlistedNames.has(name.toLowerCase())

  // Mana curve for the summary step: count nonland deck cards per CMC bucket.
  const curve = useMemo(() => {
    const counts = CURVE_BUCKETS.map(() => 0)
    for (const dc of deckCards || []) {
      if (dc?.is_commander) continue
      const sfCard = sfMap?.[dc?.scryfall_id] || null
      const type = (sfCard?.type_line || dc?.type_line || '').toLowerCase()
      if (type.includes('land')) continue
      const cmc = Math.floor(sfCard?.cmc ?? dc?.cmc ?? 0)
      const idx = Math.min(cmc, 6)
      counts[idx] += dc.qty || 1
    }
    return counts
  }, [deckCards, sfMap])

  const totalCards = useMemo(
    () => (deckCards || []).reduce((sum, dc) => sum + (dc.qty || 1), 0),
    [deckCards],
  )

  async function handleAdd(cardOrRec, name) {
    const key = name.toLowerCase()
    if (isAdded(name)) return
    setAddedNames(prev => new Set(prev).add(key))
    try {
      await onAddCard(cardOrRec)
    } catch {
      // Roll back the optimistic flag if the add failed.
      setAddedNames(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  async function handleWishlist(name) {
    const key = name.toLowerCase()
    if (isWishlisted(name) || typeof onAddToWishlist !== 'function') return
    setWishlistedNames(prev => new Set(prev).add(key))
    try {
      await onAddToWishlist(name)
    } catch {
      setWishlistedNames(prev => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  if (!hasCommander) {
    return (
      <Modal onClose={onClose} className={styles.modal}>
        <div className={styles.body}>
          <div className={styles.title}>Build from Collection</div>
          <div className={styles.empty}>
            Set a commander first — the assistant uses its color identity to pick
            legal cards from your collection.
          </div>
          <div className={styles.footer}>
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      </Modal>
    )
  }

  const current = liveCounts.get(currentRoleName) || 0
  const target = roleData?.target || 0
  const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0
  const gap = Math.max(0, target - current)

  return (
    <Modal onClose={onClose} className={styles.modal}>
      <div className={styles.body}>
        <div className={styles.header}>
          <div className={styles.title}>Build from Collection</div>
          <div className={styles.commander}>{commander.name}</div>
        </div>

        {/* Stepper */}
        <div className={styles.stepper}>
          {steps.map((role, i) => {
            if (role === SUMMARY_STEP) {
              return (
                <button
                  key={role}
                  className={`${styles.step}${i === stepIndex ? ' ' + styles.stepActive : ''}`}
                  onClick={() => setStepIndex(i)}
                  title="Summary"
                >
                  <span>Summary</span>
                </button>
              )
            }
            const c = liveCounts.get(role) || 0
            const t = plan?.roles?.find(r => r.role === role)?.target || 0
            const done = t > 0 && c >= t
            return (
              <button
                key={role}
                className={`${styles.step}${i === stepIndex ? ' ' + styles.stepActive : ''}${done ? ' ' + styles.stepDone : ''}`}
                onClick={() => setStepIndex(i)}
                title={`${role}: ${c}/${t}`}
              >
                {done && <CheckIcon size={11} />}
                <span>{role}</span>
              </button>
            )
          })}
        </div>

        {loading && <div className={styles.empty}>Analyzing your collection…</div>}
        {error && <div className={styles.error}>{error}</div>}

        {!loading && !error && roleData && (
          <div className={styles.rolePanel}>
            <div className={styles.roleHead}>
              <div className={styles.roleName}>{currentRoleName}</div>
              <div className={styles.roleCount}>
                {current} / {target}
                {gap > 0 && <span className={styles.gap}> · {gap} to go</span>}
              </div>
            </div>
            <ProgressBar value={pct} />

            {/* Owned candidates */}
            <div className={styles.sectionLabel}>From your collection</div>
            {roleData.ownedCandidates.length === 0 ? (
              <div className={styles.emptySmall}>No owned cards match this role in your colors.</div>
            ) : (
              <div className={styles.cardList}>
                {roleData.ownedCandidates.map(cand => {
                  const added = isAdded(cand.name)
                  return (
                    <button
                      key={cand.card?.id || cand.name}
                      className={`${styles.cardRow}${added ? ' ' + styles.cardRowAdded : ''}`}
                      onClick={() => handleAdd(cand.sfCard || cand.card, cand.name)}
                      disabled={added}
                    >
                      <span className={styles.cardName}>{cand.name}</span>
                      <span className={styles.cardMeta}>
                        {cand.edhrecInclusion > 0 && <span className={styles.incl}>{cand.edhrecInclusion}%</span>}
                        {added ? <CheckIcon size={13} /> : <span className={styles.add}>+</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* EDHREC upgrades (not owned) */}
            {roleData.edhrecUpgrades.length > 0 && (
              <>
                <div className={styles.sectionLabel}>Popular picks you don’t own</div>
                <div className={styles.cardList}>
                  {roleData.edhrecUpgrades.map(up => {
                    const added = isAdded(up.name)
                    const wished = isWishlisted(up.name)
                    return (
                      <div key={up.slug || up.name} className={`${styles.cardRow} ${styles.cardRowUpgrade}`}>
                        <span className={styles.cardName}>{up.name}</span>
                        <span className={styles.cardMeta}>
                          {up.edhrecInclusion > 0 && <span className={styles.incl}>{up.edhrecInclusion}%</span>}
                          <button
                            className={`${styles.miniBtn}${added ? ' ' + styles.miniBtnDone : ''}`}
                            onClick={() => handleAdd(up, up.name)}
                            disabled={added}
                            title="Add to the deck list"
                          >
                            {added ? <CheckIcon size={12} /> : '+ Deck'}
                          </button>
                          {typeof onAddToWishlist === 'function' && (
                            <button
                              className={`${styles.miniBtn}${wished ? ' ' + styles.miniBtnDone : ''}`}
                              onClick={() => handleWishlist(up.name)}
                              disabled={wished}
                              title="Add to a wishlist"
                            >
                              {wished ? <CheckIcon size={12} /> : '+ Wishlist'}
                            </button>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Summary step */}
        {!loading && !error && onSummary && plan && (
          <div className={styles.rolePanel}>
            <div className={styles.sectionLabel}>Deck composition</div>
            <div className={styles.summaryGrid}>
              {plan.roles.map(r => {
                const c = liveCounts.get(r.role) || 0
                const met = c >= r.target
                return (
                  <div key={r.role} className={styles.summaryRow}>
                    <span className={styles.summaryRole}>{r.role}</span>
                    <span className={`${styles.summaryCount}${met ? ' ' + styles.summaryMet : ' ' + styles.summaryUnder}`}>
                      {c} / {r.target}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className={styles.summaryTotals}>
              <span><strong>{totalCards}</strong> / {plan.deckSize} cards</span>
              <span>{Math.max(0, plan.deckSize - totalCards)} slots left</span>
            </div>

            <div className={styles.sectionLabel}>Mana curve (nonland)</div>
            <div className={styles.curve}>
              {(() => {
                const max = Math.max(1, ...curve)
                return CURVE_BUCKETS.map((b, i) => (
                  <div key={b} className={styles.curveCol}>
                    <div className={styles.curveBarWrap}>
                      <div className={styles.curveBar} style={{ height: `${(curve[i] / max) * 100}%` }} />
                    </div>
                    <div className={styles.curveCount}>{curve[i]}</div>
                    <div className={styles.curveLabel}>{curveLabel(b)}</div>
                  </div>
                ))
              })()}
            </div>
          </div>
        )}

        <div className={styles.footer}>
          <Button
            variant="ghost"
            disabled={stepIndex === 0}
            onClick={() => setStepIndex(i => Math.max(0, i - 1))}
          >
            Back
          </Button>
          <div className={styles.footerSpacer} />
          {stepIndex < steps.length - 1 ? (
            <Button variant="primary" onClick={() => setStepIndex(i => Math.min(steps.length - 1, i + 1))}>
              Next: {steps[stepIndex + 1] === SUMMARY_STEP ? 'Summary' : steps[stepIndex + 1]}
            </Button>
          ) : (
            <Button variant="primary" onClick={onClose}>Done</Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
