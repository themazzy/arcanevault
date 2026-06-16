import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, ProgressBar, ResponsiveMenu } from '../UI'
import uiStyles from '../UI.module.css'
import { CheckIcon, DeleteIcon, WarningIcon, ChevronDownIcon } from '../../icons'
import { getLocalCards, getLocalCardPrints } from '../../lib/db'
import { getInstantCache, getScryfallKey, getPrice, formatPrice } from '../../lib/scryfall'
import { useCombosFetch } from '../../hooks/useCombosFetch'
import { useSettings } from '../SettingsContext'
import { fetchEdhrecCommander, fetchCardsByNames, fetchCardsByScryfallIds, fetchRecommenderRecs, fetchPaperPrintingsByNamesFromDb, getCardImageUri } from '../../lib/deckBuilderApi'
import { fetchCardPrintsByScryfallIds, fetchCardPrintsByOracleIds, cardPrintRowToSfEntry } from '../../lib/cardPrints'
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
  recommendedBasicCount,
  planBasicLands,
  isBasicLandName,
  rankCutCandidates,
  CUT_MODES,
  attachRecommenderUpgrades,
  selectUpgrades,
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

// Compact labels for the node stepper (full role names are too wide to sit
// under a 24px dot). The full name still shows in the role header + tooltip.
const STEP_SHORT = {
  [ROLE_RAMP]: 'Ramp',
  [ROLE_DRAW]: 'Draw',
  [ROLE_REMOVAL]: 'Removal',
  [ROLE_WIPE]: 'Wipe',
  [ROLE_PROTECTION]: 'Protection',
  [ROLE_WINCON]: 'Win Cons',
  [ROLE_SYNERGY]: 'Synergy',
  [ROLE_LANDS]: 'Lands',
}

function roleNameSet(deckCards) {
  return new Set((deckCards || []).map(c => (c?.name || '').toLowerCase()).filter(Boolean))
}

// Live per-role counts from the actual deck contents (not just owned
// candidates) so progress bars reflect everything in the deck. Prefers the
// plan's EDHREC-derived role for a card (so a card shown under Ramp also counts
// as Ramp when added), falling back to local oracle/type classification.
function countByRole(deckCards, sfMap, roleByName) {
  const counts = new Map(ROLE_ORDER.map(r => [r, 0]))
  for (const dc of deckCards || []) {
    if (dc?.is_commander) continue
    const sfCard = sfMap?.[dc?.scryfall_id] || null
    const role = roleByName?.get((dc?.name || '').toLowerCase()) || coarseRole(dc, sfCard)
    counts.set(role, (counts.get(role) || 0) + (dc.qty || 1))
  }
  return counts
}

// Card image from the cached Scryfall art (cards.scryfall.io CDN). We never hit
// api.scryfall.com per tile — that endpoint is rate-limited and floods to 429.
// Falls back to the 'normal' size because card_prints-derived entries only store
// `normal` + `art_crop` (no `small`), which otherwise left owned tiles blank.
function cardImageUrl(sfCard) {
  if (!sfCard) return null
  return getCardImageUri(sfCard, 'small') || getCardImageUri(sfCard, 'normal')
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

// Overlay new fields onto an existing sfMap entry, skipping null/empty values
// (mirrors mergeSfEntry in scryfall.js). Used when backfilling from card_prints,
// whose entries carry null prices/images — a blind spread would wipe the
// prices/art the cached entry already has.
function overlayNonNull(base, next) {
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(next || {})) {
    if (v == null) continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

const SUMMARY_STEP = '__summary__'
const MAX_TILES = 60 // cap owned tiles per step to keep the DOM light

// Budget chip ceilings. Raw numbers compared directly against getPrice() output,
// which is in the active price_source's native currency — the same source
// formatPrice() uses below, so threshold and card price always share units.
const BUDGET_CHIPS = [null, 1, 5, 20]

// Suggestion source options (shown only when recommander returns picks).
const SUGGESTION_SOURCES = [
  { id: 'both', label: 'EDHREC + Recommander' },
  { id: 'edhrec', label: 'EDHREC' },
  { id: 'recommander', label: 'Recommander' },
]

// Mana pip colors for the manabase step. A color is "thin" (amber) below this
// many sources — a soft floor, not a hard rule.
const MANA_HEX = { W: '#e9e0c0', U: '#3b7fd4', B: '#7a6b86', R: '#d4503b', G: '#4a9a5a' }
const THIN_SOURCE_FLOOR = 8
// Basic land name → its mana color, for the auto-basics breakdown pips.
const COLOR_OF_BASIC = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' }

// Render the planned basic-land split as colored count chips (e.g. ● 8  ● 5).
function BasicsBreakdown({ counts }) {
  const entries = Object.entries(counts || {})
  if (!entries.length) return null
  return (
    <span className={styles.basicsChips}>
      {entries.map(([name, n]) => (
        <span key={name} className={styles.basicChip} title={`${n} ${name}`}>
          <span className={styles.pip} style={{ background: MANA_HEX[COLOR_OF_BASIC[name]] || '#888' }} />
          {n}
        </span>
      ))}
    </span>
  )
}

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
// Tallest a curve bar can render (px). Heights are computed in px rather than as
// a % of the flex track — a percentage height inside a flex:1 wrapper collapses
// to nothing in some engines, which left the bars invisible.
const CURVE_BAR_MAX_PX = 96

// One card tile: image + name + sub-meta + add action(s).
function CardTile({ name, sfCard, fallbackImg, pips, inclusion, tag, price, flag, overTarget, added, wished, showWishlist, onAdd, onUndo, onWishlist }) {
  const canUndo = added && typeof onUndo === 'function'
  // Cached collection art first; Scryfall-fetched fallback for unowned upgrades
  // and any owned card whose cache entry has no image.
  const img = cardImageUrl(sfCard) || fallbackImg || null
  return (
    <div className={`${styles.tile}${added ? ' ' + styles.tileAdded : ''}`}>
      <div className={styles.tileArt}>
        {img
          ? <img src={img} alt={name} loading="lazy" className={styles.tileImg} />
          : <div className={styles.tileNoImg}>{name}</div>}
        {inclusion > 0
          ? <span className={styles.tileIncl}>{inclusion}%</span>
          : tag ? <span className={`${styles.tileIncl} ${styles.tileTag}`}>{tag}</span> : null}
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
      {pips?.length ? <div className={styles.tileSub}><ColorPips colors={pips} /></div> : null}
      <div className={styles.tileActions}>
        <div className={styles.tileActionRow}>
          <span
            className={`${styles.tilePriceTag}${price ? '' : ' ' + styles.tilePriceTagEmpty}`}
            title={price ? 'Cheapest printing' : 'No price data'}
          >
            {price || '—'}
          </span>
          <button
            className={`${styles.tileBtn}${added ? ' ' + styles.tileBtnDone : ''}${canUndo ? ' ' + styles.tileBtnUndo : ''}`}
            onClick={canUndo ? onUndo : onAdd}
            disabled={added && !canUndo}
            title={canUndo ? 'Remove from deck' : undefined}
          >
            {added ? (canUndo ? 'Remove' : 'Added') : 'Add'}
          </button>
        </div>
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

// Labeled dropdown control (Theme / Bracket / Budget). Wraps ResponsiveMenu so
// it renders as a positioned panel on desktop and a bottom sheet on touch. The
// trigger shows a small uppercase label + the current value; `portal` keeps the
// panel from being clipped by the modal's overflow.
function ControlMenu({ label, valueLabel, title, disabled, busy, children }) {
  return (
    <ResponsiveMenu
      title={title || label}
      align="left"
      portal
      wrapClassName={styles.ctrlWrap}
      panelClassName={styles.ctrlPanel}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={`${styles.ctrlBtn}${open ? ' ' + styles.ctrlBtnOpen : ''}`}
          onClick={() => !disabled && toggle()}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={disabled ? false : open}
        >
          <span className={styles.ctrlLabel}>{label}</span>
          <span className={styles.ctrlValue}>{busy ? 'updating…' : valueLabel}</span>
          <ChevronDownIcon
            size={12}
            className={`${styles.ctrlChevron}${open ? ' ' + styles.ctrlChevronOpen : ''}`}
          />
        </button>
      )}
    >
      {({ close }) => (
        <div className={uiStyles.responsiveMenuList}>
          {children(close)}
        </div>
      )}
    </ResponsiveMenu>
  )
}

// One option row inside a ControlMenu — mirrors the Select dropdown styling
// (label on the left, a check on the active row).
function MenuOption({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={`${uiStyles.responsiveMenuAction}${active ? ' ' + uiStyles.responsiveMenuActionActive : ''}`}
      onClick={onClick}
    >
      <span>{children}</span>
      <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">
        {active ? <CheckIcon size={11} /> : ''}
      </span>
    </button>
  )
}

export function BuildAssistant({ userId, commander, deckCards = [], accessToken, onAddCard, onRemoveCard, onAddToWishlist, onAddBasics, onClose }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [plan, setPlan] = useState(null) // enriched plan (candidates + upgrades)
  const [sfMap, setSfMap] = useState({})
  const [stepIndex, setStepIndex] = useState(0)
  // Collapsible card sections (persist across steps). Default expanded.
  const [collapsed, setCollapsed] = useState({ owned: false, upgrades: false })
  const toggleCollapsed = key => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))
  // Cheapest *English* paper printing per card name → { price, image }. price is
  // in the active price_source currency (null = no price); image is that printing's
  // English art. Drives the per-tile price tag, the budget-per-card filter, and the
  // suggestion-tile art — so a foreign printing never makes a card look cheaper
  // than its English copy, and foreign card art never shows in recommendations.
  const [cheapestByName, setCheapestByName] = useState(() => new Map())
  const stepperRef = useRef(null)   // scroll container for the node stepper
  const activeStepRef = useRef(null) // current node, auto-centered on mobile
  const [themes, setThemes] = useState([])       // EDHREC archetypes for this commander
  const [selectedTheme, setSelectedTheme] = useState('') // '' = Balanced
  const [rebuilding, setRebuilding] = useState(false)
  const [gameChangers, setGameChangers] = useState(null) // Set of GC names (null until loaded)
  const [targetBracket, setTargetBracket] = useState(null) // null = no target; 1-4
  const [showBracketReasons, setShowBracketReasons] = useState(false) // inline "why" disclosure
  const [maxPrice, setMaxPrice] = useState(null) // budget filter ceiling, null = off
  const [suggestionSource, setSuggestionSource] = useState('both') // 'both' | 'edhrec' | 'recommander'
  const [cutMode, setCutMode] = useState('balanced') // cut helper ranking mode
  const [lockedCutIds, setLockedCutIds] = useState(() => new Set()) // deck-card ids kept off the cut list
  const [applyingCuts, setApplyingCuts] = useState(false)
  const [ownedNameSet, setOwnedNameSet] = useState(() => new Set())
  const metaFetchedRef = useRef(false) // owned-card oracle-text backfill ran for this commander
  const selectedThemeRef = useRef('')  // latest theme, read by the async backfill to avoid a stale-closure revert

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

  // Resolve oracle text + small art for unowned EDHREC cards so enrichment can
  // classify them by function (Card Advantage, Removal, …) and the tiles have
  // art. One batched name lookup, injected into every enrichPlanWithEdhrec call.
  // Card meta is intrinsic (commander-independent), so we cache by name across
  // the load, the owned-oracle backfill re-plan, and theme switches — fetching
  // each name at most once. A null entry marks a name we tried but couldn't
  // resolve, so it isn't retried.
  const upgradeMetaCacheRef = useRef(new Map())
  const fetchUpgradeMeta = useCallback(async (names) => {
    const cache = upgradeMetaCacheRef.current
    const missing = names.filter(n => !cache.has(n.toLowerCase()))
    if (missing.length) {
      const cards = await fetchCardsByNames(missing).catch(() => [])
      for (const c of cards) {
        cache.set((c.name || '').toLowerCase(), {
          name: c.name,
          oracle_text: c.oracle_text || c.card_faces?.[0]?.oracle_text || '',
          type_line: c.type_line || c.card_faces?.[0]?.type_line || '',
          image: getCardImageUri(c, 'small'),
        })
      }
      for (const n of missing) if (!cache.has(n.toLowerCase())) cache.set(n.toLowerCase(), null)
    }
    return names.map(n => cache.get(n.toLowerCase())).filter(Boolean)
  }, [])

  // Deck-aware recommander.cards picks, resolved to metadata via card_prints
  // (by oracle_id — no Scryfall call) so they can be classified + shown. Cached
  // per deck snapshot; best-effort (returns [] on any failure → EDHREC-only).
  const recCacheRef = useRef(new Map())
  const fetchRecommenderUpgrades = useCallback(async (deck) => {
    if (!commander?.name) return []
    const deckNames = (deck || []).filter(d => !d?.is_commander).map(d => d?.name).filter(Boolean)
    const sig = `${commander.name}|${[...deckNames].sort().join(',')}`
    const cache = recCacheRef.current
    if (cache.has(sig)) return cache.get(sig)
    const recs = await fetchRecommenderRecs(commander.name, deckNames)
    if (!recs.length) { cache.set(sig, []); return [] }
    const printMap = await fetchCardPrintsByOracleIds(recs.map(r => r.oracle_id)).catch(() => new Map())
    const rows = []
    for (const r of recs) {
      const row = printMap.get(r.oracle_id)
      if (!row) continue // not in our dictionary — skip rather than hit Scryfall
      rows.push({
        name: r.name || row.name,
        type_line: row.type_line || '',
        oracle_text: row.oracle_text || '',
        cmc: row.cmc ?? 0,
        colorIdentity: row.color_identity || [],
        image: getCardImageUri(cardPrintRowToSfEntry(row), 'small'),
        score: r.score ?? 0,
      })
    }
    cache.set(sig, rows)
    return rows
  }, [commander])

  // Layer recommander picks onto an EDHREC-enriched plan. Best-effort: any
  // failure leaves the EDHREC-only plan intact.
  const mergeRecommender = useCallback(async (plan, deck) => {
    if (!plan) return plan
    try {
      const recRows = await fetchRecommenderUpgrades(deck)
      return recRows.length ? attachRecommenderUpgrades(plan, recRows) : plan
    } catch {
      return plan
    }
  }, [fetchRecommenderUpgrades])

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
      const enriched = await enrichPlanWithEdhrec(base, async () => edhrec, fetchUpgradeMeta)
      setPlan(await mergeRecommender(enriched, deckCards))
    } finally {
      setRebuilding(false)
    }
  }, [commander, deckCards, fetchUpgradeMeta, mergeRecommender])

  useEffect(() => {
    let cancelled = false
    if (!hasCommander) { setLoading(false); return }
    ;(async () => {
      try {
        setLoading(true)
        setSelectedTheme('')
        selectedThemeRef.current = ''
        metaFetchedRef.current = false
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
        const enriched = await enrichPlanWithEdhrec(base, async () => edhrec, fetchUpgradeMeta)
        const withRecs = await mergeRecommender(enriched, deckCards)
        if (cancelled) return
        dataRef.current = { ownedNorm, sfById }
        setSfMap(sfById)
        setThemes(edhrec?.themes || [])
        setGameChangers(gcNames || null)
        setOwnedNameSet(new Set((ownedNorm || []).map(c => (c?.name || '').toLowerCase()).filter(Boolean)))
        setPlan(withRecs)
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
    selectedThemeRef.current = slug
    rebuildPlan(slug)
  }

  // Name → role from the (EDHREC-hybrid) plan, so the live counter and trim
  // logic classify deck cards the same way the steps display them.
  const roleByName = useMemo(() => {
    const m = new Map()
    for (const role of plan?.roles || []) {
      for (const c of role.ownedCandidates) m.set(c.name.toLowerCase(), role.role)
      for (const u of role.edhrecUpgrades) m.set(u.name.toLowerCase(), role.role)
      for (const u of role.recommenderUpgrades || []) m.set(u.name.toLowerCase(), role.role)
    }
    return m
  }, [plan])

  // Whether recommander returned anything (gates the source toggle).
  const hasRecommender = useMemo(
    () => (plan?.roles || []).some(r => (r.recommenderUpgrades || []).length > 0),
    [plan],
  )

  const liveCounts = useMemo(() => countByRole(deckCards, sfMap, roleByName), [deckCards, sfMap, roleByName])
  const deckNames = useMemo(() => roleNameSet(deckCards), [deckCards])

  const steps = useMemo(() => [...ROLE_ORDER, SUMMARY_STEP], [])
  const currentRoleName = steps[stepIndex]
  const onSummary = currentRoleName === SUMMARY_STEP
  const roleData = onSummary ? null : (plan?.roles?.find(r => r.role === currentRoleName) || null)

  // Keep the active node centered when the stepper overflows (mobile / narrow).
  useEffect(() => {
    activeStepRef.current?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [stepIndex])

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
  // Cheapest English-printing price for a card name. undefined = not yet looked
  // up; null = looked up, no price; number = the price. (Entry is { price, image }.)
  const cheapestOf = useCallback(
    name => {
      const e = cheapestByName.get((name || '').toLowerCase())
      return e === undefined ? undefined : e.price
    },
    [cheapestByName],
  )
  // English image_uri for the cheapest English printing (used so suggestion tiles
  // never show a foreign printing's art). null when unknown.
  const imageEnFor = useCallback(
    name => cheapestByName.get((name || '').toLowerCase())?.image || null,
    [cheapestByName],
  )
  // Formatted cheapest price for a tile (null when unknown → tile shows "—").
  const priceLabelFor = useCallback(
    name => {
      const v = cheapestOf(name)
      return v != null ? formatPrice(v, price_source) : null
    },
    [cheapestOf, price_source],
  )
  // Budget is "per card": judge by the cheapest available printing so an
  // expensive owned printing doesn't hide a card you could buy cheaply. Falls
  // back to the owned printing's price until the cheapest lookup resolves.
  const passesBudget = useCallback(
    (name, sfCard) => {
      if (maxPrice == null) return true
      const cheap = cheapestOf(name)
      const v = cheap !== undefined ? cheap : priceOf(sfCard)
      return v == null || v <= maxPrice
    },
    [maxPrice, cheapestOf, priceOf],
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

  // Cut-to-100 helper. When the deck is over size, rank every (eligible) deck
  // card by how cuttable it is for the chosen mode and recommend exactly the
  // overage. Protections: the commander is never a candidate; locked cards are
  // excluded; lands are only eligible when above the land target, and only the
  // worst (overage) of them — so trimming never breaks the manabase.
  const cutAnalysis = useMemo(() => {
    if (!plan) return null
    const over = totalCards - plan.deckSize
    const targets = new Map(plan.roles.map(r => [r.role, r.target]))
    const counts = new Map(ROLE_ORDER.map(r => [r, 0]))
    const rows = []
    let totalLands = 0
    for (const dc of deckCards || []) {
      if (dc?.is_commander) continue
      const sf = sfMap?.[dc?.scryfall_id] || null
      const name = dc.name || ''
      const role = roleByName.get(name.toLowerCase()) || coarseRole(dc, sf)
      counts.set(role, (counts.get(role) || 0) + (dc.qty || 1))
      const isLand = (sf?.type_line || dc?.type_line || '').toLowerCase().includes('land')
      if (isLand) totalLands += (dc.qty || 1)
      const inclusion = inclusionByName.get(name.toLowerCase()) ?? 0
      rows.push({
        id: dc.id, name, role, isLand,
        cmc: sf?.cmc ?? dc?.cmc ?? 0,
        inclusion, hasData: inclusion > 0,
      })
    }
    if (over <= 0) return { over, cutTarget: 0, recommended: [], extra: [], landOver: 0 }

    const landTarget = targets.get(ROLE_LANDS) || 37
    const landOver = Math.max(0, totalLands - landTarget)
    const withRoleOver = r => ({ ...r, role: r.isLand ? ROLE_LANDS : r.role,
      roleOver: Math.max(0, (counts.get(r.role) || 0) - (targets.get(r.role) || 0)) })

    // Eligible pool: unlocked nonland cards, plus the worst `landOver` unlocked
    // lands (only when the manabase is above target).
    const nonland = rows.filter(r => !r.isLand && !lockedCutIds.has(r.id)).map(withRoleOver)
    // Only nonbasic lands are cuttable (singletons); basics are multi-copy rows
    // managed by the lands step, so cutting one would gut the manabase.
    let landPool = []
    if (landOver > 0) {
      const lands = rows.filter(r => r.isLand && !isBasicLandName(r.name) && !lockedCutIds.has(r.id)).map(withRoleOver)
      landPool = rankCutCandidates(lands, cutMode).slice(0, landOver)
    }
    const ranked = rankCutCandidates([...nonland, ...landPool], cutMode)
    return {
      over,
      cutTarget: over,
      recommended: ranked.slice(0, over),
      extra: ranked.slice(over, over + 6), // a few more "also consider"
      landOver,
    }
  }, [plan, deckCards, sfMap, inclusionByName, totalCards, roleByName, cutMode, lockedCutIds])

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

  // (Unowned EDHREC upgrade art is resolved during enrichment via
  // fetchUpgradeMeta and attached to each upgrade as `image`; owned-card art
  // comes from the cached sfMap entry. No separate per-tile image fetch.)

  // Backfill oracle text for color-legal owned cards so the role classifier can
  // sort them into Ramp/Draw/Removal/… — without it every non-land owned card
  // collapses into Synergy and the other steps look empty. Source priority:
  // check our own card_prints (Supabase) FIRST — it now carries oracle text for
  // ~99.85% of printings, so no rate-limited Scryfall hit is needed for them —
  // and fall back to Scryfall (by exact scryfall_id, preserving the printing)
  // only for the residual it can't supply. Merged into the shared sfById map,
  // then we re-plan. Progressive enhancement: the first plan renders instantly
  // from cache, this corrects it shortly after. Runs once per commander.
  useEffect(() => {
    const d = dataRef.current
    if (!plan || !d || !commander?.name || metaFetchedRef.current) return
    const identity = (commander.color_identity || []).filter(c => 'WUBRG'.includes(c))
    const ids = []
    const seen = new Set()
    for (const c of d.ownedNorm || []) {
      const sid = c?.scryfall_id
      if (!sid || seen.has(sid)) continue
      const entry = d.sfById[sid]
      if (entry?.oracle_text) continue // already have oracle text → classifiable
      const colors = entry?.color_identity || c?.color_identity || []
      if (!colors.every(col => identity.includes(col))) continue // outside colors
      seen.add(sid)
      ids.push(sid)
    }
    metaFetchedRef.current = true
    if (!ids.length) return
    let cancelled = false
    ;(async () => {
      const merged = { ...d.sfById }
      let enrichedAny = false
      // 1) Supabase card_prints first (our DB, no rate limit, has oracle text).
      const stillMissing = []
      try {
        const printRows = await fetchCardPrintsByScryfallIds(ids)
        for (const sid of ids) {
          const row = printRows.get(sid)
          const entry = row ? cardPrintRowToSfEntry(row) : null
          if (entry) { merged[sid] = overlayNonNull(merged[sid], entry); enrichedAny = true }
          if (!entry || entry.oracle_text == null) stillMissing.push(sid)
        }
      } catch {
        stillMissing.push(...ids)
      }
      // 2) Scryfall fallback only for what card_prints couldn't supply.
      if (stillMissing.length) {
        const cards = await fetchCardsByScryfallIds(stillMissing.slice(0, 500)).catch(() => [])
        for (const sf of cards) {
          if (sf?.id) { merged[sf.id] = overlayNonNull(merged[sf.id], sf); enrichedAny = true }
        }
      }
      if (cancelled || !enrichedAny) return
      d.sfById = merged
      setSfMap(merged)
      // Re-plan with the enriched metadata, reading the *live* theme from the
      // ref (not the stale closure) so a theme picked during the fetch isn't
      // reverted. rebuildPlan also runs on theme switch, so the maps converge.
      const theme = selectedThemeRef.current
      const template = applyTemplateAdjustments(COMMANDER_TEMPLATE, archetypeAdjustments(theme))
      const base = analyzeBuildPlan({
        commander,
        ownedCards: d.ownedNorm,
        sfMap: merged,
        currentDeckCards: deckCards,
        template,
      })
      const edhrec = await fetchEdhrecCommander(
        commander.name, 'commander', theme ? { themeSlug: theme } : undefined,
      ).catch(() => null)
      // Bail if the user switched themes again while we were fetching EDHREC —
      // rebuildPlan owns the plan for the newer selection.
      if (cancelled || selectedThemeRef.current !== theme) return
      const enriched = await enrichPlanWithEdhrec(base, async () => edhrec, fetchUpgradeMeta)
      const withRecs = await mergeRecommender(enriched, deckCards)
      if (!cancelled && selectedThemeRef.current === theme) setPlan(withRecs)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, commander])

  // Manabase: commander colors + live colored-source counts from the deck.
  const cmdColors = useMemo(
    () => (commander?.color_identity || []).filter(c => 'WUBRG'.includes(c)),
    [commander],
  )
  const manaSources = useMemo(() => countManaSources(deckCards, sfMap), [deckCards, sfMap])
  const onLands = currentRoleName === ROLE_LANDS

  // For the Lands step, annotate candidates with the colors they produce and
  // surface fixers (lands that make more of the commander's colors) first.
  // Basics are excluded — they're added automatically on finish, not picked here.
  const landCandidates = useMemo(() => {
    if (!onLands || !roleData) return []
    return roleData.ownedCandidates
      .filter(cand => !isBasicLandName(cand.name))
      .map(cand => {
        const colors = [...producedColors(cand.sfCard?.oracle_text, cand.sfCard?.type_line)]
        const matching = colors.filter(c => cmdColors.includes(c))
        return { cand, colors, score: matching.length }
      })
      .sort((a, b) => (b.score - a.score) || (b.colors.length - a.colors.length) || a.cand.name.localeCompare(b.cand.name))
  }, [onLands, roleData, cmdColors])

  // Land target (Lands role target, theme-adjusted) and the basic/nonbasic split.
  // recommendedBasics scales with color count; nonbasicTarget is what to aim for
  // in this step. plannedBasics is the pip-weighted top-up applied on finish.
  const landsTarget = useMemo(
    () => plan?.roles?.find(r => r.role === ROLE_LANDS)?.target || 37,
    [plan],
  )
  const recommendedBasics = useMemo(() => recommendedBasicCount(cmdColors.length), [cmdColors])
  const nonbasicTarget = Math.max(0, landsTarget - recommendedBasics)
  const plannedBasics = useMemo(
    () => planBasicLands({ deckCards, sfMap, colors: cmdColors, landTarget: landsTarget }),
    [deckCards, sfMap, cmdColors, landsTarget],
  )

  // Drop the cheapest-price cache when the price source changes — the values are
  // stored in that source's currency, so they must be recomputed.
  useEffect(() => { setCheapestByName(new Map()) }, [price_source])

  // Resolve the cheapest *English* printing for the cards visible on this step
  // (capped to what renders). card_prints stores the English name even on foreign
  // printings (so names are fine), but a foreign printing's price/art can leak in.
  // So: pull cheap candidate printings from the DB (fast), then batch-verify their
  // language via Scryfall and pick the cheapest one that is `lang: 'en'`. Bounded
  // to the shown cards and cached per name, so each card is resolved at most once.
  const CHEAPEST_CANDIDATES = 6 // cheapest DB printings to language-check per card
  useEffect(() => {
    const names = new Set()
    if (onLands) {
      for (const l of landCandidates.slice(0, MAX_TILES)) if (l.cand?.name) names.add(l.cand.name)
    } else if (roleData) {
      for (const c of roleData.ownedCandidates.slice(0, MAX_TILES)) if (c?.name) names.add(c.name)
    }
    if (roleData) {
      for (const u of selectUpgrades(roleData, hasRecommender ? suggestionSource : 'edhrec')) {
        if (u?.name) names.add(u.name)
      }
    }
    const missing = [...names].filter(n => !cheapestByName.has(n.toLowerCase()))
    if (!missing.length) return
    let cancelled = false
    ;(async () => {
      try {
        const printMap = await fetchPaperPrintingsByNamesFromDb(missing)
        // Cheapest few DB printings per name → the language-check candidate set.
        const candsByName = new Map()
        const allIds = new Set()
        for (const n of missing) {
          const cands = (printMap.get(n) || [])
            .map(p => ({ id: p.id, price: getPrice(p, false, { price_source }) }))
            .filter(p => p.id && p.price != null)
            .sort((a, b) => a.price - b.price)
            .slice(0, CHEAPEST_CANDIDATES)
          candsByName.set(n, cands)
          for (const c of cands) allIds.add(c.id)
        }
        // One batched Scryfall lookup tells us each candidate's language + art.
        const sfCards = await fetchCardsByScryfallIds([...allIds]).catch(() => [])
        const byId = new Map(sfCards.map(c => [c.id, c]))
        const next = new Map(cheapestByName)
        for (const n of missing) {
          const cands = candsByName.get(n) || []
          let chosen = null
          for (const c of cands) { // cheapest-first
            const sc = byId.get(c.id)
            if (sc && sc.lang === 'en') { chosen = { price: c.price, image: getCardImageUri(sc, 'small') }; break }
          }
          // No English copy among the cheapest candidates → fall back to the
          // overall cheapest price (no English art to show).
          if (!chosen) chosen = cands[0] ? { price: cands[0].price, image: null } : { price: null, image: null }
          next.set(n.toLowerCase(), chosen)
        }
        if (!cancelled) setCheapestByName(next)
      } catch { /* leave cache as-is; tiles show "—" */ }
    })()
    return () => { cancelled = true }
  }, [onLands, roleData, landCandidates, suggestionSource, hasRecommender, price_source, cheapestByName])

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

  // Cut helper actions: lock a card off the suggestion list, or apply a batch.
  function toggleCutLock(id) {
    setLockedCutIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  async function applyCuts(ids) {
    if (typeof onRemoveCard !== 'function' || !ids?.length) return
    setApplyingCuts(true)
    try {
      for (const id of ids) { try { await onRemoveCard(id) } catch { /* parent surfaces */ } }
    } finally { setApplyingCuts(false) }
  }

  // Finish: top the manabase up with pip-weighted basics (the last build step),
  // then close. Additive + idempotent, so finishing twice is safe.
  const [finishing, setFinishing] = useState(false)
  async function handleFinish() {
    if (plannedBasics.total > 0 && typeof onAddBasics === 'function') {
      setFinishing(true)
      try { await onAddBasics(plannedBasics.counts) }
      catch { /* parent surfaces errors */ }
      finally { setFinishing(false) }
    }
    onClose()
  }

  // Inline undo from a card tile: drop the session "added" flag and remove the
  // matching (non-commander) deck row by name so the tile reverts to "+ Deck".
  async function handleUndoAdd(name) {
    const key = name.toLowerCase()
    setAddedNames(prev => { const next = new Set(prev); next.delete(key); return next })
    if (typeof onRemoveCard !== 'function') return
    const dc = (deckCards || []).find(c => !c?.is_commander && (c?.name || '').toLowerCase() === key)
    if (dc?.id) {
      try { await onRemoveCard(dc.id) } catch { /* parent surfaces errors */ }
    }
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

        {/* Connected node stepper — click through categories */}
        <div className={styles.stepper} ref={stepperRef} role="tablist" aria-label="Build steps">
          {steps.map((role, i) => {
            const isSummary = role === SUMMARY_STEP
            const c = liveCounts.get(role) || 0
            const t = plan?.roles?.find(r => r.role === role)?.target || 0
            const done = !isSummary && t > 0 && c >= t
            const active = i === stepIndex
            // A connector before step i is "filled" once the prior step is met
            // or we've already moved past it — so the track shows progress.
            const passed = idx => {
              const r = steps[idx]
              if (r === SUMMARY_STEP) return idx < stepIndex
              const cc = liveCounts.get(r) || 0
              const tt = plan?.roles?.find(x => x.role === r)?.target || 0
              return (tt > 0 && cc >= tt) || idx < stepIndex
            }
            return (
              <button
                key={role}
                ref={active ? activeStepRef : null}
                type="button"
                className={`${styles.node}${active ? ' ' + styles.nodeActive : ''}${done ? ' ' + styles.nodeDone : ''}`}
                onClick={() => setStepIndex(i)}
                aria-current={active ? 'step' : undefined}
                title={isSummary ? 'Summary' : `${role}: ${c}/${t}`}
              >
                <span className={styles.nodeRow}>
                  <span className={`${styles.connector}${i === 0 ? ' ' + styles.connectorHidden : ''}${i > 0 && passed(i - 1) ? ' ' + styles.connectorFill : ''}`} />
                  <span className={styles.dot}>
                    {done ? <CheckIcon size={12} /> : <span className={styles.dotNum}>{isSummary ? '★' : i + 1}</span>}
                  </span>
                  <span className={`${styles.connector}${i === steps.length - 1 ? ' ' + styles.connectorHidden : ''}${passed(i) ? ' ' + styles.connectorFill : ''}`} />
                </span>
                <span className={styles.nodeLabel}>{isSummary ? 'Summary' : (STEP_SHORT[role] || role)}</span>
              </button>
            )
          })}
        </div>

        {/* Controls: Theme / Bracket / Budget-per-card dropdowns + live readouts */}
        {!loading && !error && (
          <div className={styles.controls}>
            {themes.length > 0 && (
              <ControlMenu
                label="Theme"
                title="Deck theme"
                busy={rebuilding}
                valueLabel={selectedTheme === ''
                  ? 'Balanced'
                  : (themes.find(t => t.slug === selectedTheme)?.label || 'Balanced')}
              >
                {close => (
                  <>
                    <MenuOption active={selectedTheme === ''} onClick={() => { onSelectTheme(''); close() }}>
                      Balanced
                    </MenuOption>
                    {themes.slice(0, 8).map(t => (
                      <MenuOption
                        key={t.slug}
                        active={selectedTheme === t.slug}
                        onClick={() => { onSelectTheme(t.slug); close() }}
                      >
                        {t.label}{typeof t.count === 'number' ? ` · ${t.count.toLocaleString()}` : ''}
                      </MenuOption>
                    ))}
                  </>
                )}
              </ControlMenu>
            )}

            {gameChangers && (
              <ControlMenu
                label="Bracket"
                title="Target bracket"
                valueLabel={targetBracket == null ? 'Any' : `${targetBracket} · ${BRACKET_LABELS[targetBracket]}`}
              >
                {close => (
                  <>
                    <MenuOption active={targetBracket == null} onClick={() => { setTargetBracket(null); close() }}>
                      Any
                    </MenuOption>
                    {[1, 2, 3, 4].map(b => (
                      <MenuOption key={b} active={targetBracket === b} onClick={() => { setTargetBracket(b); close() }}>
                        {b} · {BRACKET_LABELS[b]}
                      </MenuOption>
                    ))}
                  </>
                )}
              </ControlMenu>
            )}

            <ControlMenu
              label="Budget / card"
              title="Max price per card"
              valueLabel={maxPrice == null ? 'Any' : `≤ ${formatPrice(maxPrice, price_source)}`}
            >
              {close => (
                <>
                  {BUDGET_CHIPS.map(b => (
                    <MenuOption key={b ?? 'any'} active={maxPrice === b} onClick={() => { setMaxPrice(b); close() }}>
                      {b == null ? 'Any (no limit)' : `≤ ${formatPrice(b, price_source)} per card`}
                    </MenuOption>
                  ))}
                </>
              )}
            </ControlMenu>

            {/* Suggestion source — only when recommander returned picks */}
            {hasRecommender && (
              <ControlMenu
                label="Suggestions"
                title="Suggestion source"
                valueLabel={SUGGESTION_SOURCES.find(s => s.id === suggestionSource)?.label || 'EDHREC + Recommander'}
              >
                {close => (
                  <>
                    {SUGGESTION_SOURCES.map(s => (
                      <MenuOption
                        key={s.id}
                        active={suggestionSource === s.id}
                        onClick={() => { setSuggestionSource(s.id); close() }}
                      >
                        {s.label}
                      </MenuOption>
                    ))}
                  </>
                )}
              </ControlMenu>
            )}

            {/* Live bracket estimate — toggles the reasons disclosure */}
            {gameChangers && deckBracket && (
              <button
                type="button"
                className={`${styles.bracketNow} ${styles.bracketBtn}${overTarget ? ' ' + styles.bracketOver : ''}`}
                onClick={() => setShowBracketReasons(v => !v)}
                aria-expanded={showBracketReasons}
                title="Show what's affecting the bracket estimate"
              >
                Now: B{deckBracket.bracket} {BRACKET_LABELS[deckBracket.bracket]}
                {!deckBracket.combosChecked ? ' (combos not checked)' : ''}
                <ChevronDownIcon
                  size={10}
                  className={`${styles.bracketCaret}${showBracketReasons ? ' ' + styles.bracketCaretOpen : ''}`}
                />
              </button>
            )}

            {/* Live deck value */}
            <span className={styles.deckValue} title="Estimated value of the current deck">
              Deck: {formatPrice(deckValue, price_source)}
            </span>
          </div>
        )}

        {/* Bracket "why" disclosure — touch/keyboard-accessible. */}
        {!loading && !error && gameChangers && deckBracket && showBracketReasons && (
          <div className={styles.bracketReasons}>
            {deckBracket.reasons.length ? (
              deckBracket.reasons.map((r, i) => (
                <span
                  key={i}
                  className={`${styles.bracketReason}${targetBracket != null && r.level > targetBracket ? ' ' + styles.bracketReasonOver : ''}`}
                >
                  {r.reason}
                </span>
              ))
            ) : (
              <span className={styles.bracketReasonNone}>No bracket-raising cards detected yet.</span>
            )}
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
                        {thin && <span className={styles.sourceThinTag}>low</span>}
                      </span>
                    )
                  })}
                  <span className={styles.sourcesTotal}>{manaSources.lands} lands</span>
                </div>
              )}

              {/* Basic/nonbasic split note (Lands step). Encourages leaving room
                  for basics, which are auto-added (pip-weighted) on finish. */}
              {onLands && cmdColors.length > 0 && (
                <div className={styles.basicsNote}>
                  <span>
                    Aim for about <strong>{nonbasicTarget}</strong> nonbasic / utility lands — the rest
                    fill with basics automatically when you finish.
                  </span>
                  {plannedBasics.total > 0 && (
                    <span className={styles.basicsPlan}>
                      <span className={styles.basicsPlanLabel}>+{plannedBasics.total} basics</span>
                      <BasicsBreakdown counts={plannedBasics.counts} />
                    </span>
                  )}
                </div>
              )}

              {/* Owned candidates (collapsible) */}
              <button
                type="button"
                className={styles.sectionHead}
                onClick={() => toggleCollapsed('owned')}
                aria-expanded={!collapsed.owned}
              >
                <ChevronDownIcon
                  size={12}
                  className={`${styles.sectionCaret}${collapsed.owned ? ' ' + styles.sectionCaretClosed : ''}`}
                />
                <span className={styles.sectionHeadLabel}>
                  From your collection · {onLands ? landCandidates.length : roleData.ownedCandidates.length}
                  {onLands && <span className={styles.sectionHint}> · nonbasic, fixers first</span>}
                </span>
              </button>
              {!collapsed.owned && (() => {
                // Budget filter (cards with unknown price always pass).
                const shown = onLands
                  ? landCandidates.filter(({ cand }) => passesBudget(cand.name, cand.sfCard))
                  : roleData.ownedCandidates.filter(c => passesBudget(c.name, c.sfCard))
                const baseCount = onLands ? landCandidates.length : roleData.ownedCandidates.length
                if (baseCount === 0) {
                  return <div className={styles.emptySmall}>
                    {onLands
                      ? 'No owned nonbasic lands in your colors — basics will be added automatically on finish.'
                      : 'No owned cards match this role in your colors.'}
                  </div>
                }
                if (shown.length === 0) {
                  return <div className={styles.emptySmall}>No owned {currentRoleName.toLowerCase()} cards under your budget.</div>
                }
                return (
                  <>
                    <div className={styles.grid}>
                      {shown.slice(0, MAX_TILES).map(item => {
                        const cand = onLands ? item.cand : item
                        const flag = onLands ? null : bracketFlagFor(cand.name, cand.sfCard, gameChangers)
                        return (
                          <CardTile
                            key={cand.card?.id || cand.name}
                            name={cand.name}
                            sfCard={cand.sfCard}
                            pips={onLands ? item.colors : undefined}
                            inclusion={onLands ? 0 : cand.edhrecInclusion}
                            price={priceLabelFor(cand.name)}
                            flag={flag}
                            overTarget={targetBracket != null && flag && flag.level > targetBracket}
                            added={isAdded(cand.name)}
                            onAdd={() => handleAdd(ownedCardForAdd(cand), cand.name)}
                            onUndo={() => handleUndoAdd(cand.name)}
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

              {/* Suggestions you don't own (source per the Suggestions toggle) */}
              {(() => {
                // Budget per card applies to suggestions too — these are the
                // cards you'd buy, so an over-budget pick shouldn't be offered.
                const upgrades = selectUpgrades(roleData, hasRecommender ? suggestionSource : 'edhrec')
                  .filter(u => passesBudget(u.name, null))
                if (!upgrades.length) return null
                const label = !hasRecommender || suggestionSource === 'edhrec'
                  ? 'Popular picks you don’t own'
                  : suggestionSource === 'recommander'
                    ? 'Deck-aware picks you don’t own'
                    : 'Suggested picks you don’t own'
                return (
                  <>
                    <button
                      type="button"
                      className={styles.sectionHead}
                      onClick={() => toggleCollapsed('upgrades')}
                      aria-expanded={!collapsed.upgrades}
                    >
                      <ChevronDownIcon
                        size={12}
                        className={`${styles.sectionCaret}${collapsed.upgrades ? ' ' + styles.sectionCaretClosed : ''}`}
                      />
                      <span className={styles.sectionHeadLabel}>{label} · {upgrades.length}</span>
                    </button>
                    {!collapsed.upgrades && (
                      <div className={styles.grid}>
                        {upgrades.map(up => {
                          const flag = bracketFlagFor(up.name, null, gameChangers)
                          return (
                            <CardTile
                              key={up.slug || up.name}
                              name={up.name}
                              sfCard={null}
                              fallbackImg={imageEnFor(up.name) || up.image}
                              inclusion={up.edhrecInclusion}
                              price={priceLabelFor(up.name)}
                              tag={up.source === 'recommander' ? 'rec' : undefined}
                              flag={flag}
                              overTarget={targetBracket != null && flag && flag.level > targetBracket}
                              added={isAdded(up.name)}
                              wished={isWishlisted(up.name)}
                              showWishlist={typeof onAddToWishlist === 'function'}
                              onAdd={() => handleAdd(up, up.name)}
                              onUndo={() => handleUndoAdd(up.name)}
                              onWishlist={() => handleWishlist(up.name)}
                            />
                          )
                        })}
                      </div>
                    )}
                  </>
                )
              })()}
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
              {plannedBasics.total > 0 && (
                <div className={styles.basicsNote}>
                  <span>
                    <strong>{plannedBasics.total}</strong> basic land{plannedBasics.total > 1 ? 's' : ''} added on finish,
                    split by color demand:
                  </span>
                  <BasicsBreakdown counts={plannedBasics.counts} />
                </div>
              )}

              <div className={styles.sectionLabel}>Mana curve (nonland)</div>
              <div className={styles.curve}>
                {(() => {
                  const max = Math.max(1, ...curve)
                  return CURVE_BUCKETS.map((b, i) => (
                    <div key={b} className={styles.curveCol}>
                      <div className={styles.curveBarWrap}>
                        <div className={styles.curveBar} style={{ height: `${Math.max(2, Math.round((curve[i] / max) * CURVE_BAR_MAX_PX))}px` }} />
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

              {/* Cut to 100 */}
              {cutAnalysis && cutAnalysis.over > 0 && (
                <>
                  <div className={styles.sectionLabel}>
                    Trim to 100
                    <span className={styles.sectionHint}> · {cutAnalysis.over} to cut</span>
                  </div>

                  <div className={styles.cutControls}>
                    <div className={styles.themeChips}>
                      {CUT_MODES.map(m => (
                        <button
                          key={m.id}
                          className={`${styles.themeChip}${cutMode === m.id ? ' ' + styles.themeActive : ''}`}
                          onClick={() => setCutMode(m.id)}
                          title={m.description}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                    {cutAnalysis.recommended.length > 0 && (
                      <button
                        className={styles.cutApplyBtn}
                        onClick={() => applyCuts(cutAnalysis.recommended.map(c => c.id))}
                        disabled={applyingCuts}
                      >
                        {applyingCuts ? 'Cutting…' : `Cut all ${cutAnalysis.recommended.length}`}
                      </button>
                    )}
                  </div>
                  <div className={styles.cutModeHint}>
                    {CUT_MODES.find(m => m.id === cutMode)?.description}
                  </div>

                  {cutAnalysis.recommended.length === 0 ? (
                    <div className={styles.emptySmall}>Everything else is locked or protected — unlock a card below to get suggestions.</div>
                  ) : (
                    <div className={styles.cutList}>
                      {cutAnalysis.recommended.map(c => (
                        <div key={c.id} className={styles.cutRow}>
                          <button
                            className={styles.cutKeep}
                            onClick={() => toggleCutLock(c.id)}
                            title="Keep this card (lock it out of cut suggestions)"
                          >
                            Keep
                          </button>
                          <span className={styles.cutName} title={c.name}>{c.name}</span>
                          <span className={styles.cutReason}>{c.reason}</span>
                          <span className={styles.cutMeta}>{c.hasData ? `${c.inclusion}%` : '—'} · {c.cmc} CMC</span>
                          <button
                            className={`${styles.miniBtn} ${styles.cutBtn}`}
                            onClick={() => handleRemove(c.id)}
                            title={`Remove ${c.name}`}
                          >
                            <DeleteIcon size={11} /> Cut
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {cutAnalysis.extra.length > 0 && (
                    <div className={styles.cutExtraNote}>
                      Also consider: {cutAnalysis.extra.map(c => c.name).join(', ')}
                    </div>
                  )}

                  {(() => {
                    const locked = (deckCards || []).filter(dc => lockedCutIds.has(dc.id))
                    if (!locked.length) return null
                    return (
                      <div className={styles.cutLockedStrip}>
                        <span className={styles.cutLockedLabel}>Kept:</span>
                        {locked.map(dc => (
                          <button
                            key={dc.id}
                            className={styles.cutLockedChip}
                            onClick={() => toggleCutLock(dc.id)}
                            title="Kept — tap to unlock (allow as a cut suggestion)"
                          >
                            <CheckIcon size={10} /> {dc.name}
                          </button>
                        ))}
                      </div>
                    )
                  })()}
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
            <Button variant="primary" onClick={handleFinish} disabled={finishing}>
              {plannedBasics.total > 0
                ? (finishing ? 'Adding basics…' : `Add ${plannedBasics.total} basics & finish`)
                : 'Done'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
