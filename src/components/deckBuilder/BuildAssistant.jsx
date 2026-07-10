import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Button, ProgressBar, ResponsiveMenu } from '../UI'
import uiStyles from '../UI.module.css'
import { CheckIcon, DeleteIcon, WarningIcon, ChevronDownIcon, LightningIcon, ExternalLinkIcon } from '../../icons'
import { getLocalCards, getLocalCardPrints, getLocalFolders, getAllLocalFolderCards } from '../../lib/db'
import { getInstantCache, getScryfallKey, getPrice, formatPrice } from '../../lib/scryfall'
import { useCombosFetch } from '../../hooks/useCombosFetch'
import { useSettings } from '../SettingsContext'
import { fetchEdhrecCommander, fetchRecommendationMetadataByNames, fetchCardsByScryfallIds, fetchRecommenderRecs, fetchPaperPrintingsByNamesFromDb, getCardImageUri } from '../../lib/deckBuilderApi'
import { fetchCardPrintsByScryfallIds, fetchCardPrintsByOracleIds, fetchOracleTextByNames, cardPrintRowToSfEntry } from '../../lib/cardPrints'
import {
  analyzeBracket,
  fetchGameChangerNames,
  BRACKET_LABELS,
} from '../../lib/commanderBracket'
import {
  analyzeBuildPlan,
  binderPlacedCardIds,
  buildBuyList,
  buyListText,
  tcgplayerMassEntryUrl,
  planAutoFill,
  enrichPlanWithEdhrec,
  archetypeAdjustments,
  applyTemplateAdjustments,
  bracketFlagFor,
  producedColors,
  countManaSources,
  karstenColorRequirements,
  roleOfDeckCard,
  countByRole,
  pickCheapestEnglish,
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
import { cardNameMatchKeys } from '../../lib/deckBuilderHelpers'
import styles from './BuildAssistant.module.css'

// Guided "build from collection" wizard. Walks the user role-by-role (Ramp →
// Draw → Removal → …), surfacing their owned color-legal cards first
// and EDHREC suggestions for what they don't own yet. Adding a card delegates
// to the parent's addCardToDeck (owned → full Scryfall object, upgrades → EDHREC
// rec object; deck_cards is intended contents, so unowned cards are addable).

// What each role does + why the target count, shown at the top of each step.
const ROLE_INFO = {
  [ROLE_RAMP]: 'Mana acceleration — rocks, dorks, and land fetch. Helps you deploy your commander and spells ahead of curve.',
  [ROLE_DRAW]: 'Draw — card advantage engines and tutors that refill your hand and find your key pieces.',
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
  // Full + front-face keys, so EDHREC/combo names (front face for DFCs) still
  // match deck rows stored under the full "Front // Back" name.
  return new Set((deckCards || []).flatMap(c => cardNameMatchKeys(c?.name)))
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
  { id: 'both', label: 'EDHREC + Recommander', desc: 'EDHREC staples blended with deck-aware picks' },
  { id: 'edhrec', label: 'EDHREC', desc: 'What real decks for this commander run, by inclusion %' },
  { id: 'recommander', label: 'Recommander', desc: 'Deck-aware ML picks that fit your current list' },
]

// One-line meaning for each Commander Bracket, shown under the option.
const BRACKET_DESC = {
  1: 'Ultra-casual — no Game Changers',
  2: 'Average precon power level',
  3: 'Upgraded — a few Game Changers',
  4: 'High-power, no restrictions',
}

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
function CardTile({ name, sfCard, fallbackImg, pips, inclusion, tag, price, flag, overTarget, added, wished, showWishlist, ownedElsewhere, onAdd, onUndo, onWishlist }) {
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
      {ownedElsewhere && (
        <div
          className={styles.tileOwnedNote}
          title="You own this card, but every copy is allocated to another deck"
        >
          In another deck
        </div>
      )}
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
function ControlMenu({ label, valueLabel, title, hint, disabled, busy, children }) {
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
          title={hint || undefined}
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
// (label on the left, a check on the active row). `desc` adds a muted sub-line
// explaining the option (so the dropdowns keep the guidance the old chips had).
function MenuOption({ active, onClick, children, desc }) {
  return (
    <button
      type="button"
      className={`${uiStyles.responsiveMenuAction}${active ? ' ' + uiStyles.responsiveMenuActionActive : ''}`}
      onClick={onClick}
      title={typeof desc === 'string' ? desc : undefined}
    >
      {desc ? (
        <span className={styles.menuOptText}>
          <span>{children}</span>
          <span className={styles.menuOptDesc}>{desc}</span>
        </span>
      ) : (
        <span>{children}</span>
      )}
      <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">
        {active ? <CheckIcon size={11} /> : ''}
      </span>
    </button>
  )
}

export function BuildAssistant({ userId, commander, deckCards = [], accessToken, onAddCard, onAddCards, onRemoveCard, onRemoveCards, onAddToWishlist, onAddBasics, onClose }) {
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
  // Names owned overall but with every copy allocated to another collection
  // deck — excluded from the owned pool, badged on suggestion tiles instead.
  const [inOtherDeckNames, setInOtherDeckNames] = useState(() => new Set())
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
  // classify them by function (Draw, Removal, …) and the tiles have
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
      const cards = await fetchRecommendationMetadataByNames(missing).catch(() => [])
      for (const c of cards) {
        const requestedName = c.requested_name || c.name
        cache.set((requestedName || '').toLowerCase(), {
          name: requestedName,
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
        const [owned, prints, cache, edhrec, gcNames, folders] = await Promise.all([
          getLocalCards(userId),
          getLocalCardPrints().catch(() => []),
          getInstantCache().catch(() => null),
          fetchEdhrecCommander(commander.name).catch(() => null),
          fetchGameChangerNames().catch(() => null),
          getLocalFolders(userId).catch(() => null),
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
        // Local card_prints is usually empty, but the Scryfall instant cache is
        // keyed by set-collector and already holds art / oracle text / prices for
        // every card the user has browsed. Map owned + deck cards into it by their
        // own set/collector so the engine's sfMap[scryfall_id] lookup resolves
        // immediately — otherwise tiles render blank (and cards misclassify)
        // until the slow per-card backfills finish.
        for (const c of [...(owned || []), ...(deckCards || [])]) {
          const sid = c?.scryfall_id
          if (!sid || sfById[sid]) continue
          const entry = cacheBySetCol[getScryfallKey(c)]
          if (entry) sfById[sid] = entry
        }
        // Post-5d owned rows may lack scryfall_id; resolve it via card_prints so
        // the engine's sfMap[card.scryfall_id] lookup hits.
        let ownedNorm = (owned || []).map(c => {
          if (c?.scryfall_id) return c
          const print = c?.card_print_id ? printById.get(c.card_print_id) : null
          return print?.scryfall_id ? { ...c, scryfall_id: print.scryfall_id } : c
        })
        // Only binder-placed copies are available to build with — a card whose
        // every copy is allocated to another collection deck is already in use.
        // Skipped when either IDB read failed (null), so a local hiccup degrades
        // to the old everything-owned pool instead of emptying the wizard.
        // Names removed here (owned, but no free binder copy) are remembered so
        // suggestion tiles can carry an "In another deck" note instead of
        // silently presenting the card as unowned.
        let elsewhereKeys = new Set()
        if (folders) {
          const binderFolderIds = folders.filter(f => f?.type === 'binder').map(f => f.id)
          const binderRows = binderFolderIds.length
            ? await getAllLocalFolderCards(binderFolderIds).catch(() => null)
            : []
          if (binderRows) {
            const availableIds = binderPlacedCardIds(folders, binderRows)
            const excluded = ownedNorm.filter(c => !availableIds.has(c.id))
            ownedNorm = ownedNorm.filter(c => availableIds.has(c.id))
            elsewhereKeys = new Set(excluded.flatMap(c => cardNameMatchKeys(c?.name)))
            // A name with both a binder copy and a deck copy is still available.
            for (const c of ownedNorm) for (const k of cardNameMatchKeys(c?.name)) elsewhereKeys.delete(k)
          }
        }
        // Oracle text for the cards already in the deck, up front (one fast
        // Supabase query). deck_cards_view carries no oracle text, so without
        // this every existing deck card classifies as Synergy until the much
        // larger owned-collection backfill finishes — which on big collections
        // can take many seconds, leaving the other roles looking empty.
        const deckIds = [...new Set(
          (deckCards || [])
            .filter(dc => !dc?.is_commander && dc?.scryfall_id && !sfById[dc.scryfall_id]?.oracle_text)
            .map(dc => dc.scryfall_id),
        )]
        if (deckIds.length) {
          try {
            const printRows = await fetchCardPrintsByScryfallIds(deckIds)
            // Some printings' rows carry no oracle text (and sometimes no
            // oracle_id either); remember the card name so we can recover the
            // text from a sibling printing below.
            const needOracle = [] // { sid, name }
            const idToName = new Map((deckCards || []).map(dc => [dc.scryfall_id, dc.name]))
            for (const sid of deckIds) {
              const row = printRows.get(sid)
              const entry = row ? cardPrintRowToSfEntry(row) : null
              if (entry) sfById[sid] = overlayNonNull(sfById[sid], entry)
              const name = row?.name || idToName.get(sid)
              if (!sfById[sid]?.oracle_text && name) needOracle.push({ sid, name })
            }
            // Fallback: pull oracle text (+ type/keywords) from any printing of
            // the same card that has it. Oracle text is identical across
            // printings, so this fixes cards whose exact printing's row is blank
            // (otherwise they'd misclassify as Synergy). Keyed by name because
            // the blank rows can also lack oracle_id. Art/price are left as the
            // deck's own printing — only classification fields are overlaid.
            if (needOracle.length) {
              const byName = await fetchOracleTextByNames(needOracle.map(x => x.name))
              for (const { sid, name } of needOracle) {
                const alt = byName.get(name)
                if (alt?.oracle_text) {
                  sfById[sid] = overlayNonNull(sfById[sid], {
                    oracle_text: alt.oracle_text,
                    type_line: alt.type_line,
                    keywords: alt.keywords,
                  })
                }
              }
            }
          } catch { /* counts will correct once the owned backfill runs */ }
        }
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
        setOwnedNameSet(new Set((ownedNorm || []).flatMap(c => cardNameMatchKeys(c?.name))))
        setInOtherDeckNames(elsewhereKeys)
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
      for (const c of role.ownedCandidates) for (const k of cardNameMatchKeys(c.name)) m.set(k, role.role)
      for (const u of role.edhrecUpgrades) for (const k of cardNameMatchKeys(u.name)) m.set(k, role.role)
      for (const u of role.recommenderUpgrades || []) for (const k of cardNameMatchKeys(u.name)) m.set(k, role.role)
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
      for (const c of role.ownedCandidates) for (const k of cardNameMatchKeys(c.name)) m.set(k, c.edhrecInclusion || 0)
      for (const u of role.edhrecUpgrades) for (const k of cardNameMatchKeys(u.name)) m.set(k, u.edhrecInclusion || 0)
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
      const role = roleOfDeckCard(dc, sfMap, roleByName)
      counts.set(role, (counts.get(role) || 0) + (dc.qty || 1))
      const isLand = (sf?.type_line || dc?.type_line || '').toLowerCase().includes('land')
      if (isLand) totalLands += (dc.qty || 1)
      const inclusion = cardNameMatchKeys(name).map(k => inclusionByName.get(k)).find(v => v != null) ?? 0
      rows.push({
        id: dc.id, name, role, isLand,
        scryfall_id: dc.scryfall_id,
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
    // Also enrich cards already in the deck. deck_cards_view carries no oracle
    // text, so without this the live per-role counts (and cut/bracket analysis)
    // classify every existing deck card as Synergy — emptying the other roles
    // whenever the assistant opens on a filled deck. No color-identity filter:
    // a card that's in the deck should be classified regardless.
    for (const dc of deckCards || []) {
      if (dc?.is_commander) continue
      const sid = dc?.scryfall_id
      if (!sid || seen.has(sid)) continue
      if (d.sfById[sid]?.oracle_text) continue
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
  // Karsten per-color source targets from the deck's own pip demands (incl.
  // the commander — you want to cast it on curve too).
  const karstenReqs = useMemo(() => karstenColorRequirements(deckCards, sfMap), [deckCards, sfMap])
  const onLands = currentRoleName === ROLE_LANDS

  // Annotate land candidates with the colors they produce; rank lands covering
  // colors that are BELOW their Karsten source target first, then broader
  // fixers. Basics are excluded — they're added automatically on finish, not
  // picked here. Computed from the plan (not the current step) because
  // auto-fill needs it on any step; auto-fill consumes this same order, so its
  // land picks chase the shortfalls too.
  const landCandidates = useMemo(() => {
    const landsRole = plan?.roles?.find(r => r.role === ROLE_LANDS)
    if (!landsRole) return []
    const needy = cmdColors.filter(c => (karstenReqs[c]?.needed || 0) > (manaSources[c] || 0))
    return landsRole.ownedCandidates
      .filter(cand => !isBasicLandName(cand.name))
      .map(cand => {
        const colors = [...producedColors(cand.sfCard?.oracle_text, cand.sfCard?.type_line)]
        const matching = colors.filter(c => cmdColors.includes(c))
        const needScore = matching.filter(c => needy.includes(c)).length
        return { cand, colors, score: matching.length, needScore }
      })
      .sort((a, b) => (b.needScore - a.needScore) || (b.score - a.score) || (b.colors.length - a.colors.length) || a.cand.name.localeCompare(b.cand.name))
  }, [plan, cmdColors, karstenReqs, manaSources])

  // Land target (Lands role target, theme-adjusted) and the basic/nonbasic split.
  // recommendedBasics scales with color count; nonbasicTarget is what to aim for
  // in this step. plannedBasics is the top-up applied on finish (Karsten
  // shortfalls first, then pip weights — see planBasicLands).
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

  // ── Auto-fill ───────────────────────────────────────────────────────────────
  // One click adds the top binder-available candidate for every remaining role
  // slot (budget + target bracket respected), plus nonbasic lands; basics still
  // top up on finish. The dry-run memo drives the button label, so the user
  // sees exactly how many cards a click will add.
  const currentBasicLands = useMemo(() => {
    let n = 0
    for (const dc of deckCards || []) {
      if (!dc?.is_commander && isBasicLandName(dc?.name)) n += dc.qty || 1
    }
    return n
  }, [deckCards])

  const autoFillExclude = useCallback(cand => {
    if (!cand?.name || isAdded(cand.name)) return true
    if (!passesBudget(cand.name, cand.sfCard)) return true
    if (targetBracket != null) {
      const flag = bracketFlagFor(cand.name, cand.sfCard, gameChangers)
      if (flag && flag.level > targetBracket) return true
    }
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addedNames, deckNames, passesBudget, targetBracket, gameChangers])

  const autoFillBase = useMemo(() => {
    if (!plan || loading) return null
    return {
      liveCounts,
      totalCards,
      deckSize: plan.deckSize,
      landsTarget,
      currentLands: manaSources.lands,
      nonbasicTarget,
      currentNonbasicLands: Math.max(0, manaSources.lands - currentBasicLands),
      landCandidates: landCandidates.map(l => l.cand),
      exclude: autoFillExclude,
    }
  }, [plan, loading, liveCounts, totalCards, landsTarget, manaSources.lands,
      nonbasicTarget, currentBasicLands, landCandidates, autoFillExclude])

  const upgradesFor = useCallback(
    role => selectUpgrades(role, hasRecommender ? suggestionSource : 'edhrec'),
    [hasRecommender, suggestionSource],
  )

  // Two dry runs drive the modal's option labels: binders only, and binders
  // topped up with unowned suggestions.
  const autoFillPicksOwned = useMemo(
    () => (autoFillBase ? planAutoFill({ ...autoFillBase, roles: plan.roles }) : []),
    [autoFillBase, plan],
  )
  const autoFillPicksAll = useMemo(() => {
    if (!autoFillBase) return []
    const roles = plan.roles.map(r => ({ ...r, upgrades: upgradesFor(r) }))
    const landsRole = plan.roles.find(r => r.role === ROLE_LANDS)
    const landUpgrades = landsRole
      ? upgradesFor(landsRole).filter(u => (u.type || '').toLowerCase().includes('land'))
      : []
    return planAutoFill({ ...autoFillBase, roles, landUpgrades, includeUpgrades: true })
  }, [autoFillBase, plan, upgradesFor])

  const [autoFillOpen, setAutoFillOpen] = useState(false)
  const [autoFillSource, setAutoFillSource] = useState('owned') // 'owned' | 'all'
  const [autoFilling, setAutoFilling] = useState(null) // { total, bulk } | { done, total }
  const [autoFillResult, setAutoFillResult] = useState(null) // { added, skipped }
  const autoFillSelected = autoFillSource === 'all' ? autoFillPicksAll : autoFillPicksOwned

  async function startAutoFill() {
    const picks = autoFillSelected
    if (!picks.length || autoFilling) return
    // Fast path: one batched parent call instead of a network round-trip per
    // card. Falls back to sequential adds when the parent doesn't provide it.
    if (typeof onAddCards === 'function') {
      setAutoFilling({ total: picks.length, bulk: true })
      try {
        const items = picks.map(p => p.owned
          ? { ...ownedCardForAdd(p.cand), foil: !!p.cand.card?.foil, card_print_id: p.cand.card?.card_print_id || null }
          : p.cand)
        const res = await onAddCards(items)
        setAddedNames(prev => {
          const next = new Set(prev)
          for (const p of picks) next.add(p.cand.name.toLowerCase())
          return next
        })
        setAutoFillResult({ added: res?.added ?? picks.length, skipped: res?.skipped ?? 0 })
      } catch {
        setAutoFillResult({ added: 0, skipped: picks.length })
      } finally {
        setAutoFilling(null)
      }
      return
    }
    setAutoFilling({ done: 0, total: picks.length })
    try {
      for (let i = 0; i < picks.length; i++) {
        const p = picks[i]
        await handleAdd(p.owned ? ownedCardForAdd(p.cand) : p.cand, p.cand.name)
        setAutoFilling({ done: i + 1, total: picks.length })
      }
      setAutoFillResult({ added: picks.length, skipped: 0 })
    } finally {
      setAutoFilling(null)
    }
  }

  // ── Buy the gap ─────────────────────────────────────────────────────────────
  // Deck cards not available in the binders, split into "to buy" and "owned in
  // another deck". Prices come from the same cheapest-English cache the tiles
  // use (resolved for these names by the effect below when the summary opens).
  const buyGap = useMemo(
    () => buildBuyList(deckCards, ownedNameSet, inOtherDeckNames),
    [deckCards, ownedNameSet, inOtherDeckNames],
  )
  const buyGapPrice = useMemo(() => {
    let total = 0
    let unpriced = 0
    for (const m of buyGap.toBuy) {
      const v = cheapestOf(m.name)
      if (v != null) total += v * m.qty
      else unpriced++
    }
    return { total, unpriced }
  }, [buyGap, cheapestOf])
  const [copiedGap, setCopiedGap] = useState(false)
  async function handleCopyBuyList() {
    try {
      await navigator.clipboard.writeText(buyListText(buyGap.toBuy))
      setCopiedGap(true)
      setTimeout(() => setCopiedGap(false), 2000)
    } catch { /* clipboard unavailable — the list is still on screen */ }
  }

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
    // Summary: price the buy-the-gap list with the same cheapest-English data.
    if (onSummary) {
      for (const m of [...buyGap.toBuy, ...buyGap.elsewhere]) names.add(m.name)
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
        const langById = new Map(sfCards.map(c => [c.id, c.lang]))
        const next = new Map(cheapestByName)
        for (const n of missing) {
          const cands = candsByName.get(n) || []
          const en = pickCheapestEnglish(cands, langById)
          // No English copy among the cheapest candidates → fall back to the
          // overall cheapest price (no English art to show).
          const chosen = en
            ? { price: en.price, image: getCardImageUri(byId.get(en.id), 'small') }
            : (cands[0] ? { price: cands[0].price, image: null } : { price: null, image: null })
          next.set(n.toLowerCase(), chosen)
        }
        if (!cancelled) setCheapestByName(next)
      } catch { /* leave cache as-is; tiles show "—" */ }
    })()
    return () => { cancelled = true }
  }, [onLands, onSummary, buyGap, roleData, landCandidates, suggestionSource, hasRecommender, price_source, cheapestByName])

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
    if (!ids?.length) return
    setApplyingCuts(true)
    try {
      if (typeof onRemoveCards === 'function') {
        // One state update + one DB delete for the whole batch — cutting per
        // card re-renders the assistant and reruns the plan after every cut.
        try { await onRemoveCards(ids) } catch { /* parent surfaces */ }
      } else if (typeof onRemoveCard === 'function') {
        for (const id of ids) { try { await onRemoveCard(id) } catch { /* parent surfaces */ } }
      }
    } finally { setApplyingCuts(false) }
  }

  // Finish: optionally top the manabase up with pip-weighted basics (the last
  // build step), then close. Additive + idempotent, so finishing twice is safe.
  // The basics top-up is opt-out: it fills to the land target, which would push
  // a low-land deck over 100, so the summary lets you finish without it.
  const [finishing, setFinishing] = useState(false)
  const [addBasics, setAddBasics] = useState(true)
  const willAddBasics = addBasics && plannedBasics.total > 0
  async function handleFinish() {
    if (willAddBasics && typeof onAddBasics === 'function') {
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
    const dc = (deckCards || []).find(c => !c?.is_commander && cardNameMatchKeys(c?.name).includes(key))
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
          <span className={styles.title}>Build Assistant</span>
          <span className={styles.commander}>{commander.name}</span>
          {!loading && !error && (
            <div className={styles.controlsReadouts}>
              {gameChangers && deckBracket && (
                <button
                  type="button"
                  className={`${styles.bracketNow} ${styles.bracketBtn}${overTarget ? ' ' + styles.bracketOver : ''}`}
                  onClick={() => setShowBracketReasons(v => !v)}
                  aria-expanded={showBracketReasons}
                  title={`Estimated Commander Bracket: ${deckBracket.bracket} (${BRACKET_LABELS[deckBracket.bracket]})`
                    + (deckBracket.combosChecked ? '' : ' — combos not checked yet, may rise')
                    + '. Tap to see what drives it.'}
                >
                  B{deckBracket.bracket} · {BRACKET_LABELS[deckBracket.bracket]}
                  {!deckBracket.combosChecked && <WarningIcon size={11} />}
                  <ChevronDownIcon
                    size={10}
                    className={`${styles.bracketCaret}${showBracketReasons ? ' ' + styles.bracketCaretOpen : ''}`}
                  />
                </button>
              )}
              <span className={styles.deckValue} title="Estimated value of the current deck">
                {formatPrice(deckValue, price_source)}
              </span>
            </div>
          )}
        </div>

        {/* Bracket "why" disclosure — near the estimate badge. */}
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
            <div className={styles.controlsGroup}>
            {themes.length > 0 && (
              <ControlMenu
                label="Theme"
                title="Deck theme"
                hint="Re-weight the role targets and suggestions toward an archetype"
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
                hint="Target power level — flags cards that push the deck above it"
                valueLabel={targetBracket == null ? 'Any' : `${targetBracket} · ${BRACKET_LABELS[targetBracket]}`}
              >
                {close => (
                  <>
                    <MenuOption active={targetBracket == null} onClick={() => { setTargetBracket(null); close() }}
                      desc="No power-level target">
                      Any
                    </MenuOption>
                    {[1, 2, 3, 4].map(b => (
                      <MenuOption key={b} active={targetBracket === b} onClick={() => { setTargetBracket(b); close() }}
                        desc={BRACKET_DESC[b]}>
                        {b} · {BRACKET_LABELS[b]}
                      </MenuOption>
                    ))}
                  </>
                )}
              </ControlMenu>
            )}

            <ControlMenu
              label="Budget"
              title="Max price per card"
              hint="Hide owned cards and suggestions whose cheapest English printing costs more than this"
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
                hint="Where the 'don't own' picks come from"
                valueLabel={SUGGESTION_SOURCES.find(s => s.id === suggestionSource)?.label || 'EDHREC + Recommander'}
              >
                {close => (
                  <>
                    {SUGGESTION_SOURCES.map(s => (
                      <MenuOption
                        key={s.id}
                        active={suggestionSource === s.id}
                        onClick={() => { setSuggestionSource(s.id); close() }}
                        desc={s.desc}
                      >
                        {s.label}
                      </MenuOption>
                    ))}
                  </>
                )}
              </ControlMenu>
            )}
            </div>
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
              {/* Pinned so the target + progress stay visible while the card
                  list scrolls. */}
              <div className={styles.roleHead}>
                <div className={styles.roleHeadTop}>
                  <div className={styles.roleName} title={ROLE_INFO[currentRoleName]}>{currentRoleName}</div>
                  <div className={styles.roleCount}>
                    {current} / {target}
                    {gap > 0 ? <span className={styles.gap}> · {gap} to go</span>
                             : <span className={styles.met}> · target met</span>}
                  </div>
                </div>
                <ProgressBar value={pct} />
              </div>
              <div className={styles.roleDesc}>{ROLE_INFO[currentRoleName]}</div>

              {/* Manabase: colored sources vs Karsten targets (Lands step only).
                  Each color's target comes from the deck's most demanding spell
                  of that color (Karsten 2022, 99-card column); no spells of a
                  color → no target, plain count with the old soft floor. */}
              {onLands && cmdColors.length > 0 && (
                <div className={styles.sources}>
                  <span
                    className={styles.sourcesLabel}
                    title="Colored sources (lands, rocks, dorks) vs the count Frank Karsten's math says your most demanding spell of each color wants"
                  >
                    Mana sources
                  </span>
                  {cmdColors.map(c => {
                    const n = manaSources[c] || 0
                    const req = karstenReqs[c]
                    const thin = req ? n < req.needed : n < THIN_SOURCE_FLOOR
                    const title = req
                      ? `${c}: ${n} of ${req.needed} sources — most demanding: ${req.card} (${c.repeat(req.pips)} at ${req.cmc} mana)`
                        + (thin ? ' — consider more fixing' : '')
                      : `${c}: ${n} sources${thin ? ' — consider more fixing' : ''}`
                    return (
                      <span key={c} className={`${styles.sourceItem}${thin ? ' ' + styles.sourceThin : ''}`} title={title}>
                        <span className={styles.pip} style={{ background: MANA_HEX[c] }} />
                        {n}
                        {req && <span className={styles.sourceTarget}>/{req.needed}</span>}
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
                <span
                  className={styles.sectionHeadLabel}
                  title="Only binder copies are offered — cards allocated to other decks show under suggestions with an 'In another deck' note"
                >
                  From your binders · {onLands ? landCandidates.length : roleData.ownedCandidates.length}
                  {onLands && <span className={styles.sectionHint}> · nonbasic, needed colors first</span>}
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
                      ? 'No nonbasic lands available in your binders — basics will be added automatically on finish.'
                      : 'Nothing in your binders matches this role in your colors. Copies already allocated to other decks aren’t offered.'}
                  </div>
                }
                if (shown.length === 0) {
                  return <div className={styles.emptySmall}>No {currentRoleName.toLowerCase()} cards in your binders under your budget.</div>
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
                      <div className={styles.moreNote}>+{shown.length - MAX_TILES} more in your binders</div>
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
                              ownedElsewhere={cardNameMatchKeys(up.name).some(k => inOtherDeckNames.has(k))}
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
                <label className={styles.basicsNote} style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    className={styles.basicsCheck}
                    checked={addBasics}
                    onChange={e => setAddBasics(e.target.checked)}
                  />
                  {addBasics ? (
                    <span>
                      Add <strong>{plannedBasics.total}</strong> basic land{plannedBasics.total > 1 ? 's' : ''} on finish,
                      split by color demand:
                    </span>
                  ) : (
                    <span>Basics won’t be added — finish leaves the manabase as-is.</span>
                  )}
                  {addBasics && <BasicsBreakdown counts={plannedBasics.counts} />}
                </label>
              )}

              {/* Buy the gap — deck cards not available in the binders */}
              <div className={styles.sectionLabel}>
                Missing from your binders
                {(buyGap.toBuy.length + buyGap.elsewhere.length) > 0 && (
                  <span className={styles.sectionHint}>
                    {' '}· {buyGap.toBuy.length + buyGap.elsewhere.length} cards
                    {buyGapPrice.total > 0 && ` · ~${formatPrice(buyGapPrice.total, price_source)} to buy`}
                    {buyGapPrice.unpriced > 0 && ` (${buyGapPrice.unpriced} unpriced)`}
                  </span>
                )}
              </div>
              {buyGap.toBuy.length === 0 && buyGap.elsewhere.length === 0 ? (
                <div className={styles.emptySmall}>Every nonbasic card is available in your binders.</div>
              ) : (
                <>
                  {buyGap.toBuy.length > 0 && (
                    <div className={styles.gapActions}>
                      <button className={styles.themeChip} onClick={handleCopyBuyList}>
                        {copiedGap ? 'Copied!' : `Copy buy list (${buyGap.toBuy.length})`}
                      </button>
                      <a
                        className={`${styles.themeChip} ${styles.chipLink}`}
                        href={tcgplayerMassEntryUrl(buyGap.toBuy)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open the buy list in TCGplayer Mass Entry"
                      >
                        TCGplayer <ExternalLinkIcon size={11} />
                      </a>
                    </div>
                  )}
                  <div className={styles.gapList}>
                    {[...buyGap.toBuy, ...buyGap.elsewhere].map(m => {
                      const v = cheapestOf(m.name)
                      return (
                        <div key={m.name} className={styles.gapRow}>
                          <span className={styles.gapQty}>{m.qty}×</span>
                          <span className={styles.gapName} title={m.name}>{m.name}</span>
                          {m.elsewhere && (
                            <span
                              className={styles.gapElsewhere}
                              title="You own this card — every copy is allocated to another deck"
                            >
                              in another deck
                            </span>
                          )}
                          <span className={styles.gapPrice}>
                            {v != null ? formatPrice(v, price_source) : '—'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </>
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
                              <span key={m.name} className={styles.comboNeed} title="Not available — unowned, or every copy is in another deck">{m.name}</span>
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
                      {cutAnalysis.recommended.map(c => {
                        const img = cardImageUrl(sfMap?.[c.scryfall_id] || null)
                        return (
                        <div key={c.id} className={styles.cutRow}>
                          <span className={styles.cutThumb} aria-hidden="true">
                            {img
                              ? <img src={img} alt="" loading="lazy" className={styles.cutThumbImg} />
                              : <span className={styles.cutThumbFallback} />}
                          </span>
                          <span className={styles.cutInfo}>
                            <span className={styles.cutName} title={c.name}>{c.name}</span>
                            <span className={styles.cutSub}>
                              <span className={styles.cutReason}>{c.reason}</span>
                              <span className={styles.cutMeta}>{c.hasData ? `${c.inclusion}%` : '—'} · {c.cmc} CMC</span>
                            </span>
                          </span>
                          <button
                            className={styles.cutKeep}
                            onClick={() => toggleCutLock(c.id)}
                            title="Keep this card (lock it out of cut suggestions)"
                          >
                            Keep
                          </button>
                          <button
                            className={`${styles.miniBtn} ${styles.cutBtn}`}
                            onClick={() => handleRemove(c.id)}
                            title={`Remove ${c.name}`}
                          >
                            <DeleteIcon size={11} /> Cut
                          </button>
                        </div>
                        )
                      })}
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
          {!loading && !error && plan && (autoFilling || autoFillPicksOwned.length > 0 || autoFillPicksAll.length > 0) && (
            <Button
              variant="ghost"
              className={styles.autoFillBtn}
              onClick={() => { setAutoFillResult(null); setAutoFillOpen(true) }}
              disabled={!!autoFilling}
              title="Fill every remaining role automatically — from your binders only, or topped up with suggestions"
            >
              <LightningIcon size={13} />
              {autoFilling
                ? (autoFilling.bulk ? ' Adding…' : ` Adding ${autoFilling.done}/${autoFilling.total}…`)
                : ' Auto-fill'}
            </Button>
          )}
          <div className={styles.footerSpacer} />
          {stepIndex < steps.length - 1 ? (
            <Button variant="primary" onClick={() => setStepIndex(i => Math.min(steps.length - 1, i + 1))}>
              Next: {steps[stepIndex + 1] === SUMMARY_STEP ? 'Summary' : steps[stepIndex + 1]}
            </Button>
          ) : (
            <Button variant="primary" onClick={handleFinish} disabled={finishing}>
              {willAddBasics
                ? (finishing ? 'Adding basics…' : `Add ${plannedBasics.total} basics & finish`)
                : 'Finish'}
            </Button>
          )}
        </div>

        {/* Auto-fill dialog — in-panel overlay (the assistant is already a
            modal; stacking a second Modal would double the body scroll lock). */}
        {autoFillOpen && (
          <div className={styles.afOverlay} role="dialog" aria-modal="true" aria-label="Auto-fill deck">
            <div className={styles.afCard}>
              <div className={styles.afTitle}>Auto-fill deck</div>
              {!autoFilling && !autoFillResult && (
                <>
                  <label className={`${styles.afOption}${autoFillSource === 'owned' ? ' ' + styles.afOptionActive : ''}`}>
                    <input
                      type="radio"
                      name="af-source"
                      className={styles.afRadio}
                      checked={autoFillSource === 'owned'}
                      onChange={() => setAutoFillSource('owned')}
                    />
                    <span className={styles.afOptionBody}>
                      <span className={styles.afOptionLabel}>From your binders only</span>
                      <span className={styles.afOptionDesc}>
                        {autoFillPicksOwned.length
                          ? `Adds ${autoFillPicksOwned.length} card${autoFillPicksOwned.length === 1 ? '' : 's'} you can pull from binders right now.`
                          : 'Nothing left to add from your binders.'}
                      </span>
                    </span>
                  </label>
                  <label className={`${styles.afOption}${autoFillSource === 'all' ? ' ' + styles.afOptionActive : ''}`}>
                    <input
                      type="radio"
                      name="af-source"
                      className={styles.afRadio}
                      checked={autoFillSource === 'all'}
                      onChange={() => setAutoFillSource('all')}
                    />
                    <span className={styles.afOptionBody}>
                      <span className={styles.afOptionLabel}>Binders + suggestions</span>
                      <span className={styles.afOptionDesc}>
                        {(() => {
                          const owned = autoFillPicksAll.filter(p => p.owned).length
                          const sugg = autoFillPicksAll.length - owned
                          return autoFillPicksAll.length
                            ? `Adds ${owned} from your binders and ${sugg} suggested card${sugg === 1 ? '' : 's'} you don’t own — those land in the summary’s buy list.`
                            : 'No fitting cards or suggestions left.'
                        })()}
                      </span>
                    </span>
                  </label>
                  <div className={styles.afNote}>
                    Your budget and bracket filters apply. Basic lands are still added when you finish.
                  </div>
                  <div className={styles.afActions}>
                    <Button variant="ghost" onClick={() => setAutoFillOpen(false)}>Cancel</Button>
                    <Button variant="primary" disabled={autoFillSelected.length === 0} onClick={startAutoFill}>
                      Add {autoFillSelected.length} card{autoFillSelected.length === 1 ? '' : 's'}
                    </Button>
                  </div>
                </>
              )}
              {autoFilling && (
                <div className={styles.afProgress}>
                  {autoFilling.bulk
                    ? `Adding ${autoFilling.total} cards…`
                    : `Adding ${autoFilling.done} / ${autoFilling.total}…`}
                </div>
              )}
              {!autoFilling && autoFillResult && (
                <>
                  <div className={styles.afResult}>
                    Added {autoFillResult.added} card{autoFillResult.added === 1 ? '' : 's'}
                    {autoFillResult.skipped ? ` · ${autoFillResult.skipped} skipped (no card data)` : ''}.
                  </div>
                  <div className={styles.afActions}>
                    <Button variant="primary" onClick={() => { setAutoFillResult(null); setAutoFillOpen(false) }}>
                      Done
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
