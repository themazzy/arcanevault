import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Modal, ConfirmModal, Button, Input, ProgressBar, ResponsiveMenu } from '../UI'
import uiStyles from '../UI.module.css'
import { CheckIcon, DeleteIcon, WarningIcon, ChevronDownIcon, LightningIcon, ExternalLinkIcon, CloseIcon } from '../../icons'
import { useCardSearch } from '../../hooks/useCardSearch'
import { getCardLegalityWarnings } from '../../lib/deckLegality'
import { getLocalCards, getLocalCardPrints, getLocalFolders, getAllLocalFolderCards } from '../../lib/db'
import { getInstantCache, getScryfallKey, getPrice, formatPrice, scryfallImageAtSize } from '../../lib/scryfall'
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
  bracketAdjustments,
  combineTemplateDeltas,
  applyTemplateAdjustments,
  bracketFlagFor,
  comboFitsBracket,
  comboInColorIdentity,
  mapAlmostCombos,
  comboTargetForBracket,
  planComboCompletion,
  producedColors,
  faceOracleText,
  faceTypeLine,
  countManaSources,
  karstenColorRequirements,
  roleOfDeckCard,
  coarseRole,
  countByRole,
  pickCheapestEnglish,
  recommendedBasicCount,
  basicsForAutoFill,
  isBasicLandName,
  analyzeCut,
  CUT_MODES,
  attachRecommenderUpgrades,
  selectUpgrades,
  upgradeDisplayLimit,
  upgradePoolDepth,
  deckAvgCmc,
  planTargetAvgCmc,
  curveVerdict,
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
  [ROLE_RAMP]: 'Mana acceleration — Mana rocks, dorks, and land fetching. Helps you deploy your commander and spells ahead of curve, before your opponents do.',
  [ROLE_DRAW]: 'Draw — Card advantage engines and tutors that refill your hand and find your key pieces to stay ahead of your opponents.',
  [ROLE_REMOVAL]: 'Spot interaction — Destroy, exile, bounce, counter, or burn a single problematic permanent or spell that threatens your position.',
  [ROLE_WIPE]: 'Board wipes — Mass removal to reset the board when you fall behind.',
  [ROLE_PROTECTION]: 'Protection — Keep your commander and key cards safe with hexproof, indestructibility and redirects.',
  [ROLE_WINCON]: 'Game plan — How the deck actually closes the game: combos, extra turns, and big finishers.',
  [ROLE_SYNERGY]: 'Synergy — cards that support your commander’s theme and strategy. This will take majority of your deck.',
  [ROLE_LANDS]: 'Mana base — Lands, including utility lands. Aim for roughly the recommended ammount to hit your colors consistently.',
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

// Module-scope caches so reopening the assistant is instant — both hold
// intrinsic data that doesn't change within a page session:
//   • upgrade meta is keyed by card name (oracle/type/art — printing-agnostic)
//   • recommander picks are keyed by commander + sorted deck signature
// Bounded LRU (oldest evicted) so long sessions don't grow unbounded.
const UPGRADE_META_CACHE = new Map() // name → { name, oracle_text, type_line, image } | null
const RECOMMENDER_CACHE = new Map()  // sig  → rows[]
const CACHE_CAP = 4000
function cachePut(map, key, value) {
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  while (map.size > CACHE_CAP) map.delete(map.keys().next().value)
}

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

// Flavor phrases cycled while auto-fill runs — pure garnish, MTG-themed so the
// wait reads as part of the game rather than a generic spinner.
const AUTOFILL_PHRASES = [
  'Untapping your lands…',
  'Consulting the Oracle…',
  'Shuffling up the library…',
  'Searching for the perfect curve…',
  'Paying the commander tax…',
  'Fetching dual lands…',
  'Weighing every ramp package…',
  'Tutoring for the answers…',
  'Drawing the opening hand…',
  'Counting your mana symbols…',
  'Assembling the game plan…',
  'Summoning your all-stars…',
]
// Order the pips animate through — WUBRG, the canonical color wheel.
const AUTOFILL_MANA = ['W', 'U', 'B', 'R', 'G']

// Animated auto-fill loader: a ring of pulsing mana pips over a cycling MTG
// flavor phrase. `progress` (optional { done, total }) shows a live count on the
// sequential add path; the bulk path just cycles phrases. Honors reduce_motion —
// with motion off the pips sit still and the phrase doesn't rotate.
function AutoFillLoader({ progress, reduceMotion }) {
  const [phrase, setPhrase] = useState(() => AUTOFILL_PHRASES[0])
  useEffect(() => {
    if (reduceMotion) return
    let i = 0
    const id = setInterval(() => {
      i = (i + 1) % AUTOFILL_PHRASES.length
      setPhrase(AUTOFILL_PHRASES[i])
    }, 1700)
    return () => clearInterval(id)
  }, [reduceMotion])
  return (
    <div className={styles.afLoader}>
      <div className={`${styles.afMana}${reduceMotion ? ' ' + styles.afManaStill : ''}`}>
        {AUTOFILL_MANA.map((c, i) => (
          <span
            key={c}
            className={styles.afManaPip}
            style={{ background: MANA_HEX[c], animationDelay: `${i * 0.13}s` }}
          />
        ))}
      </div>
      <div key={phrase} className={styles.afPhrase}>{phrase}</div>
      {progress
        ? <div className={styles.afCount}>{progress.done} / {progress.total} cards</div>
        : <div className={styles.afCount}>Building your deck</div>}
    </div>
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
function CardTile({ name, sfCard, fallbackImg, pips, inclusion, tag, price, flag, overTarget, added, wished, showWishlist, ownedElsewhere, previewProps, onAdd, onUndo, onWishlist }) {
  const canUndo = added && typeof onUndo === 'function'
  // Cached collection art first; Scryfall-fetched fallback for unowned upgrades
  // and any owned card whose cache entry has no image.
  const img = cardImageUrl(sfCard) || fallbackImg || null
  // previewProps carries the hover/tap handlers for the large-image preview;
  // it's empty ({}) when the card has no art to enlarge. No special cursor — the
  // enlarge is a hover affordance, and a zoom-in cursor would wrongly imply a click.
  return (
    <div className={`${styles.tile}${added ? ' ' + styles.tileAdded : ''}`}>
      <div className={styles.tileArt} {...(previewProps || {})}>
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

// Persistent "add a specific card" search — the manual escape hatch for cards
// the recommendation feed didn't surface. Sits above the per-step content so
// it's reachable on every step. Each result shows the deck category it will be
// filed under (→ Ramp / Removal / …) so the user knows where to find it after
// adding; off-color / illegal cards are flagged but still addable (the user
// confirms). Adds go through the same handler as tiles, so owned-vs-buy
// accounting and category persistence stay identical.
function SpecificCardSearch({ search, onAdd, isAdded, categoryOf, commanderColorIdentity, makePreview }) {
  const { query, results, loading, handleInput } = search
  const trimmed = (query || '').trim()
  // The results float over the panel (don't push it down) and behave like an
  // autocomplete popover: a click outside closes them, and focusing the search
  // bar reopens them.
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDocDown = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('touchstart', onDocDown)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('touchstart', onDocDown)
    }
  }, [open])
  const showResults = open && trimmed.length > 0
  return (
    <div className={styles.specSearch} ref={wrapRef}>
      <div className={styles.specSearchLabel}>Add a specific card</div>
      <Input
        value={query}
        onChange={e => { handleInput(e.target.value); setOpen(true) }}
        onClear={() => { handleInput(''); setOpen(false) }}
        onFocus={() => setOpen(true)}
        placeholder="Search a card by name…"
        clearable
      />
      {showResults && (
        <div className={styles.specResults}>
          {loading && results.length === 0
            ? <div className={styles.emptySmall}>Searching…</div>
            : results.length === 0
              ? <div className={styles.emptySmall}>No cards found.</div>
              : results.slice(0, 8).map(card => {
                  const cat = categoryOf(card)
                  const warnings = getCardLegalityWarnings({
                    card,
                    formatId: 'commander',
                    formatLabel: 'Commander',
                    isEDH: true,
                    commanderColorIdentity,
                  })
                  const added = isAdded(card.name)
                  const thumb = getCardImageUri(card, 'small')
                  return (
                    <div key={card.id} className={styles.specRow}>
                      {/* Thumbnail + name are the hover target (hugs the content,
                          not the whole row) — hovering either enlarges to a floating
                          preview (desktop) or a tap-lightbox (touch). No name
                          tooltip; the preview is the only affordance. */}
                      <div
                        className={styles.specHover}
                        {...makePreview({ name: card.name, scryfall_id: card.id, img: getCardImageUri(card, 'large') })}
                      >
                        {thumb && (
                          <img src={thumb} alt="" className={styles.specThumb} loading="lazy" />
                        )}
                        <span className={styles.specName}>{card.name}</span>
                      </div>
                      <div className={styles.specMeta}>
                        {warnings.length > 0 && (
                          <span className={styles.specWarn} title={warnings.map(w => w.text).join('\n')}>
                            <WarningIcon size={12} />
                          </span>
                        )}
                        {!added && <span className={styles.specCat} title="Build role this card will be filed under">{cat}</span>}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onAdd(card)}
                          disabled={added}
                        >
                          {added ? `Added to ${cat}` : 'Add'}
                        </Button>
                      </div>
                    </div>
                  )
                })}
        </div>
      )}
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

export function BuildAssistant({ userId, commander, deckCards = [], accessToken, onAddCard, onAddCards, onUndoAutoFill, onPlaytest, onRemoveCard, onRemoveCards, onAddToWishlist, onAddBasics, onClose }) {
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
  const afCardRef = useRef(null)     // auto-fill dialog card, focused on open
  const [themes, setThemes] = useState([])       // EDHREC archetypes for this commander
  const [selectedTheme, setSelectedTheme] = useState('') // '' = Balanced
  const [rebuilding, setRebuilding] = useState(false)
  const [gameChangers, setGameChangers] = useState(null) // Set of GC names (null until loaded)
  const [targetBracket, setTargetBracket] = useState(null) // null = no target; 1-4
  const [showBracketReasons, setShowBracketReasons] = useState(false) // inline "why" disclosure
  const [maxPrice, setMaxPrice] = useState(null) // budget filter ceiling, null = off
  const [curveTarget, setCurveTarget] = useState(null) // target avg CMC (EDHREC data → archetype fallback)
  const [suggestionSource, setSuggestionSource] = useState('both') // 'both' | 'edhrec' | 'recommander'
  const [cutMode, setCutMode] = useState('balanced') // cut helper ranking mode
  const [lockedCutIds, setLockedCutIds] = useState(() => new Set()) // deck-card ids kept off the cut list
  const [applyingCuts, setApplyingCuts] = useState(false)
  // Large-image card preview shown from the summary lists: hover-follows the
  // cursor on pointer devices, or a centered tap-to-dismiss lightbox on touch.
  // { name, scryfall_id, x, y } | null.
  const [preview, setPreview] = useState(null)
  const [ownedNameSet, setOwnedNameSet] = useState(() => new Set())
  // Names owned overall but with every copy allocated to another collection
  // deck — excluded from the owned pool, badged on suggestion tiles instead.
  const [inOtherDeckNames, setInOtherDeckNames] = useState(() => new Set())
  const metaFetchedRef = useRef(false) // owned-card oracle-text backfill ran for this commander
  const selectedThemeRef = useRef('')  // latest theme, read by the async backfill to avoid a stale-closure revert
  const targetBracketRef = useRef(null) // latest target bracket, read by the async re-plans (same stale-closure guard)

  const { price_source, reduce_motion } = useSettings()
  // Persistent "add a specific card" search (Commander-scoped ordering). Reuses
  // the builder's search hook so results carry full card data for classification
  // and legality checks.
  const cardSearch = useCardSearch({ format: 'commander' })
  // Guard against accidentally dismissing the assistant (backdrop click / Escape
  // / the X). A close attempt opens a confirm step instead of leaving outright.
  const [confirmClose, setConfirmClose] = useState(false)
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
  const fetchUpgradeMeta = useCallback(async (names) => {
    const cache = UPGRADE_META_CACHE
    const missing = names.filter(n => !cache.has(n.toLowerCase()))
    if (missing.length) {
      const cards = await fetchRecommendationMetadataByNames(missing).catch(() => [])
      for (const c of cards) {
        const requestedName = c.requested_name || c.name
        cachePut(cache, (requestedName || '').toLowerCase(), {
          name: requestedName,
          oracle_text: c.oracle_text || c.card_faces?.[0]?.oracle_text || '',
          type_line: c.type_line || c.card_faces?.[0]?.type_line || '',
          image: getCardImageUri(c, 'small'),
        })
      }
      for (const n of missing) if (!cache.has(n.toLowerCase())) cachePut(cache, n.toLowerCase(), null)
    }
    return names.map(n => cache.get(n.toLowerCase())).filter(Boolean)
  }, [])

  // Deck-aware recommander.cards picks, resolved to metadata via card_prints
  // (by oracle_id — no Scryfall call) so they can be classified + shown. Cached
  // per deck snapshot; best-effort (returns [] on any failure → EDHREC-only).
  const fetchRecommenderUpgrades = useCallback(async (deck) => {
    if (!commander?.name) return []
    const deckNames = (deck || []).filter(d => !d?.is_commander).map(d => d?.name).filter(Boolean)
    const sig = `${commander.name}|${commander.partnerName || ''}|${[...deckNames].sort().join(',')}`
    const cache = RECOMMENDER_CACHE
    if (cache.has(sig)) return cache.get(sig)
    const recs = await fetchRecommenderRecs(commander.name, deckNames, commander.partnerName || null)
    if (!recs.length) { cachePut(cache, sig, []); return [] }
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
    cachePut(cache, sig, rows)
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
      const template = applyTemplateAdjustments(
        COMMANDER_TEMPLATE,
        combineTemplateDeltas(archetypeAdjustments(themeSlug), bracketAdjustments(targetBracketRef.current)),
      )
      const base = analyzeBuildPlan({
        commander,
        ownedCards: d.ownedNorm,
        sfMap: d.sfById,
        currentDeckCards: deckCards,
        template,
      })
      const edhrec = await fetchEdhrecCommander(commander.name, 'commander', { themeSlug: themeSlug || '', partnerName: commander.partnerName || '' })
      setCurveTarget(planTargetAvgCmc(edhrec, themeSlug))
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
          fetchEdhrecCommander(commander.name, 'commander', { partnerName: commander.partnerName || '' }).catch(() => null),
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
        if (cancelled) return
        dataRef.current = { ownedNorm, sfById }
        setSfMap(sfById)
        setThemes(edhrec?.themes || [])
        setCurveTarget(planTargetAvgCmc(edhrec, ''))
        setGameChangers(gcNames || null)
        setOwnedNameSet(new Set((ownedNorm || []).flatMap(c => cardNameMatchKeys(c?.name))))
        setInOtherDeckNames(elsewhereKeys)
        // Show the EDHREC plan immediately — it's the reliable base. The deck-aware
        // Recommander picks layer on asynchronously, so a slow/down recommender
        // never blocks the initial render; if it returns nothing, EDHREC stands.
        // Guarded on the theme (still Balanced) so a theme switch mid-fetch wins.
        setPlan(enriched)
        mergeRecommender(enriched, deckCards)
          .then(withRecs => {
            if (!cancelled && selectedThemeRef.current === '' && withRecs !== enriched) setPlan(withRecs)
          })
          .catch(() => {})
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to analyze your collection.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // Re-run only when the commander identity changes — not on every deck edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, commander?.name, commander?.partnerName, (commander?.color_identity || []).join('')])

  function onSelectTheme(slug) {
    if (slug === selectedTheme) return
    setSelectedTheme(slug)
    selectedThemeRef.current = slug
    rebuildPlan(slug)
  }

  // Re-plan when the target bracket changes: the bracket reshapes the whole
  // fixed-role template (bracketAdjustments), composed with the active archetype.
  // Skips the initial mount (bracket starts null = no shift) and waits until the
  // collection has loaded. rebuildPlan reads the live bracket from the ref.
  const bracketInit = useRef(true)
  useEffect(() => {
    targetBracketRef.current = targetBracket
    if (bracketInit.current) { bracketInit.current = false; return }
    if (!dataRef.current) return
    rebuildPlan(selectedThemeRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetBracket])

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

  // Deck's current average nonland mana value + verdict vs. the target curve
  // (EDHREC data for this commander/theme, or an archetype fallback). Advisory —
  // shown on the summary curve so the player can see if the deck runs heavy.
  const avgCmc = useMemo(() => deckAvgCmc(deckCards, sfMap), [deckCards, sfMap])
  const curveStatus = useMemo(() => curveVerdict(avgCmc, curveTarget), [avgCmc, curveTarget])

  const totalCards = useMemo(
    () => (deckCards || []).reduce((sum, dc) => sum + (dc.qty || 1), 0),
    [deckCards],
  )
  // Target deck size (100 for Commander) — drives the auto-fill "→ 100" framing.
  const afTarget = plan?.deckSize || 100

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
  const cutAnalysis = useMemo(() => analyzeCut({
    plan, deckCards, sfMap, totalCards, cutMode, lockedIds: lockedCutIds,
    roleOf: dc => roleOfDeckCard(dc, sfMap, roleByName),
    inclusionOf: name => cardNameMatchKeys(name).map(k => inclusionByName.get(k)).find(v => v != null),
  }), [plan, deckCards, sfMap, inclusionByName, totalCards, roleByName, cutMode, lockedCutIds])

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
    return mapAlmostCombos({
      almost: combos.almost,
      deckNameKeys: deckNames,
      ownedNameKeys: ownedNameSet,
      limit: 12,
    })
  }, [combos.fetched, combos.almost, deckNames, ownedNameSet])

  // Combos that suit the target bracket (B3 → 3+ card, B4/cEDH → incl. fast
  // 2-card, B≤2 → none). Drives the summary suggestion list. When some combos
  // were hidden purely by the bracket filter we say so, rather than reading as
  // "no combos".
  const suggestedCombos = useMemo(
    () => almostCombos.filter(c => comboFitsBracket(c.uses.length, targetBracket)),
    [almostCombos, targetBracket],
  )
  const combosHiddenByBracket = almostCombos.length > 0 && suggestedCombos.length === 0 && targetBracket != null

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
      const template = applyTemplateAdjustments(
        COMMANDER_TEMPLATE,
        combineTemplateDeltas(archetypeAdjustments(theme), bracketAdjustments(targetBracketRef.current)),
      )
      const base = analyzeBuildPlan({
        commander,
        ownedCards: d.ownedNorm,
        sfMap: merged,
        currentDeckCards: deckCards,
        template,
      })
      const edhrec = await fetchEdhrecCommander(
        commander.name, 'commander', { themeSlug: theme || '', partnerName: commander.partnerName || '' },
      ).catch(() => null)
      // Bail if the user switched themes again while we were fetching EDHREC —
      // rebuildPlan owns the plan for the newer selection.
      if (cancelled || selectedThemeRef.current !== theme) return
      setCurveTarget(planTargetAvgCmc(edhrec, theme))
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
        const colors = [...producedColors(faceOracleText(cand.sfCard), faceTypeLine(cand.sfCard))]
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
  // Finish top-up: fill the manabase toward the land target, but never past the
  // deck's open slots — a deck already at (or over) deckSize gets 0 basics, so
  // "Finish" can't push a 100/101-card deck to 101/102. Mirrors the auto-fill
  // path (basicsForAutoFill); planBasicLands alone ignores deck size.
  const plannedBasics = useMemo(
    () => basicsForAutoFill({
      deckCards, sfMap, colors: cmdColors, landTarget: landsTarget,
      openSlots: Math.max(0, afTarget - totalCards),
    }),
    [deckCards, sfMap, cmdColors, landsTarget, afTarget, totalCards],
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
      // Curve plays a subordinate role in which good cards get picked: within a
      // band of similarly-recommended cards, auto-fill favors the ones that pull
      // the deck toward its target curve (see rankComparator/curveFitKey).
      targetCmc: curveTarget,
      curveStatus: curveStatus.status,
      exclude: autoFillExclude,
    }
  }, [plan, loading, liveCounts, totalCards, landsTarget, manaSources.lands,
      nonbasicTarget, currentBasicLands, landCandidates, autoFillExclude,
      curveTarget, curveStatus.status])

  // Auto-fill draws the FULL retained pool (Infinity), not the small display
  // cap — planAutoFill's exclude gate then removes over-budget / over-bracket /
  // owned picks, so a deep pool is what keeps harsh filters from starving the
  // build short of 100.
  const upgradesFor = useCallback(
    role => selectUpgrades(role, hasRecommender ? suggestionSource : 'edhrec', Infinity),
    [hasRecommender, suggestionSource],
  )

  // Two dry runs drive the modal's option labels: binders only, and the
  // ownership-blind "top recommendations" build.
  const autoFillPicksOwned = useMemo(
    () => (autoFillBase ? planAutoFill({ ...autoFillBase, roles: plan.roles }) : []),
    [autoFillBase, plan],
  )
  const autoFillPicksRec = useMemo(() => {
    if (!autoFillBase) return []
    const roles = plan.roles.map(r => ({ ...r, upgrades: upgradesFor(r) }))
    const landsRole = plan.roles.find(r => r.role === ROLE_LANDS)
    const landUpgrades = landsRole
      ? upgradesFor(landsRole).filter(u => (u.type || '').toLowerCase().includes('land'))
      : []
    return planAutoFill({ ...autoFillBase, roles, landUpgrades, source: 'recommended' })
  }, [autoFillBase, plan, upgradesFor])

  const [autoFillOpen, setAutoFillOpen] = useState(false)
  const [autoFillSource, setAutoFillSource] = useState('owned') // 'owned' | 'recommended'
  const [autoFilling, setAutoFilling] = useState(null) // { total, bulk } | { done, total }
  const [autoFillResult, setAutoFillResult] = useState(null) // { added, skipped, basics }

  // How many combos the post-fill pass will aim for at the current target
  // bracket — gates + labels the opt-in. Combos are completed in a SECOND pass
  // after the deck is populated (see runComboPass), not injected up front, so
  // this doesn't depend on the pre-fill deck already being close to a combo.
  const comboPassTarget = comboTargetForBracket(targetBracket)

  // Final auto-fill pick list: just the chosen source's role/land picks
  // (already capped to the deck's open slots by planAutoFill). Combo completion
  // happens post-fill in runComboPass, which cuts filler to make room.
  const autoFillSelected = autoFillSource === 'recommended' ? autoFillPicksRec : autoFillPicksOwned

  // Pseudo-rows for the sequential fallback (no bulk-add return): built from the
  // picks so the basics predictor sees real mana_cost / type_line before the
  // deckCards prop round-trips. Owned picks carry sfCard for pips.
  const picksToPseudoRows = picks => picks.map(p => ({
    name: p.cand.name,
    type_line: p.cand.sfCard?.type_line || p.cand.type || '',
    mana_cost: p.cand.sfCard?.mana_cost || p.cand.mana_cost || '',
    cmc: p.cand.cmc ?? p.cand.sfCard?.cmc ?? 0,
    oracle_text: p.cand.sfCard?.oracle_text || '',
    qty: 1,
  }))

  // Post-fill combo pass (opt-in). Re-queries Commander Spellbook on the just-
  // populated deck, completes as many bracket-appropriate combos as the target
  // allows (source-aware: 'owned' uses owned pieces only, 'recommended' may reach
  // for unowned pieces → buy list), and cuts an equal number of just-filled
  // filler cards so the deck size holds. Only cards THIS run added are cuttable —
  // never the user's existing cards, and never a piece of a combo being completed
  // — which also keeps undo coherent (undo returns to the pre-fill deck).
  // `populated` = [...deckCards, ...fillRows]; `fillIds` = this run's added ids.
  // Returns { comboRows, cutIds, combosCompleted }; best-effort, zeros on failure.
  async function runComboPass(populated, fillIds) {
    const empty = { comboRows: [], cutIds: [], combosCompleted: 0 }
    if (comboPassTarget <= 0) return empty
    try {
      const res = await combos.fetchCombos(populated)
      if (!res) return empty
      const deckKeys = new Set(
        populated.filter(d => !d?.is_commander).flatMap(d => cardNameMatchKeys(d?.name)),
      )
      // Only complete combos that live within the commander's color identity —
      // Spellbook's results include off-color "by adding colors" combos we must
      // not add. See comboInColorIdentity.
      const inIdentityAlmost = (res.almost || []).filter(c => comboInColorIdentity(c, commander?.color_identity))
      const almost = mapAlmostCombos({
        almost: inIdentityAlmost,
        deckNameKeys: deckKeys,
        ownedNameKeys: ownedNameSet,
      })

      // Room the combo pass can absorb without cutting the user's existing cards:
      // the open slots the fill left, plus this run's cuttable (nonland) filler.
      // Capping combo pieces to this keeps the deck at ≤ deckSize — otherwise a
      // near-full deck could end above 100, since we only cut cards THIS run added.
      const fillSet = new Set(fillIds || [])
      const isLandRow = d => (sfMap?.[d?.scryfall_id]?.type_line || d?.type_line || '').toLowerCase().includes('land')
      const openSlots = Math.max(0, (plan?.deckSize || 100) - populated.length)
      const cuttableFillCount = protNames => populated.filter(d =>
        !d?.is_commander && fillSet.has(d.id) && !isLandRow(d)
        && !cardNameMatchKeys(d?.name).some(k => protNames.has(k))).length
      const planCombos = maxPieces => planComboCompletion({
        almostCombos: almost,
        targetBracket,
        source: autoFillSource,
        deckNameKeys: deckKeys,
        passesBudget: name => passesBudget(name, null),
        maxPieces,
      })
      // Plan uncapped, then re-plan capped to the room if it wouldn't fit. Fewer
      // combos only free more cuttable filler, so a single re-plan is safe.
      let { pieces, combosCompleted, protectedNames } = planCombos(Infinity)
      if (pieces.length > openSlots + cuttableFillCount(protectedNames)) {
        ({ pieces, combosCompleted, protectedNames } = planCombos(openSlots + cuttableFillCount(protectedNames)))
      }
      if (!pieces.length) return { ...empty, combosCompleted }

      // Cuttable = this run's filler, minus any card that's a piece of a combo
      // we're completing. Lock everything else so analyzeCut only pulls from it.
      const cuttableIds = new Set(
        populated
          .filter(d => !d?.is_commander && fillSet.has(d.id)
            && !cardNameMatchKeys(d?.name).some(k => protectedNames.has(k)))
          .map(d => d.id),
      )
      const lockedIds = new Set(
        populated.filter(d => !d?.is_commander && !cuttableIds.has(d.id)).map(d => d.id),
      )
      // over = (populated − deckSize) + pieces added → exactly the cuts needed to
      // hold the size, absorbing any open slots the fill left.
      const cut = analyzeCut({
        plan, deckCards: populated, sfMap,
        totalCards: populated.length + pieces.length,
        cutMode: 'balanced', lockedIds,
        roleOf: dc => roleOfDeckCard(dc, sfMap, roleByName),
        inclusionOf: name => cardNameMatchKeys(name).map(k => inclusionByName.get(k)).find(v => v != null),
      })
      const cutIds = (cut?.recommended || []).map(r => r.id).filter(Boolean)

      if (cutIds.length && typeof onRemoveCards === 'function') {
        try { await onRemoveCards(cutIds) } catch { /* parent surfaces errors */ }
      }
      let comboRows = []
      try {
        const addRes = await onAddCards(pieces.map(p => ({ name: p.name })))
        comboRows = addRes?.rows || []
        setAddedNames(prev => {
          const next = new Set(prev)
          for (const r of comboRows) if (r?.name) next.add(r.name.toLowerCase())
          return next
        })
      } catch { /* parent surfaces errors */ }
      return { comboRows, cutIds, combosCompleted }
    } catch {
      return empty
    }
  }

  // Post-fill Game Changer top-up (Bracket 4 only). The estimator floors a deck
  // at Bracket 4 once it runs 4+ Game Changers, so a "target 4" build that landed
  // fewer would still read Bracket 3. This adds the shortfall from the commander's
  // OWN recommended pool (owned candidates first, then EDHREC upgrades) — so the
  // picks stay on-theme and in color — capped to `maxAdd` open slots, so they take
  // basic-land slots rather than cutting spells (no overshoot). Source-aware:
  // 'owned' only pulls owned Game Changers. Returns { gcRows }.
  async function runGameChangerPass(populated, maxAdd) {
    const empty = { gcRows: [] }
    if (targetBracket !== 4 || !gameChangers || maxAdd <= 0 || typeof onAddCards !== 'function') return empty
    const isGC = name => {
      const l = String(name || '').toLowerCase()
      return gameChangers.has(l) || gameChangers.has(l.split('//')[0].trim())
    }
    const gcInDeck = new Set()
    for (const d of populated) {
      if (!d?.is_commander && isGC(d?.name)) gcInDeck.add(String(d.name).toLowerCase())
    }
    const need = 4 - gcInDeck.size
    if (need <= 0) return empty

    const deckKeys = new Set(populated.filter(d => !d?.is_commander).flatMap(d => cardNameMatchKeys(d?.name)))
    const seen = new Set()
    const owned = []
    const rec = []
    for (const role of plan?.roles || []) {
      for (const c of role.ownedCandidates || []) {
        const name = c?.name
        if (!name || !isGC(name)) continue
        const key = name.toLowerCase()
        if (seen.has(key) || deckKeys.has(key)) continue // owned copies aren't gated by budget
        seen.add(key)
        owned.push({ name, inclusion: c.edhrecInclusion || 0 })
      }
    }
    if (autoFillSource === 'recommended') {
      for (const role of plan?.roles || []) {
        for (const u of upgradesFor(role) || []) {
          const name = u?.name
          if (!name || !isGC(name)) continue
          const key = name.toLowerCase()
          if (seen.has(key) || deckKeys.has(key) || !passesBudget(name, null)) continue
          seen.add(key)
          rec.push({ name, inclusion: u.edhrecInclusion || 0 })
        }
      }
    }
    owned.sort((a, b) => b.inclusion - a.inclusion)
    rec.sort((a, b) => b.inclusion - a.inclusion)
    const toAdd = [...owned, ...rec].slice(0, Math.min(need, maxAdd))
    if (!toAdd.length) return empty
    try {
      const addRes = await onAddCards(toAdd.map(g => ({ name: g.name })))
      const gcRows = addRes?.rows || []
      setAddedNames(prev => {
        const next = new Set(prev)
        for (const r of gcRows) if (r?.name) next.add(r.name.toLowerCase())
        return next
      })
      return { gcRows }
    } catch {
      return empty
    }
  }

  // Auto-fill completes the whole build in one go: role picks, nonbasic lands,
  // an optional post-fill combo pass, then the pip/Karsten-weighted basics — and
  // lands on the summary step so the result (composition, buy list, trim) is
  // immediately visible. `rows` are what actually landed (bulk path) or the
  // pseudo-rows (sequential path); `addedCardIds` are the deck-card ids to
  // remove on undo.
  async function finishAutoFill(rows, added, skipped, addedCardIds) {
    let effectiveRows = rows
    let effectiveAdded = added
    let effectiveAddedIds = addedCardIds || []
    let combosCompleted = 0
    let comboAdded = 0
    let cutCount = 0

    // Combo pass runs before basics so completed-combo pieces take real slots and
    // basics top up whatever's left. Bulk path only (needs the fill row ids to
    // know what's cuttable); the sequential fallback skips it. Whether it runs at
    // all is decided by the target bracket (comboPassTarget: ≤2 → none), not a
    // user toggle — runComboPass no-ops when the bracket allows no combos.
    if (typeof onAddCards === 'function' && (addedCardIds?.length)) {
      const populated = [...deckCards, ...rows]
      const pass = await runComboPass(populated, addedCardIds)
      combosCompleted = pass.combosCompleted
      comboAdded = pass.comboRows.length
      cutCount = pass.cutIds.length
      if (cutCount || comboAdded) {
        const cutSet = new Set(pass.cutIds)
        effectiveRows = [...rows.filter(r => !cutSet.has(r.id)), ...pass.comboRows]
        effectiveAdded = added - cutCount + comboAdded
        effectiveAddedIds = [
          ...(addedCardIds || []).filter(id => !cutSet.has(id)),
          ...pass.comboRows.map(r => r.id).filter(Boolean),
        ]
      }
    }

    // Game Changer top-up (Bracket 4 target): fill the shortfall to the 4-GC
    // floor from the commander's recommended pool, into the basic-land slots.
    if (targetBracket === 4 && gameChangers && typeof onAddCards === 'function' && (addedCardIds?.length)) {
      const openForGC = Math.max(0, (plan?.deckSize || 100) - (totalCards + effectiveAdded))
      const gcPass = await runGameChangerPass([...deckCards, ...effectiveRows], openForGC)
      if (gcPass.gcRows.length) {
        effectiveRows = [...effectiveRows, ...gcPass.gcRows]
        effectiveAdded += gcPass.gcRows.length
        effectiveAddedIds = [...effectiveAddedIds, ...gcPass.gcRows.map(r => r.id).filter(Boolean)]
      }
    }

    let basics = 0
    let basicCounts = null
    // Basics top up the rest of the deck, capped to the open slots so a DFC/MDFC
    // land type quirk can't push the deck past deckSize (see basicsForAutoFill).
    const openSlots = Math.max(0, (plan?.deckSize || 100) - (totalCards + effectiveAdded))
    const planned = basicsForAutoFill({
      deckCards: [...deckCards, ...effectiveRows],
      sfMap,
      colors: cmdColors,
      landTarget: landsTarget,
      openSlots,
    })
    if (planned.total > 0 && typeof onAddBasics === 'function') {
      try {
        await onAddBasics(planned.counts)
        basics = planned.total
        basicCounts = planned.counts
      } catch { /* parent surfaces errors; summary still offers the top-up */ }
    }
    // Slots the run could NOT fill (candidate pools ran dry) — called out in
    // the result so an under-100 build doesn't read as a complete deck.
    // totalCards is the pre-add count: this closure was created before the
    // deckCards prop round-tripped.
    const left = Math.max(0, (plan?.deckSize || 100) - (totalCards + effectiveAdded + basics))
    // Refresh the combo analysis on the FINAL deck: runComboPass fetched combos
    // on the pre-completion deck (to find pieces to add), so without this the
    // summary's combo panel shows the completed combos as still-incomplete until
    // the assistant is reopened. Basics don't form combos, so they're omitted.
    combos.fetchCombos([...deckCards, ...effectiveRows]).catch(() => {})
    setAutoFillResult({
      added: effectiveAdded, skipped, basics, left,
      addedCardIds: effectiveAddedIds, basicCounts,
      combosCompleted, comboAdded, cutCount,
    })
    setStepIndex(steps.length - 1)
  }

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
        const rows = res?.rows || []
        // Mark exactly what landed (skipped names must not read as Added).
        setAddedNames(prev => {
          const next = new Set(prev)
          for (const r of rows) if (r?.name) next.add(r.name.toLowerCase())
          return next
        })
        await finishAutoFill(rows, res?.added ?? rows.length, res?.skipped ?? 0, rows.map(r => r.id))
      } catch {
        setAutoFillResult({ added: 0, skipped: picks.length, basics: 0, left: 0, addedCardIds: [], basicCounts: null })
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
      // Sequential path has no returned rows/ids — undo falls back to name-based
      // removal via the normal per-tile Remove, so no addedCardIds here.
      await finishAutoFill(picksToPseudoRows(picks), picks.length, 0, [])
    } finally {
      setAutoFilling(null)
    }
  }

  // Move focus into the auto-fill dialog when it opens, so keyboard users land
  // inside it and Escape/Tab behave (the overlay handles Escape).
  useEffect(() => {
    if (autoFillOpen) afCardRef.current?.focus()
  }, [autoFillOpen])

  const [undoing, setUndoing] = useState(false)
  async function handleAutoFillUndo() {
    const r = autoFillResult
    if (!r || undoing || typeof onUndoAutoFill !== 'function') return
    setUndoing(true)
    try {
      await onUndoAutoFill(r.addedCardIds || [], r.basicCounts || {})
      // Drop the session "added" flags for the removed cards so their tiles
      // revert (names aren't tracked per-id, so clear the whole session set —
      // deckNames still reflects anything the user added manually).
      setAddedNames(new Set())
      setAutoFillResult(null)
      setAutoFillOpen(false)
    } finally {
      setUndoing(false)
    }
  }
  // Undo is only reliable on the bulk path (we have the exact row ids).
  const canUndo = typeof onUndoAutoFill === 'function' && (autoFillResult?.addedCardIds?.length > 0 || autoFillResult?.basics > 0)

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
      // Price the DEEP pool (not just the display cap) so the budget filter that
      // trims this list downstream judges every candidate it might surface.
      for (const u of selectUpgrades(roleData, hasRecommender ? suggestionSource : 'edhrec', upgradePoolDepth(roleData.gap || 0))) {
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
        // card_prints rows already carry lang + art, so byId/langById come
        // straight from them — no per-candidate Scryfall lookup (api.scryfall.com
        // /cards/collection has no CORS headers on our origin and 400s the batch).
        const candsByName = new Map()
        const byId = new Map()
        const langById = new Map()
        for (const n of missing) {
          const cands = (printMap.get(n) || [])
            .map(p => ({ id: p.id, price: getPrice(p, false, { price_source }), sf: p }))
            .filter(p => p.id && p.price != null)
            .sort((a, b) => a.price - b.price)
            .slice(0, CHEAPEST_CANDIDATES)
          candsByName.set(n, cands)
          for (const c of cands) {
            byId.set(c.id, c.sf)
            langById.set(c.id, c.sf.lang)
          }
        }
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
    if (isAdded(name)) return false
    setAddedNames(prev => new Set(prev).add(key))
    try {
      await onAddCard(cardOrRec)
      return true
    } catch {
      setAddedNames(prev => { const next = new Set(prev); next.delete(key); return next })
      return false
    }
  }

  // Manual add from the "Add a specific card" search. Routes through the same
  // handleAdd as tiles (owned-vs-buy accounting + category persistence live in
  // the parent). The row's Add button flips to "Added to <role>" once it lands,
  // so no toast is needed. A searched card is a full Scryfall card.
  async function addSpecificCard(card) {
    if (!card?.name || isAdded(card.name)) return
    await handleAdd(card, card.name)
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

  // Pointer devices get a hover preview; touch devices tap to toggle a centered
  // image. Evaluated once — the input class doesn't change mid-session.
  const hoverCapable = useMemo(
    () => typeof window === 'undefined' || !window.matchMedia
      ? true
      : window.matchMedia('(hover: hover) and (pointer: fine)').matches,
    [],
  )

  // Resolve a card name to the scryfall_id of its deck row, so the buy-list
  // (whose items are merged by name) can still show art + remove the right rows.
  const deckRowsForName = name => {
    const key = (name || '').toLowerCase()
    return (deckCards || []).filter(c => !c?.is_commander && cardNameMatchKeys(c?.name).includes(key))
  }

  // Event handlers that drive the large-image preview for one card. On pointer
  // devices the image follows the cursor (mouseenter/move/leave); on touch a tap
  // toggles a centered lightbox. `card` = { name, scryfall_id, img? } — a card
  // with a scryfall_id resolves its large art from sfMap; unowned upgrades carry
  // an explicit `img` URL instead. Cards with neither get no preview affordance.
  const previewHandlers = card => {
    if (!card?.scryfall_id && !card?.img) return {}
    if (hoverCapable) {
      return {
        onMouseEnter: e => setPreview({ ...card, x: e.clientX, y: e.clientY }),
        onMouseMove: e => setPreview(p => (p ? { ...p, x: e.clientX, y: e.clientY } : p)),
        onMouseLeave: () => setPreview(null),
      }
    }
    return {
      onClick: () => setPreview(p =>
        p && p.name === card.name ? null : { ...card }),
    }
  }

  // Trash action for a summary card: remove every deck row of that name (a card
  // can hold several printings). Batched when the parent supports it.
  async function removeCardByName(name) {
    const ids = deckRowsForName(name).map(c => c.id).filter(Boolean)
    if (!ids.length) return
    if (preview?.name?.toLowerCase() === name.toLowerCase()) setPreview(null)
    if (typeof onRemoveCards === 'function') {
      try { await onRemoveCards(ids) } catch { /* parent surfaces errors */ }
    } else if (typeof onRemoveCard === 'function') {
      for (const id of ids) { try { await onRemoveCard(id) } catch { /* parent surfaces errors */ } }
    }
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

  // Theme / Bracket / Budget tuning dropdowns — shared between the main controls
  // bar and the "Finish this deck" auto-fill dialog. Both surfaces drive the same
  // state, so a change in either place re-plans/re-filters the picks live.
  const renderThemeMenu = () => themes.length > 0 && (
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
  )

  const renderBracketMenu = () => gameChangers && (
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
  )

  const renderBudgetMenu = () => (
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
  )

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
    <Modal onClose={() => setConfirmClose(true)} className={styles.modal} contentClassName={styles.modalContent}>
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
            {renderThemeMenu()}
            {renderBracketMenu()}
            {renderBudgetMenu()}

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

        {/* Persistent manual-add search — above the per-step content, so it's
            reachable on every step (role steps + summary). */}
        {!loading && !error && (
          <SpecificCardSearch
            search={cardSearch}
            onAdd={addSpecificCard}
            isAdded={isAdded}
            categoryOf={card => coarseRole(card, card)}
            commanderColorIdentity={commander?.color_identity || []}
            makePreview={previewHandlers}
          />
        )}

        <div className={styles.main}>
          {loading && (
            <div className={styles.analyzing}>
              <div className={`${styles.afMana}${reduce_motion ? ' ' + styles.afManaStill : ''}`}>
                {AUTOFILL_MANA.map((c, i) => (
                  <span
                    key={c}
                    className={styles.afManaPip}
                    style={{ background: MANA_HEX[c], animationDelay: `${i * 0.13}s` }}
                  />
                ))}
              </div>
              <div className={styles.analyzingLabel}>Analyzing your collection…</div>
            </div>
          )}
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
                            previewProps={previewHandlers({
                              name: cand.name,
                              scryfall_id: cand.sfCard?.id || cand.card?.scryfall_id || null,
                              img: cardImageUrl(cand.sfCard),
                            })}
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
                // Filter the DEEP pool first, then take the display cap, so a
                // tight budget doesn't blank the section when cheaper picks
                // exist further down the list.
                const gap = roleData.gap || 0
                const upgrades = selectUpgrades(roleData, hasRecommender ? suggestionSource : 'edhrec', upgradePoolDepth(gap))
                  .filter(u => passesBudget(u.name, null))
                  .slice(0, upgradeDisplayLimit(gap))
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
                          // Feed the resolved oracle text (from the upgrade meta
                          // cache) so mass-land-denial / extra-turn bracket flags
                          // fire on unowned suggestions too, not just Game Changers.
                          const meta = UPGRADE_META_CACHE.get(up.name.toLowerCase())
                          const flag = bracketFlagFor(up.name, meta?.oracle_text ? { oracle_text: meta.oracle_text } : null, gameChangers)
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
                              previewProps={previewHandlers({
                                name: up.name,
                                scryfall_id: null,
                                // Tile art is a 146px thumbnail; re-tier the Scryfall
                                // URL up to 'large' (672px) for the enlarged preview
                                // so it isn't an upscaled thumbnail. EDHREC fallback
                                // URLs aren't cards.scryfall.io, so they pass through.
                                img: scryfallImageAtSize(imageEnFor(up.name), 'large') || up.image || null,
                              })}
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
              {/* Cut to 100 — surfaced first when the deck is over size so
                  trimming is the primary action before reviewing the rest. */}
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
                          <button
                            type="button"
                            className={styles.cutPeek}
                            title={`View ${c.name}`}
                            {...previewHandlers({ name: c.name, scryfall_id: c.scryfall_id })}
                          >
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
                          </button>
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
                      const sid = deckRowsForName(m.name)[0]?.scryfall_id || null
                      return (
                        <div key={m.name} className={styles.gapRow}>
                          <span className={styles.gapQty}>{m.qty}×</span>
                          <span
                            className={styles.gapName}
                            title={m.name}
                            {...previewHandlers({
                              name: m.name,
                              scryfall_id: sid,
                              // Buy-the-gap cards aren't in the deck, so `sid` is
                              // usually null — fall back to the enriched art so the
                              // hover preview still works.
                              img: scryfallImageAtSize(imageEnFor(m.name), 'large'),
                            })}
                          >
                            {m.name}
                          </span>
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
                          {typeof onRemoveCard === 'function' && (
                            <button
                              type="button"
                              className={styles.gapTrash}
                              onClick={() => removeCardByName(m.name)}
                              title={`Remove ${m.name} from the deck`}
                              aria-label={`Remove ${m.name} from the deck`}
                            >
                              <DeleteIcon size={13} />
                            </button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              <div className={styles.sectionLabel}>
                Mana curve (nonland)
                {avgCmc != null && (
                  <span className={styles.sectionHint}>
                    {' · avg '}{avgCmc.toFixed(2)}
                    {curveTarget != null && (
                      <>
                        {' · target ~'}{curveTarget.toFixed(1)}
                        {curveStatus.status !== 'on' && (
                          <span
                            className={`${styles.curveVerdict} ${curveStatus.status === 'high' ? styles.curveHigh : styles.curveLow}`}
                            title={curveStatus.status === 'high'
                              ? 'Your curve runs higher than a typical deck for this commander — consider cheaper cards or more ramp.'
                              : 'Your curve runs lower than a typical deck for this commander — you have room for pricier bombs.'}
                          >
                            {curveStatus.status === 'high' ? 'a bit high' : 'a bit low'}
                          </span>
                        )}
                      </>
                    )}
                  </span>
                )}
              </div>
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
                {combos.fetched && <span className={styles.sectionHint}> · {(combos.included || []).length} complete in deck{targetBracket != null ? ` · Bracket ${targetBracket} filter` : ''}</span>}
              </div>
              {!combos.fetched ? (
                <div>
                  <button className={styles.themeChip} onClick={combos.fetchCombos} disabled={combos.loading}>
                    {combos.loading ? 'Checking combos…' : 'Check combos'}
                  </button>
                </div>
              ) : combosHiddenByBracket ? (
                <div className={styles.emptySmall}>
                  {targetBracket <= 2
                    ? `Combos are discouraged at Bracket ${targetBracket} — none suggested. Raise the target bracket to see combo options.`
                    : `Near-complete combos found, but all are 2-card (fast) combos — raise the target bracket to Bracket 4 to include them.`}
                </div>
              ) : suggestedCombos.length === 0 ? (
                <div className={styles.emptySmall}>No near-complete combos found from your current list.</div>
              ) : (
                <div className={styles.comboList}>
                  {suggestedCombos.map(combo => {
                    const allOwned = combo.missing.every(m => m.owned)
                    return (
                      <div key={combo.id} className={styles.comboRow}>
                        <div className={styles.comboInfo}>
                          <div className={styles.comboProduces}>
                            {combo.produces.slice(0, 2).join(', ') || 'Combo'}
                            <span className={styles.comboPieces}>{combo.uses.length}-card</span>
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
            </>
          )}
        </div>

        <div className={styles.footer}>
          <Button
            variant="ghost"
            disabled={stepIndex === 0 || loading}
            onClick={() => setStepIndex(i => Math.max(0, i - 1))}
          >
            Back
          </Button>
          {!loading && !error && plan && (autoFilling || autoFillPicksOwned.length > 0 || autoFillPicksRec.length > 0) && (
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
            <Button variant="primary" disabled={loading} onClick={() => setStepIndex(i => Math.min(steps.length - 1, i + 1))}>
              Next: {steps[stepIndex + 1] === SUMMARY_STEP ? 'Summary' : steps[stepIndex + 1]}
            </Button>
          ) : (
            <>
              {typeof onPlaytest === 'function' && totalCards > 1 && (
                <Button variant="ghost" onClick={onPlaytest} disabled={finishing || loading}>
                  Playtest
                </Button>
              )}
              <Button variant="primary" onClick={handleFinish} disabled={finishing || loading}>
                {willAddBasics
                  ? (finishing ? 'Adding basics…' : `Add ${plannedBasics.total} basics & finish`)
                  : 'Finish'}
              </Button>
            </>
          )}
        </div>

        {/* Auto-fill dialog — in-panel overlay (the assistant is already a
            modal; stacking a second Modal would double the body scroll lock). */}
        {autoFillOpen && (
          <div
            className={styles.afOverlay}
            role="dialog"
            aria-modal="true"
            aria-label="Auto-fill deck"
            onKeyDown={e => {
              // Escape cancels — but never mid-run (a partial add is worse than
              // waiting) and never while an undo is in flight.
              if (e.key === 'Escape' && !autoFilling && !undoing) {
                e.stopPropagation()
                setAutoFillResult(null)
                setAutoFillOpen(false)
              }
            }}
          >
            <div
              className={styles.afCard}
              ref={afCardRef}
              tabIndex={-1}
            >
              <div className={styles.afHead}>
                <span className={styles.afHeadIcon}><LightningIcon size={16} /></span>
                <div>
                  <div className={styles.afTitle}>{autoFillResult ? 'Deck built' : 'Finishing deck'}</div>
                  {!autoFillResult && (
                    <div className={styles.afSubtitle}>
                      Fills every empty slot and fills your deck to {afTarget} cards.
                    </div>
                  )}
                </div>
              </div>
              {!autoFilling && !autoFillResult && (
                <>
                  <div className={styles.afMeter}>
                    <div className={styles.afMeterHead}>
                      <span>Deck size</span>
                      <span className={styles.afMeterNums}>
                        <b>{totalCards}</b>
                        <span className={styles.afMeterArrow}>→</span>
                        <b className={styles.afMeterGoal}>{afTarget}</b>
                      </span>
                    </div>
                    <div className={styles.afMeterTrack}>
                      <div
                        className={styles.afMeterProjected}
                        style={{ width: `${Math.min(100, ((totalCards + autoFillSelected.length) / afTarget) * 100)}%` }}
                      />
                      <div
                        className={styles.afMeterFill}
                        style={{ width: `${Math.min(100, (totalCards / afTarget) * 100)}%` }}
                      />
                    </div>
                    <div className={styles.afMeterLegend}>
                      <span><i className={styles.afSwatchNow} /> In deck now</span>
                      <span><i className={styles.afSwatchAdd} /> +{autoFillSelected.length} from auto-fill</span>
                      <span><i className={styles.afSwatchBasics} /> basics finish to {afTarget}</span>
                    </div>
                  </div>
                  {/* Tune the build — same theme / bracket / budget knobs as the
                      main controls bar; changing them re-plans the picks live. */}
                  <div className={styles.afTune}>
                    <span className={styles.afTuneLabel}>Tune the build</span>
                    <div className={styles.afTuneRow}>
                      {renderThemeMenu()}
                      {renderBracketMenu()}
                      {renderBudgetMenu()}
                    </div>
                  </div>
                  <label className={`${styles.afOption}${autoFillSource === 'owned' ? ' ' + styles.afOptionActive : ''}`}>
                    <input
                      type="radio"
                      name="af-source"
                      className={styles.afRadio}
                      checked={autoFillSource === 'owned'}
                      onChange={() => setAutoFillSource('owned')}
                    />
                    <span className={styles.afOptionBody}>
                      <span className={styles.afOptionLabel}>Complete it from your binders</span>
                      <span className={styles.afOptionDesc}>
                        {autoFillPicksOwned.length
                          ? `Fills the deck to ${afTarget} using only cards you can pull right now — adds ${autoFillPicksOwned.length}, then basic lands.`
                          : 'Nothing left to add from your binders.'}
                      </span>
                    </span>
                  </label>
                  <label className={`${styles.afOption}${autoFillSource === 'recommended' ? ' ' + styles.afOptionActive : ''}`}>
                    <input
                      type="radio"
                      name="af-source"
                      className={styles.afRadio}
                      checked={autoFillSource === 'recommended'}
                      onChange={() => setAutoFillSource('recommended')}
                    />
                    <span className={styles.afOptionBody}>
                      <span className={styles.afOptionLabel}>Complete it with the best cards</span>
                      <span className={styles.afOptionDesc}>
                        {(() => {
                          const sugg = autoFillPicksRec.filter(p => !p.owned).length
                          return autoFillPicksRec.length
                            ? `Fills the deck to ${afTarget} with the top cards for this commander, whatever you own — the ${sugg} you’re missing go to the summary’s buy list.`
                            : 'No fitting recommendations left.'
                        })()}
                      </span>
                    </span>
                  </label>
                  {comboPassTarget > 0 && (
                    <div className={styles.afNote}>
                      <LightningIcon size={12} /> After filling, up to {comboPassTarget} bracket-appropriate combo{comboPassTarget === 1 ? '' : 's'}
                      {targetBracket != null ? ` (Bracket ${targetBracket})` : ' (aiming low — Bracket 2/3)'} in {commander?.name ? `${commander.name}’s` : 'your commander’s'} colors will be completed automatically, adding the missing {autoFillSource === 'owned' ? 'owned ' : ''}piece{comboPassTarget === 1 ? '' : 's'} and cutting the weakest just-filled cards to make room.
                    </div>
                  )}
                  <div className={styles.afNote}>
                    Your budget and bracket filters apply. Basic lands will top up the rest of the deck, then you will be able to review your new deck.
                  </div>
                  <div className={styles.afActions}>
                    <Button variant="ghost" onClick={() => setAutoFillOpen(false)}>Cancel</Button>
                    <Button variant="primary" disabled={autoFillSelected.length === 0} onClick={startAutoFill}>
                      Auto build deck
                    </Button>
                  </div>
                </>
              )}
              {autoFilling && (
                <AutoFillLoader
                  reduceMotion={reduce_motion}
                  progress={autoFilling.bulk ? null : autoFilling}
                />
              )}
              {!autoFilling && autoFillResult && (
                <>
                  <div className={styles.afResult}>
                    Added {autoFillResult.added} card{autoFillResult.added === 1 ? '' : 's'}
                    {autoFillResult.basics ? ` and ${autoFillResult.basics} basic land${autoFillResult.basics === 1 ? '' : 's'}` : ''}.
                  </div>
                  {autoFillResult.left > 0 && (
                    <div className={styles.afShortfall}>
                      <WarningIcon size={12} /> The deck is still {autoFillResult.left} card{autoFillResult.left === 1 ? '' : 's'} short —
                      {autoFillSource === 'owned'
                        ? ' your binders ran out of fitting cards. Re-run with “Top recommendations”, or add from the suggestion tiles.'
                        : ' not enough fitting recommendations were found. Add the rest from the role steps.'}
                    </div>
                  )}
                  <div className={styles.afActions}>
                    {canUndo && (
                      <Button variant="ghost" onClick={handleAutoFillUndo} disabled={undoing}>
                        {undoing ? 'Undoing…' : 'Undo'}
                      </Button>
                    )}
                    {typeof onPlaytest === 'function' && autoFillResult.added > 0 && (
                      <Button
                        variant="ghost"
                        onClick={() => { setAutoFillResult(null); setAutoFillOpen(false); onPlaytest() }}
                        disabled={undoing}
                      >
                        Playtest
                      </Button>
                    )}
                    <Button variant="primary" onClick={() => { setAutoFillResult(null); setAutoFillOpen(false) }} disabled={undoing}>
                      Done
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

      </div>

      {/* Large-image card preview — portaled to <body> so it floats above the
          modal at viewport coordinates. Hover-follows the cursor on pointer
          devices; a centered tap-to-dismiss lightbox on touch. */}
      {preview && (() => {
        const sf = sfMap?.[preview.scryfall_id] || null
        const img = getCardImageUri(sf, 'normal') || cardImageUrl(sf) || preview.img || null
        if (!img) return null
        const node = hoverCapable ? (
          <div className={styles.hoverPreview} style={cardPreviewStyle(preview.x, preview.y)}>
            <img src={img} alt={preview.name} className={styles.hoverPreviewImg} />
          </div>
        ) : (
          <div className={styles.previewLightbox} onClick={() => setPreview(null)} role="dialog" aria-modal="true" aria-label={`${preview.name} enlarged`}>
            {/* Stop taps on the card itself from closing — only the backdrop and
                the Close button dismiss it. The Close button sits above the card
                (never over the art); the image is capped to the viewport so a tall
                card never overflows the screen. */}
            <div className={styles.previewLightboxInner} onClick={e => e.stopPropagation()}>
              <div className={styles.previewLightboxBar}>
                <Button variant="secondary" size="sm" onClick={() => setPreview(null)} aria-label="Close preview">
                  <CloseIcon size={14} /> Close
                </Button>
              </div>
              <img src={img} alt={preview.name} className={styles.previewLightboxImg} />
            </div>
          </div>
        )
        return createPortal(node, document.body)
      })()}

      {confirmClose && (
        <ConfirmModal
          title="Leave the Build Assistant?"
          message="Cards you've added are already saved to the deck. You can reopen the assistant anytime to keep building."
          confirmLabel="Leave"
          cancelLabel="Keep building"
          variant="primary"
          onConfirm={() => { setConfirmClose(false); onClose?.() }}
          onClose={() => setConfirmClose(false)}
        />
      )}
    </Modal>
  )
}

// Fixed-position style for the hover preview: sits beside the cursor, flips to
// the other side / clamps so a 240×336 card image never spills off-screen.
function cardPreviewStyle(x, y) {
  const W = 340, H = 476, pad = 12, off = 22
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  let left = x + off
  if (left + W + pad > vw) left = x - W - off
  if (left < pad) left = pad
  let top = y - H / 2
  if (top < pad) top = pad
  if (top + H + pad > vh) top = vh - H - pad
  return { left, top, width: W }
}
