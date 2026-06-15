import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, ProgressBar } from '../UI'
import { CheckIcon, CloseIcon, WarningIcon } from '../../icons'
import { getLocalCards, getLocalCardPrints } from '../../lib/db'
import { getInstantCache, getScryfallKey, getPrice, formatPrice } from '../../lib/scryfall'
import { useCombosFetch } from '../../hooks/useCombosFetch'
import { useSettings } from '../SettingsContext'
import { fetchEdhrecCommander, getCardImageUri } from '../../lib/deckBuilderApi'
import {
  analyzeBracket,
  fetchGameChangerNames,
  BRACKET_LABELS,
} from '../../lib/commanderBracket'
import {
  analyzeBuildPlan,
  enrichPlanWithEdhrec,
  archetypeAdjustments,
  applyTemplateAdjustments,
  bracketFlagFor,
  producedColors,
  countManaSources,
  coarseRole,
  COMMANDER_TEMPLATE,
  ROLE_ORDER,
  ROLE_RAMP,
  ROLE_DRAW,
  ROLE_REMOVAL,
  ROLE_WIPE,
  ROLE_PROTECTION,
  ROLE_WINCON,
  ROLE_SYNERGY,
  ROLE_LANDS,
} from '../../lib/deckBuildAssistant'
import styles from './BuildAssistant.module.css'

// Guided "build from collection" wizard. Walks the user role-by-role (Ramp →
// Card Advantage → Removal → …), surfacing their owned color-legal cards first
// and EDHREC suggestions for what they don't own yet. Adding a card delegates
// to the parent's addCardToDeck (owned → full Scryfall object, upgrades → EDHREC
// rec object; deck_cards is intended contents, so unowned cards are addable).

// What each role does + why the target count, shown at the top of each step.
const ROLE_INFO = {
  [ROLE_RAMP]: 'Mana acceleration — rocks, dorks, and land fetch. Helps you deploy your commander and spells ahead of curve.',
  [ROLE_DRAW]: 'Card advantage — draw engines and tutors that refill your hand and find your key pieces.',
  [ROLE_REMOVAL]: 'Spot interaction — destroy, exile, bounce, counter, or burn a single problematic permanent or spell.',
  [ROLE_WIPE]: 'Board wipes — mass removal to reset the board when you fall behind.',
  [ROLE_PROTECTION]: 'Protection — keep your commander and key permanents safe (hexproof, indestructible, redirects).',
  [ROLE_WINCON]: 'Game plan — how the deck actually closes: combos, extra turns, and big finishers.',
  [ROLE_SYNERGY]: 'Synergy — cards that support your commander’s theme and strategy. The bulk of the deck.',
  [ROLE_LANDS]: 'Mana base — lands, including utility lands. Aim for roughly this many to hit your colors consistently.',
}

function roleNameSet(deckCards) {
  return new Set((deckCards || []).map(c => (c?.name || '').toLowerCase()).filter(Boolean))
}

// Live per-role counts from the actual deck contents (not just owned
// candidates) so progress bars reflect everything in the deck.
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

// Card image from the cached Scryfall art (cards.scryfall.io CDN). We never hit
// api.scryfall.com per tile — that endpoint is rate-limited and floods to 429.
// Unowned upgrades have no cached art and fall back to a text placeholder.
function cardImageUrl(sfCard) {
  return sfCard ? getCardImageUri(sfCard, 'small') : null
}

// Shape an owned candidate into a Scryfall-card-like object the parent's
// addCardToDeck recognizes: it detects a "full card" via `.set` and reads
// `.id`/`.set` (getDeckBuilderCardMeta). The instant-cache entry only has
// `set_code`/`collector_number` and no `id`, so we remap and attach the owned
// row's resolved scryfall_id — otherwise the card falls into the EDHREC-rec
// branch and gets re-fetched by name, discarding the exact owned printing.
function ownedCardForAdd(cand) {
  const sf = cand?.sfCard
  if (!sf) return cand?.card // no cache entry → let the parent resolve by name
  return { ...sf, id: cand.card?.scryfall_id || sf.id || null, set: sf.set || sf.set_code || null }
}

const SUMMARY_STEP = '__summary__'
const MAX_TILES = 60 // cap owned tiles per step to keep the DOM light

// Budget chip ceilings. Raw numbers compared directly against getPrice() output,
// which is in the active price_source's native currency — the same source
// formatPrice() uses below, so threshold and card price always share units.
const BUDGET_CHIPS = [null, 1, 5, 20]

// Mana pip colors for the manabase step. A color is "thin" (amber) below this
// many sources — a soft floor, not a hard rule.
const MANA_HEX = { W: '#e9e0c0', U: '#3b7fd4', B: '#7a6b86', R: '#d4503b', G: '#4a9a5a' }
const THIN_SOURCE_FLOOR = 8

function ColorPips({ colors }) {
  if (!colors?.length) return null
  return (
    <span className={styles.pips}>
      {colors.map(c => (
        <span key={c} className={styles.pip} style={{ background: MANA_HEX[c] || '#888' }} title={c} />
      ))}
    </span>
  )
}

// Mana-curve buckets for the summary step (top end collapses into "6+").
const CURVE_BUCKETS = [0, 1, 2, 3, 4, 5, 6]
function curveLabel(b) { return b === 6 ? '6+' : String(b) }

// One card tile: image + name + sub-meta + add action(s).
function CardTile({ name, sfCard, subtitle, pips, inclusion, price, flag, overTarget, added, wished, showWishlist, onAdd, onWishlist }) {
  const img = cardImageUrl(sfCard)
  return (
    <div className={`${styles.tile}${added ? ' ' + styles.tileAdded : ''}`}>
      <div className={styles.tileArt}>
        {img
          ? <img src={img} alt={name} loading="lazy" className={styles.tileImg} />
          : <div className={styles.tileNoImg}>{name}</div>}
        {inclusion > 0 && <span className={styles.tileIncl}>{inclusion}%</span>}
        {price && <span className={styles.tilePrice}>{price}</span>}
        {flag && (
          <span
            className={`${styles.tileFlag}${overTarget ? ' ' + styles.tileFlagWarn : ''}`}
            title={overTarget
              ? `${flag.label} — pushes deck to Bracket ${flag.level} (${BRACKET_LABELS[flag.level]}), above your target`
              : `${flag.label} — Bracket ${flag.level}+ signal`}
          >
            {overTarget && <WarningIcon size={11} />}{flag.label}
          </span>
        )}
        {added && <span className={styles.tileCheck}><CheckIcon size={18} /></span>}
      </div>
      <div className={styles.tileName} title={name}>{name}</div>
      {pips?.length ? <div className={styles.tileSub}><ColorPips colors={pips} /></div>
        : subtitle ? <div className={styles.tileSub}>{subtitle}</div> : null}
      <div className={styles.tileActions}>
        <button
          className={`${styles.tileBtn}${added ? ' ' + styles.tileBtnDone : ''}`}
          onClick={onAdd}
          disabled={added}
        >
          {added ? 'Added' : '+ Deck'}
        </button>
        {showWishlist && (
          <button
            className={`${styles.tileBtn} ${styles.tileBtnAlt}${wished ? ' ' + styles.tileBtnDone : ''}`}
            onClick={onWishlist}
            disabled={wished}
            title="Add to a wishlist"
          >
            {wished ? 'Wished' : '+ Wishlist'}
          </button>
        )}
      </div>
    </div>
  )
}

export function BuildAssistant({ userId, commander, deckCards = [], accessToken, onAddCard, onRemoveCard, onAddToWishlist, onClose }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [plan, setPlan] = useState(null) // enriched plan (candidates + upgrades)
  const [sfMap, setSfMap] = useState({})
  const [stepIndex, setStepIndex] = useState(0)
  const [themes, setThemes] = useState([])       // EDHREC archetypes for this commander
  const [selectedTheme, setSelectedTheme] = useState('') // '' = Balanced
  const [rebuilding, setRebuilding] = useState(false)
  const [gameChangers, setGameChangers] = useState(null) // Set of GC names (null until loaded)
  const [targetBracket, setTargetBracket] = useState(null) // null = no target; 1-4
  const [maxPrice, setMaxPrice] = useState(null) // budget filter ceiling, null = off
  const [ownedNameSet, setOwnedNameSet] = useState(() => new Set())

  const { price_source } = useSettings()
  // Names added/wishlisted this session — instant feedback before the deckCards
  // prop round-trips back from the parent.
  const [addedNames, setAddedNames] = useState(() => new Set())
  const [wishlistedNames, setWishlistedNames] = useState(() => new Set())

  // Cached collection data so theme switches re-plan without re-reading IDB.
  const dataRef = useRef(null) // { ownedNorm, sfById }

  // Commander Spellbook combo lookup (shared hook). Drives an accurate bracket
  // estimate + the "combos you're close to" panel on the summary step.
  const combos = useCombosFetch({ commanderCard: commander, deckCards, accessToken })

  const hasCommander = !!commander?.name

  // Re-run the plan for a given archetype theme: flex the role quotas and swap
  // the suggestion source to that theme's EDHREC page (owned cards re-ranked by
  // theme synergy, upgrades drawn from the theme). '' = balanced template.
  const rebuildPlan = useCallback(async (themeSlug) => {
    const d = dataRef.current
    if (!d || !commander?.name) return
    setRebuilding(true)
    try {
      const template = applyTemplateAdjustments(COMMANDER_TEMPLATE, archetypeAdjustments(themeSlug))
      const base = analyzeBuildPlan({
        commander,
        ownedCards: d.ownedNorm,
        sfMap: d.sfById,
        currentDeckCards: deckCards,
        template,
      })
      const edhrec = await fetchEdhrecCommander(commander.name, 'commander', themeSlug ? { themeSlug } : undefined)
      const enriched = await enrichPlanWithEdhrec(base, async () => edhrec)
      setPlan(enriched)
    } finally {
      setRebuilding(false)
    }
  }, [commander, deckCards])

  useEffect(() => {
    let cancelled = false
    if (!hasCommander) { setLoading(false); return }
    ;(async () => {
      try {
        setLoading(true)
        setSelectedTheme('')
        const [owned, prints, cache, edhrec, gcNames] = await Promise.all([
          getLocalCards(userId),
          getLocalCardPrints().catch(() => []),
          getInstantCache().catch(() => null),
          fetchEdhrecCommander(commander.name).catch(() => null),
          fetchGameChangerNames().catch(() => null),
        ])
        // The instant cache is keyed by `${set}-${collector}` (getScryfallKey),
        // but the engine looks cards up by scryfall_id. Build a scryfall_id →
        // cached-entry map from local card_prints (no network — we already store
        // this data). This is what makes oracle-text classification and card art
        // work; without it everything fell back to Synergy with no images.
        const cacheBySetCol = cache || {}
        const sfById = {}
        const printById = new Map()
        for (const p of prints || []) {
          if (p?.id) printById.set(p.id, p)
          if (!p?.scryfall_id) continue
          const entry = cacheBySetCol[getScryfallKey(p)]
          if (entry) sfById[p.scryfall_id] = entry
        }
        // Post-5d owned rows may lack scryfall_id; resolve it via card_prints so
        // the engine's sfMap[card.scryfall_id] lookup hits.
        const ownedNorm = (owned || []).map(c => {
          if (c?.scryfall_id) return c
          const print = c?.card_print_id ? printById.get(c.card_print_id) : null
          return print?.scryfall_id ? { ...c, scryfall_id: print.scryfall_id } : c
        })
        const base = analyzeBuildPlan({
          commander,
          ownedCards: ownedNorm,
          sfMap: sfById,
          currentDeckCards: deckCards,
        })
        const enriched = await enrichPlanWithEdhrec(base, async () => edhrec)
        if (cancelled) return
        dataRef.current = { ownedNorm, sfById }
        setSfMap(sfById)
        setThemes(edhrec?.themes || [])
        setGameChangers(gcNames || null)
        setOwnedNameSet(new Set((ownedNorm || []).map(c => (c?.name || '').toLowerCase()).filter(Boolean)))
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

  function onSelectTheme(slug) {
    if (slug === selectedTheme) return
    setSelectedTheme(slug)
    rebuildPlan(slug)
  }

  const liveCounts = useMemo(() => countByRole(deckCards, sfMap), [deckCards, sfMap])
  const deckNames = useMemo(() => roleNameSet(deckCards), [deckCards])

  const steps = useMemo(() => [...ROLE_ORDER, SUMMARY_STEP], [])
  const currentRoleName = steps[stepIndex]
  const onSummary = currentRoleName === SUMMARY_STEP
  const roleData = onSummary ? null : (plan?.roles?.find(r => r.role === currentRoleName) || null)

  const isAdded = name => addedNames.has(name.toLowerCase()) || deckNames.has(name.toLowerCase())
  const isWishlisted = name => wishlistedNames.has(name.toLowerCase())

  const curve = useMemo(() => {
    const counts = CURVE_BUCKETS.map(() => 0)
    for (const dc of deckCards || []) {
      if (dc?.is_commander) continue
      const sfCard = sfMap?.[dc?.scryfall_id] || null
      const type = (sfCard?.type_line || dc?.type_line || '').toLowerCase()
      if (type.includes('land')) continue
      const cmc = Math.floor(sfCard?.cmc ?? dc?.cmc ?? 0)
      counts[Math.min(cmc, 6)] += dc.qty || 1
    }
    return counts
  }, [deckCards, sfMap])

  const totalCards = useMemo(
    () => (deckCards || []).reduce((sum, dc) => sum + (dc.qty || 1), 0),
    [deckCards],
  )

  // Pricing helpers (budget guidance). Cards with no price data pass the budget
  // filter (we can't judge them) and aren't counted in deck value.
  const priceOf = useCallback(
    (sfCard, foil = false) => getPrice(sfCard, foil, { price_source }),
    [price_source],
  )
  const passesBudget = useCallback(
    (sfCard) => {
      if (maxPrice == null) return true
      const v = priceOf(sfCard)
      return v == null || v <= maxPrice
    },
    [maxPrice, priceOf],
  )
  const deckValue = useMemo(() => {
    let total = 0
    for (const dc of deckCards || []) {
      const v = priceOf(sfMap?.[dc?.scryfall_id] || null, dc.foil)
      if (v != null) total += v * (dc.qty || 1)
    }
    return total
  }, [deckCards, sfMap, priceOf])

  // EDHREC inclusion by card name, from the enriched plan (owned + upgrades) —
  // used to rank cut candidates (least-played first).
  const inclusionByName = useMemo(() => {
    const m = new Map()
    for (const role of plan?.roles || []) {
      for (const c of role.ownedCandidates) m.set(c.name.toLowerCase(), c.edhrecInclusion || 0)
      for (const u of role.edhrecUpgrades) m.set(u.name.toLowerCase(), u.edhrecInclusion || 0)
    }
    return m
  }, [plan])

  // "What to cut": when the deck is over size or a role is over its quota,
  // suggest removals. Per over-quota role, rank that role's deck cards by
  // least-played (EDHREC inclusion) then highest CMC, and flag the excess.
  const cutPlan = useMemo(() => {
    if (!plan) return null
    const byRole = new Map(ROLE_ORDER.map(r => [r, []]))
    for (const dc of deckCards || []) {
      if (dc?.is_commander) continue
      const sf = sfMap?.[dc?.scryfall_id] || null
      const role = coarseRole(dc, sf)
      byRole.get(role)?.push({
        id: dc.id,
        name: dc.name,
        cmc: sf?.cmc ?? dc?.cmc ?? 0,
        inclusion: inclusionByName.get((dc.name || '').toLowerCase()) ?? 0,
      })
    }
    const overRoles = []
    for (const role of plan.roles) {
      const cards = byRole.get(role.role) || []
      const count = cards.length
      const excess = count - role.target
      if (excess <= 0) continue
      const ranked = [...cards].sort((a, b) => (a.inclusion - b.inclusion) || (b.cmc - a.cmc) || a.name.localeCompare(b.name))
      overRoles.push({ role: role.role, count, target: role.target, excess, cuts: ranked.slice(0, excess) })
    }
    // totalCards and deckSize both include the commander, so this is "over 100".
    return { over: totalCards - plan.deckSize, overRoles }
  }, [plan, deckCards, sfMap, inclusionByName, totalCards])

  // Completed combos in the deck → card-name lists for the bracket analyzer.
  const comboCardLists = useMemo(() => {
    if (!combos.fetched) return null
    return (combos.included || []).map(c =>
      (c.uses || []).map(u => u.card?.name || u.template?.name || '').filter(Boolean),
    )
  }, [combos.fetched, combos.included])

  // Live Commander Bracket estimate from the current deck. Becomes accurate once
  // combos are checked; until then it's a lower bound (combos not counted).
  const deckBracket = useMemo(() => {
    if (!gameChangers) return null
    const cards = (deckCards || []).map(dc => {
      const sf = sfMap?.[dc?.scryfall_id] || null
      return {
        name: dc.name,
        oracle_text: sf?.oracle_text || '',
        cmc: sf?.cmc ?? dc?.cmc ?? 0,
        qty: dc.qty || 1,
      }
    })
    return analyzeBracket({ cards, gameChangerNames: gameChangers, comboCardLists })
  }, [deckCards, sfMap, gameChangers, comboCardLists])

  const overTarget = targetBracket != null && deckBracket && deckBracket.bracket > targetBracket

  // Combos you're close to completing (1-2 missing pieces), owned-missing first.
  const almostCombos = useMemo(() => {
    if (!combos.fetched) return []
    return (combos.almost || [])
      .map(c => {
        const uses = (c.uses || []).map(u => u.card?.name || u.template?.name || '').filter(Boolean)
        const produces = (c.produces || []).map(p => p.feature?.name).filter(Boolean)
        const missing = uses
          .filter(n => !deckNames.has(n.toLowerCase()))
          .map(n => ({ name: n, owned: ownedNameSet.has(n.toLowerCase()) }))
        return { id: c.id, uses, produces, missing }
      })
      .filter(c => c.missing.length >= 1 && c.missing.length <= 2)
      .sort((a, b) => {
        const ao = a.missing.every(m => m.owned) ? 0 : 1
        const bo = b.missing.every(m => m.owned) ? 0 : 1
        return (ao - bo) || (a.missing.length - b.missing.length)
      })
      .slice(0, 12)
  }, [combos.fetched, combos.almost, deckNames, ownedNameSet])

  // Auto-check combos the first time the summary step is opened. Intentionally
  // one-shot (fires only on the first summary visit) to avoid hammering the
  // combo proxy on every deck edit — if the deck changes afterward the user
  // re-runs it via the "Check combos" button, and the bracket pill shows a
  // "(combos not checked)" hint until then.
  useEffect(() => {
    if (onSummary && hasCommander && !combos.fetched && !combos.loading) combos.fetchCombos()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSummary])

  // Manabase: commander colors + live colored-source counts from the deck.
  const cmdColors = useMemo(
    () => (commander?.color_identity || []).filter(c => 'WUBRG'.includes(c)),
    [commander],
  )
  const manaSources = useMemo(() => countManaSources(deckCards, sfMap), [deckCards, sfMap])
  const onLands = currentRoleName === ROLE_LANDS

  // For the Lands step, annotate candidates with the colors they produce and
  // surface fixers (lands that make more of the commander's colors) first.
  const landCandidates = useMemo(() => {
    if (!onLands || !roleData) return []
    return roleData.ownedCandidates
      .map(cand => {
        const colors = [...producedColors(cand.sfCard?.oracle_text, cand.sfCard?.type_line)]
        const matching = colors.filter(c => cmdColors.includes(c))
        return { cand, colors, score: matching.length }
      })
      .sort((a, b) => (b.score - a.score) || (b.colors.length - a.colors.length) || a.cand.name.localeCompare(b.cand.name))
  }, [onLands, roleData, cmdColors])

  async function handleAdd(cardOrRec, name) {
    const key = name.toLowerCase()
    if (isAdded(name)) return
    setAddedNames(prev => new Set(prev).add(key))
    try {
      await onAddCard(cardOrRec)
    } catch {
      setAddedNames(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }

  async function handleWishlist(name) {
    const key = name.toLowerCase()
    if (isWishlisted(name) || typeof onAddToWishlist !== 'function') return
    setWishlistedNames(prev => new Set(prev).add(key))
    try {
      await onAddToWishlist(name)
    } catch {
      setWishlistedNames(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }

  async function handleRemove(deckCardId) {
    if (typeof onRemoveCard !== 'function' || !deckCardId) return
    try { await onRemoveCard(deckCardId) } catch { /* parent surfaces errors */ }
  }

  if (!hasCommander) {
    return (
      <Modal onClose={onClose} className={styles.modal}>
        <div className={styles.body}>
          <div className={styles.title}>Build Assistant</div>
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
    <Modal onClose={onClose} className={styles.modal} contentClassName={styles.modalContent}>
      <div className={styles.body}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Build Assistant</div>
            <div className={styles.commander}>{commander.name}</div>
          </div>
          {!onSummary && (
            <div className={styles.stepCounter}>Step {stepIndex + 1} of {steps.length}</div>
          )}
        </div>

        {/* Stepper */}
        <div className={styles.stepper}>
          {steps.map((role, i) => {
            const isSummary = role === SUMMARY_STEP
            const c = liveCounts.get(role) || 0
            const t = plan?.roles?.find(r => r.role === role)?.target || 0
            const done = !isSummary && t > 0 && c >= t
            return (
              <button
                key={role}
                className={`${styles.step}${i === stepIndex ? ' ' + styles.stepActive : ''}${done ? ' ' + styles.stepDone : ''}`}
                onClick={() => setStepIndex(i)}
                title={isSummary ? 'Summary' : `${role}: ${c}/${t}`}
              >
                {done && <CheckIcon size={11} />}
                <span>{isSummary ? 'Summary' : role}</span>
              </button>
            )
          })}
        </div>

        {/* Archetype / theme selector — flexes quotas + suggestion source */}
        {!loading && !error && themes.length > 0 && (
          <div className={styles.themeRow}>
            <span className={styles.themeLabel}>Theme</span>
            <div className={styles.themeChips}>
              <button
                className={`${styles.themeChip}${selectedTheme === '' ? ' ' + styles.themeActive : ''}`}
                onClick={() => onSelectTheme('')}
                disabled={rebuilding}
              >
                Balanced
              </button>
              {themes.slice(0, 6).map(t => (
                <button
                  key={t.slug}
                  className={`${styles.themeChip}${selectedTheme === t.slug ? ' ' + styles.themeActive : ''}`}
                  onClick={() => onSelectTheme(t.slug)}
                  disabled={rebuilding}
                  title={`${t.count.toLocaleString()} decks on EDHREC`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {rebuilding && <span className={styles.themeBusy}>updating…</span>}
          </div>
        )}

        {/* Bracket target selector + live estimate */}
        {!loading && !error && gameChangers && (
          <div className={styles.themeRow}>
            <span className={styles.themeLabel}>Bracket</span>
            <div className={styles.themeChips}>
              <button
                className={`${styles.themeChip}${targetBracket == null ? ' ' + styles.themeActive : ''}`}
                onClick={() => setTargetBracket(null)}
              >
                Any
              </button>
              {[1, 2, 3, 4].map(b => (
                <button
                  key={b}
                  className={`${styles.themeChip}${targetBracket === b ? ' ' + styles.themeActive : ''}`}
                  onClick={() => setTargetBracket(b)}
                  title={BRACKET_LABELS[b]}
                >
                  {b} · {BRACKET_LABELS[b]}
                </button>
              ))}
            </div>
            {deckBracket && (
              <span
                className={`${styles.bracketNow}${overTarget ? ' ' + styles.bracketOver : ''}`}
                title={deckBracket.reasons.length
                  ? deckBracket.reasons.map(r => r.reason).join(' · ')
                  : 'No bracket-raising cards detected yet'}
              >
                Now: B{deckBracket.bracket} {BRACKET_LABELS[deckBracket.bracket]}
                {!deckBracket.combosChecked ? ' (combos not checked)' : ''}
              </span>
            )}
          </div>
        )}

        {/* Budget selector + live deck value */}
        {!loading && !error && (
          <div className={styles.themeRow}>
            <span className={styles.themeLabel}>Budget</span>
            <div className={styles.themeChips}>
              {BUDGET_CHIPS.map(b => (
                <button
                  key={b ?? 'any'}
                  className={`${styles.themeChip}${maxPrice === b ? ' ' + styles.themeActive : ''}`}
                  onClick={() => setMaxPrice(b)}
                  title={b == null ? 'No budget limit' : `Hide suggestions over ${formatPrice(b, price_source)}`}
                >
                  {b == null ? 'Any' : `≤ ${formatPrice(b, price_source)}`}
                </button>
              ))}
            </div>
            <span className={styles.bracketNow} title="Estimated value of the current deck">
              Deck: {formatPrice(deckValue, price_source)}
            </span>
          </div>
        )}

        {/* Over-target warning */}
        {overTarget && deckBracket && (
          <div className={styles.bracketWarn}>
            <WarningIcon size={13} /> Deck is at Bracket {deckBracket.bracket} ({BRACKET_LABELS[deckBracket.bracket]}), above your
            target of {targetBracket}. {deckBracket.reasons.filter(r => r.level > targetBracket).map(r => r.reason).join(' · ')}
          </div>
        )}

        <div className={styles.main}>
          {loading && <div className={styles.empty}>Analyzing your collection…</div>}
          {error && <div className={styles.error}>{error}</div>}

          {!loading && !error && roleData && (
            <>
              <div className={styles.roleHead}>
                <div className={styles.roleHeadTop}>
                  <div className={styles.roleName}>{currentRoleName}</div>
                  <div className={styles.roleCount}>
                    {current} / {target}
                    {gap > 0 ? <span className={styles.gap}> · {gap} to go</span>
                             : <span className={styles.met}> · target met</span>}
                  </div>
                </div>
                <div className={styles.roleDesc}>{ROLE_INFO[currentRoleName]}</div>
                <ProgressBar value={pct} />
              </div>

              {/* Manabase: colored-source counts (Lands step only) */}
              {onLands && cmdColors.length > 0 && (
                <div className={styles.sources}>
                  <span className={styles.sourcesLabel}>Mana sources</span>
                  {cmdColors.map(c => {
                    const n = manaSources[c] || 0
                    const thin = n < THIN_SOURCE_FLOOR
                    return (
                      <span key={c} className={`${styles.sourceItem}${thin ? ' ' + styles.sourceThin : ''}`}
                        title={thin ? `${c}: only ${n} sources — consider more fixing` : `${c}: ${n} sources`}>
                        <span className={styles.pip} style={{ background: MANA_HEX[c] }} />
                        {n}
                      </span>
                    )
                  })}
                  <span className={styles.sourcesTotal}>{manaSources.lands} lands</span>
                </div>
              )}

              {/* Owned candidates */}
              <div className={styles.sectionLabel}>
                From your collection · {roleData.ownedCandidates.length}
                {onLands && <span className={styles.sectionHint}> · fixers first</span>}
              </div>
              {(() => {
                // Budget filter (cards with unknown price always pass).
                const shown = onLands
                  ? landCandidates.filter(({ cand }) => passesBudget(cand.sfCard))
                  : roleData.ownedCandidates.filter(c => passesBudget(c.sfCard))
                if (roleData.ownedCandidates.length === 0) {
                  return <div className={styles.emptySmall}>No owned cards match this role in your colors.</div>
                }
                if (shown.length === 0) {
                  return <div className={styles.emptySmall}>No owned {currentRoleName.toLowerCase()} cards under your budget.</div>
                }
                return (
                  <>
                    <div className={styles.grid}>
                      {shown.slice(0, MAX_TILES).map(item => {
                        const cand = onLands ? item.cand : item
                        const priceVal = priceOf(cand.sfCard)
                        const flag = onLands ? null : bracketFlagFor(cand.name, cand.sfCard, gameChangers)
                        return (
                          <CardTile
                            key={cand.card?.id || cand.name}
                            name={cand.name}
                            sfCard={cand.sfCard}
                            pips={onLands ? item.colors : undefined}
                            subtitle={onLands ? undefined : cand.granularCat}
                            inclusion={onLands ? 0 : cand.edhrecInclusion}
                            price={priceVal != null ? formatPrice(priceVal, price_source) : null}
                            flag={flag}
                            overTarget={targetBracket != null && flag && flag.level > targetBracket}
                            added={isAdded(cand.name)}
                            onAdd={() => handleAdd(ownedCardForAdd(cand), cand.name)}
                          />
                        )
                      })}
                    </div>
                    {shown.length > MAX_TILES && (
                      <div className={styles.moreNote}>+{shown.length - MAX_TILES} more in your collection</div>
                    )}
                  </>
                )
              })()}

              {/* EDHREC upgrades (not owned) */}
              {roleData.edhrecUpgrades.length > 0 && (
                <>
                  <div className={styles.sectionLabel}>Popular picks you don’t own</div>
                  <div className={styles.grid}>
                    {roleData.edhrecUpgrades.map(up => {
                      const flag = bracketFlagFor(up.name, null, gameChangers)
                      return (
                        <CardTile
                          key={up.slug || up.name}
                          name={up.name}
                          sfCard={null}
                          subtitle={up.type}
                          inclusion={up.edhrecInclusion}
                          flag={flag}
                          overTarget={targetBracket != null && flag && flag.level > targetBracket}
                          added={isAdded(up.name)}
                          wished={isWishlisted(up.name)}
                          showWishlist={typeof onAddToWishlist === 'function'}
                          onAdd={() => handleAdd(up, up.name)}
                          onWishlist={() => handleWishlist(up.name)}
                        />
                      )
                    })}
                  </div>
                </>
              )}
            </>
          )}

          {/* Summary step */}
          {!loading && !error && onSummary && plan && (
            <>
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
                <span>Value: <strong>{formatPrice(deckValue, price_source)}</strong></span>
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

              {/* Combos */}
              <div className={styles.sectionLabel}>
                Combos
                {combos.fetched && <span className={styles.sectionHint}> · {(combos.included || []).length} complete in deck</span>}
              </div>
              {!combos.fetched ? (
                <div>
                  <button className={styles.themeChip} onClick={combos.fetchCombos} disabled={combos.loading}>
                    {combos.loading ? 'Checking combos…' : 'Check combos'}
                  </button>
                </div>
              ) : almostCombos.length === 0 ? (
                <div className={styles.emptySmall}>No near-complete combos found from your current list.</div>
              ) : (
                <div className={styles.comboList}>
                  {almostCombos.map(combo => {
                    const allOwned = combo.missing.every(m => m.owned)
                    return (
                      <div key={combo.id} className={styles.comboRow}>
                        <div className={styles.comboInfo}>
                          <div className={styles.comboProduces}>
                            {combo.produces.slice(0, 2).join(', ') || 'Combo'}
                            {allOwned && <span className={styles.comboOwnedTag}>you own the missing piece{combo.missing.length > 1 ? 's' : ''}</span>}
                          </div>
                          <div className={styles.comboUses}>{combo.uses.join(' + ')}</div>
                        </div>
                        <div className={styles.comboMissing}>
                          {combo.missing.map(m => (
                            m.owned ? (
                              <button
                                key={m.name}
                                className={`${styles.miniBtn}${isAdded(m.name) ? ' ' + styles.miniBtnDone : ''}`}
                                onClick={() => handleAdd({ name: m.name }, m.name)}
                                disabled={isAdded(m.name)}
                                title="Add this owned piece to the deck"
                              >
                                {isAdded(m.name) ? <CheckIcon size={11} /> : '+ '}{m.name}
                              </button>
                            ) : (
                              <span key={m.name} className={styles.comboNeed} title="Not in your collection">{m.name}</span>
                            )
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* What to cut */}
              {cutPlan && (cutPlan.over > 0 || cutPlan.overRoles.length > 0) && (
                <>
                  <div className={styles.sectionLabel}>
                    Trim
                    {cutPlan.over > 0
                      ? <span className={styles.sectionHint}> · {cutPlan.over} over 100</span>
                      : <span className={styles.sectionHint}> · roles over quota</span>}
                  </div>
                  {cutPlan.overRoles.length === 0 ? (
                    <div className={styles.emptySmall}>Deck is over 100 but every role is within quota — trim your longest/weakest cards.</div>
                  ) : (
                    <div className={styles.comboList}>
                      {cutPlan.overRoles.map(or => (
                        <div key={or.role} className={styles.comboRow}>
                          <div className={styles.comboInfo}>
                            <div className={styles.comboProduces}>
                              {or.role}
                              <span className={styles.comboOwnedTag} style={{ color: 'var(--gold)', borderColor: 'rgba(201,168,76,0.4)' }}>
                                {or.count}/{or.target} · cut {or.excess}
                              </span>
                            </div>
                            <div className={styles.comboUses}>Least-played first</div>
                          </div>
                          <div className={styles.comboMissing}>
                            {or.cuts.map(cut => (
                              <button
                                key={cut.id}
                                className={`${styles.miniBtn} ${styles.cutBtn}`}
                                onClick={() => handleRemove(cut.id)}
                                title={`Remove ${cut.name} (${cut.inclusion}% EDHREC, CMC ${cut.cmc})`}
                              >
                                <CloseIcon size={11} /> {cut.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
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
