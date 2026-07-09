import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import {
  FORMATS, TYPE_GROUPS, classifyCardType,
  parseDeckMeta, serializeDeckMeta, getCardImageUri,
  fetchCardsByNames, fetchCardsByScryfallIds, getDeckBuilderCardMeta,
  fetchRecommendationMetadataByNames,
  fetchEdhrecCommander, fetchPaperPrintings,
  fetchPaperPrintingsFromDb, fetchPaperPrintingsByNamesFromDb,
  pickAutomaticDeckPrinting,
} from '../lib/deckBuilderApi'
import {
  getLocalCards, getDeckCards, putDeckCards, deleteDeckCardLocal, getMeta, setMeta,
  deleteDeckAllocationsByIds, replaceDeckAllocations, putDeckAllocations, putFolderCards, putCards,
  replaceLocalFolderCards,
} from '../lib/db'
import styles from './DeckBuilder.module.css'
import uiStyles from '../components/UI.module.css'
import { ResponsiveMenu, Select, Modal } from '../components/UI'
import { useToast } from '../components/ToastContext'
import PromptDialog from '../components/PromptDialog'
import { CardDetail } from '../components/CardComponents'
import DeckStats, { normalizeDeckBuilderCards, CAT_COLORS, CAT_ORDER } from '../components/DeckStats'
import BracketBadge from '../components/BracketBadge'
import { analyzeBracket, fetchGameChangerNames, computeBracketMetaPatch } from '../lib/commanderBracket'
import { getScryfallKey, formatPrice, getPrice } from '../lib/scryfall'
import { getCardCategoryFromCard, isTypeFallbackCategory } from '../lib/cardCategory'
import { pickPrintingForMode, PRINTING_MODES } from '../lib/printingOptimize'
import { BASIC_LAND_TYPES, BASIC_LAND_NAMES, isBasicLandName } from '../lib/basicLands'
import { addMissingToWishlist } from '../lib/setCompletion'
import { isOathbreaker, isSignatureSpell, getOathbreakerPairIssue, validateCompanion, companionDeckSizeBonus } from '../lib/commandZone'
import { logDeckChange, fetchDeckHistory } from '../lib/deckHistory'
import ExportModal from '../components/ExportModal'
import { fetchDeckAllocations, fetchDeckAllocationsForCardIdentities, fetchDeckCards, mergeAllocationRows, upsertDeckAllocations } from '../lib/deckData'
import {
  createDeckCategory,
  deleteDeckCategory,
  fetchDeckCategories,
  renameDeckCategory,
  resetDeckCategories,
  setDeckCardCategory,
  updateDeckCategoryOrder,
} from '../lib/deckCategories'
import { getCardLegalityWarnings } from '../lib/deckLegality'
import { useDeckCardLegalityWarnings } from '../lib/useDeckWarnings'
import {
  buildSyncDiff,
  buildSyncSnapshot,
  getSyncState,
  getLogicalKey,
  linkDeckPair,
  patchDeckMeta,
  persistLinkedSyncSnapshot,
  setLinkedDeckVisibility,
  summarizeSyncDiff,
  unlinkPairedDeck,
  withLinkedPair,
} from '../lib/deckSync'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { getPublicAppUrl } from '../lib/publicUrl'
import { loadLocalPlacementSnapshot, refreshRemotePlacementSnapshot } from '../lib/deckPlacementData'
import {
  toDeckCardRow,
  toCardPrintSource,
  requireCardPrintIds,
  ownedCardKey,
  additiveSaveOwnedCards,
  additiveSaveWishlistItems,
} from '../lib/deckBuilderWrites'
import {
  ListViewIcon,
  StacksViewIcon,
  GridViewIcon,
  SettingsIcon,
  TableViewIcon,
  SortIcon,
  FilterIcon,
  SearchIcon,
  StarIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CollectionIcon,
  DeckIcon,
  LightningIcon,
  MenuIcon,
  AddIcon,
  CheckIcon,
  ShareIcon,
  ExternalLinkIcon,
  CopyIcon,
  DeleteIcon,
  SyncIcon,
  CloseIcon,
  WishlistsIcon,
} from '../icons'
import { lastInputWasTouch } from '../lib/inputType'
import { bindTouchContextMenu, consumeLongPressClick } from '../lib/touchContextMenu'
import {
  EMPTY_DECK_CARD_FILTERS,
  DECK_CARD_TYPE_OPTIONS,
  DECK_CARD_RARITY_OPTIONS,
  countActiveCardFilters,
  matchesDeckCardFilters,
  manaValueGroupKey,
  colorGroupKey,
  MANA_VALUE_GROUP_ORDER,
  COLOR_GROUP_ORDER,
} from '../lib/deckCardFilters'
import { COLOR_MODE_LABELS, COLOR_MATCH_MODES } from '../lib/deckIndexFilters'

import {
  CAN_HOVER,
  RARITY_ORDER,
  RARITY_COLORS,
  FOLDER_TAG_COLOR,
  FOLDER_TAG_BORDER,
  BOARD_ORDER,
  BOARD_LABELS,
  BOARD_FILTERS,
  UNCATEGORIZED,
  PIP_COLORS,
  BASIC_LANDS,
  DEFAULT_LIST_COLUMNS,
  DEFAULT_COMPACT_COLUMNS,
} from '../lib/deckBuilderConstants'
import {
  normalizeBoard,
  normalizeCardName,
  isGroupFolder,
  toLargeImg,
  toArtCropImg,
  manaSymbolUrl,
  deckAllocationKeys,
  allocationSetHas,
  normalizePrintKey,
  printingSupportsFoil,
  printingSupportsNonfoil,
  defaultFoilForPrinting,
  getCommanderOracle,
  normalizePartnerName,
  getCommanderProfile,
  canBeCommander,
  getNonCommanderDeckCoverArt,
  getCommanderPairIssue,
  findCommanderTransferHint,
  collectCardIdentities,
} from '../lib/deckBuilderHelpers'
import {
  formatOwnedPrinting,
  formatQtyLabel,
} from '../lib/deckSyncDecisions'

import { ManaCostInline, OwnershipBadge } from '../components/deckBuilder/primitives'
import { DeckCardActionsMenuBody, DeckCardRow, EditMenu } from '../components/deckBuilder/DeckCardRow'
import { DeckCategoryHeader } from '../components/deckBuilder/DeckCategoryHeader'
import { DeckCardSection } from '../components/deckBuilder/DeckCardSection'
import { DeckCard } from '../components/deckBuilder/DeckCard'
import { CategoryPickerModal } from '../components/deckBuilder/CategoryPickerModal'

import { FloatingPreview, WarningTooltip } from '../components/deckBuilder/FloatingPreview'

// ── Single card row in search results ─────────────────────────────────────────
const SearchResultRow = memo(function SearchResultRow({ card, ownedQty, onAdd, addFeedback, onOpenDetail, onHoverEnter, onHoverLeave, onHoverMove, legalityWarnings = [] }) {
  const img = getCardImageUri(card, 'small')
  const largeUri = img ? img.replace('/small/', '/normal/') : null
  const warningTitle = legalityWarnings.map(w => w.text).join('\n')
  const warningText = legalityWarnings.map(w => w.text).join(' ')
  const hoverableProps = CAN_HOVER && !lastInputWasTouch && largeUri
    ? {
        onMouseEnter: e => onHoverEnter?.(largeUri, e),
        onMouseMove: e => onHoverMove?.(e),
        onMouseLeave: () => onHoverLeave?.(),
      }
    : {}
  return (
    <div className={styles.searchRow}>
      {img
        ? <img className={styles.searchThumb} src={img} alt="" loading="lazy" onClick={() => onOpenDetail?.(card)} style={{ cursor: 'pointer' }} {...hoverableProps} />
        : <div className={styles.searchThumbPlaceholder} />
      }
      <div className={styles.searchInfo}>
        <div className={styles.searchName}>
          <span style={{ cursor: 'pointer' }} onClick={() => onOpenDetail?.(card)} {...hoverableProps}>{card.name}</span>
          {addFeedback?.count > 0 && (
            <span style={{ marginLeft:8, color:'var(--green)', fontSize:'0.74rem', fontWeight:600 }}>
              {`+${addFeedback.count}`}
            </span>
          )}
        </div>
        <div className={styles.searchType}>{card.type_line}</div>
        {legalityWarnings.length > 0 && (
          <div className={styles.searchWarningDetail}>{warningText}</div>
        )}
        </div>
      <div className={styles.searchMeta}>
        {legalityWarnings.length > 0 && (
          <span className={styles.searchWarningBadge} title={warningTitle} aria-label={warningTitle}>Warning</span>
        )}
        {ownedQty > 0 && <span className={styles.ownedBadge}>OK {ownedQty}x</span>}
      </div>
      <button className={styles.addBtn} onClick={e => { e.stopPropagation(); onAdd(card) }} title="Add to deck">+</button>
    </div>
  )
}, areSearchResultRowPropsEqual)

function areSearchResultRowPropsEqual(prev, next) {
  if (
    prev.card !== next.card ||
    prev.ownedQty !== next.ownedQty ||
    prev.addFeedback !== next.addFeedback ||
    prev.onAdd !== next.onAdd ||
    prev.onOpenDetail !== next.onOpenDetail ||
    prev.onHoverEnter !== next.onHoverEnter ||
    prev.onHoverLeave !== next.onHoverLeave ||
    prev.onHoverMove !== next.onHoverMove
  ) return false

  const prevWarnings = prev.legalityWarnings || []
  const nextWarnings = next.legalityWarnings || []
  if (prevWarnings.length !== nextWarnings.length) return false
  return prevWarnings.every((warning, index) => warning.text === nextWarnings[index]?.text)
}

// ── Deck filter panel ─────────────────────────────────────────────────────────
// Shared body for every "filter the deck list" surface (toolbar menu, filter-bar
// funnel, mobile sheet): board + color/type/rarity/CMC filters. Search stays in
// the host UI when it already has an input (showSearch=false).
const GROUPBY_STORE_KEY = 'deckloom_deckbuilder_groupby_v1'
const DECK_GROUP_MODES = ['none', 'type', 'category', 'cmc', 'color', 'rarity', 'set']

function cycleColorMode(mode) {
  const i = COLOR_MATCH_MODES.indexOf(mode)
  return COLOR_MATCH_MODES[(i + 1) % COLOR_MATCH_MODES.length]
}

function DeckFilterPanel({ filters, setFilters, boardFilter, setBoardFilter, showSearch, deckSearch, setDeckSearch }) {
  const set = patch => setFilters(f => ({ ...f, ...patch }))
  const toggleIn = (key, v) => setFilters(f => ({
    ...f,
    [key]: f[key].includes(v) ? f[key].filter(x => x !== v) : [...f[key], v],
  }))
  const anythingActive = countActiveCardFilters(filters) > 0 || boardFilter !== 'all'
  return (
    <div className={styles.deckFilterMenuBody}>
      {showSearch && (
        <input
          className={styles.deckSearchInput}
          value={deckSearch}
          onChange={e => setDeckSearch(e.target.value)}
          placeholder="Search deck..."
          autoFocus
        />
      )}
      <div className={styles.deckFilterMenuBoardLabel}>Board</div>
      <div className={styles.boardFilterGroup}>
        {BOARD_FILTERS.map(filter => (
          <button
            key={filter.id}
            className={`${styles.boardFilterBtn}${boardFilter === filter.id ? ' ' + styles.boardFilterBtnActive : ''}`}
            onClick={() => setBoardFilter(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div className={styles.deckFilterMenuBoardLabel}>Colors</div>
      <div className={styles.deckFilterPips}>
        {['W', 'U', 'B', 'R', 'G', 'C'].map(c => (
          <button
            key={c}
            className={`${styles.deckFilterPip}${filters.colors.includes(c) ? ' ' + styles.deckFilterPipActive : ''}`}
            title={`Filter ${c}`}
            onClick={() => toggleIn('colors', c)}
          >
            <img src={manaSymbolUrl(c)} alt={c} />
          </button>
        ))}
        {filters.colors.length > 0 && (
          <button
            className={styles.deckFilterModeBtn}
            onClick={() => set({ colorMode: cycleColorMode(filters.colorMode) })}
            title="How selected colors match the card's color identity"
          >
            {COLOR_MODE_LABELS[filters.colorMode] || 'Includes'}
          </button>
        )}
      </div>
      <div className={styles.deckFilterMenuBoardLabel}>Type</div>
      <div className={`${styles.boardFilterGroup} ${styles.deckFilterWrapGroup}`}>
        {DECK_CARD_TYPE_OPTIONS.map(t => (
          <button
            key={t}
            className={`${styles.boardFilterBtn}${filters.types.includes(t) ? ' ' + styles.boardFilterBtnActive : ''}`}
            onClick={() => toggleIn('types', t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className={styles.deckFilterMenuBoardLabel}>Rarity</div>
      <div className={`${styles.boardFilterGroup} ${styles.deckFilterWrapGroup}`}>
        {DECK_CARD_RARITY_OPTIONS.map(r => (
          <button
            key={r}
            className={`${styles.boardFilterBtn}${filters.rarities.includes(r) ? ' ' + styles.boardFilterBtnActive : ''}`}
            onClick={() => toggleIn('rarities', r)}
          >
            {r[0].toUpperCase() + r.slice(1)}
          </button>
        ))}
      </div>
      <div className={styles.deckFilterMenuBoardLabel}>Mana Value</div>
      <div className={styles.deckFilterCmcRow}>
        <input
          type="number" min="0" inputMode="numeric"
          className={styles.deckFilterCmcInput}
          value={filters.cmcMin}
          onChange={e => set({ cmcMin: e.target.value })}
          placeholder="Min"
        />
        <span className={styles.deckFilterCmcDash}>–</span>
        <input
          type="number" min="0" inputMode="numeric"
          className={styles.deckFilterCmcInput}
          value={filters.cmcMax}
          onChange={e => set({ cmcMax: e.target.value })}
          placeholder="Max"
        />
      </div>
      {anythingActive && (
        <button
          className={styles.deckFilterClearBtn}
          onClick={() => { setFilters({ ...EMPTY_DECK_CARD_FILTERS }); setBoardFilter('all') }}
        >
          Clear filters
        </button>
      )}
    </div>
  )
}

// ── Single card row in EDHRec recommendations ─────────────────────────────────
function RecRow({ rec, imageUri, ownedQty, onAdd, onHoverEnter, onHoverLeave, onHoverMove, onOpenDetail }) {
  const inclusionPct = rec.potentialDecks > 0
    ? Math.round((rec.inclusion / rec.potentialDecks) * 100)
    : (rec.inclusion ?? 0)
  const synergyPct = Math.round((rec.synergy ?? 0) * 100)
  // Scryfall CDN URLs have the size in the path - swap small -> normal for hover preview
  const largeUri = imageUri ? imageUri.replace('/small/', '/normal/') : null
  const hoverableProps = CAN_HOVER && !lastInputWasTouch && largeUri
    ? {
        onMouseEnter: e => onHoverEnter?.(largeUri, e),
        onMouseMove: e => onHoverMove?.(e),
        onMouseLeave: () => onHoverLeave?.(),
      }
    : {}
  return (
    <div className={styles.recRow}>
      {imageUri
        ? <img
            className={styles.recThumb}
            src={imageUri}
            alt=""
            loading="lazy"
            onClick={() => onOpenDetail?.(rec.name)}
            style={{ cursor: 'pointer' }}
            {...hoverableProps}
          />
        : <div className={styles.recThumbPlaceholder} />
      }
      <div className={styles.recInfo}>
        <div className={styles.recName} onClick={() => onOpenDetail?.(rec.name)} style={{ cursor: 'pointer' }} {...hoverableProps}>{rec.name}</div>
        <div className={styles.recMeta}>
          {rec.type && <span className={styles.recType}>{rec.type}</span>}
          {rec.cmc != null && rec.cmc > 0 && <span className={styles.recCmc}>{rec.cmc} CMC</span>}
        </div>
        <div className={styles.recStats}>
          <div className={styles.inclusionBar}>
            <div className={styles.inclusionFill} style={{ width: `${inclusionPct}%` }} />
          </div>
          <span
            className={styles.inclusionPct}
            title={`Included in ${inclusionPct}% of ${rec.potentialDecks.toLocaleString()} sampled ${rec.potentialDecks === 1 ? 'deck' : 'decks'} for this commander`}
          >{inclusionPct}%</span>
          {synergyPct !== 0 && (
            <span
              className={synergyPct > 0 ? styles.synergyPos : styles.synergyNeg}
              title={`${synergyPct > 0 ? '+' : ''}${synergyPct}% synergy - appears ${Math.abs(synergyPct)}% ${synergyPct > 0 ? 'more' : 'less'} often in this commander's decks than average`}
            >
              {synergyPct > 0 ? '+' : ''}{synergyPct}
            </span>
          )}
          {ownedQty > 0 && <span className={styles.ownedBadge}>OK</span>}
        </div>
      </div>
      <button className={styles.addBtn} onClick={e => { e.stopPropagation(); onAdd(rec) }} title="Add to deck">+</button>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// Pure helpers (commander, allocation, image, etc.) live in deckBuilderHelpers.js

// Edit dropdown (⚙) and DeckCardRow live in components/deckBuilder/DeckCardRow.jsx.

// CategoryPickerModal lives in components/deckBuilder/CategoryPickerModal.jsx.


// Combo recommendation components (ComboResultCard, ComboCardThumb) live in
// components/deckBuilder/combos.jsx.

// Decision/format helpers (buildChosenAllocations, getDecisionCategory, etc.)
// extracted to src/lib/deckSyncDecisions.js

import MakeDeckModal from '../components/deckBuilder/MakeDeckModal'

// ── Make Deck modal ────────────────────────────────────────────────────────────
import SyncModal from '../components/deckBuilder/SyncModal'

import VersionPickerModal from '../components/deckBuilder/VersionPickerModal'
import DeckWinrateMini from '../components/deckBuilder/DeckWinrateMini'
import MoveOwnedCardsModal from '../components/deckBuilder/MoveOwnedCardsModal'
import DeckImportModal from '../components/deckBuilder/DeckImportModal'
import CombosTab from '../components/deckBuilder/CombosTab'
import ShareDeckModal from '../components/deckBuilder/ShareDeckModal'
import DeckMetaModal from '../components/deckBuilder/DeckMetaModal'
import { BuildAssistant } from '../components/deckBuilder/BuildAssistant'
import { useCommanderSearch } from '../hooks/useCommanderSearch'
import { useCardSearch } from '../hooks/useCardSearch'
import { useCombosFetch } from '../hooks/useCombosFetch'

// ── Main DeckBuilder component ────────────────────────────────────────────────
export default function DeckBuilderPage() {
  const { id: deckId } = useParams()
  const { user, session } = useAuth()
  const { grid_density, price_source, default_grouping, deckbuilder_sort } = useSettings()
  const navigate       = useNavigate()
  const location       = useLocation()
  const { showToast }  = useToast()
  const queryClient    = useQueryClient()

  // Wrap a Supabase mutation result and surface errors. Supabase JS does NOT throw
  // on REST errors — it returns { data, error }. We unwrap and toast on failure.
  const sbExec = useCallback(async (resultPromise, opts = {}) => {
    const { silent = false, label = 'Save failed' } = opts
    try {
      const res = await resultPromise
      if (res && res.error) {
        if (!silent) showToast(`${label}: ${res.error.message || 'unknown error'}`, { tone: 'error', duration: 4000 })
        console.error('[DeckBuilder] supabase write error:', res.error)
        throw res.error
      }
      return res
    } catch (err) {
      if (!silent) showToast(`${label}: ${err?.message || 'network error'}`, { tone: 'error', duration: 4000 })
      console.error('[DeckBuilder] supabase write threw:', err)
      throw err
    }
  }, [showToast])

  // Deck state
  const [deck,       setDeck]       = useState(null)
  const [deckMeta,   setDeckMeta]   = useState({})
  const [deckCards,  setDeckCards]  = useState([])
  const [deckCategories, setDeckCategories] = useState([])
  const [deckName,   setDeckName]   = useState('')
  const [saving,     setSaving]     = useState(false)
  const [loading,    setLoading]    = useState(true)
  const [loadError,  setLoadError]  = useState(null)

  // Left panel
  const [leftTab,       setLeftTab]       = useState('search')

  // Commander picker — search state lives in the hook, picking is in pickCommander() below.
  const {
    query:       cmdQuery,
    results:     cmdResults,
    loading:     cmdLoading,
    isOpen:      showCmdPicker,
    setIsOpen:   setShowCmdPicker,
    handleQuery: handleCmdQuery,
    close:       closeCmdPicker,
  } = useCommanderSearch()

  // Companion picker — separate search scoped to cards with the Companion keyword.
  const {
    query:       compQuery,
    results:     compResults,
    isOpen:      showCompPicker,
    setIsOpen:   setShowCompPicker,
    handleQuery: handleCompQuery,
    close:       closeCompPicker,
  } = useCommanderSearch({ scope: 'companion' })

  // Build-from-collection assistant (guided wizard)
  const [showBuildAssistant, setShowBuildAssistant] = useState(false)

  // Card detail modal (read-only, used throughout the builder)
  const [detailCard, setDetailCard] = useState(null) // { card, sfCard }
  const [contextMenu, setContextMenu] = useState(null) // { dc, x, y }
  const [categoryPickCard, setCategoryPickCard] = useState(null)

  // Card search — debounced Scryfall query for the left-panel search panel.
  const {
    query:       searchQuery,
    results:     searchResults,
    loading:     searchLoading,
    hasMore:     searchHasMore,
    page:        searchPage,
    error:       searchError,
    handleInput: handleSearchInput,
    loadMore:    loadMoreSearch,
  } = useCardSearch({ format: deckMeta.format })

  // Recommendations
  const [recs,         setRecs]         = useState([])
  const [recImages,    setRecImages]    = useState({}) // name -> image_uri
  const [recCards,     setRecCards]     = useState({}) // name -> Supabase-resolved card
  const [recLegalities, setRecLegalities] = useState({}) // name -> legalities object
  const [recsLoading,   setRecsLoading]   = useState(false)
  const [recsError,     setRecsError]     = useState(null)
  const [recsOwnedOnly, setRecsOwnedOnly] = useState(false)
  const [collapsedCats, setCollapsedCats] = useState(new Set())
  const recsLoadedForRef = useRef(null) // track {commanderName, formatId} the current recs were loaded for

  // Collection
  const [ownedMap,       setOwnedMap]       = useState(new Map())
  const [ownedNameMap,   setOwnedNameMap]   = useState(new Map())
  const [ownedFoilMap,   setOwnedFoilMap]   = useState(new Map())
  const [inOtherDeckSet,  setInOtherDeckSet]  = useState(new Set())
  const [collDeckSfSet,   setCollDeckSfSet]   = useState(new Set())
  // False until the allocation indicators (inOtherDeckSet/collDeckSfSet) have
  // loaded at least once — the ownership badge must not render "Owned" from
  // the default empty sets before we know whether the card is really free.
  const [ownershipReady,  setOwnershipReady]  = useState(false)
  // Version picker
  const [versionPickCard, setVersionPickCard] = useState(null)
  const [addFeedback, setAddFeedback] = useState(null)
  // Share modal
  const [shareState, setShareState] = useState(null)
  const [shareBusy, setShareBusy] = useState(false)

  // Hover preview — FloatingPreview owns its own state and is updated imperatively,
  // so neither pointer movement nor enter/leave triggers a DeckBuilder re-render.
  const floatingPreviewRef = useRef(null)
  // Deck-list scroll container — measured (via a callback ref so it fires once the
  // list actually mounts, not before data loads) so the tab bar can inset its right
  // edge by the exact scrollbar width and line up pixel-perfectly with the banner.
  const deckListScrollObs = useRef(null)
  const deckListScrollRef = useCallback((el) => {
    const root = document.documentElement
    if (deckListScrollObs.current) { deckListScrollObs.current.disconnect(); deckListScrollObs.current = null }
    if (!el) { root.style.removeProperty('--deck-scrollbar-w'); return }
    const update = () => root.style.setProperty('--deck-scrollbar-w', `${el.offsetWidth - el.clientWidth}px`)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    deckListScrollObs.current = ro
  }, [])
  const setHoverImages = useCallback((uris) => {
    floatingPreviewRef.current?.setImages(uris)
  }, [])
  const updateHoverPos = useCallback((x, y) => {
    floatingPreviewRef.current?.setPos(x, y)
  }, [])

  // Right panel tabs: 'deck' | 'stats' | 'combos'
  const [rightTab,            setRightTab]            = useState('deck')
  const [statsBracketOverride, setStatsBracketOverride] = useState(null)
  const [deckGameResults,        setDeckGameResults]        = useState([])
  const [deckGameResultsLoading, setDeckGameResultsLoading] = useState(false)
  const [deckGameResultsLoaded,  setDeckGameResultsLoaded]  = useState(false)
  const [deckView,    setDeckView]    = useState('list')   // 'list' | 'compact' | 'stacks' | 'grid'
  const [showOptimize, setShowOptimize] = useState(false)
  const [optimizeBusy, setOptimizeBusy] = useState(null)   // mode id while running
  const [showHistory, setShowHistory] = useState(false)
  const [history, setHistory] = useState(null)             // null = loading
  const [showBasics, setShowBasics] = useState(false)
  const [basicsBusy, setBasicsBusy] = useState(null)       // land name while writing
  const [showMissing, setShowMissing] = useState(false)
  const [missingWishlists, setMissingWishlists] = useState(null)  // null = loading
  const [missingTargetId, setMissingTargetId] = useState('')
  const [missingNewName, setMissingNewName] = useState('')
  const [missingBusy, setMissingBusy] = useState(false)
  const [showRight, setShowRight] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 900)
  const wasMobileLayoutRef = useRef(typeof window !== 'undefined' ? window.innerWidth <= 900 : false)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [deckSort,    setDeckSort]    = useState(deckbuilder_sort || 'price_asc')   // 'name' | 'cmc_asc' | 'cmc_desc' | 'color' | 'type' | 'price_asc' | 'price_desc' | 'set' | 'rarity_asc' | 'rarity_desc'
  // Last-used grouping wins over the default_grouping setting (which stays the
  // fallback for devices that never changed it).
  const [groupBy, setGroupByState] = useState(() => {
    try {
      const saved = localStorage.getItem(GROUPBY_STORE_KEY)
      if (saved && DECK_GROUP_MODES.includes(saved)) return saved
    } catch { /* private mode */ }
    return default_grouping === 'category' ? 'category' : default_grouping === 'none' ? 'none' : 'type'
  })
  const setGroupBy = useCallback((v) => {
    setGroupByState(v)
    try { localStorage.setItem(GROUPBY_STORE_KEY, v) } catch { /* private mode */ }
  }, [])
  const [deckFilters, setDeckFilters] = useState(() => ({ ...EMPTY_DECK_CARD_FILTERS }))
  const [visibleColumns, setVisibleColumns] = useState(DEFAULT_LIST_COLUMNS)
  const [compactVisibleColumns, setCompactVisibleColumns] = useState(DEFAULT_COMPACT_COLUMNS)
  const [builderSfMap, setBuilderSfMap] = useState({})
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())
  const [draggedCategoryId, setDraggedCategoryId] = useState(null)
  const [stackHoverState, setStackHoverState] = useState(null) // { group, stackIdx }
  const [touchActiveStack, setTouchActiveStack] = useState(null) // { group, stackIdx, id }
  const [deckSearch, setDeckSearch] = useState('')
  const [boardFilter, setBoardFilter] = useState('all')
  const [warningsOpen, setWarningsOpen] = useState(false)
  const [warningTooltip, setWarningTooltip] = useState(null)
  useEffect(() => {
    if (!warningTooltip || CAN_HOVER) return
    const dismiss = (e) => {
      if (e.target.closest && e.target.closest(`.${styles.warningSummaryBtn}`)) return
      setWarningTooltip(null)
    }
    document.addEventListener('click', dismiss, true)
    return () => document.removeEventListener('click', dismiss, true)
  }, [warningTooltip])
  const [isMobileWarnings, setIsMobileWarnings] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= 900 : false
  ))
  const [syncStatus, setSyncStatus] = useState({ loading: false, dirty: false, count: 0, unavailable: false })

  useEffect(() => {
    const handleResize = () => {
      const isMobile = window.innerWidth <= 900
      if (isMobile && !wasMobileLayoutRef.current) {
        setShowRight(true)
      }
      wasMobileLayoutRef.current = isMobile
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Combos (Commander Spellbook) — hook initialized below, once commanderCard is derived.

  // Import / Export
  const [showImport,    setShowImport]    = useState(false)
  const [showExport,    setShowExport]    = useState(false)

  // Make Deck / Sync
  const [showMakeDeck,    setShowMakeDeck]    = useState(false)
  const [showSync,        setShowSync]        = useState(false)
  const [makeDeckDone,    setMakeDeckDone]    = useState(false)
  const [makeDeckMsg,     setMakeDeckMsg]     = useState('')
  const [makeDeckRunning, setMakeDeckRunning] = useState(false)
  const [syncRunning,     setSyncRunning]     = useState(false)
  const [syncDone,        setSyncDone]        = useState(false)
  const [syncMsg,         setSyncMsg]         = useState('')
  const [pendingOwnedMove, setPendingOwnedMove] = useState(null)

  // Description & tags
  const [cmdDescription, setCmdDescription] = useState('')
  const [cmdTags,        setCmdTags]        = useState([])
  const [newTagInput,    setNewTagInput]    = useState('')
  const [showMetaModal,  setShowMetaModal]  = useState(false)
  const [confirmState, setConfirmState] = useState(null)
  const confirmAsync = useCallback((message) => new Promise(resolve => setConfirmState({ message, resolve })), [])
  const handleConfirm = useCallback((result) => {
    setConfirmState(prev => {
      prev?.resolve(result)
      return null
    })
  }, [])
  const [promptState, setPromptState] = useState(null)
  // Async string prompt rendered via Modal — replaces window.prompt for category names.
  const promptAsync = useCallback((opts) =>
    new Promise(resolve => setPromptState({
      title: opts?.title || 'Enter a value',
      placeholder: opts?.placeholder || '',
      initialValue: opts?.initialValue || '',
      submitLabel: opts?.submitLabel || 'OK',
      resolve,
    })),
  [])
  const handlePromptResolve = useCallback((value) => {
    setPromptState(prev => {
      prev?.resolve(value)
      return null
    })
  }, [])
  const [copyDeckBusy, setCopyDeckBusy] = useState(false)
  const [deleteDeckBusy, setDeleteDeckBusy] = useState(false)

  // Mobile leftTop collapse: auto-collapses when commander is first set on mobile
  const [leftTopOpen, setLeftTopOpen] = useState(true)
  const leftTopAutoCollapsedRef = useRef(false)

  // Refs
  const deckCardsRef    = useRef(deckCards)
  const deckCategoriesRef = useRef(deckCategories)
  const deckMetaRef     = useRef(deckMeta)
  const qtyTimers       = useRef(new Map())
  const saveMetaTimer   = useRef(null)
  const hoverPreviewCache = useRef(new Map())
  const hoverPreviewPromises = useRef(new Map())
  const addFeedbackTimer = useRef(null)
  const addFeedbackRef = useRef(null)
  const hoverPreviewKey = useRef(null)
  const hoverPreviewTimer = useRef(null)
  const dragAutoScrollActive = useRef(false)
  const dragAutoScrollFrame = useRef(null)
  const dragAutoScrollPoint = useRef({ x: 0, y: 0 })
  const printingLookupCache = useRef(new Map())
  const ownedPrintingCandidatesCache = useRef(new Map())
  const ownedPrintingRefreshPromises = useRef(new Map())

  const invalidateCollectionPlacementQueries = useCallback(async ({ includeFolders = false, includeCards = false } = {}) => {
    const invalidations = [
      queryClient.invalidateQueries({ queryKey: ['folderPlacements', user.id] }),
    ]
    if (includeFolders) invalidations.push(queryClient.invalidateQueries({ queryKey: ['folders', user.id] }))
    if (includeCards) {
      invalidations.push(queryClient.invalidateQueries({ queryKey: ['cards', user.id] }))
      invalidations.push(queryClient.invalidateQueries({ queryKey: ['sfMap', user.id] }))
    }
    await Promise.all(invalidations)
  }, [queryClient, user.id])

  useEffect(() => {
    return () => {
      clearTimeout(saveMetaTimer.current)
      clearTimeout(addFeedbackTimer.current)
      if (dragAutoScrollFrame.current) cancelAnimationFrame(dragAutoScrollFrame.current)
      for (const timer of qtyTimers.current.values()) clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    let ignore = false
    getMeta('deckbuilder_visible_columns_v1')
      .then(saved => {
        if (ignore || !saved || typeof saved !== 'object') return
        setVisibleColumns(prev => ({ ...prev, ...saved }))
      })
      .catch(() => {})
    return () => { ignore = true }
  }, [])

  useEffect(() => {
    let ignore = false
    getMeta('deckbuilder_compact_visible_columns_v1')
      .then(saved => {
        if (ignore || !saved || typeof saved !== 'object') return
        setCompactVisibleColumns(prev => ({ ...prev, ...saved }))
      })
      .catch(() => {})
    return () => { ignore = true }
  }, [])

  useEffect(() => {
    setMeta('deckbuilder_visible_columns_v1', visibleColumns).catch(() => {})
  }, [visibleColumns])

  useEffect(() => {
    setMeta('deckbuilder_compact_visible_columns_v1', compactVisibleColumns).catch(() => {})
  }, [compactVisibleColumns])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onResize = () => setIsMobileWarnings(window.innerWidth <= 900)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    // A remembered per-device grouping wins over the settings default.
    try { if (localStorage.getItem(GROUPBY_STORE_KEY)) return } catch { /* private mode */ }
    setGroupByState(default_grouping === 'category' ? 'category' : default_grouping === 'none' ? 'none' : 'type')
  }, [default_grouping])

  useEffect(() => {
    if (deckbuilder_sort) setDeckSort(deckbuilder_sort)
  }, [deckbuilder_sort])

  // Signature of unique printings (set_code-collector_number + scryfall_id) in
  // the deck. Only this string drives the Scryfall metadata/price refetch
  // below — qty/category/board mutations don't change the print set, so they
  // should not refire the expensive `loadCardMapWithSharedPrices` call.
  const builderPrintSignature = useMemo(() => {
    const seen = new Set()
    for (const dc of deckCards) {
      if (!dc.set_code || !dc.collector_number) continue
      seen.add(`${String(dc.set_code).toLowerCase()}-${String(dc.collector_number).toLowerCase()}|${dc.scryfall_id || ''}`)
    }
    return [...seen].sort().join(',')
  }, [deckCards])

  useEffect(() => {
    if (!builderPrintSignature) {
      setBuilderSfMap({})
      return
    }
    let cancelled = false
    const seen = new Set()
    const cards = []
    // Read from the current render's deckCards (captured by closure) — the
    // signature dep guarantees this effect only fires when the print set
    // actually changed, but we still need the latest card objects for the
    // fetch (they carry scryfall_id used for price lookup).
    for (const dc of deckCards) {
      if (!dc.set_code || !dc.collector_number) continue
      const key = `${String(dc.set_code).toLowerCase()}-${String(dc.collector_number).toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      cards.push(dc)
    }
    if (!cards.length) {
      setBuilderSfMap({})
      return
    }
    // requireOracle: pull oracle_text from Scryfall for entries only filled
    // by card_prints. Needed so category-inference can see real card text.
    loadCardMapWithSharedPrices(cards, { requireOracle: true })
      .then(map => { if (!cancelled) setBuilderSfMap(map || {}) })
      .catch(() => { if (!cancelled) setBuilderSfMap({}) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builderPrintSignature])

  useEffect(() => { deckCardsRef.current = deckCards }, [deckCards])
  useEffect(() => { deckCategoriesRef.current = deckCategories }, [deckCategories])
  useEffect(() => { deckMetaRef.current = deckMeta }, [deckMeta])

  // One-shot per deck load: rescue cards pinned to a type-line fallback
  // category (Instant/Sorcery/Enchantment/…) when live regex inference now
  // lands them in a functional bucket (Ramp, Burn, Doublers, …). Cleared
  // cards fall through to live inference on render (see getDeckCardGroup).
  // Never downgrades — only fires when stored is a fallback AND inferred
  // is non-fallback. Runs once builderSfMap is populated so oracle text
  // is available to the regex ladder.
  const categoryUpgradeRunRef = useRef(false)
  useEffect(() => { categoryUpgradeRunRef.current = false }, [deckId])
  useEffect(() => {
    if (categoryUpgradeRunRef.current) return
    if (!deckId || !deckCards.length || !deckCategories.length) return
    if (builderPrintSignature && !Object.keys(builderSfMap).length) return

    const byId = new Map(deckCategories.map(cat => [cat.id, cat]))
    const idsToClear = []
    for (const dc of deckCards) {
      if (!dc.category_id) continue
      const storedName = byId.get(dc.category_id)?.name
      if (!storedName || !isTypeFallbackCategory(storedName)) continue
      const sf = dc.set_code && dc.collector_number ? (builderSfMap[getScryfallKey(dc)] || {}) : {}
      const inferred = getCardCategoryFromCard(dc, sf)
      if (!inferred || inferred === 'Other' || isTypeFallbackCategory(inferred)) continue
      if (inferred === storedName) continue
      idsToClear.push(dc.id)
    }

    // Flip the ref synchronously so a re-render mid-flight (e.g. a card add)
    // can't queue a duplicate upgrade pass before the await resolves.
    categoryUpgradeRunRef.current = true

    if (!idsToClear.length) return

    ;(async () => {
      try {
        const { error } = await sb.from('deck_cards')
          .update({ category_id: null, updated_at: new Date().toISOString() })
          .in('id', idsToClear)
        if (error) {
          console.error('[DeckBuilder] category auto-upgrade failed:', error)
          return
        }
        const idSet = new Set(idsToClear)
        const next = deckCardsRef.current.map(dc => idSet.has(dc.id) ? { ...dc, category_id: null } : dc)
        deckCardsRef.current = next
        setDeckCards(next)
        putDeckCards(next.filter(dc => idSet.has(dc.id))).catch(() => {})
      } catch (err) {
        console.error('[DeckBuilder] category auto-upgrade error:', err)
      }
    })()
  }, [deckId, deckCards, deckCategories, builderSfMap, builderPrintSignature])

  // ── Load on mount ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!deckId) return
    let ignore = false
    ;(async () => {
      setLoading(true)
      setOwnershipReady(false)
      try {
        // Load deck folder
        const { data: folder, error } = await sb.from('folders').select('*').eq('id', deckId).single()
        if (error || !folder) { setLoadError('Deck not found'); setLoading(false); return }

        const meta = parseDeckMeta(folder.description)
        if (folder.user_id !== user.id) {
          // Non-owner: if the deck is public, send them to the shared deck view.
          if (meta.is_public) { navigate(`/d/${deckId}`, { replace: true }); return }
          setLoadError('Access denied'); setLoading(false); return
        }

        // Default collection decks to commander format if no format set
        if (folder.type === 'deck' && !meta.format) {
          meta.format = 'commander'
        }
        // Re-show in builder list if user navigated here directly (e.g. "Edit in Builder")
        if (meta.hideFromBuilder) {
          const hiddenMeta = { ...meta }
          delete meta.hideFromBuilder
          try { await patchDeckMeta(deckId, hiddenMeta, meta) }
          catch (err) { console.warn('[DeckBuilder] failed to unhide deck:', err) }
        }
        setDeck(folder)
        setDeckMeta(meta)
        deckMetaRef.current = meta
        setDeckName(folder.name)
        setCmdDescription(meta.deckDescription || '')
        setCmdTags(meta.tags || [])
        setStatsBracketOverride(meta.bracketManual ? (meta.bracket ?? null) : null)
        const categoryRows = await fetchDeckCategories(deckId)
        if (!ignore) setDeckCategories(categoryRows)

        async function enrichDeckCardsWithMetadata(rows) {
          const rowsNeedingMeta = (rows || []).filter(row => !row.type_line || !row.image_uri || row.cmc == null)
          if (!rowsNeedingMeta.length) return rows || []

          const missingIds = [...new Set(rowsNeedingMeta.map(row => row.scryfall_id).filter(Boolean))]
          const fetchedByIdRows = missingIds.length ? await fetchCardsByScryfallIds(missingIds) : []
          const fetchedById = new Map(fetchedByIdRows.map(card => [card.id, card]))

          const unresolvedNameRows = rowsNeedingMeta.filter(row => !row.scryfall_id || !fetchedById.has(row.scryfall_id))
          const missingMetaNames = [...new Set(unresolvedNameRows.map(row => row.name).filter(Boolean))]
          const fetchedByNameRows = missingMetaNames.length ? await fetchCardsByNames(missingMetaNames) : []
          const fetchedByName = new Map(fetchedByNameRows.map(card => [(card.name || '').toLowerCase(), card]))
          const enrichedRows = (rows || []).map(row => {
            const resolvedById   = row.scryfall_id ? fetchedById.get(row.scryfall_id) : null
            const resolvedByName = !resolvedById   ? fetchedByName.get((row.name || '').toLowerCase()) : null
            const fetched = resolvedById || resolvedByName
            if (!fetched) return row
            const meta = getDeckBuilderCardMeta(fetched)

            // Only update printing-identity fields (scryfall_id, set, image) when:
            // - resolved via the card's own ID (safe — same card), OR
            // - the row genuinely has no printing info yet (name-only, e.g. text import)
            // Never overwrite an existing scryfall_id with a name lookup — that
            // would silently reassign to whatever Scryfall currently returns as
            // the "newest" printing (e.g. an upcoming set reprint).
            const canUpdatePrinting = !!resolvedById || !row.scryfall_id

            const next = {
              ...row,
              type_line: row.type_line || meta.type_line,
              mana_cost: row.mana_cost || meta.mana_cost,
              cmc: row.cmc ?? meta.cmc,
              color_identity: (row.color_identity && row.color_identity.length > 0)
                ? row.color_identity
                : (meta.color_identity || []),
              ...(canUpdatePrinting && {
                scryfall_id:       row.scryfall_id       || meta.scryfall_id,
                set_code:          row.set_code          || meta.set_code,
                collector_number:  row.collector_number  || meta.collector_number,
                image_uri:         row.image_uri         || meta.image_uri || null,
              }),
            }

            const changed =
              next.scryfall_id !== row.scryfall_id ||
              next.set_code !== row.set_code ||
              next.collector_number !== row.collector_number ||
              next.type_line !== row.type_line ||
              next.mana_cost !== row.mana_cost ||
              next.cmc !== row.cmc ||
              JSON.stringify(next.color_identity || []) !== JSON.stringify(row.color_identity || []) ||
              next.image_uri !== row.image_uri

            return changed ? next : row
          })

          return enrichedRows
        }

        let cardList = await fetchDeckCards(deckId)
        if (folder.type === 'deck' && cardList.length === 0) {
          // The view may exclude rows that exist in the raw table (join mismatch).
          // Check the table directly before deciding to hydrate from allocations.
          const { data: rawExisting } = await sb
            .from('deck_cards').select('id').eq('deck_id', deckId).limit(1)
          const tableIsEmpty = !(rawExisting?.length)

          if (tableIsEmpty && !ignore) {
            const allocations = await fetchDeckAllocations(deckId)
            if ((allocations || []).length > 0 && !ignore) {
              const now = new Date().toISOString()
              const hydratedRows = allocations.map(row => ({
                id: crypto.randomUUID(),
                deck_id: deckId,
                user_id: user.id,
                card_print_id: row.card_print_id || null,
                scryfall_id: row.scryfall_id || null,
                name: row.name,
                set_code: row.set_code || null,
                collector_number: row.collector_number || null,
                type_line: row.type_line || null,
                mana_cost: row.mana_cost || null,
                cmc: row.cmc ?? null,
                color_identity: row.color_identity || [],
                image_uri: row.image_uri || null,
                qty: row.qty || 1,
                foil: row.foil ?? false,
                is_commander: false,
                board: 'main',
                category_id: null,
                created_at: now,
                updated_at: now,
              }))
              const { error: hydrateErr } = await sb.from('deck_cards').insert(hydratedRows.map(toDeckCardRow))
              // 23505 = duplicate key: StrictMode re-run or race — rows exist, re-fetch handles it
              if (hydrateErr && hydrateErr.code !== '23505') throw hydrateErr
            }
          }

          // Re-fetch from view so we get enriched data regardless of insert path
          const refetched = await fetchDeckCards(deckId)
          cardList = await enrichDeckCardsWithMetadata(refetched)
        } else {
          cardList = await enrichDeckCardsWithMetadata(cardList)
        }

        setDeckCards(cardList)
        putDeckCards(cardList).catch(() => {})
        if (!ignore) setLoading(false)

        // Build owned maps — failures here must not block the deck display.
        // Everything is computed into locals first and only applied via
        // setState at the end (guarded by `ignore`) — otherwise a slower,
        // cancelled load for a *previous* deck can finish after this one and
        // silently overwrite inOtherDeckSet/ownedFoilMap with data scoped to
        // the wrong deck, since navigating away doesn't abort in-flight awaits.
        try {
          const owned = await getLocalCards(user.id)
          const map     = new Map()
          const nameMap = new Map()
          const foilMap = new Map()
          for (const c of owned) {
            if (c.scryfall_id) {
              map.set(c.scryfall_id, (map.get(c.scryfall_id) ?? 0) + (c.qty || 1))
              const fk = `${c.scryfall_id}|${c.foil ? '1' : '0'}`
              foilMap.set(fk, (foilMap.get(fk) ?? 0) + (c.qty || 1))
            }
            const n = (c.name || '').toLowerCase()
            if (n) nameMap.set(n, (nameMap.get(n) ?? 0) + (c.qty || 1))
          }

          // For linked builder decks, allocations live on the paired collection deck
          const allocDeckId = meta.linked_deck_id || (folder.type === 'deck' ? deckId : null) || deckId
          const thisAllocations = await fetchDeckAllocations(allocDeckId)
          const collSet = new Set((thisAllocations || []).flatMap(row => deckAllocationKeys(row)))

          const allAllocations = await fetchDeckAllocationsForCardIdentities(user.id, collectCardIdentities(cardList))
          const otherSet = new Set(
            (allAllocations || [])
              .filter(row => row.deck_id !== deckId && row.deck_id !== allocDeckId)
              .flatMap(row => deckAllocationKeys(row))
          )

          if (!ignore) {
            setOwnedMap(map)
            setOwnedNameMap(nameMap)
            setOwnedFoilMap(foilMap)
            setCollDeckSfSet(collSet)
            setInOtherDeckSet(otherSet)
            setOwnershipReady(true)
          }
        } catch (ownedErr) {
          console.error('[DeckBuilder] owned card indicators failed to load:', ownedErr)
        }
      } catch (err) {
        if (!ignore) {
          setLoadError('Failed to load deck')
          console.error(err)
        }
      }
      if (!ignore) setLoading(false)
    })()
    return () => { ignore = true }
  }, [deckId, user.id])

  // ── Computed ─────────────────────────────────────────────────────────────────
  const format         = useMemo(() => FORMATS.find(f => f.id === (deckMeta.format || 'commander')), [deckMeta.format])
  const isEDH          = format?.isEDH ?? false
  const commanderCards = useMemo(() => deckCards.filter(dc => dc.is_commander), [deckCards])
  const commanderCard  = commanderCards[0] ?? null

  // Combos hook — needs commanderCard + deckCards + access token.
  const {
    fetched:      combosFetched,
    loading:      combosLoading,
    included:     combosIncluded,
    almost:       combosAlmost,
    sectionsOpen: comboSectionsOpen,
    toggleSection: toggleComboSection,
    fetchCombos,
  } = useCombosFetch({ commanderCard, deckCards, accessToken: session?.access_token })
  const mainDeckCards  = useMemo(() => deckCards.filter(dc => normalizeBoard(dc.board) === 'main'), [deckCards])

  // Cards in the deck the user does NOT own (by name), basic lands excluded.
  // Keeps a representative deck-card row per name so we can add the deck's
  // chosen printing to a wishlist. Powers "Add missing to wishlist".
  const missingCards = useMemo(() => {
    const needed = new Map()   // name -> { qty, row }
    for (const dc of deckCards) {
      if (!dc.is_commander && normalizeBoard(dc.board) === 'maybe') continue
      const name = (dc.name || '').trim()
      if (!name || BASIC_LAND_NAMES.has(name.toLowerCase())) continue
      const ex = needed.get(name)
      if (ex) ex.qty += (dc.qty || 0)
      else needed.set(name, { qty: dc.qty || 0, row: dc })
    }
    const out = []
    for (const [name, { qty, row }] of needed) {
      const missing = Math.max(0, qty - (ownedNameMap.get(name.toLowerCase()) || 0))
      if (missing > 0) out.push({ name, qty: missing, row })
    }
    return out
  }, [deckCards, ownedNameMap])
  const normalizedStatsCards = useMemo(
    () => normalizeDeckBuilderCards(mainDeckCards, builderSfMap, { price_source }),
    [mainDeckCards, builderSfMap, price_source]
  )

  // Two-card combo names for the Bracket estimate.
  const comboNameLists = useMemo(() => {
    if (!combosFetched) return null
    return combosIncluded.map(c =>
      (c.uses || []).map(u => u.card?.name || u.template?.name).filter(Boolean)
    )
  }, [combosFetched, combosIncluded])

  // Commander Bracket estimate — computed once here (not inside DeckStats) so
  // the art banner's BracketBadge and the Stats tab's can share the same
  // analysis instead of double-fetching Game Changers / re-analyzing.
  const [gameChangerNames, setGameChangerNames] = useState(null)
  useEffect(() => {
    if (!isEDH || gameChangerNames) return
    let active = true
    fetchGameChangerNames()
      .then(names => { if (active) setGameChangerNames(names) })
      .catch(() => { if (active) setGameChangerNames(new Set()) })
    return () => { active = false }
  }, [isEDH, gameChangerNames])

  const bracketAnalysis = useMemo(() => {
    if (!isEDH) return null
    return analyzeBracket({
      cards: normalizedStatsCards,
      gameChangerNames: gameChangerNames || new Set(),
      comboCardLists: combosFetched ? (comboNameLists || []) : null,
    })
  }, [isEDH, normalizedStatsCards, gameChangerNames, combosFetched, comboNameLists])

  const effectiveBracket = statsBracketOverride ?? bracketAnalysis?.bracket ?? 1

  // Persist the effective bracket to the deck's meta blob so list/browser views
  // (Builder.jsx tiles, DeckBrowser) can show a pill without re-fetching every
  // deck's cards and re-running analyzeBracket just to render a list.
  useEffect(() => {
    if (!deckId || !isEDH || !bracketAnalysis) return
    const nextMeta = computeBracketMetaPatch(deckMetaRef.current, effectiveBracket, statsBracketOverride != null)
    if (!nextMeta) return
    const baseMeta = deckMetaRef.current || {}
    applyLocalDeckMeta(nextMeta)
    patchDeckMeta(deckId, baseMeta, nextMeta)
      .then(applyLocalDeckMeta)
      .catch(err => console.warn('[DeckBuilder] bracket metadata save failed:', err))
  }, [deckId, isEDH, bracketAnalysis, effectiveBracket, statsBracketOverride])

  // Auto-collapse format/commander section on mobile once commander is set
  useEffect(() => {
    if (commanderCard && !leftTopAutoCollapsedRef.current && window.innerWidth <= 900) {
      leftTopAutoCollapsedRef.current = true
      setLeftTopOpen(false)
    }
  }, [commanderCard])
  const totalCards     = useMemo(() => deckCards.reduce((s, dc) => s + dc.qty, 0), [deckCards])
  const totalDeckPrice = useMemo(() => mainDeckCards.reduce((sum, dc) => {
    const sf = builderSfMap[getScryfallKey(dc)]
    const p = sf ? getPrice(sf, dc.foil, { price_source }) : null
    return sum + (p != null ? p * (dc.qty || 1) : 0)
  }, 0), [mainDeckCards, builderSfMap, price_source])
  const listGridLayout = useMemo(() => {
    const cardColumnWidth = 220
    const cols = [`minmax(${cardColumnWidth}px, 1fr)`]
    let fixedWidth = 0
    const addColumn = (width) => {
      cols.push(`${width}px`)
      fixedWidth += width
    }
    if (visibleColumns.set) addColumn(88)
    if (visibleColumns.manaValue) addColumn(88)
    if (visibleColumns.cmc) addColumn(56)
    if (visibleColumns.price) addColumn(78)
    if (visibleColumns.status) addColumn(94)
    if (visibleColumns.qty) addColumn(64)
    if (visibleColumns.actions) addColumn(32)
    if (visibleColumns.remove) addColumn(32)
    const gapWidth = Math.max(0, cols.length - 1) * 8
    return {
      template: cols.join(' '),
      minWidth: `${cardColumnWidth + fixedWidth + gapWidth + 16}px`,
    }
  }, [visibleColumns])
  const listGridTemplate = listGridLayout.template
  const listGridMinWidth = listGridLayout.minWidth

  const activeColumns = deckView === 'compact' ? compactVisibleColumns : visibleColumns
  const setActiveColumns = deckView === 'compact' ? setCompactVisibleColumns : setVisibleColumns
  const getCardOwnershipProps = useCallback((dc) => ({
    ownedQty: ownedFoilMap.get(`${dc.scryfall_id}|${dc.foil ? '1' : '0'}`) ?? 0,
    ownedFoilAlt: ownedFoilMap.get(`${dc.scryfall_id}|${dc.foil ? '0' : '1'}`) ?? 0,
    ownedAlt: ownedNameMap.get((dc.name || '').toLowerCase()) ?? 0,
    ownedInDeck: allocationSetHas(inOtherDeckSet, dc),
    inCollDeck: allocationSetHas(collDeckSfSet, dc),
    ownershipReady,
  }), [ownedFoilMap, ownedNameMap, inOtherDeckSet, collDeckSfSet, ownershipReady])

  const getDeckCardPriceLabel = useCallback((dc) => {
    if (!dc?.set_code || !dc?.collector_number) return '—'
    const sf = builderSfMap[getScryfallKey(dc)]
    if (!sf) return '—'
    const price = getPrice(sf, dc.foil, { price_source })
    return price != null ? formatPrice(price, price_source) : '—'
  }, [builderSfMap, price_source])
  const handleSearchRowHoverEnter = useCallback((uri, e) => {
    updateHoverPos(e.clientX, e.clientY)
    setHoverImages(uri ? [uri] : [])
  }, [updateHoverPos])
  const handleSearchRowHoverMove = useCallback((e) => {
    updateHoverPos(e.clientX, e.clientY)
  }, [updateHoverPos])
  const handleSearchRowHoverLeave = useCallback(() => {
    setHoverImages([])
  }, [])
  const colorIdentity  = useMemo(() => {
    const cols = new Set()
    for (const c of commanderCards) for (const col of (c.color_identity || [])) cols.add(col)
    return [...cols]
  }, [commanderCards])
  const deckSize       = (format?.deckSize ?? 60) + (deckMeta.companion ? companionDeckSizeBonus(deckMeta.companion) : 0)

  // Companion validation — checks the designated companion against the starting
  // (main-board) deck using full Scryfall data for type/oracle-text rules.
  const companionValidation = useMemo(() => {
    const companion = deckMeta.companion
    if (!companion) return null
    const merged = mainDeckCards.map(dc => {
      const sf = dc.set_code && dc.collector_number ? builderSfMap[getScryfallKey(dc)] : null
      return {
        name: dc.name,
        type_line: sf?.type_line || dc.type_line || '',
        mana_cost: sf?.mana_cost || dc.mana_cost || '',
        cmc: sf?.cmc ?? dc.cmc ?? 0,
        oracle_text: getCommanderOracle(sf) || '',
        qty: dc.qty || 1,
      }
    })
    return validateCompanion(companion, merged)
  }, [deckMeta.companion, mainDeckCards, builderSfMap])

  const isCollectionDeck = deck?.type === 'deck'

  const deckWarnings = useMemo(() => {
    const warnings = []
    const playableCards = deckCards.filter(dc => normalizeBoard(dc.board) !== 'maybe')
    const mainQty = mainDeckCards.reduce((sum, dc) => sum + (dc.qty || 0), 0)
    const sideQty = deckCards.filter(dc => normalizeBoard(dc.board) === 'side').reduce((sum, dc) => sum + (dc.qty || 0), 0)
    const maybeQty = deckCards.filter(dc => normalizeBoard(dc.board) === 'maybe').reduce((sum, dc) => sum + (dc.qty || 0), 0)
    const formatId = format?.id || 'commander'
    const formatLabel = format?.label || formatId
    const pushWarning = (warning) => warnings.push(warning)

    if (mainQty > deckSize) pushWarning({ key: 'size-over', level: 'error', summary: `Mainboard ${mainQty}/${deckSize}`, detail: `Mainboard is over size by ${mainQty - deckSize} card${mainQty - deckSize === 1 ? '' : 's'}.` })
    if (mainQty < deckSize) pushWarning({ key: 'size-under', level: 'error', summary: `Mainboard ${mainQty}/${deckSize}`, detail: `Mainboard is short by ${deckSize - mainQty} card${deckSize - mainQty === 1 ? '' : 's'}.` })
    const isOath = formatId === 'oathbreaker'
    if (isEDH && commanderCards.length === 0) pushWarning({ key: 'no-commander', level: 'error', summary: isOath ? 'Oathbreaker missing' : 'Commander missing', detail: isOath ? 'Oathbreaker requires a planeswalker Oathbreaker before the deck is legal.' : 'Commander format requires a commander before the deck is legal.' })
    if (isEDH) {
      const pairIssue = isOath ? getOathbreakerPairIssue(commanderCards) : getCommanderPairIssue(commanderCards, builderSfMap)
      if (pairIssue) pushWarning({ key: 'commander-pair', level: 'error', summary: isOath ? 'Invalid command zone' : (commanderCards.length > 2 ? `${commanderCards.length} commanders marked` : 'Invalid commander pair'), detail: pairIssue })
      for (const dc of commanderCards) {
        const sf = dc.set_code && dc.collector_number ? builderSfMap[getScryfallKey(dc)] : null
        const merged = { ...dc, type_line: sf?.type_line || dc.type_line }
        const valid = isOath ? (isOathbreaker(merged) || isSignatureSpell(merged)) : canBeCommander(dc, sf)
        if (!valid) pushWarning({ key: `commander:${dc.id}`, level: 'error', summary: `${dc.name}: invalid ${isOath ? 'command-zone card' : 'commander'}`, detail: `${dc.name} cannot be ${isOath ? 'in the Oathbreaker command zone' : 'your commander'}.` })
      }
    }
    if (isEDH && sideQty > 0) pushWarning({ key: 'sideboard-edh', level: 'info', summary: `Sideboard ${sideQty}`, detail: `Sideboard has ${sideQty} card${sideQty === 1 ? '' : 's'}. Collection sync includes it, but Commander stats and combo checks ignore it.` })
    if (maybeQty > 0) pushWarning({ key: 'maybeboard', level: 'info', summary: `Maybeboard ${maybeQty}`, detail: `Maybeboard has ${maybeQty} card${maybeQty === 1 ? '' : 's'} and is excluded from stats, combos, and collection sync.` })

    if (isEDH && colorIdentity.length > 0) {
      for (const dc of playableCards) {
        if (dc.is_commander) continue
        const outside = (dc.color_identity || []).filter(color => !colorIdentity.includes(color))
        if (outside.length) pushWarning({ key: `color:${dc.id}`, level: 'error', summary: `${dc.name}: off-color`, detail: `${dc.name} is outside the commander's color identity because it includes ${outside.join('')}.` })
      }
    }

    const nameQty = new Map()
    for (const dc of playableCards) {
      const name = normalizeCardName(dc.name)
      if (!name) continue
      nameQty.set(name, (nameQty.get(name) || 0) + (dc.qty || 0))
    }
    if (isEDH) {
      for (const [name, qty] of nameQty) {
        if (qty <= 1) continue
        const sample = playableCards.find(dc => normalizeCardName(dc.name) === name)
        if (!isBasicLandName(sample?.name || name)) {
          pushWarning({ key: `duplicate:${name}`, level: 'error', summary: `${sample?.name || name}: ${qty} copies`, detail: `${sample?.name || name} exceeds singleton limits for this format.` })
        }
      }
    }

    let unknownLegalityCount = 0
    for (const dc of playableCards) {
      const sf = dc.set_code && dc.collector_number ? builderSfMap[getScryfallKey(dc)] : null
      const legality = sf?.legalities?.[formatId]
      if (!sf?.legalities) {
        unknownLegalityCount += 1
        continue
      }
      if (legality === 'not_legal' || legality === 'banned') {
        pushWarning({ key: `legality:${dc.id}`, level: 'error', summary: `${dc.name}: ${legality.replace('_', ' ')}`, detail: `${dc.name} is ${legality.replace('_', ' ')} in ${formatLabel}.` })
      } else if (legality === 'restricted' && (dc.qty || 0) > 1) {
        pushWarning({ key: `restricted:${dc.id}`, level: 'error', summary: `${dc.name}: restricted`, detail: `${dc.name} is restricted in ${formatLabel}, so only one copy is allowed.` })
      }
    }
    if (unknownLegalityCount > 0) {
      pushWarning({ key: 'unknown-legality', level: 'info', summary: `Legality unknown: ${unknownLegalityCount}`, detail: `Legality data is unavailable for ${unknownLegalityCount} card${unknownLegalityCount === 1 ? '' : 's'}.` })
    }

    if (deckMeta.companion) {
      if (companionValidation && !companionValidation.ok) {
        pushWarning({ key: 'companion', level: 'error', summary: `Companion: ${companionValidation.offenders.length} illegal`, detail: `${deckMeta.companion.name}: ${companionValidation.note} Offenders: ${companionValidation.offenders.slice(0, 8).join(', ')}${companionValidation.offenders.length > 8 ? '…' : ''}.` })
      }
      if (isEDH && colorIdentity.length) {
        const outside = (deckMeta.companion.color_identity || []).filter(c => !colorIdentity.includes(c))
        if (outside.length) pushWarning({ key: 'companion-ci', level: 'error', summary: 'Companion off-color', detail: `${deckMeta.companion.name} is outside the commander color identity (${outside.join('')}).` })
      }
    }

    return warnings
  }, [builderSfMap, colorIdentity, commanderCards, deckCards, deckSize, format, isEDH, mainDeckCards, deckMeta.companion, companionValidation])

  const visibleDeckWarnings = useMemo(
    () => deckWarnings.filter(w => w.level === 'error'),
    [deckWarnings]
  )

  const deckCardLegalityWarnings = useDeckCardLegalityWarnings({
    deckCards,
    builderSfMap,
    format,
    isEDH,
    colorIdentity,
  })

  // Open card detail modal from a deck_card or Scryfall card object
  const openDeckCardDetail = useCallback((dc) => {
    setDetailCard({ card: dc, sfCard: null })
  }, [])

  // Open card detail modal for a Scryfall search result (id = scryfall_id, set = set_code)
  const openSearchCardDetail = useCallback((c) => {
    setDetailCard({
      card: { scryfall_id: c.id, set_code: c.set, collector_number: c.collector_number, name: c.name, qty: 1, foil: false },
      sfCard: c,
    })
  }, [])

  const copyShareLink = useCallback(async (url) => {
    try {
      await navigator.clipboard.writeText(url)
      return true
    } catch {
      return false
    }
  }, [])

  const handleShareDeck = useCallback(async () => {
    if (!deckId || shareBusy) return
    setShareBusy(true)
    const url = getPublicAppUrl(`/d/${deckId}`)
    const wasPrivate = !deckMeta.is_public
    try {
      if (wasPrivate) {
        await setVisibility(true)
      }

      const copied = await copyShareLink(url)
      setShareState({ url, copied, madePublic: wasPrivate, error: null })
    } catch (error) {
      console.error('[DeckBuilder] share failed:', error)
      setShareState({ url, copied: false, madePublic: false, error: 'Could not publish this deck. Try again in a moment.' })
    } finally {
      setShareBusy(false)
    }
  }, [copyShareLink, deckId, deckMeta, shareBusy])

  function makePrivateCopyMeta(meta) {
    const next = { ...(meta || {}) }
    next.is_public = false
    delete next.linked_deck_id
    delete next.linked_builder_id
    delete next.sync_state
    delete next.last_sync_at
    delete next.last_sync_snapshot
    delete next.unsynced_builder
    delete next.unsynced_collection
    delete next.hideFromBuilder
    return next
  }

  async function getNextCopyDeckName(baseName) {
    const base = String(baseName || 'Deck').trim() || 'Deck'
    const { data } = await sb.from('folders')
      .select('name')
      .eq('user_id', user.id)
      .in('type', ['builder_deck', 'deck'])
    const taken = new Set((data || []).map(row => String(row.name || '').toLowerCase()))
    let n = 1
    while (taken.has(`${base} copy ${n}`.toLowerCase())) n += 1
    return `${base} copy ${n}`
  }

  async function handleCopyDeck() {
    if (!deckId || !user?.id || copyDeckBusy) return
    setCopyDeckBusy(true)
    let createdDeckId = null
    try {
      const now = new Date().toISOString()
      const copyName = await getNextCopyDeckName(deckName)
      const copyMeta = makePrivateCopyMeta(deckMeta)
      const { data: newDeck, error: deckError } = await sb.from('folders').insert({
        user_id: user.id,
        type: 'builder_deck',
        name: copyName,
        description: serializeDeckMeta(copyMeta),
      }).select().single()
      if (deckError) throw deckError
      createdDeckId = newDeck.id

      const sourceCategories = deckCategoriesRef.current || []
      const categoryIdMap = new Map()
      if (sourceCategories.length) {
        const categoryInserts = sourceCategories.map(cat => ({
          id: crypto.randomUUID(),
          deck_id: newDeck.id,
          user_id: user.id,
          name: cat.name,
          sort_order: cat.sort_order ?? 0,
          created_at: now,
        }))
        const { error: catError } = await sb.from('deck_categories').insert(categoryInserts)
        if (catError) throw catError
        sourceCategories.forEach((cat, i) => categoryIdMap.set(cat.id, categoryInserts[i].id))
      }

      const rows = deckCardsRef.current.map(card => toDeckCardRow({
        ...card,
        id: crypto.randomUUID(),
        deck_id: newDeck.id,
        user_id: user.id,
        category_id: card.category_id ? (categoryIdMap.get(card.category_id) || null) : null,
        created_at: now,
        updated_at: now,
      }))
      if (rows.length) {
        const { error: cardsError } = await sb.from('deck_cards').insert(rows.map(toDeckCardRow))
        if (cardsError) throw cardsError
        // IDB stores enriched rows (with denorm fields) for fast UI render.
        putDeckCards(rows).catch(() => {})
      }
      navigate(`/builder/${newDeck.id}`)
    } catch (error) {
      console.error('[DeckBuilder] copy deck failed:', error)
      if (createdDeckId) {
        try {
          await sb.from('deck_cards').delete().eq('deck_id', createdDeckId)
          await sb.from('deck_categories').delete().eq('deck_id', createdDeckId)
          await sb.from('folders').delete().eq('id', createdDeckId).eq('user_id', user.id)
        } catch {}
      }
    } finally {
      setCopyDeckBusy(false)
    }
  }

  async function handleDeleteBuilderDeck() {
    if (!deckId || isCollectionDeck || deleteDeckBusy) return
    const ok = await confirmAsync('Delete this builder deck? This cannot be undone.')
    if (!ok) return
    setDeleteDeckBusy(true)
    try {
      const meta = deckMetaRef.current || {}
      if (meta.linked_deck_id) {
        const { data: counterpart } = await sb.from('folders').select('*').eq('id', meta.linked_deck_id).maybeSingle()
        if (counterpart) await unlinkPairedDeck({ counterpart })
      }
      await sb.from('deck_cards').delete().eq('deck_id', deckId)
      await sb.from('folders').delete().eq('id', deckId).eq('user_id', user.id)
      navigate('/builder')
    } catch (error) {
      console.error('[DeckBuilder] delete deck failed:', error)
    } finally {
      setDeleteDeckBusy(false)
    }
  }

  const renderDeckActionsMenu = ({ close, includeQuickActions = true }) => (
    <div className={uiStyles.responsiveMenuList}>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowImport(true); close() }}>
        <span>Import</span>
      </button>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowExport(true); close() }}>
        <span>Export</span>
      </button>
      {includeQuickActions && (
        <Link className={uiStyles.responsiveMenuAction} to={`/builder/${deckId}/playtest`} onClick={close}>
          <span>Playtest</span>
        </Link>
      )}
      <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowMetaModal(true); close() }}>
        <span>Description &amp; Tags</span>
      </button>
      <button
        className={`${uiStyles.responsiveMenuAction} ${deckMeta.is_public ? uiStyles.responsiveMenuActionActive : ''}`}
        onClick={togglePublic}
      >
        <span>Visibility</span>
        <span className={styles.visibilityMenuState}>{deckMeta.is_public ? 'Public' : 'Private'}</span>
      </button>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { resetAllCategories(); close() }}>
        <span>Reset Categories</span>
      </button>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowBasics(true); close() }}>
        <span>Add Basic Lands</span>
      </button>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { openMissingWishlist(); close() }}>
        <span>Add Missing to Wishlist</span>
        <WishlistsIcon size={13} />
      </button>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowOptimize(true); close() }}>
        <span>Optimize Printings</span>
      </button>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { openHistory(); close() }}>
        <span>Deck History</span>
      </button>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { handleCopyDeck(); close() }} disabled={copyDeckBusy}>
        <span>{copyDeckBusy ? 'Copying...' : 'Copy Deck'}</span>
        <CopyIcon size={13} />
      </button>
      {!isCollectionDeck && (
        <button className={`${uiStyles.responsiveMenuAction} ${uiStyles.responsiveMenuActionDanger}`} onClick={() => { handleDeleteBuilderDeck(); close() }} disabled={deleteDeckBusy}>
          <span>{deleteDeckBusy ? 'Deleting...' : 'Delete Deck'}</span>
          <DeleteIcon size={13} />
        </button>
      )}
      {includeQuickActions && (
        <button className={uiStyles.responsiveMenuAction} onClick={() => { handleShareDeck(); close() }} disabled={shareBusy}>
          <span>{shareBusy ? 'Sharing...' : 'Share'}</span>
        </button>
      )}
      {includeQuickActions && (
        <Link className={uiStyles.responsiveMenuAction} to="/builder" onClick={close}>
          <span>Back to Decks</span>
        </Link>
      )}
    </div>
  )

  // Open recommendation/combo details from the shared Supabase dictionary.
  const openCardDetailByName = useCallback(async (name) => {
    try {
      const data = recCards[name] || (await fetchRecommendationMetadataByNames([name]))[0]
      if (!data) return
      setDetailCard({
        card: { scryfall_id: data.id, set_code: data.set, collector_number: data.collector_number, name: data.name, qty: 1, foil: false },
        sfCard: data,
      })
    } catch {}
  }, [recCards])


  const visibleDeckCards = useMemo(() => {
    const q = deckSearch.trim().toLowerCase()
    return deckCards.filter(dc => {
      if (boardFilter !== 'all' && normalizeBoard(dc.board) !== boardFilter) return false
      if (!matchesDeckCardFilters(dc, builderSfMap[getScryfallKey(dc)], deckFilters)) return false
      if (!q) return true
      return [
        dc.name,
        dc.type_line,
        dc.mana_cost,
        dc.set_code,
        dc.collector_number,
      ].some(value => String(value || '').toLowerCase().includes(q))
    })
  }, [deckCards, deckSearch, boardFilter, deckFilters, builderSfMap])

  const sortedDeckCards = useMemo(() => {
    if (deckSort === 'type') return visibleDeckCards // type uses grouped rendering
    const cards = [...visibleDeckCards]
    if (deckSort === 'name')      return cards.sort((a, b) => a.name.localeCompare(b.name))
    if (deckSort === 'name_desc') return cards.sort((a, b) => b.name.localeCompare(a.name))
    if (deckSort === 'cmc_asc')  return cards.sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0) || a.name.localeCompare(b.name))
    if (deckSort === 'cmc_desc') return cards.sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0) || a.name.localeCompare(b.name))
    if (deckSort === 'color') return cards.sort((a, b) => {
      const ca = (a.color_identity || []).join('')
      const cb = (b.color_identity || []).join('')
      return ca.localeCompare(cb) || a.name.localeCompare(b.name)
    })
    if (deckSort === 'price_desc' || deckSort === 'price') return cards.sort((a, b) => {
      const sfA = builderSfMap[getScryfallKey(a)]
      const sfB = builderSfMap[getScryfallKey(b)]
      const pA = getPrice(sfA, a.foil, { price_source }) ?? -1
      const pB = getPrice(sfB, b.foil, { price_source }) ?? -1
      return pB - pA
    })
    if (deckSort === 'price_asc') return cards.sort((a, b) => {
      const sfA = builderSfMap[getScryfallKey(a)]
      const sfB = builderSfMap[getScryfallKey(b)]
      const pA = getPrice(sfA, a.foil, { price_source }) ?? Infinity
      const pB = getPrice(sfB, b.foil, { price_source }) ?? Infinity
      return pA - pB
    })
    if (deckSort === 'set') return cards.sort((a, b) => {
      const sfA = builderSfMap[getScryfallKey(a)]
      const sfB = builderSfMap[getScryfallKey(b)]
      const sA = sfA?.set_name || a.set_code || ''
      const sB = sfB?.set_name || b.set_code || ''
      return sA.localeCompare(sB) || a.name.localeCompare(b.name)
    })
    if (deckSort === 'rarity_desc' || deckSort === 'rarity') return cards.sort((a, b) => {
      const sfA = builderSfMap[getScryfallKey(a)]
      const sfB = builderSfMap[getScryfallKey(b)]
      const rA = RARITY_ORDER.indexOf(sfA?.rarity || 'common')
      const rB = RARITY_ORDER.indexOf(sfB?.rarity || 'common')
      return rA - rB || a.name.localeCompare(b.name)
    })
    if (deckSort === 'rarity_asc') return cards.sort((a, b) => {
      const sfA = builderSfMap[getScryfallKey(a)]
      const sfB = builderSfMap[getScryfallKey(b)]
      const rA = RARITY_ORDER.indexOf(sfA?.rarity || 'common')
      const rB = RARITY_ORDER.indexOf(sfB?.rarity || 'common')
      return rB - rA || a.name.localeCompare(b.name)
    })
    return visibleDeckCards
  }, [visibleDeckCards, deckSort, builderSfMap, price_source])

  const sortedDeckCategories = useMemo(() => (
    [...deckCategories].sort((a, b) =>
      (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
      String(a.name || '').localeCompare(String(b.name || ''))
    )
  ), [deckCategories])

  const categoryById = useMemo(
    () => new Map(sortedDeckCategories.map(category => [category.id, category])),
    [sortedDeckCategories]
  )

  const getInferredDeckCategory = useCallback((dc) => {
    if (dc.is_commander) return 'Commander'
    const sf = dc.set_code && dc.collector_number ? (builderSfMap[getScryfallKey(dc)] || {}) : {}
    const inferred = getCardCategoryFromCard(dc, sf)
    return inferred && inferred !== 'Other' ? inferred : UNCATEGORIZED
  }, [builderSfMap])

  const getDeckCardCategoryName = useCallback((dc) => {
    if (dc.category_id) {
      const storedName = categoryById.get(dc.category_id)?.name
      if (!storedName) return UNCATEGORIZED
      // When a card is pinned to a type-line fallback category (Instant,
      // Sorcery, etc.) but live inference now lands it in a functional
      // bucket, prefer the inference. Never downgrades a manual functional
      // placement — only rescues fallback pins from a stale regex era.
      if (isTypeFallbackCategory(storedName)) {
        const inferred = getInferredDeckCategory(dc)
        if (inferred && inferred !== 'Other' && !isTypeFallbackCategory(inferred)) {
          return inferred
        }
      }
      return storedName
    }
    return getInferredDeckCategory(dc)
  }, [categoryById, getInferredDeckCategory])

  const categoryOptions = useMemo(() => {
    const byName = new Map()
    for (const category of sortedDeckCategories) byName.set(category.name.toLowerCase(), category)
    for (const dc of deckCards) {
      const name = getDeckCardCategoryName(dc)
      // 'Commander' is a pinned, auto-derived group — never an assignable
      // picker option. (The user can still create a custom deck_categories
      // row with that name, in which case it comes via sortedDeckCategories.)
      if (name === 'Commander') continue
      if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { id: null, name })
    }
    if (!byName.has(UNCATEGORIZED.toLowerCase())) byName.set(UNCATEGORIZED.toLowerCase(), { id: null, name: UNCATEGORIZED })
    return [...byName.values()].sort((a, b) => {
      const ai = a.id ? sortedDeckCategories.findIndex(category => category.id === a.id) : CAT_ORDER.indexOf(a.name)
      const bi = b.id ? sortedDeckCategories.findIndex(category => category.id === b.id) : CAT_ORDER.indexOf(b.name)
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.name.localeCompare(b.name)
    })
  }, [deckCards, getDeckCardCategoryName, sortedDeckCategories])

  // categoryNameOrder is the source-of-truth ordering for moveRenderedCategory's
  // default sourceOrder. Prepend 'Commander' so the auto-pinned group can be
  // reordered correctly when callers omit an explicit groupOrder.
  const categoryNameOrder = useMemo(() => {
    const hasCommander = deckCards.some(dc => dc.is_commander)
    const base = categoryOptions.map(category => category.name)
    return hasCommander && !base.includes('Commander') ? ['Commander', ...base] : base
  }, [categoryOptions, deckCards])

  // Group resolver used by the deck-render IIFE. Hoisted out of the IIFE so
  // it isn't reconstructed on every render and so `getCategoryOrder` below
  // can share the same identity.
  const getDeckCardGroup = useCallback((dc) => {
    const sf = dc.set_code && dc.collector_number ? (builderSfMap[getScryfallKey(dc)] || {}) : {}
    if (groupBy === 'category') {
      if (dc.is_commander && !dc.category_id) return 'Commander'
      if (dc.category_id) {
        const storedName = categoryById.get(dc.category_id)?.name
        if (!storedName) return UNCATEGORIZED
        // Same rescue logic as getDeckCardCategoryName — keep both in sync.
        if (isTypeFallbackCategory(storedName)) {
          const inferred = getCardCategoryFromCard(dc, sf)
          if (inferred && inferred !== 'Other' && !isTypeFallbackCategory(inferred)) {
            return inferred
          }
        }
        return storedName
      }
      const inferred = getCardCategoryFromCard(dc, sf)
      return inferred && inferred !== 'Other' ? inferred : UNCATEGORIZED
    }
    if (groupBy === 'rarity') return sf.rarity || 'common'
    if (groupBy === 'set') return sf.set_name || (dc.set_code ? dc.set_code.toUpperCase() : 'Unknown')
    if (groupBy === 'cmc') return dc.is_commander ? 'Commander' : manaValueGroupKey(dc)
    if (groupBy === 'color') return dc.is_commander ? 'Commander' : colorGroupKey(dc)
    return dc.is_commander ? 'Commander' : classifyCardType(dc.type_line)
  }, [builderSfMap, groupBy, categoryById])

  const getCategoryRow = useCallback(
    (group) => sortedDeckCategories.find(category => category.name === group) || null,
    [sortedDeckCategories]
  )

  const getCategoryOrder = useCallback((cards) => {
    const present = new Set(cards.map(getDeckCardGroup))
    const order = []
    // Track inserted names by lowercased key so two categories that differ
    // only in case (e.g. a user-created "removal" alongside the canonical
    // "Removal") don't both get a header.
    const seen = new Set()
    const push = (name) => {
      const key = String(name).toLowerCase()
      if (seen.has(key)) return
      seen.add(key)
      order.push(name)
    }
    if (present.has('Commander')) push('Commander')
    for (const category of sortedDeckCategories) {
      if (present.has(category.name)) push(category.name)
    }
    for (const category of CAT_ORDER) {
      if (present.has(category)) push(category)
    }
    if (present.has(UNCATEGORIZED)) push(UNCATEGORIZED)
    for (const category of [...present].sort()) push(category)
    return order
  }, [getDeckCardGroup, sortedDeckCategories])

  // Group header order for the current groupBy — shared by the stacks and
  // list/grid renderers so the two views never disagree.
  const getGroupOrder = useCallback((cards) => {
    if (groupBy === 'category') return getCategoryOrder(cards)
    if (groupBy === 'rarity')   return RARITY_ORDER.filter(r => cards.some(dc => getDeckCardGroup(dc) === r))
    if (groupBy === 'set')      return [...new Set(cards.map(getDeckCardGroup))].sort()
    if (groupBy === 'cmc')      return ['Commander', ...MANA_VALUE_GROUP_ORDER].filter(g => cards.some(dc => getDeckCardGroup(dc) === g))
    if (groupBy === 'color')    return ['Commander', ...COLOR_GROUP_ORDER].filter(g => cards.some(dc => getDeckCardGroup(dc) === g))
    return TYPE_GROUPS
  }, [groupBy, getCategoryOrder, getDeckCardGroup])

  // De-dupes concurrent createDeckCategory calls for the same (deckId, lowercased name)
  // so two parallel addCardToDeck() invocations don't both insert "Removal".
  const categoryCreationCacheRef = useRef(new Map())

  async function ensureDeckCategoryForName(name) {
    const trimmed = String(name || '').trim()
    if (!trimmed || trimmed === UNCATEGORIZED) return null
    const key = `${deckId}|${trimmed.toLowerCase()}`
    const existing = deckCategoriesRef.current.find(category => category.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) return existing
    const inflight = categoryCreationCacheRef.current.get(key)
    if (inflight) return inflight
    const nextOrder = deckCategoriesRef.current.reduce((max, category) => Math.max(max, category.sort_order ?? 0), -1) + 1
    const promise = (async () => {
      try {
        const created = await createDeckCategory(deckId, user.id, trimmed, nextOrder)
        // Re-check after await — another caller may have raced through earlier steps
        const stillMissing = !deckCategoriesRef.current.find(category => category.id === created.id)
        if (stillMissing) {
          deckCategoriesRef.current = [...deckCategoriesRef.current, created]
          setDeckCategories(deckCategoriesRef.current)
        }
        return created
      } finally {
        categoryCreationCacheRef.current.delete(key)
      }
    })()
    categoryCreationCacheRef.current.set(key, promise)
    return promise
  }

  async function addCustomCategory() {
    const name = await promptAsync({ title: 'New Category', placeholder: 'Category name', submitLabel: 'Add' })
    if (!name?.trim()) return
    await ensureDeckCategoryForName(name)
    setGroupBy('category')
  }

  async function renameCustomCategory(category) {
    const name = await promptAsync({ title: 'Rename Category', placeholder: 'Category name', initialValue: category.name, submitLabel: 'Save' })
    if (!name?.trim() || name.trim() === category.name) return
    const renamed = await renameDeckCategory(category.id, name)
    setDeckCategories(prev => prev.map(row => row.id === category.id ? renamed : row))
  }

  async function removeCustomCategory(category) {
    const ok = await confirmAsync(`Delete category "${category.name}"? Cards stay in the deck and fall back to inferred categories.`)
    if (!ok) return
    await deleteDeckCategory(category.id)
    setDeckCategories(prev => prev.filter(row => row.id !== category.id))
    deckCardsRef.current = deckCardsRef.current.map(dc => dc.category_id === category.id ? { ...dc, category_id: null } : dc)
    setDeckCards(deckCardsRef.current)
  }

  async function ensureDeckCategoriesForOrder(names) {
    const uniqueNames = [...new Set((names || []).map(name => String(name || '').trim()).filter(Boolean))]
    const byName = new Map(deckCategoriesRef.current.map(category => [category.name.toLowerCase(), category]))
    const nextRows = []

    for (let index = 0; index < uniqueNames.length; index += 1) {
      const name = uniqueNames[index]
      const key = name.toLowerCase()
      const existing = byName.get(key)
      if (existing) {
        nextRows.push({ ...existing, sort_order: index })
        continue
      }
      const created = await createDeckCategory(deckId, user.id, name, index)
      byName.set(key, created)
      nextRows.push({ ...created, sort_order: index })
    }

    const existingNotShown = deckCategoriesRef.current
      .filter(category => !uniqueNames.some(name => name.toLowerCase() === category.name.toLowerCase()))
      .map((category, offset) => ({ ...category, sort_order: uniqueNames.length + offset }))
    const ordered = [...nextRows, ...existingNotShown]
    deckCategoriesRef.current = ordered
    setDeckCategories(ordered)
    await updateDeckCategoryOrder(ordered.map((row, index) => ({ ...row, sort_order: index })))
    return ordered
  }

  async function moveRenderedCategory(groupName, direction, sourceOrder = categoryNameOrder) {
    const order = [...new Set(sourceOrder)]
    const idx = order.indexOf(groupName)
    const swapIdx = direction === 'left' || direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || swapIdx < 0 || swapIdx >= order.length) return
    const next = [...order]
    ;[next[idx], next[swapIdx]] = [next[swapIdx], next[idx]]
    await ensureDeckCategoriesForOrder(next)
  }

  async function moveRenderedCategoryTo(groupName, targetName, sourceOrder = categoryNameOrder) {
    if (!groupName || !targetName || groupName === targetName) return
    const order = [...new Set(sourceOrder)]
    const fromIdx = order.indexOf(groupName)
    const toIdx = order.indexOf(targetName)
    if (fromIdx < 0 || toIdx < 0) return
    const next = [...order]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    await ensureDeckCategoriesForOrder(next)
  }

  async function resetAllCategories() {
    const ok = await confirmAsync('Reset all deck categories? This clears manual card assignments and removes all custom category columns.')
    if (!ok) return
    await resetDeckCategories(deckId)
    deckCategoriesRef.current = []
    setDeckCategories([])
    deckCardsRef.current = deckCardsRef.current.map(dc => ({ ...dc, category_id: null }))
    setDeckCards(deckCardsRef.current)
    putDeckCards(deckCardsRef.current).catch(() => {})
    setCollapsedGroups(new Set())
  }

  async function moveDeckCardToCategory(deckCardId, category) {
    const target = category?.id ? category : await ensureDeckCategoryForName(category?.name)
    const categoryId = category?.name === UNCATEGORIZED ? null : (target?.id || null)
    deckCardsRef.current = deckCardsRef.current.map(dc => dc.id === deckCardId ? { ...dc, category_id: categoryId } : dc)
    setDeckCards(deckCardsRef.current)
    await setDeckCardCategory(deckCardId, categoryId)
    putDeckCards(deckCardsRef.current.filter(dc => dc.id === deckCardId)).catch(() => {})
  }

  async function clearDeckCardCategory(deckCardId) {
    deckCardsRef.current = deckCardsRef.current.map(dc => dc.id === deckCardId ? { ...dc, category_id: null } : dc)
    setDeckCards(deckCardsRef.current)
    await setDeckCardCategory(deckCardId, null)
    putDeckCards(deckCardsRef.current.filter(dc => dc.id === deckCardId)).catch(() => {})
  }

  function getScrollableDragTarget(x, y, axis) {
    const elements = document.elementsFromPoint(x, y)
    for (const el of elements) {
      if (!el || el === document.body || el === document.documentElement) continue
      const style = window.getComputedStyle(el)
      const overflow = axis === 'x' ? style.overflowX : style.overflowY
      const canScroll = axis === 'x'
        ? el.scrollWidth > el.clientWidth
        : el.scrollHeight > el.clientHeight
      if (canScroll && /(auto|scroll)/.test(overflow)) return el
    }
    return document.scrollingElement || document.documentElement
  }

  function applyDragAutoScroll() {
    dragAutoScrollFrame.current = null
    if (!dragAutoScrollActive.current) return

    const { x, y } = dragAutoScrollPoint.current
    const edge = 72
    const maxStep = 26
    const calcStep = (distance) => Math.ceil(((edge - distance) / edge) * maxStep)
    const xTarget = getScrollableDragTarget(x, y, 'x')
    const yTarget = getScrollableDragTarget(x, y, 'y')

    const xRect = xTarget === document.scrollingElement || xTarget === document.documentElement
      ? { left: 0, right: window.innerWidth }
      : xTarget.getBoundingClientRect()
    const yRect = yTarget === document.scrollingElement || yTarget === document.documentElement
      ? { top: 0, bottom: window.innerHeight }
      : yTarget.getBoundingClientRect()

    let dx = 0
    let dy = 0
    if (x - xRect.left < edge) dx = -calcStep(Math.max(0, x - xRect.left))
    else if (xRect.right - x < edge) dx = calcStep(Math.max(0, xRect.right - x))
    if (y - yRect.top < edge) dy = -calcStep(Math.max(0, y - yRect.top))
    else if (yRect.bottom - y < edge) dy = calcStep(Math.max(0, yRect.bottom - y))

    if (dx) xTarget.scrollLeft += dx
    if (dy) yTarget.scrollTop += dy
    if (dx || dy) dragAutoScrollFrame.current = requestAnimationFrame(applyDragAutoScroll)
  }

  function startDragAutoScroll(event) {
    dragAutoScrollActive.current = true
    if (event) dragAutoScrollPoint.current = { x: event.clientX, y: event.clientY }
  }

  function stopDragAutoScroll() {
    dragAutoScrollActive.current = false
    setDraggedCategoryId(null)
    if (dragAutoScrollFrame.current) cancelAnimationFrame(dragAutoScrollFrame.current)
    dragAutoScrollFrame.current = null
  }

  useEffect(() => {
    const onDragOver = (event) => {
      if (!dragAutoScrollActive.current) return
      dragAutoScrollPoint.current = { x: event.clientX, y: event.clientY }
      if (!dragAutoScrollFrame.current) {
        dragAutoScrollFrame.current = requestAnimationFrame(applyDragAutoScroll)
      }
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragend', stopDragAutoScroll)
    document.addEventListener('drop', stopDragAutoScroll)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragend', stopDragAutoScroll)
      document.removeEventListener('drop', stopDragAutoScroll)
    }
  }, [])

  function handleCardDragStart(dc, event) {
    startDragAutoScroll(event)
    event.dataTransfer.setData('text/plain', dc.id)
    event.dataTransfer.setData('application/x-deck-card-id', dc.id)
    event.dataTransfer.effectAllowed = 'move'
  }

  function handleCategoryDrop(group, event) {
    event.preventDefault()
    const categoryDragName = event.dataTransfer.getData('application/x-deck-category-name')
    if (categoryDragName) return
    const deckCardId = event.dataTransfer.getData('application/x-deck-card-id') || event.dataTransfer.getData('text/plain')
    if (!deckCardId) return
    moveDeckCardToCategory(deckCardId, { name: group }).catch(error => console.error('[DeckBuilder] move category failed:', error))
  }

  // Shared DeckCategoryHeader handlers — toggle a group's collapsed state,
  // start a header drag, and apply a header drop. The drag-data wiring
  // (setData / getData of the category name) lives inside DeckCategoryHeader.
  const toggleGroupCollapsed = useCallback((key) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }, [])

  const onCategoryHeaderDragStart = useCallback((e, group) => {
    startDragAutoScroll(e)
    setDraggedCategoryId(group)
  }, [startDragAutoScroll])

  const onCategoryHeaderDrop = useCallback((fromName, toGroup, groupOrder) => {
    moveRenderedCategoryTo(fromName, toGroup, groupOrder)
    setDraggedCategoryId(null)
  }, [moveRenderedCategoryTo])

  // Combined image map: deck cards + rec images (for combo thumbnails)
  const deckImagesMap = useMemo(() => {
    const map = { ...recImages }
    for (const dc of deckCards) if (dc.image_uri) map[dc.name] = dc.image_uri
    return map
  }, [deckCards, recImages])

  const deckNameSet = useMemo(() => new Set(deckCards.map(dc => dc.name.toLowerCase())), [deckCards])
  const visualCardMinWidth = useMemo(() => {
    const densityMap = {
      cozy: 170,
      comfortable: 136,
      compact: 112,
    }
    return densityMap[grid_density] || densityMap.comfortable
  }, [grid_density])

  const recCategoriesFiltered = useMemo(() => {
    if (!recs?.categories) return []
    const formatId = format?.id || 'commander'
    // Brawl EDHRec endpoint is deprecated — always enforce legality for Brawl and Standard Brawl
    const enforceLegality = formatId !== 'commander'
    return recs.categories.map(c => ({
      ...c,
      cards: c.cards.filter(r => {
        if (deckNameSet.has(r.name.toLowerCase())) return false
        if (recsOwnedOnly && (ownedNameMap.get(r.name.toLowerCase()) ?? 0) === 0) return false
        if (enforceLegality) {
          const leg = recLegalities[r.name]
          if (!leg) return false
          const status = leg[formatId]
          if (status !== 'legal' && status !== 'restricted') return false
        }
        return true
      }),
    })).filter(c => c.cards.length > 0)
  }, [recs, deckNameSet, recsOwnedOnly, ownedNameMap, format, recLegalities])

  // ── Format change ─────────────────────────────────────────────────────────
  async function handleFormatChange(fmtId) {
    const baseMeta = deckMetaRef.current || deckMeta
    const newMeta = { ...deckMeta, format: fmtId }
    if (!FORMATS.find(f => f.id === fmtId)?.isEDH) {
      delete newMeta.commanderName
      delete newMeta.commanderScryfallId
      delete newMeta.commanderColorIdentity
      delete newMeta.coverArtUri
      delete newMeta.partnerName
      delete newMeta.partnerScryfallId
      delete newMeta.commanders
      delete newMeta.bracket
      delete newMeta.bracketManual
      setStatsBracketOverride(null)
    }
    applyLocalDeckMeta(newMeta)
    await saveMeta(newMeta, baseMeta)
  }

  // ── Save helpers ──────────────────────────────────────────────────────────
  function withPersistentMetaFields(meta, base = deckMetaRef.current) {
    const next = { ...(meta || {}) }
    if (base?.sync_state) next.sync_state = base.sync_state
    if (next.linked_deck_id == null && base?.linked_deck_id) next.linked_deck_id = base.linked_deck_id
    if (next.linked_builder_id == null && base?.linked_builder_id) next.linked_builder_id = base.linked_builder_id
    return next
  }

  function applyLocalDeckMeta(meta) {
    const next = meta || {}
    deckMetaRef.current = next
    setDeckMeta(next)
    setDeck(prev => prev ? { ...prev, description: serializeDeckMeta(next) } : prev)
    return next
  }

  async function persistMetaNow(nextMeta, baseMeta = deckMetaRef.current) {
    clearTimeout(saveMetaTimer.current)
    const next = withPersistentMetaFields(nextMeta, baseMeta)
    const persisted = await patchDeckMeta(deckId, baseMeta || {}, next)
    return applyLocalDeckMeta(persisted)
  }

  async function saveMeta(meta, baseMeta = deckMetaRef.current || {}) {
    clearTimeout(saveMetaTimer.current)
    const nextMeta = withPersistentMetaFields(meta, baseMeta)
    saveMetaTimer.current = setTimeout(async () => {
      try {
        const persisted = await patchDeckMeta(deckId, baseMeta, nextMeta)
        applyLocalDeckMeta(persisted)
      } catch (err) {
        console.error('[DeckBuilder] save meta failed:', err)
        showToast('Save deck info failed', { tone: 'error' })
      }
    }, 600)
  }

  function applyAndSaveMeta(nextMeta) {
    const baseMeta = deckMetaRef.current || {}
    applyLocalDeckMeta(nextMeta)
    return saveMeta(nextMeta, baseMeta)
  }

  useEffect(() => {
    if (!deckId || !deck || isCollectionDeck || isEDH) return
    const coverArtUri = getNonCommanderDeckCoverArt(mainDeckCards, builderSfMap, price_source)
    if (!coverArtUri) return
    const currentMeta = deckMetaRef.current || {}
    if (coverArtUri === currentMeta.coverArtUri) return
    const nextMeta = { ...currentMeta, coverArtUri }
    applyAndSaveMeta(nextMeta)
    // Intentionally exclude `deckMeta` — we read latest via deckMetaRef to avoid
    // a feedback loop where setDeckMeta retriggers this effect.
  }, [builderSfMap, deck, deckId, isCollectionDeck, isEDH, mainDeckCards, price_source])

  function saveDescription(val) {
    const newMeta = { ...deckMeta, deckDescription: val }
    applyAndSaveMeta(newMeta)
  }

  function addTag(raw) {
    const tag = raw.trim().slice(0, 30)
    if (!tag || cmdTags.includes(tag) || cmdTags.length >= 20) return
    const next = [...cmdTags, tag]
    setCmdTags(next)
    setNewTagInput('')
    const newMeta = { ...deckMeta, tags: next }
    applyAndSaveMeta(newMeta)
  }

  function removeTag(tag) {
    const next = cmdTags.filter(t => t !== tag)
    setCmdTags(next)
    const newMeta = { ...deckMeta, tags: next }
    applyAndSaveMeta(newMeta)
  }

  async function saveNameBlur() {
    if (!deckName.trim()) return
    setSaving(true)
    try {
      await sbExec(sb.from('folders').update({ name: deckName.trim() }).eq('id', deckId), { label: 'Rename failed' })
    } catch {} finally {
      setSaving(false)
    }
  }

  async function setVisibility(nextPublic) {
    const previousMeta = deckMetaRef.current || deckMeta
    const previous = !!previousMeta.is_public
    if (nextPublic === previous) return
    clearTimeout(saveMetaTimer.current)
    const newMeta = { ...previousMeta, is_public: nextPublic }
    applyLocalDeckMeta(newMeta)
    try {
      const result = await setLinkedDeckVisibility(deckId, nextPublic)
      applyLocalDeckMeta(result?.deck_meta || newMeta)
      logDeckChange(deckId, user?.id, 'Visibility', nextPublic ? 'Made public' : 'Made private')
    } catch (err) {
      applyLocalDeckMeta(previousMeta)
      showToast(`Toggle public failed: ${err?.message || 'unknown error'}`, { tone: 'error' })
      throw err
    }
  }

  async function togglePublic() {
    await setVisibility(!deckMeta.is_public)
  }

  async function loadDeckGameResults() {
    if (deckGameResultsLoaded || !deckId || !user?.id) return
    setDeckGameResultsLoading(true)
    try {
      const { data } = await sb.from('game_results')
        .select('id,placement,played_at,player_count,format')
        .eq('user_id', user.id)
        .eq('deck_id', deckId)
        .order('played_at', { ascending: false })
        .limit(200)
      setDeckGameResults(data || [])
      setDeckGameResultsLoaded(true)
    } catch {
      setDeckGameResults([])
    } finally {
      setDeckGameResultsLoading(false)
    }
  }

  // ── Commander pick ────────────────────────────────────────────────────────
  // Search state lives in useCommanderSearch(); this handler applies the pick
  // to the deck (mutates deck_cards + folder description meta).
  async function pickCommander(sfCard) {
    closeCmdPicker()
    const baseMeta = deckMetaRef.current || deckMeta

    // The commander search returns whichever single print Scryfall considers
    // canonical (unique=cards), which can be an art-series/special printing.
    // Resolve the actual print the same way the normal card search does:
    // owned binder copy first, then owned deck copy, then newest paper print.
    let resolved = null
    try {
      resolved = await resolvePreferredDeckPrinting(sfCard.name, sfCard)
    } catch (err) {
      console.warn('[DeckBuilder] commander printing resolution failed:', err)
    }
    const cmdCard = resolved?.sfCard || sfCard
    const cmdFoil = !!resolved?.foil

    const newMeta = {
      ...deckMeta,
      commanderName: cmdCard.name,
      commanderScryfallId: cmdCard.id,
      coverArtUri: getCardImageUri(cmdCard, 'art_crop'),
      commanderColorIdentity: cmdCard.color_identity,
    }
    applyLocalDeckMeta(newMeta)

    // Remove any existing commander — use ref to avoid stale closure
    const existingCmd = deckCardsRef.current.find(dc => dc.is_commander)
    if (existingCmd) {
      await removeCardFromDeck(existingCmd.id)
    }

    // Build commander deck card — getDeckBuilderCardMeta like every other add
    // path ('normal' image, primary-face fields). The hand-rolled version this
    // replaces stored the 'art_crop' image, rendering the commander as an art
    // card in the deck list; 'art_crop' is only for the deck cover above.
    const cmdRow = {
      id:           crypto.randomUUID(),
      deck_id:      deckId,
      user_id:      user.id,
      name:         cmdCard.name,
      ...getDeckBuilderCardMeta(cmdCard),
      qty:          1,
      foil:         cmdFoil,
      is_commander: true,
      board:        'main',
      card_print_id: resolved?.card_print_id || undefined,
      created_at:   new Date().toISOString(),
      updated_at:   new Date().toISOString(),
    }

    // Update state and persist — read ref again for current non-commander cards
    const nonCmdCards = deckCardsRef.current.filter(dc => !dc.is_commander)
    // deck_cards.card_print_id is NOT NULL; hydrate any rows missing it (cmdRow,
    // and nonCmdCards loaded from a folder_cards fallback) before the upsert.
    const allRows = [cmdRow, ...nonCmdCards]
    const hydratedRows = await requireCardPrintIds(allRows, 'Commander deck card')
    const hydratedCmdRow = hydratedRows[0]
    const hydratedNonCmd = hydratedRows.slice(1)
    setDeckCards([hydratedCmdRow, ...hydratedNonCmd])
    // Upsert all rows: this handles collection decks where non-commander cards came from the
    // folder_cards fallback and were never saved to deck_cards in Supabase. Without this,
    // a reload after picking a commander would show only 1 card (just the commander).
    try {
      await sbExec(sb.from('deck_cards').upsert(hydratedRows.map(toDeckCardRow), { onConflict: 'id' }), { label: 'Save commander deck failed' })
      putDeckCards(hydratedRows).catch(() => {})
    } catch { return }

    // Save meta immediately (not debounced) so navigation away won't lose the commander
    clearTimeout(saveMetaTimer.current)
    try {
      await persistMetaNow(newMeta, baseMeta)
      logDeckChange(deckId, user?.id, 'Commander', `Set to ${cmdCard.name}`)
    } catch {}
  }

  // ── Companion ───────────────────────────────────────────────────────────────
  function setCompanion(sfCard) {
    closeCompPicker()
    const companion = {
      name:           sfCard.name,
      scryfall_id:    sfCard.id,
      color_identity: sfCard.color_identity || [],
      image_uri:      getCardImageUri(sfCard, 'normal'),
      type_line:      sfCard.type_line || sfCard.card_faces?.[0]?.type_line || '',
      mana_cost:      sfCard.mana_cost || sfCard.card_faces?.[0]?.mana_cost || '',
      cmc:            sfCard.cmc ?? 0,
      oracle_text:    getCommanderOracle(sfCard),
      keywords:       sfCard.keywords || [],
    }
    const newMeta = { ...deckMeta, companion }
    applyAndSaveMeta(newMeta)
    logDeckChange(deckId, user?.id, 'Companion', `Set to ${companion.name}`)
  }

  function clearCompanion() {
    const newMeta = { ...deckMeta }
    delete newMeta.companion
    applyAndSaveMeta(newMeta)
  }

  // ── Card search ───────────────────────────────────────────────────────────
  // Search state + debounced fetch live in useCardSearch(); page only renders.

  async function fetchPrintingsForDeckCardName(name) {
    if (!name) return []
    const key = normalizeCardName(name)
    if (printingLookupCache.current.has(key)) return printingLookupCache.current.get(key)
    // Source from our own card_prints/card_prices catalog first (no Scryfall
    // rate limit); only fall back to a live Scryfall search if we have no rows.
    let printings = []
    try { printings = await fetchPaperPrintingsFromDb(name) } catch { printings = [] }
    if (!printings.length) {
      try { printings = await fetchPaperPrintings(name) } catch { printings = [] }
    }
    printingLookupCache.current.set(key, printings)
    return printings
  }

  function candidatesFromPlacementSnapshot(snapshot, cardName) {
    const target = normalizeCardName(cardName)
    return (snapshot?.cards || [])
      .filter(row => normalizeCardName(row.name) === target)
      .map(row => ({
        ...row,
        binderQty: snapshot.binderQtyByCardId.get(row.id) || 0,
        deckQty: snapshot.deckQtyByCardId.get(row.id) || 0,
      }))
  }

  async function fetchOwnedPrintingCandidates(cardName) {
    if (!cardName || !user?.id) return []

    const key = normalizeCardName(cardName)
    if (ownedPrintingCandidatesCache.current.has(key)) {
      return ownedPrintingCandidatesCache.current.get(key)
    }

    const localSnapshot = await loadLocalPlacementSnapshot(user.id, { names: [cardName] })
    const localCandidates = candidatesFromPlacementSnapshot(localSnapshot, cardName)
    ownedPrintingCandidatesCache.current.set(key, localCandidates)

    if (!ownedPrintingRefreshPromises.current.has(key)) {
      const promise = refreshRemotePlacementSnapshot(user.id, { names: [cardName] })
        .then(snapshot => {
          const remoteCandidates = candidatesFromPlacementSnapshot(snapshot, cardName)
          ownedPrintingCandidatesCache.current.set(key, remoteCandidates)
          return remoteCandidates
        })
        .catch(err => {
          console.warn('[DeckBuilder] owned printing refresh failed:', err)
          return localCandidates
        })
        .finally(() => ownedPrintingRefreshPromises.current.delete(key))
      ownedPrintingRefreshPromises.current.set(key, promise)
    }

    return localCandidates
  }

  function pickOwnedPrintingCandidate(candidates, printRank, placement) {
    return [...candidates]
      .filter(row => (placement === 'binder' ? row.binderQty : row.deckQty) > 0)
      .sort((a, b) => {
        const rankA = printRank.get(a.scryfall_id) ?? printRank.get(normalizePrintKey(a)) ?? Number.MAX_SAFE_INTEGER
        const rankB = printRank.get(b.scryfall_id) ?? printRank.get(normalizePrintKey(b)) ?? Number.MAX_SAFE_INTEGER
        if (rankA !== rankB) return rankA - rankB
        const qtyA = placement === 'binder' ? a.binderQty : a.deckQty
        const qtyB = placement === 'binder' ? b.binderQty : b.deckQty
        if (qtyA !== qtyB) return qtyB - qtyA
        return Number(!!a.foil) - Number(!!b.foil)
      })[0] || null
  }

  async function resolvePreferredDeckPrinting(cardName, fallbackSfCard) {
    const printings = await fetchPrintingsForDeckCardName(cardName)
    const printById = new Map(printings.map(print => [print.id, print]))
    const printByKey = new Map(printings.map(print => [normalizePrintKey(print), print]).filter(([key]) => key))
    const printRank = new Map()
    printings.forEach((print, index) => {
      printRank.set(print.id, index)
      const key = normalizePrintKey(print)
      if (key && !printRank.has(key)) printRank.set(key, index)
    })

    let ownedCandidates = []
    try {
      ownedCandidates = await fetchOwnedPrintingCandidates(cardName)
    } catch (err) {
      console.warn('[DeckBuilder] preferred owned printing lookup failed:', err)
    }

    const binderPick = pickOwnedPrintingCandidate(ownedCandidates, printRank, 'binder')
    const deckPick = !binderPick ? pickOwnedPrintingCandidate(ownedCandidates, printRank, 'deck') : null
    const ownedPick = binderPick || deckPick
    if (ownedPick) {
      const sfCard = printById.get(ownedPick.scryfall_id) || printByKey.get(normalizePrintKey(ownedPick))
      if (sfCard) return { sfCard, foil: !!ownedPick.foil, card_print_id: ownedPick.card_print_id || null }
      if (ownedPick.scryfall_id) {
        const [fetched] = await fetchCardsByScryfallIds([ownedPick.scryfall_id])
        if (fetched) return { sfCard: fetched, foil: !!ownedPick.foil, card_print_id: ownedPick.card_print_id || null }
      }
    }

    // Automatic choices prefer English artwork. An exact owned printing is
    // resolved above and remains untouched, including foreign-language copies.
    const newest = pickAutomaticDeckPrinting(printings, fallbackSfCard)
    return newest ? { sfCard: newest, foil: defaultFoilForPrinting(newest), card_print_id: null } : null
  }

  function isSameDeckPrinting(a, b) {
    if (!!a.foil !== !!b.foil) return false
    if (normalizeBoard(a.board) !== normalizeBoard(b.board)) return false
    if (a.card_print_id && b.card_print_id) return a.card_print_id === b.card_print_id
    if (a.scryfall_id && b.scryfall_id) return a.scryfall_id === b.scryfall_id
    const aKey = normalizePrintKey(a)
    const bKey = normalizePrintKey(b)
    return !!aKey && aKey === bKey
  }

  async function applyResolvedPrintingToDeckRow(placeholderRow, resolved) {
    if (!resolved?.sfCard) return
    if (!deckCardsRef.current.some(dc => dc.id === placeholderRow.id)) return
    const meta = getDeckBuilderCardMeta(resolved.sfCard)
    const now = new Date().toISOString()
    const [printing] = await requireCardPrintIds([{
      card_print_id:    resolved.card_print_id || null,
      scryfall_id:      meta.scryfall_id,
      name:             resolved.sfCard.name || placeholderRow.name,
      set_code:         meta.set_code,
      collector_number: meta.collector_number,
      type_line:        meta.type_line,
      mana_cost:        meta.mana_cost,
      cmc:              meta.cmc,
      color_identity:   meta.color_identity,
      image_uri:        meta.image_uri,
      foil:             !!resolved.foil,
    }], 'Deck card printing')

    const inferredCategory = getCardCategoryFromCard({ type_line: meta.type_line }, resolved.sfCard)
    // Only persist a category when the regex landed on a functional bucket.
    // Type-line fallbacks (Instant/Sorcery/etc.) are left as null so the
    // auto-upgrade pass on next load can re-infer them when the regex improves.
    const shouldPersistCategory =
      inferredCategory && inferredCategory !== 'Other' && !isTypeFallbackCategory(inferredCategory)
    const initialCategory = shouldPersistCategory ? await ensureDeckCategoryForName(inferredCategory) : null
    const nextRow = { ...placeholderRow, ...printing, category_id: initialCategory?.id || null, foil: !!resolved.foil, updated_at: now }
    const existing = deckCardsRef.current.find(dc => dc.id !== placeholderRow.id && isSameDeckPrinting(dc, nextRow))

    if (existing) {
      const updatedExisting = { ...existing, qty: (existing.qty || 0) + (placeholderRow.qty || 1), updated_at: now }
      deckCardsRef.current = deckCardsRef.current
        .filter(dc => dc.id !== placeholderRow.id)
        .map(dc => dc.id === existing.id ? updatedExisting : dc)
      setDeckCards(deckCardsRef.current)
      try {
        await sbExec(sb.from('deck_cards').update({ qty: updatedExisting.qty, updated_at: now }).eq('id', existing.id), { label: 'Add card failed' })
        putDeckCards([updatedExisting]).catch(() => {})
        deleteDeckCardLocal(placeholderRow.id).catch(() => {})
      } catch {}
      return
    }

    deckCardsRef.current = deckCardsRef.current.map(dc => dc.id === placeholderRow.id ? nextRow : dc)
    setDeckCards(deckCardsRef.current)
    try {
      await sbExec(sb.from('deck_cards').insert(toDeckCardRow(nextRow)), { label: 'Add card failed' })
      putDeckCards([nextRow]).catch(() => {})
    } catch {}
  }

  // ── Optimize printings ──────────────────────────────────────────────────────
  // Bulk-set every deck card to a target printing (cheapest/expensive/oldest/
  // newest) or finish (foil/nonfoil). Printing modes fetch all paper printings
  // per unique card name (cached). Collisions on (card_print_id, foil, board)
  // are merged by summing qty.
  async function optimizePrintings(mode) {
    if (optimizeBusy) return
    setOptimizeBusy(mode)
    try {
      const cards = deckCardsRef.current.slice()
      const now = new Date().toISOString()
      const applied = [] // changed rows (full deck-card shape)

      if (mode === 'foil' || mode === 'nonfoil') {
        const targetFoil = mode === 'foil'
        for (const dc of cards) {
          if (!!dc.foil !== targetFoil) applied.push({ ...dc, foil: targetFoil, updated_at: now })
        }
      } else {
        const names = [...new Set(cards.map(dc => dc.name).filter(Boolean))]
        // One batched DB read for the whole deck (card_prints + card_prices) —
        // no per-card Scryfall search. Names missing from the catalog fall back
        // to a single live Scryfall lookup each (rare).
        const printsByName = {}
        let dbMap = new Map()
        try { dbMap = await fetchPaperPrintingsByNamesFromDb(names) } catch { dbMap = new Map() }
        const missing = []
        for (const name of names) {
          const rows = dbMap.get(name) || []
          if (rows.length) { printsByName[name] = rows; printingLookupCache.current.set(normalizeCardName(name), rows) }
          else missing.push(name)
        }
        for (const name of missing) {
          try { printsByName[name] = await fetchPrintingsForDeckCardName(name) }
          catch { printsByName[name] = [] }
        }
        const pending = []
        for (const dc of cards) {
          const chosen = pickPrintingForMode(printsByName[dc.name], mode, { foil: !!dc.foil, priceSource: price_source })
          if (!chosen) continue
          const meta = getDeckBuilderCardMeta(chosen)
          if (!meta.scryfall_id || meta.scryfall_id === dc.scryfall_id) continue // already this print
          pending.push({ dc, meta })
        }
        if (pending.length) {
          const hydrated = await requireCardPrintIds(pending.map(({ dc, meta }) => ({
            card_print_id: null, scryfall_id: meta.scryfall_id, name: dc.name,
            set_code: meta.set_code, collector_number: meta.collector_number,
            type_line: meta.type_line, mana_cost: meta.mana_cost, cmc: meta.cmc,
            color_identity: meta.color_identity, image_uri: meta.image_uri, foil: dc.foil,
          }), 'Optimize printing'))
          pending.forEach(({ dc, meta }, i) => {
            applied.push({
              ...dc,
              card_print_id: hydrated[i].card_print_id,
              scryfall_id: meta.scryfall_id,
              set_code: meta.set_code,
              collector_number: meta.collector_number,
              image_uri: meta.image_uri,
              updated_at: now,
            })
          })
        }
      }

      if (!applied.length) {
        showToast('No changes — printings already match.', { tone: 'info' })
        return
      }

      // Build final deck state, then merge rows that now share
      // (card_print_id, foil, board).
      const byId = new Map(cards.map(dc => [dc.id, dc]))
      for (const row of applied) byId.set(row.id, row)
      const keyOf = r => `${r.card_print_id}|${r.foil ? 1 : 0}|${normalizeBoard(r.board)}`
      const mergedByKey = new Map()
      const deletedIds = []
      for (const r of byId.values()) {
        const k = keyOf(r)
        const ex = mergedByKey.get(k)
        if (ex) { ex.qty = (ex.qty || 0) + (r.qty || 0); deletedIds.push(r.id) }
        else mergedByKey.set(k, { ...r })
      }
      const keptRows = [...mergedByKey.values()]

      const origById = new Map(cards.map(dc => [dc.id, dc]))
      const touched = keptRows.filter(r => {
        const o = origById.get(r.id)
        return !o || o.card_print_id !== r.card_print_id || !!o.foil !== !!r.foil ||
          (o.qty || 0) !== (r.qty || 0) || o.scryfall_id !== r.scryfall_id
      })

      deckCardsRef.current = keptRows
      setDeckCards(keptRows)
      try {
        if (touched.length) {
          await sbExec(sb.from('deck_cards').upsert(touched.map(toDeckCardRow), { onConflict: 'id' }), { label: 'Optimize printings failed' })
          putDeckCards(touched).catch(() => {})
        }
        if (deletedIds.length) {
          await sbExec(sb.from('deck_cards').delete().in('id', deletedIds), { label: 'Optimize printings failed' })
          await Promise.all(deletedIds.map(id => deleteDeckCardLocal(id).catch(() => {})))
        }
      } catch { return }

      const label = PRINTING_MODES.find(m => m.id === mode)?.label || 'Optimized'
      showToast(`${label}: updated ${touched.length} card${touched.length === 1 ? '' : 's'}.`)
      logDeckChange(deckId, user?.id, 'Printings', `${label} · ${touched.length} card${touched.length === 1 ? '' : 's'}`)
      setShowOptimize(false)
    } finally {
      setOptimizeBusy(null)
    }
  }

  async function openHistory() {
    setShowHistory(true)
    setHistory(null)
    try { setHistory(await fetchDeckHistory(deckId)) }
    catch { setHistory([]) }
  }

  // ── Add / remove / qty ────────────────────────────────────────────────────
  async function addCardToDeck(sfCardOrRec) {
    // Determine if it's a full Scryfall card or an EDHRec rec object
    const isSfCard = !!sfCardOrRec.set
    let name, scryfallId, setCode, collNum, typeLine, manaCost, cmc, colorId, imageUri

    if (isSfCard) {
      const meta = getDeckBuilderCardMeta(sfCardOrRec)
      name       = sfCardOrRec.name
      scryfallId = meta.scryfall_id
      setCode    = meta.set_code
      collNum    = meta.collector_number
      typeLine   = meta.type_line
      manaCost   = meta.mana_cost
      cmc        = meta.cmc
      colorId    = meta.color_identity
      imageUri   = meta.image_uri
    } else {
      // EDHRec/assistant rec — resolve from the shared Supabase dictionary.
      name       = sfCardOrRec.name
      scryfallId = null
      setCode    = null
      collNum    = null
      typeLine   = sfCardOrRec.type
      cmc        = sfCardOrRec.cmc
      colorId    = sfCardOrRec.colorIdentity
      imageUri   = recImages[name] || null

      // Reuse the Recommendations-tab batch when available; assistant/combo
      // additions resolve one name through the same bounded database RPC.
      try {
        const full = recCards[name] || (await fetchRecommendationMetadataByNames([name]))[0]
        if (full) {
          const meta = getDeckBuilderCardMeta(full)
          scryfallId = meta.scryfall_id
          setCode    = meta.set_code
          collNum    = meta.collector_number
          typeLine   = meta.type_line
          manaCost   = meta.mana_cost
          cmc        = meta.cmc
          colorId    = meta.color_identity
          imageUri   = meta.image_uri
        }
      } catch {}
    }

    const flashAddFeedback = (cardName, scryfallId, qtyAdded = 1) => {
      const key = scryfallId || cardName
      const prev = addFeedbackRef.current
      const next = prev?.key === key
        ? { key, name: cardName, count: (prev.count || 0) + qtyAdded }
        : { key, name: cardName, count: qtyAdded }
      addFeedbackRef.current = next
      setAddFeedback(next)
      if (addFeedbackTimer.current) clearTimeout(addFeedbackTimer.current)
      addFeedbackTimer.current = setTimeout(() => {
        addFeedbackRef.current = null
        setAddFeedback(null)
      }, 2600)
    }

    const placeholderRow = {
      id:               crypto.randomUUID(),
      deck_id:          deckId,
      user_id:          user.id,
      scryfall_id:      null,
      name,
      set_code:         null,
      collector_number: null,
      type_line:        typeLine || null,
      mana_cost:        manaCost || null,
      cmc:              cmc ?? null,
      color_identity:   colorId || [],
      image_uri:        null,
      qty:              1,
      foil:             false,
      is_commander:     false,
      board:            'main',
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    }

    deckCardsRef.current = [...deckCardsRef.current, placeholderRow]
    setDeckCards(deckCardsRef.current)
    putDeckCards([placeholderRow]).catch(() => {})
    flashAddFeedback(name, scryfallId, 1)

    const fallbackSfCard = isSfCard
      ? sfCardOrRec
      : (scryfallId ? { id: scryfallId, name, set: setCode, collector_number: collNum, type_line: typeLine, mana_cost: manaCost, cmc, color_identity: colorId, image_uris: imageUri ? { normal: imageUri } : null } : null)
    try {
      const resolved = await resolvePreferredDeckPrinting(name, fallbackSfCard)
      await applyResolvedPrintingToDeckRow(placeholderRow, resolved)
    } catch (err) {
      console.error('[DeckBuilder] failed to resolve preferred printing:', err)
      deckCardsRef.current = deckCardsRef.current.filter(dc => dc.id !== placeholderRow.id)
      setDeckCards(deckCardsRef.current)
      deleteDeckCardLocal(placeholderRow.id).catch(() => {})
    }
  }

  function changeQty(deckCardId, delta) {
    const current = deckCardsRef.current.find(dc => dc.id === deckCardId)
    if (!current) return

    const nextQty = current.qty + delta
    if (nextQty <= 0) {
      removeCardFromDeck(deckCardId)
      return
    }

    setDeckCards(prev => prev.map(dc => {
      if (dc.id !== deckCardId) return dc
      return { ...dc, qty: nextQty }
    }))

    if (qtyTimers.current.has(deckCardId)) clearTimeout(qtyTimers.current.get(deckCardId))
    const timer = setTimeout(async () => {
      const latest = deckCardsRef.current.find(dc => dc.id === deckCardId)
      if (!latest || latest.qty <= 0) return
      try {
        await sbExec(sb.from('deck_cards').update({ qty: latest.qty, updated_at: new Date().toISOString() }).eq('id', deckCardId), { label: 'Update qty failed' })
      } catch {}
      qtyTimers.current.delete(deckCardId)
    }, 600)
    qtyTimers.current.set(deckCardId, timer)
  }

  async function removeCardFromDeck(deckCardId) {
    const current = deckCardsRef.current.find(dc => dc.id === deckCardId)
    if (!current) return

    setDeckCards(prev => prev.filter(dc => dc.id !== deckCardId))
    try {
      await sbExec(sb.from('deck_cards').delete().eq('id', deckCardId), { label: 'Remove card failed' })
      deleteDeckCardLocal(deckCardId).catch(() => {})
    } catch {
      setDeckCards(prev => [...prev, current])
    }
  }

  // Add Basic Lands helper — set the exact count of one basic land on the main
  // board. Reuses addCardToDeck (which resolves a real printing) for the first
  // copy, then writes the target quantity directly.
  async function setBasicLandCount(land, target) {
    target = Math.max(0, Math.min(99, Math.round(Number(target) || 0)))
    const lname = land.name.toLowerCase()
    const findRow = () => deckCardsRef.current.find(dc =>
      !dc.is_commander && normalizeBoard(dc.board) === 'main' &&
      (dc.name || '').toLowerCase() === lname)

    const writeQty = async (row, qty) => {
      const updated = { ...row, qty, updated_at: new Date().toISOString() }
      deckCardsRef.current = deckCardsRef.current.map(dc => dc.id === row.id ? updated : dc)
      setDeckCards(deckCardsRef.current)
      putDeckCards([updated]).catch(() => {})
      try {
        await sbExec(sb.from('deck_cards').update({ qty, updated_at: updated.updated_at }).eq('id', row.id), { label: 'Update qty failed' })
      } catch {}
    }

    setBasicsBusy(land.name)
    try {
      const existing = findRow()
      if (existing) {
        if (target === existing.qty) return
        if (target <= 0) { await removeCardFromDeck(existing.id); return }
        await writeQty(existing, target)
        return
      }
      if (target <= 0) return
      await addCardToDeck({ name: land.name })
      const added = findRow()
      if (added && target > 1) await writeQty(added, target)
    } finally {
      setBasicsBusy(null)
    }
  }

  // ── Add missing to wishlist ─────────────────────────────────────────────────
  // Loads the user's wishlists (list folders) and opens the picker modal.
  async function openMissingWishlist() {
    setShowMissing(true)
    setMissingWishlists(null)
    setMissingNewName(`${deckName || 'Deck'} — Wishlist`)
    try {
      const { data } = await sb
        .from('folders')
        .select('id, name, description, type')
        .eq('user_id', user.id)
        .eq('type', 'list')
        .order('name')
      const lists = (data || []).filter(f => !isGroupFolder(f))
      setMissingWishlists(lists)
      setMissingTargetId(lists[0]?.id || '')
    } catch {
      setMissingWishlists([])
      setMissingTargetId('')
    }
  }

  // Adds every missing card (the deck's chosen printing) to the given wishlist.
  // When folderId is null, creates a new list folder named missingNewName first.
  async function addMissingToWishlistAction(folderId) {
    if (!missingCards.length || missingBusy) return
    setMissingBusy(true)
    try {
      let targetId = folderId
      let targetName = missingWishlists?.find(w => w.id === folderId)?.name
      if (!targetId) {
        const name = (missingNewName || '').trim() || `${deckName || 'Deck'} — Wishlist`
        const { data, error } = await sb
          .from('folders')
          .insert({ user_id: user.id, type: 'list', name })
          .select('id, name')
          .single()
        if (error) throw error
        targetId = data.id
        targetName = data.name
      }
      const sfCards = missingCards.map(({ row }) => ({
        id: row.scryfall_id,
        name: row.name,
        set: row.set_code,
        collector_number: row.collector_number,
        type_line: row.type_line,
        mana_cost: row.mana_cost,
        cmc: row.cmc,
        color_identity: row.color_identity,
        image_uris: row.image_uri ? { normal: row.image_uri } : null,
      }))
      const added = await addMissingToWishlist({ folderId: targetId, userId: user.id, sfCards })
      window.dispatchEvent(new CustomEvent('av:wishlist-updated'))
      showToast(`Added ${added} card${added === 1 ? '' : 's'} to ${targetName || 'wishlist'}.`)
      setShowMissing(false)
    } catch (err) {
      showToast(err?.message || 'Could not add cards to the wishlist.', { tone: 'error' })
    } finally {
      setMissingBusy(false)
    }
  }

  // Build Assistant: add a single unowned card (by name) to a wishlist. Routes
  // to a dedicated "<Deck> — Wishlist" list, reusing/creating it once per
  // session so repeated adds land in the same place.
  const assistantWishlistRef = useRef(null) // { id, name }
  async function addUpgradeToWishlist(name) {
    const full = recCards[name] || (await fetchRecommendationMetadataByNames([name]))[0]
    if (!full) {
      showToast(`Couldn't find ${name} in the card database.`, { tone: 'error' })
      throw new Error('card not found')
    }
    let target = assistantWishlistRef.current
    if (!target) {
      const wlName = `${deckName || 'Deck'} — Wishlist`
      const { data, error } = await sb
        .from('folders')
        .select('id, name, description, type')
        .eq('user_id', user.id)
        .eq('type', 'list')
      if (error) throw error
      const lists = (data || []).filter(f => !isGroupFolder(f))
      let folder = lists.find(l => l.name === wlName)
      if (!folder) {
        const { data: created, error: createErr } = await sb
          .from('folders')
          .insert({ user_id: user.id, type: 'list', name: wlName, description: '{}' })
          .select('id, name')
          .single()
        if (createErr) throw createErr
        folder = created
      }
      target = { id: folder.id, name: folder.name }
      assistantWishlistRef.current = target
    }
    await addMissingToWishlist({ folderId: target.id, userId: user.id, sfCards: [full] })
    window.dispatchEvent(new CustomEvent('av:wishlist-updated'))
    showToast(`Added ${name} to ${target.name}.`)
  }

  async function toggleFoil(deckCardId) {
    const card = deckCardsRef.current.find(dc => dc.id === deckCardId)
    if (!card) return
    const newFoil = !card.foil
    setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? { ...dc, foil: newFoil } : dc))
    try {
      await sbExec(sb.from('deck_cards').update({ foil: newFoil, updated_at: new Date().toISOString() }).eq('id', deckCardId), { label: 'Toggle foil failed' })
    } catch {
      setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? { ...dc, foil: !newFoil } : dc))
    }
  }

  async function moveCardToBoard(deckCardId, board) {
    const nextBoard = normalizeBoard(board)
    const card = deckCardsRef.current.find(dc => dc.id === deckCardId)
    if (!card || normalizeBoard(card.board) === nextBoard) return
    if (card.is_commander && nextBoard !== 'main') return

    const matchingTarget = deckCardsRef.current.find(dc =>
      dc.id !== deckCardId &&
      normalizeBoard(dc.board) === nextBoard &&
      !!dc.foil === !!card.foil &&
      ((card.scryfall_id && dc.scryfall_id === card.scryfall_id) ||
        (!card.scryfall_id && (dc.name || '').toLowerCase() === (card.name || '').toLowerCase()))
    )

    if (matchingTarget) {
      const previousState = deckCardsRef.current
      const updatedTarget = {
        ...matchingTarget,
        qty: (matchingTarget.qty || 0) + (card.qty || 0),
        updated_at: new Date().toISOString(),
      }
      setDeckCards(prev => prev
        .filter(dc => dc.id !== deckCardId)
        .map(dc => dc.id === matchingTarget.id ? updatedTarget : dc)
      )
      putDeckCards([updatedTarget]).catch(() => {})
      deleteDeckCardLocal(deckCardId).catch(() => {})
      try {
        await Promise.all([
          sbExec(sb.from('deck_cards').update({ qty: updatedTarget.qty, updated_at: updatedTarget.updated_at }).eq('id', matchingTarget.id), { label: 'Move card failed' }),
          sbExec(sb.from('deck_cards').delete().eq('id', deckCardId), { silent: true }),
        ])
      } catch {
        setDeckCards(previousState)
      }
      return
    }

    const previousCard = card
    const updated = { ...card, board: nextBoard, updated_at: new Date().toISOString() }
    setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? updated : dc))
    putDeckCards([updated]).catch(() => {})
    try {
      await sbExec(sb.from('deck_cards').update({ board: nextBoard, updated_at: updated.updated_at }).eq('id', deckCardId), { label: 'Move card failed' })
    } catch {
      setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? previousCard : dc))
    }
  }

  async function setCardAsCommander(dc, nextIsCommander = true) {
    if (!nextIsCommander) {
      await unsetCommander(dc.id)
      return
    }
    const sf = dc.set_code && dc.collector_number ? builderSfMap[getScryfallKey(dc)] : null
    const isOath = format?.id === 'oathbreaker'
    const merged = { ...dc, type_line: sf?.type_line || dc.type_line }
    const eligible = isOath ? (isOathbreaker(merged) || isSignatureSpell(merged)) : canBeCommander(dc, sf)
    if (!eligible) {
      console.warn(`[DeckBuilder] refused invalid command-zone card: ${dc.name}`)
      return
    }
    const nextCommanderCards = deckCardsRef.current
      .map(c => c.id === dc.id ? { ...dc, is_commander: true, board: 'main' } : c)
      .filter(c => c.is_commander)
    if (nextCommanderCards.length > 2) {
      console.warn('[DeckBuilder] refused more than two commanders')
      return
    }
    const previousCard = dc
    const updated = { ...dc, is_commander: true, board: 'main' }
    setDeckCards(prev => prev.map(c => c.id === dc.id ? updated : c))
    putDeckCards([updated]).catch(() => {})
    try {
      await sbExec(sb.from('deck_cards').update({ is_commander: true, board: 'main', updated_at: new Date().toISOString() }).eq('id', dc.id), { label: 'Set commander failed' })
    } catch {
      setDeckCards(prev => prev.map(c => c.id === dc.id ? previousCard : c))
      return
    }
    // Build commanders array from all current commander cards + the newly set one
    const allCmdCards = deckCardsRef.current
      .map(c => c.id === dc.id ? updated : c)
      .filter(c => c.is_commander)
    const commanders = allCmdCards.map(c => ({
      name: c.name,
      scryfall_id: c.scryfall_id,
      color_identity: c.color_identity ?? [],
      image_uri: c.image_uri || null,
    }))
    const baseMeta = deckMetaRef.current || deckMeta
    const newMeta = {
      ...deckMeta,
      commanders,
      // Keep legacy fields for backward compat (primary commander)
      commanderName: commanders[0]?.name || null,
      commanderScryfallId: commanders[0]?.scryfall_id || null,
      commanderColorIdentity: commanders[0]?.color_identity ?? [],
      coverArtUri: commanders[0]?.image_uri ? toArtCropImg(commanders[0].image_uri) : (deckMeta.coverArtUri || null),
    }
    delete newMeta.partnerName
    delete newMeta.partnerScryfallId
    applyLocalDeckMeta(newMeta)
    // Save meta immediately (not debounced) — navigating away quickly would lose the commander name otherwise
    clearTimeout(saveMetaTimer.current)
    try {
      await persistMetaNow(newMeta, baseMeta)
    } catch {}
    // Recs are loaded lazily when the Recommendations tab is opened
  }

  async function unsetCommander(deckCardId) {
    const baseMeta = deckMetaRef.current || deckMeta
    const previous = deckCardsRef.current.find(dc => dc.id === deckCardId)
    setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? { ...dc, is_commander: false } : dc))
    try {
      await sbExec(sb.from('deck_cards').update({ is_commander: false }).eq('id', deckCardId), { label: 'Unset commander failed' })
    } catch {
      if (previous) setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? previous : dc))
      return
    }
    // Rebuild commanders array from remaining commander cards
    const remaining = deckCardsRef.current.filter(c => c.id !== deckCardId && c.is_commander)
    const nextMeta = { ...deckMeta }
    if (remaining.length) {
      nextMeta.commanders = remaining.map(c => ({
        name: c.name,
        scryfall_id: c.scryfall_id,
        color_identity: c.color_identity ?? [],
        image_uri: c.image_uri || null,
      }))
      const primary = remaining[0]
      nextMeta.commanderName = primary.name
      nextMeta.commanderScryfallId = primary.scryfall_id || null
      nextMeta.commanderColorIdentity = primary.color_identity ?? []
      nextMeta.coverArtUri = primary.image_uri ? toArtCropImg(primary.image_uri) : (deckMeta.coverArtUri || null)
    } else {
      delete nextMeta.commanders
      delete nextMeta.commanderName
      delete nextMeta.commanderScryfallId
      delete nextMeta.commanderColorIdentity
      delete nextMeta.coverArtUri
    }
    delete nextMeta.partnerName
    delete nextMeta.partnerScryfallId
    applyLocalDeckMeta(nextMeta)
    clearTimeout(saveMetaTimer.current)
    try {
      await persistMetaNow(nextMeta, baseMeta)
    } catch {}
  }

  // ── EDHRec recommendations ────────────────────────────────────────────────
  async function loadRecs(commanderName, formatId = 'commander') {
    recsLoadedForRef.current = { commanderName, formatId }
    setRecsLoading(true)
    setRecsError(null)
    setRecs([])
    setRecImages({})
    setRecCards({})
    setRecLegalities({})
    setCollapsedCats(new Set())

    // Brawl EDHRec endpoint is deprecated — always load Commander recommendations
    const recFormatId = 'commander'
    const data = await fetchEdhrecCommander(commanderName, recFormatId)
    if (!data) { setRecsError('unavailable'); setRecsLoading(false); return }

    setRecs(data)

    // Enforce legality filtering for all non-Commander formats (Brawl, Standard Brawl, etc.)
    const needsLegality = formatId !== 'commander'
    // For non-commander formats we need legality data before showing recs, otherwise illegal cards flash in
    if (!needsLegality) setRecsLoading(false)

    const allRecNames = data.categories.flatMap(c => c.cards.map(r => r.name))

    const sfCards = await fetchRecommendationMetadataByNames(allRecNames).catch(() => [])
    const imgMap = {}
    const cardMap = {}
    const legMap = {}
    for (const c of sfCards) {
      const requestedName = c.requested_name || c.name
      cardMap[requestedName] = c
      const uri = getCardImageUri(c, 'small')
      if (uri) imgMap[requestedName] = uri
      if (c.legalities) legMap[requestedName] = c.legalities
    }
    setRecImages(imgMap)
    setRecCards(cardMap)
    setRecLegalities(legMap)
    if (needsLegality) setRecsLoading(false)
  }

  async function updateCardVersion(versionTarget, sfCard) {
    const dcId = versionTarget?.id || versionTarget
    const meta = getDeckBuilderCardMeta(sfCard)
    const [updated] = await requireCardPrintIds([{
      name:             sfCard.name || versionTarget?.name || 'Unknown Card',
      scryfall_id:      meta.scryfall_id,
      set_code:         meta.set_code,
      collector_number: meta.collector_number,
      type_line:        meta.type_line,
      mana_cost:        meta.mana_cost,
      cmc:              meta.cmc,
      color_identity:   meta.color_identity,
      image_uri:        meta.image_uri,
    }], 'Deck card printing')
    if (versionTarget?.splitOne) {
      const original = deckCardsRef.current.find(d => d.id === dcId)
      if (!original || (original.qty || 0) < 2) return
      const now = new Date().toISOString()
      const splitRow = {
        ...original,
        ...updated,
        id: crypto.randomUUID(),
        qty: 1,
        updated_at: now,
        created_at: now,
      }
      setDeckCards(prev => prev.flatMap(d => {
        if (d.id !== dcId) return [d]
        return [{ ...d, qty: d.qty - 1 }, splitRow]
      }))
      try {
        await sbExec(sb.from('deck_cards').update({ qty: original.qty - 1, updated_at: now }).eq('id', dcId), { label: 'Change version failed' })
        await sbExec(sb.from('deck_cards').insert(toDeckCardRow(splitRow)), { label: 'Change version failed' })
        putDeckCards([{ ...original, qty: original.qty - 1, updated_at: now }, splitRow]).catch(() => {})
      } catch {
        // Revert split: restore original row, drop new row
        setDeckCards(prev => prev.flatMap(d => {
          if (d.id === splitRow.id) return []
          if (d.id === dcId) return [{ ...d, qty: original.qty }]
          return [d]
        }))
      }
      setVersionPickCard(null)
      return
    }
    const previous = deckCardsRef.current.find(d => d.id === dcId)
    setDeckCards(prev => prev.map(d => d.id === dcId ? { ...d, ...updated } : d))
    try {
      await sbExec(sb.from('deck_cards').update(toDeckCardRow(updated)).eq('id', dcId), { label: 'Change version failed' })
    } catch {
      if (previous) setDeckCards(prev => prev.map(d => d.id === dcId ? previous : d))
    }
    setVersionPickCard(null)
  }

  function getHoverImagesFromScryfallCard(sfCard) {
    if (!sfCard) return []
    const faceImages = (sfCard.card_faces || [])
      .map(face => face?.image_uris?.large || face?.image_uris?.normal || null)
      .filter(Boolean)
    if (faceImages.length > 1) return faceImages
    const single = getCardImageUri(sfCard, 'large') || getCardImageUri(sfCard, 'normal')
    return single ? [single] : []
  }

  async function showHoverPreviewForDeckCard(dc, e) {
    if (!CAN_HOVER || lastInputWasTouch) return
    const fallback = dc.image_uri ? [toLargeImg(dc.image_uri)] : []
    const hoverKey = dc.id || dc.scryfall_id || dc.name
    hoverPreviewKey.current = hoverKey
    updateHoverPos(e.clientX, e.clientY)
    setHoverImages(fallback)

    if (!dc.scryfall_id) return
    if (hoverPreviewTimer.current) clearTimeout(hoverPreviewTimer.current)
    if (hoverPreviewCache.current.has(dc.scryfall_id)) {
      if (hoverPreviewKey.current === hoverKey) setHoverImages(hoverPreviewCache.current.get(dc.scryfall_id))
      return
    }

    hoverPreviewTimer.current = setTimeout(async () => {
      if (hoverPreviewKey.current !== hoverKey) return
      try {
        let promise = hoverPreviewPromises.current.get(dc.scryfall_id)
        if (!promise) {
          promise = fetchCardsByScryfallIds([dc.scryfall_id])
          hoverPreviewPromises.current.set(dc.scryfall_id, promise)
        }
        const [sfCard] = await promise
        hoverPreviewPromises.current.delete(dc.scryfall_id)
        const images = getHoverImagesFromScryfallCard(sfCard)
        if (!images.length) return
        hoverPreviewCache.current.set(dc.scryfall_id, images)
        if (hoverPreviewKey.current === hoverKey) setHoverImages(images)
      } catch {
        hoverPreviewPromises.current.delete(dc.scryfall_id)
      }
    }, 180)
  }

  function clearHoverPreview() {
    if (hoverPreviewTimer.current) {
      clearTimeout(hoverPreviewTimer.current)
      hoverPreviewTimer.current = null
    }
    hoverPreviewKey.current = null
    setHoverImages([])
  }

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const openDeckCardContextMenu = useCallback((dc, e) => {
    e.preventDefault?.()
    e.stopPropagation?.()
    clearHoverPreview()

    const useResponsiveSheet = Boolean(e.touchSource) ||
      (typeof window !== 'undefined' && (
        window.innerWidth <= 640 ||
        window.matchMedia?.('(hover: none), (pointer: coarse)').matches
      ))
    const menuWidth = 240
    const menuHeight = dc.qty > 1 ? 420 : 376
    const gap = 8
    const x = Math.min(Math.max(gap, e.clientX), Math.max(gap, window.innerWidth - menuWidth - gap))
    const y = Math.min(Math.max(gap, e.clientY), Math.max(gap, window.innerHeight - menuHeight - gap))
    setContextMenu({ dc, x, y, useResponsiveSheet })
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onKeyDown = (e) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [contextMenu])

  function getAllocationDeckId() {
    return isCollectionDeck ? deckId : (deckMeta.linked_deck_id || null)
  }

  async function refreshAllocationIndicators(explicitDeckId = null) {
    const allocationDeckId = explicitDeckId || getAllocationDeckId()
    if (allocationDeckId) {
      const thisAllocations = await fetchDeckAllocations(allocationDeckId)
      setCollDeckSfSet(new Set((thisAllocations || []).flatMap(row => deckAllocationKeys(row))))
    } else {
      setCollDeckSfSet(new Set())
    }

    const allAllocations = await fetchDeckAllocationsForCardIdentities(user.id, collectCardIdentities(deckCardsRef.current))
    setInOtherDeckSet(new Set(
      (allAllocations || [])
        .filter(row => row.deck_id !== allocationDeckId)
        .flatMap(row => deckAllocationKeys(row))
    ))
  }

  // Stable string key for the sync baseline + linked deck id, so meta edits like
  // description/tags/public-toggle don't refire fetchDeckAllocations.
  const linkedDeckId = isCollectionDeck ? deckId : (deckMeta.linked_deck_id || null)
  const syncSnapshotKey = useMemo(() => {
    const snapshot = getSyncState(deckMeta).last_sync_snapshot
    return snapshot ? JSON.stringify(snapshot) : ''
  }, [deckMeta])

  useEffect(() => {
    const targetDeckId = isCollectionDeck ? deckId : linkedDeckId
    const baseline = syncSnapshotKey
      ? JSON.parse(syncSnapshotKey)
      : { builder_cards: [], collection_cards: [] }
    if (!targetDeckId || !user?.id) {
      setSyncStatus({ loading: false, dirty: false, count: 0, unavailable: true })
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setSyncStatus(prev => ({ ...prev, loading: true, unavailable: false }))
      try {
        const currentAllocations = await fetchDeckAllocations(targetDeckId)
        const diff = buildSyncDiff({
          baseline,
          builderCards: deckCards.filter(card => normalizeBoard(card.board) !== 'maybe'),
          collectionCards: currentAllocations || [],
        })
        const summary = summarizeSyncDiff(diff)
        if (!cancelled) setSyncStatus({ loading: false, dirty: summary.dirty, count: summary.total, unavailable: false, diff })
      } catch {
        if (!cancelled) setSyncStatus({ loading: false, dirty: false, count: 0, unavailable: true })
      }
    }, 1200)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [deckCards, syncSnapshotKey, linkedDeckId, deckId, isCollectionDeck, user?.id])

  useEffect(() => {
    if (!location.state?.openSync) return
    if (loading) return
    if (!(isCollectionDeck || deckMeta.linked_deck_id)) return
    setShowSync(true)
    navigate(location.pathname, { replace: true, state: {} })
  }, [location.state, location.pathname, loading, isCollectionDeck, deckMeta.linked_deck_id, navigate])

  // Guided deck creation: Builder.jsx navigates here with the chosen commander
  // in router state. Set it (full print resolution via pickCommander), then
  // auto-open the build-from-collection wizard. Runs once per navigation.
  const guidedHandledRef = useRef(false)
  useEffect(() => {
    if (guidedHandledRef.current || loading) return
    const guided = location.state?.guidedCommander
    if (!guided) return
    guidedHandledRef.current = true
    ;(async () => {
      try {
        if (!deckCardsRef.current.some(dc => dc.is_commander)) {
          await pickCommander(guided)
        }
      } catch (err) {
        console.warn('[DeckBuilder] guided commander pick failed:', err)
      }
      setShowBuildAssistant(true)
      navigate(location.pathname, { replace: true, state: {} })
    })()
  }, [location.state, location.pathname, loading, navigate])

  // Import-on-create: Builder.jsx's "Import deck" new-deck mode creates a
  // blank deck then navigates here flagging the import modal to auto-open,
  // skipping the blank-deck → menu → import detour.
  const autoImportHandledRef = useRef(false)
  useEffect(() => {
    if (autoImportHandledRef.current || loading) return
    if (!location.state?.autoOpenImport) return
    autoImportHandledRef.current = true
    setShowImport(true)
    navigate(location.pathname, { replace: true, state: {} })
  }, [location.state, location.pathname, loading, navigate])

  function matchesAllocationRow(dc, row) {
    const sameF = (dc.foil ?? false) === (row.foil ?? false)
    if (dc.scryfall_id && row.scryfall_id) return dc.scryfall_id === row.scryfall_id && sameF
    return (dc.name || '').toLowerCase() === (row.name || '').toLowerCase() && sameF
  }

  async function getOwnedMoveRowsForDeckCard(dc, desiredQty) {
    const allocationDeckId = getAllocationDeckId()
    if (!allocationDeckId) return []

    const allocations = await fetchDeckAllocations(allocationDeckId)
    const matchingRows = (allocations || [])
      .filter(row => matchesAllocationRow(dc, row))
      .sort((a, b) => (a.qty || 0) - (b.qty || 0))

    const allocatedQty = matchingRows.reduce((sum, row) => sum + (row.qty || 0), 0)
    let remaining = Math.max(0, allocatedQty - desiredQty)
    if (remaining <= 0) return []

    const rows = []
    for (const row of matchingRows) {
      if (remaining <= 0) break
      const qty = Math.min(row.qty || 0, remaining)
      if (qty <= 0) continue
      rows.push({
        key: `${row.id}:${qty}`,
        card_id: row.card_id,
        qty,
        name: row.name || dc.name,
        allocRow: row,
      })
      remaining -= qty
    }

    return rows
  }

  async function loadMoveTargets(excludeDeckId) {
    const { data, error } = await sb
      .from('folders')
      .select('id, name, type, description')
      .eq('user_id', user.id)
      .in('type', ['binder', 'deck'])
      .neq('id', excludeDeckId)
      .order('type')
      .order('name')

    if (error) throw error
    return (data || []).filter(folder => !isGroupFolder(folder))
  }

  async function moveOwnedCopiesOutOfDeck(rows, destination) {
    if (!rows?.length || !destination?.id) return { deletedAllocIds: [], updatedAllocs: [], touchedDeckIds: [], touchedFolderIds: [] }

    const movesByAllocation = new Map()
    for (const row of rows) {
      if (!row?.allocRow?.id || !row.card_id || !(row.qty > 0)) continue
      const existing = movesByAllocation.get(row.allocRow.id)
      if (existing) existing.qty += row.qty
      else movesByAllocation.set(row.allocRow.id, { ...row })
    }

    const normalizedRows = [...movesByAllocation.values()]
    const destinationByCardId = new Map()
    for (const row of normalizedRows) {
      destinationByCardId.set(row.card_id, (destinationByCardId.get(row.card_id) || 0) + row.qty)
    }
    const cardIds = [...destinationByCardId.keys()]
    const touchedDeckIds = new Set()
    const touchedFolderIds = new Set()

    if (destination.type === 'deck') {
      touchedDeckIds.add(destination.id)
      const { data: existingRows, error } = await sb
        .from('deck_allocations')
        .select('id, card_id, qty')
        .eq('deck_id', destination.id)
        .in('card_id', cardIds)
      if (error) throw error

      const existingMap = new Map((existingRows || []).map(row => [row.card_id, row]))
      const inserts = []
      for (const [cardId, qty] of destinationByCardId) {
        const existing = existingMap.get(cardId)
        if (existing) {
          const { error: updateErr } = await sb.from('deck_allocations').update({ qty: (existing.qty || 0) + qty }).eq('id', existing.id)
          if (updateErr) throw updateErr
        } else {
          inserts.push({ id: crypto.randomUUID(), deck_id: destination.id, user_id: user.id, card_id: cardId, qty })
        }
      }
      if (inserts.length) {
        const { error: insertErr } = await sb.from('deck_allocations').insert(inserts)
        if (insertErr) throw insertErr
      }
    } else {
      touchedFolderIds.add(destination.id)
      const { data: existingRows, error } = await sb
        .from('folder_cards')
        .select('id, card_id, qty')
        .eq('folder_id', destination.id)
        .in('card_id', cardIds)
      if (error) throw error

      const existingMap = new Map((existingRows || []).map(row => [row.card_id, row]))
      const inserts = []
      for (const [cardId, qty] of destinationByCardId) {
        const existing = existingMap.get(cardId)
        if (existing) {
          const { error: updateErr } = await sb.from('folder_cards').update({ qty: (existing.qty || 0) + qty }).eq('id', existing.id)
          if (updateErr) throw updateErr
        } else {
          inserts.push({ folder_id: destination.id, card_id: cardId, qty })
        }
      }
      if (inserts.length) {
        const { error: insertErr } = await sb.from('folder_cards').insert(inserts)
        if (insertErr) throw insertErr
      }
    }

    const deletedAllocIds = []
    const updatedAllocs = []
    for (const row of normalizedRows) {
      if (row.allocRow.deck_id) touchedDeckIds.add(row.allocRow.deck_id)
      const nextQty = (row.allocRow.qty || 0) - row.qty
      if (nextQty > 0) {
        const { error } = await sb.from('deck_allocations').update({ qty: nextQty }).eq('id', row.allocRow.id)
        if (error) throw error
        updatedAllocs.push({ ...row.allocRow, qty: nextQty })
      } else {
        const { error } = await sb.from('deck_allocations').delete().eq('id', row.allocRow.id)
        if (error) throw error
        deletedAllocIds.push(row.allocRow.id)
      }
    }
    return { deletedAllocIds, updatedAllocs, touchedDeckIds: [...touchedDeckIds], touchedFolderIds: [...touchedFolderIds] }
  }

  async function refreshPlacementCaches({ deckIds = [], folderIds = [] } = {}) {
    const uniqueDeckIds = [...new Set((deckIds || []).filter(Boolean))]
    const uniqueFolderIds = [...new Set((folderIds || []).filter(Boolean))]

    for (const deckId of uniqueDeckIds) {
      const freshAllocs = await fetchDeckAllocations(deckId)
      await replaceDeckAllocations([deckId], (freshAllocs || []).map(row => ({
        id: row.id, deck_id: row.deck_id, user_id: row.user_id, card_id: row.card_id, qty: row.qty,
      }))).catch(() => {})
    }

    if (uniqueFolderIds.length) {
      const { data: freshFc } = await sb
        .from('folder_cards')
        .select('id, folder_id, card_id, qty, updated_at')
        .in('folder_id', uniqueFolderIds)
      await replaceLocalFolderCards(uniqueFolderIds, freshFc || []).catch(() => {})
    }

    if (uniqueDeckIds.length || uniqueFolderIds.length) {
      await invalidateCollectionPlacementQueries()
    }
  }

  async function promptToMoveOwnedCopies({ title, message, items, onComplete }) {
    const folders = await loadMoveTargets(getAllocationDeckId())
    setPendingOwnedMove({
      title,
      message,
      items,
      folders,
      onConfirm: async (destination) => {
        try {
          const { deletedAllocIds, updatedAllocs, touchedDeckIds, touchedFolderIds } = await moveOwnedCopiesOutOfDeck(items, destination)
          await deleteDeckAllocationsByIds(deletedAllocIds).catch(() => {})
          if (updatedAllocs.length) await putDeckAllocations(updatedAllocs).catch(() => {})
          await refreshPlacementCaches({ deckIds: touchedDeckIds, folderIds: touchedFolderIds })
          await onComplete?.(destination)
          await refreshAllocationIndicators()
        } catch (err) {
          showToast(`Move failed: ${err?.message || 'unknown error'}`, { tone: 'error', duration: 4000 })
          console.error('[DeckBuilder] move owned copies failed:', err)
        }
        setPendingOwnedMove(null)
      },
    })
  }

  async function reassignPlacementsToDeck(targetDeckId, rows) {
    if (!rows?.length) return { touchedDeckIds: [], touchedFolderIds: [] }

    const cardIds = [...new Set(rows.map(row => row.card_id).filter(Boolean))]
    if (!cardIds.length) return { touchedDeckIds: [], touchedFolderIds: [] }
    const touchedDeckIds = new Set([targetDeckId])
    const touchedFolderIds = new Set()

    const [{ data: folderPlacements, error: folderErr }, { data: deckPlacements, error: deckErr }] = await Promise.all([
      sb.from('folder_cards')
        .select('id, folder_id, card_id, qty')
        .in('card_id', cardIds),
      sb.from('deck_allocations')
        .select('id, deck_id, card_id, qty')
        .in('card_id', cardIds)
        .neq('deck_id', targetDeckId),
    ])

    if (folderErr) throw folderErr
    if (deckErr) throw deckErr

    const placementsByCardId = new Map()
    for (const row of folderPlacements || []) {
      const list = placementsByCardId.get(row.card_id) || []
      list.push({ ...row, table: 'folder_cards', placementKey: 'folder_id', placementId: row.folder_id, rank: 0 })
      placementsByCardId.set(row.card_id, list)
    }
    for (const row of deckPlacements || []) {
      const list = placementsByCardId.get(row.card_id) || []
      list.push({ ...row, table: 'deck_allocations', placementKey: 'deck_id', placementId: row.deck_id, rank: 1 })
      placementsByCardId.set(row.card_id, list)
    }

    for (const row of rows) {
      let remaining = row.qty || 0
      const placements = (placementsByCardId.get(row.card_id) || [])
        .sort((a, b) => a.rank - b.rank || (a.qty || 0) - (b.qty || 0))

      for (const placement of placements) {
        if (remaining <= 0) break
        const usedQty = Math.min(placement.qty || 0, remaining)
        const nextQty = (placement.qty || 0) - usedQty

        if (nextQty > 0) {
          const { error } = await sb.from(placement.table).update({ qty: nextQty }).eq('id', placement.id)
          if (error) throw error
        } else {
          const { error } = await sb.from(placement.table).delete().eq('id', placement.id)
          if (error) throw error
        }
        if (placement.table === 'deck_allocations') touchedDeckIds.add(placement.placementId)
        else touchedFolderIds.add(placement.placementId)

        remaining -= usedQty
      }
    }
    return { touchedDeckIds: [...touchedDeckIds], touchedFolderIds: [...touchedFolderIds] }
  }

  async function syncDeckRowsToAllocatedPrintings(items) {
    const normalizedItems = (items || []).filter(item => item?.dc?.id && (item.allocations || []).length > 0)
    if (!normalizedItems.length) return

    const desiredByDeckCardId = new Map()
    for (const item of normalizedItems) {
      const prints = [...new Map(
        (item.allocations || []).map(row => [
          `${row.scryfall_id || ''}|${row.set_code || ''}|${row.collector_number || ''}|${row.foil ? '1' : '0'}`,
          row,
        ])
      ).values()]
      if (prints.length !== 1) continue

      const desired = prints[0]
      const samePrinting =
        (item.dc.scryfall_id || null) === (desired.scryfall_id || null) &&
        (item.dc.set_code || null) === (desired.set_code || null) &&
        (item.dc.collector_number || null) === (desired.collector_number || null) &&
        !!item.dc.foil === !!desired.foil
      if (!samePrinting) desiredByDeckCardId.set(item.dc.id, desired)
    }
    if (!desiredByDeckCardId.size) return

    const scryfallIds = [...new Set([...desiredByDeckCardId.values()].map(row => row.scryfall_id).filter(Boolean))]
    const fetchedRows = scryfallIds.length ? await fetchCardsByScryfallIds(scryfallIds) : []
    const fetchedById = new Map(fetchedRows.map(card => [card.id, card]))

    const now = new Date().toISOString()
    const currentById = new Map(deckCardsRef.current.map(dc => [dc.id, dc]))
    const updates = []
    for (const [deckCardId, desired] of desiredByDeckCardId.entries()) {
      const dc = currentById.get(deckCardId)
      if (!dc) continue
      const fetched = desired.scryfall_id ? fetchedById.get(desired.scryfall_id) : null
      const meta = fetched ? getDeckBuilderCardMeta(fetched) : null
      const [next] = await requireCardPrintIds([{
        card_print_id: desired.card_print_id || null,
        name: desired.name || meta?.name || dc.name,
        scryfall_id: desired.scryfall_id || dc.scryfall_id || null,
        set_code: desired.set_code || meta?.set_code || dc.set_code || null,
        collector_number: desired.collector_number || meta?.collector_number || dc.collector_number || null,
        type_line: meta?.type_line || dc.type_line || null,
        mana_cost: meta?.mana_cost || dc.mana_cost || null,
        cmc: meta?.cmc ?? dc.cmc ?? null,
        color_identity: meta?.color_identity || dc.color_identity || [],
        image_uri: meta?.image_uri || dc.image_uri || null,
        foil: !!desired.foil,
        updated_at: now,
      }], 'Deck card printing')
      updates.push({ id: dc.id, ...next })
    }

    const updateById = new Map(updates.map(update => [update.id, update]))
    setDeckCards(prev => prev.map(dc => updateById.has(dc.id) ? { ...dc, ...updateById.get(dc.id) } : dc))

    for (const update of updates) {
      const { id, ...payload } = update
      await sbExec(sb.from('deck_cards').update(toDeckCardRow(payload)).eq('id', id), { silent: true })
    }
  }

  async function applyExplicitPrintingSelections(printingSelections) {
    const selections = (printingSelections || []).filter(row => row?.deckCardId && row?.candidate)
    if (!selections.length) return

    const scryfallIds = [...new Set(selections.map(row => row.candidate.scryfall_id).filter(Boolean))]
    const fetchedRows = scryfallIds.length ? await fetchCardsByScryfallIds(scryfallIds) : []
    const fetchedById = new Map(fetchedRows.map(card => [card.id, card]))
    const now = new Date().toISOString()
    const currentById = new Map(deckCardsRef.current.map(dc => [dc.id, dc]))
    const updates = []

    for (const selection of selections) {
      const dc = currentById.get(selection.deckCardId)
      if (!dc) continue
      const candidate = selection.candidate
      const fetched = candidate.scryfall_id ? fetchedById.get(candidate.scryfall_id) : null
      const meta = fetched ? getDeckBuilderCardMeta(fetched) : null
      const [next] = await requireCardPrintIds([{
        card_print_id: candidate.card_print_id || null,
        name: candidate.name || meta?.name || dc.name,
        scryfall_id: candidate.scryfall_id || dc.scryfall_id || null,
        set_code: candidate.set_code || meta?.set_code || dc.set_code || null,
        collector_number: candidate.collector_number || meta?.collector_number || dc.collector_number || null,
        type_line: meta?.type_line || dc.type_line || null,
        mana_cost: meta?.mana_cost || dc.mana_cost || null,
        cmc: meta?.cmc ?? dc.cmc ?? null,
        color_identity: meta?.color_identity || dc.color_identity || [],
        image_uri: meta?.image_uri || dc.image_uri || null,
        foil: !!candidate.foil,
        updated_at: now,
      }], 'Deck card printing')
      updates.push({ id: selection.deckCardId, ...next })
    }

    const updateById = new Map(updates.map(update => [update.id, update]))
    setDeckCards(prev => prev.map(dc => updateById.has(dc.id) ? { ...dc, ...updateById.get(dc.id) } : dc))

    for (const update of updates) {
      const { id, ...payload } = update
      await sbExec(sb.from('deck_cards').update(toDeckCardRow(payload)).eq('id', id), { silent: true })
    }
  }

  async function handleMakeDeck({ addItems, missingItems, printingSelections, addMissing, wishlistId, wishlistName }) {
    if (makeDeckRunning) return
    setMakeDeckRunning(true)
    setShowMakeDeck(false)
    // LIFO cleanup stack — each entry is a best-effort async undo for a step we
    // already committed. On failure we run them in reverse to leave the user as
    // close to their pre-MakeDeck state as possible. We DO NOT roll back
    // additiveSaveOwnedCards (it merges into existing rows; safe undo is impossible
    // without a per-row baseline). If that step throws, we report it but the
    // owned cards table may have stale qty bumps — same risk as before this fix.
    const cleanupStack = []
    let createdCollectionDeckId = null
    let createdWishlistId = null
    const builderMetaSnapshot = { ...(deckMetaRef.current || deckMeta) }
    try {
      const builderMeta = builderMetaSnapshot
      const { data: newCollectionDeck, error: createDeckErr } = await sb
        .from('folders')
        .insert({
          user_id: user.id,
          type: 'deck',
          name: deck.name,
          description: serializeDeckMeta({ format: builderMeta.format || 'commander' }),
        })
        .select()
        .single()
      if (createDeckErr || !newCollectionDeck) throw createDeckErr || new Error('Failed to create linked collection deck.')
      createdCollectionDeckId = newCollectionDeck.id
      cleanupStack.push(async () => {
        await sb.from('deck_allocations').delete().eq('deck_id', newCollectionDeck.id)
        await sb.from('folders').delete().eq('id', newCollectionDeck.id).eq('user_id', user.id)
      })

      const linkResult = await linkDeckPair(deckId, newCollectionDeck.id)
      const linkedBuilderMeta = linkResult?.builder_meta || withLinkedPair(builderMeta, { linkedDeckId: newCollectionDeck.id })
      const linkedCollectionMeta = linkResult?.collection_meta || withLinkedPair(parseDeckMeta(newCollectionDeck.description), { linkedBuilderId: deckId })
      cleanupStack.push(async () => {
        await patchDeckMeta(deckId, linkedBuilderMeta, builderMetaSnapshot)
        applyLocalDeckMeta(builderMetaSnapshot)
      })
      applyLocalDeckMeta(linkedBuilderMeta)
      await applyExplicitPrintingSelections(printingSelections)
      const touchedPlacementDeckIds = new Set([newCollectionDeck.id])
      const touchedPlacementFolderIds = new Set()

      if (addItems.length > 0) {
        const allocationRows = mergeAllocationRows(addItems
          .flatMap(item => (item.allocations || []).map(row => ({
            id: crypto.randomUUID(),
            card_id: row.card_id,
            qty: row.qty,
          }))))

        await syncDeckRowsToAllocatedPrintings(addItems)
        await upsertDeckAllocations(newCollectionDeck.id, user.id, allocationRows)
        const touched = await reassignPlacementsToDeck(newCollectionDeck.id, allocationRows)
        for (const id of touched.touchedDeckIds || []) touchedPlacementDeckIds.add(id)
        for (const id of touched.touchedFolderIds || []) touchedPlacementFolderIds.add(id)
      }

      if (addMissing && missingItems.length > 0) {
        const cardInserts = missingItems.map(i => ({
          user_id: user.id,
          name: i.dc.name,
          set_code: i.dc.set_code || null,
          collector_number: i.dc.collector_number || null,
          scryfall_id: i.dc.scryfall_id || null,
          card_print_id: i.dc.card_print_id || null,
          foil: i.dc.foil ?? false,
          qty: i.missingQty,
          language: 'en',
          condition: 'near_mint',
          purchase_price: 0,
          currency: 'EUR',
        }))
        const hydratedCardRows = await requireCardPrintIds(cardInserts, 'Missing owned card')
        const savedCards = await additiveSaveOwnedCards(hydratedCardRows, 'Missing owned card')
        if (savedCards.length) putCards(savedCards).catch(() => {})
        const savedByKey = new Map(savedCards.map(card => [ownedCardKey(card), card]))
        const newAllocRows = hydratedCardRows.map(row => {
          const savedCard = savedByKey.get(ownedCardKey(row))
          if (!savedCard) return null
          return {
          id: crypto.randomUUID(),
            card_id: savedCard.id,
            qty: row.qty,
          }
        }).filter(Boolean)
        await upsertDeckAllocations(newCollectionDeck.id, user.id, newAllocRows)
      }

      let targetWishlistId = wishlistId
      if (!targetWishlistId && wishlistName) {
        const { data: wl, error: wlErr } = await sb.from('folders').insert({ user_id: user.id, type: 'list', name: wishlistName, description: '{}' }).select().single()
        if (wlErr) throw wlErr
        targetWishlistId = wl?.id
        if (targetWishlistId) {
          createdWishlistId = targetWishlistId
          cleanupStack.push(async () => {
            await sb.from('list_items').delete().eq('folder_id', createdWishlistId)
            await sb.from('folders').delete().eq('id', createdWishlistId).eq('user_id', user.id)
          })
        }
      }
      if (targetWishlistId && missingItems.length > 0) {
        const listInserts = missingItems.map(i => ({
          name: i.dc.name,
          scryfall_id: i.dc.scryfall_id || null,
          set_code: i.dc.set_code || null,
          collector_number: i.dc.collector_number || null,
          card_print_id: i.dc.card_print_id || null,
          foil: i.dc.foil ?? false,
          qty: i.missingQty,
        }))
        await additiveSaveWishlistItems(targetWishlistId, user.id, listInserts, 'Missing wishlist item')
      }

      const allocationRows = await fetchDeckAllocations(newCollectionDeck.id)
      await replaceDeckAllocations([newCollectionDeck.id], (allocationRows || []).map(row => ({
        id: row.id, deck_id: row.deck_id, user_id: row.user_id, card_id: row.card_id, qty: row.qty,
      }))).catch(() => {})
      await refreshPlacementCaches({
        deckIds: [...touchedPlacementDeckIds],
        folderIds: [...touchedPlacementFolderIds],
      })
      const initialSnapshot = buildSyncSnapshot({
        builderCards: deckCardsRef.current.filter(card => normalizeBoard(card.board) !== 'maybe'),
        collectionCards: allocationRows || [],
      })
      const { builderNext } = await persistLinkedSyncSnapshot({
        builderDeckId: deckId,
        collectionDeckId: newCollectionDeck.id,
        builderMeta: linkedBuilderMeta,
        collectionMeta: linkedCollectionMeta,
        snapshot: initialSnapshot,
        hasUnresolved: false,
      })
      setDeckMeta(builderNext)
      await refreshAllocationIndicators(newCollectionDeck.id)
      await invalidateCollectionPlacementQueries({ includeFolders: true, includeCards: addMissing && missingItems.length > 0 })
      setSyncStatus({ loading: false, dirty: false, count: 0, unavailable: false, diff: null })

      const addCount = addItems.reduce((s, i) => s + i.totalAdd, 0)
      const misCount = missingItems.reduce((s, i) => s + i.missingQty, 0)
      let msg = `${addCount} card${addCount !== 1 ? 's' : ''} added to collection deck`
      if (addMissing && misCount > 0) msg += `, ${misCount} missing card${misCount !== 1 ? 's' : ''} added to collection`
      else if (targetWishlistId && misCount > 0) msg += `, ${misCount} added to wishlist`
      setMakeDeckMsg(msg)
      setMakeDeckDone(true)
    } catch (err) {
      console.error('[MakeDeck]', err)
      // Best-effort rollback in reverse order. Cleanup failures are logged but
      // not surfaced — the original error is the actionable one for the user.
      for (let i = cleanupStack.length - 1; i >= 0; i -= 1) {
        try { await cleanupStack[i]() } catch (cleanupErr) {
          console.error('[MakeDeck] cleanup step failed:', cleanupErr)
        }
      }
      setMakeDeckMsg('Failed to make collection deck. Try again.')
      setMakeDeckDone(true)
    }
    setMakeDeckRunning(false)
  }

  function buildCommanderMetaFromCards(cards, currentMeta) {
    const commanderRows = (cards || []).filter(card => card.is_commander)
    const nextMeta = { ...currentMeta }

    if (!commanderRows.length) {
      delete nextMeta.commanderName
      delete nextMeta.commanderScryfallId
      delete nextMeta.commanderColorIdentity
      delete nextMeta.coverArtUri
      delete nextMeta.partnerName
      delete nextMeta.partnerScryfallId
      delete nextMeta.commanders
      return nextMeta
    }

    const commanders = commanderRows.map(c => ({
      name: c.name,
      scryfall_id: c.scryfall_id,
      color_identity: c.color_identity ?? [],
      image_uri: c.image_uri || null,
    }))
    nextMeta.commanders = commanders

    // Legacy fields for backward compat
    const primary = commanders[0]
    nextMeta.commanderName = primary.name
    nextMeta.commanderScryfallId = primary.scryfall_id || null
    nextMeta.commanderColorIdentity = primary.color_identity ?? []
    nextMeta.coverArtUri = primary.image_uri ? toArtCropImg(primary.image_uri) : (currentMeta?.coverArtUri || null)

    delete nextMeta.partnerName
    delete nextMeta.partnerScryfallId

    return nextMeta
  }

  async function applyCollectionSelectionsToBuilder(rows) {
    if (!rows?.length) return { nextDeckCards: deckCardsRef.current, nextMeta: deckMeta }
    const now = new Date().toISOString()
    const currentDeckCards = [...deckCardsRef.current]
    const updates = []
    const inserts = []
    const deletes = []
    const nextDeckCards = [...currentDeckCards]

    for (const row of rows) {
      const desiredQty = row.collectionQty || 0
      const matching = nextDeckCards.filter(dc => getLogicalKey(dc) === row.key)
      const currentQty = matching.reduce((sum, dc) => sum + (dc.qty || 0), 0)
      if (currentQty === desiredQty) continue

      if (desiredQty <= 0) {
        for (const dc of matching) {
          deletes.push(dc.id)
        }
        for (let i = nextDeckCards.length - 1; i >= 0; i -= 1) {
          if (getLogicalKey(nextDeckCards[i]) === row.key) nextDeckCards.splice(i, 1)
        }
        continue
      }

      if (matching.length === 0) {
        const base = row.collection || row.builder || {}
        const commanderHint = findCommanderTransferHint(row, currentDeckCards)
        const newRow = {
          id: crypto.randomUUID(),
          deck_id: deckId,
          user_id: user.id,
          card_print_id: base.card_print_id || null,
          scryfall_id: base.scryfall_id || null,
          name: base.name || 'Unknown Card',
          set_code: base.set_code || null,
          collector_number: base.collector_number || null,
          type_line: base.type_line || null,
          mana_cost: base.mana_cost || null,
          cmc: base.cmc ?? null,
          color_identity: base.color_identity || [],
          image_uri: base.image_uri || null,
          qty: desiredQty,
          foil: base.foil ?? false,
          is_commander: !!commanderHint.is_commander,
          board: base.board || 'main',
          created_at: now,
          updated_at: now,
        }
        inserts.push(newRow)
        nextDeckCards.push(newRow)
        continue
      }

      const sorted = [...matching].sort((a, b) => {
        if (!!a.is_commander !== !!b.is_commander) return a.is_commander ? -1 : 1
        return (b.qty || 0) - (a.qty || 0)
      })
      const totalCurrent = sorted.reduce((sum, dc) => sum + (dc.qty || 0), 0)
      let remaining = desiredQty
      // Distribute desiredQty proportionally across existing rows; the last row
      // collects whatever remainder is left. When totalCurrent is 0 there is no
      // signal to split by, so the last row gets everything — acceptable since
      // both rows had 0 anyway.
      const allocations = sorted.map((dc, idx) => {
        if (idx === sorted.length - 1) return remaining
        const share = totalCurrent > 0
          ? Math.round((dc.qty || 0) * desiredQty / totalCurrent)
          : 0
        const clamped = Math.max(0, Math.min(remaining, share))
        remaining -= clamped
        return clamped
      })
      for (let idx = 0; idx < sorted.length; idx += 1) {
        const dc = sorted[idx]
        const nextQty = allocations[idx]
        if (nextQty > 0) {
          if ((dc.qty || 0) !== nextQty) {
            updates.push({ id: dc.id, qty: nextQty, updated_at: now })
            const target = nextDeckCards.find(item => item.id === dc.id)
            if (target) target.qty = nextQty
          }
        } else {
          deletes.push(dc.id)
        }
      }
      const deletesSet = new Set(deletes)
      for (let i = nextDeckCards.length - 1; i >= 0; i -= 1) {
        if (deletesSet.has(nextDeckCards[i].id)) nextDeckCards.splice(i, 1)
      }
    }

    for (const row of updates) {
      await sbExec(sb.from('deck_cards').update({ qty: row.qty, updated_at: row.updated_at }).eq('id', row.id), { silent: true })
    }
    if (inserts.length) {
      const hydratedInserts = await requireCardPrintIds(inserts, 'Synced deck card')
      const hydratedById = new Map(hydratedInserts.map(row => [row.id, row]))
      for (let i = 0; i < nextDeckCards.length; i += 1) {
        const hydrated = hydratedById.get(nextDeckCards[i].id)
        if (hydrated) nextDeckCards[i] = hydrated
      }
      await sbExec(sb.from('deck_cards').insert(hydratedInserts.map(toDeckCardRow)), { silent: true })
    }
    for (const id of deletes) {
      await sbExec(sb.from('deck_cards').delete().eq('id', id), { silent: true })
      deleteDeckCardLocal(id).catch(() => {})
    }
    if (inserts.length) putDeckCards(nextDeckCards.filter(dc => inserts.some(row => row.id === dc.id))).catch(() => {})
    if (updates.length) putDeckCards(nextDeckCards.filter(dc => updates.some(u => u.id === dc.id))).catch(() => {})

    const baseMeta = deckMetaRef.current || deckMeta
    const nextMeta = buildCommanderMetaFromCards(nextDeckCards, baseMeta)
    if (serializeDeckMeta(nextMeta) !== serializeDeckMeta(baseMeta)) {
      applyLocalDeckMeta(nextMeta)
      await persistMetaNow(nextMeta, baseMeta)
    }

    deckCardsRef.current = nextDeckCards
    setDeckCards(nextDeckCards)
    return { nextDeckCards, nextMeta }
  }

  async function handleSync({ diff, resolutions, builderPlan, collectionSelections }) {
    if (syncRunning) return
    setSyncRunning(true)
    setShowSync(false)
    try {
      const targetDeckId = diff?.targetDeckId || getAllocationDeckId()
      if (!targetDeckId) throw new Error('No linked collection deck to sync.')
      const { addItems = [], missingItems = [], changedItems = [], removedItems = [], printingSelections = [], moveDestinationId = null, wishlistId = null, wishlistName = null } = builderPlan || {}
      const ownedAdded = addItems
      const unownedAdded = missingItems
      await applyExplicitPrintingSelections(printingSelections)

      if (ownedAdded.length > 0) {
        const addedRows = mergeAllocationRows(ownedAdded.flatMap(i => (i.allocations || []).map(row => ({
          id: crypto.randomUUID(),
          card_id: row.card_id,
          qty: row.qty,
        }))))
        await syncDeckRowsToAllocatedPrintings(ownedAdded)
        await upsertDeckAllocations(targetDeckId, user.id, addedRows)
        const touched = await reassignPlacementsToDeck(targetDeckId, addedRows)
        await refreshPlacementCaches(touched)
      }
      const increased = changedItems.filter(c => c.newQty > c.oldQty)
      const decreased = changedItems.filter(c => c.newQty < c.oldQty)
      for (const c of increased) {
        await sbExec(sb.from('deck_allocations').update({ qty: c.newQty }).eq('id', c.allocRow.id), { silent: true })
      }
      const increasedRows = mergeAllocationRows(increased
        .map(c => ({ card_id: c.cardId, qty: c.newQty - c.oldQty }))
      )
      if (increasedRows.length > 0) {
        const touched = await reassignPlacementsToDeck(targetDeckId, increasedRows)
        await refreshPlacementCaches(touched)
      }

      const moveRows = [
        ...decreased.map(c => ({
          key: `changed:${c.allocRow.id}`,
          card_id: c.cardId,
          qty: c.oldQty - c.newQty,
          name: c.dc.name,
          allocRow: c.allocRow,
        })),
        ...removedItems.map(r => ({
          key: `removed:${r.allocRow.id}`,
          card_id: r.cardId,
          qty: r.allocRow.qty || 0,
          name: r.name,
          allocRow: r.allocRow,
        })),
      ]

      if (moveRows.length > 0) {
        const destination = targetDeckId && moveDestinationId
          ? (await loadMoveTargets(targetDeckId)).find(folder => folder.id === moveDestinationId)
          : null
        if (!destination) throw new Error('Select a destination for removed owned cards.')
        const { deletedAllocIds, updatedAllocs, touchedDeckIds, touchedFolderIds } = await moveOwnedCopiesOutOfDeck(moveRows, destination)
        await deleteDeckAllocationsByIds(deletedAllocIds).catch(() => {})
        if (updatedAllocs.length) await putDeckAllocations(updatedAllocs).catch(() => {})
        await refreshPlacementCaches({ deckIds: touchedDeckIds, folderIds: touchedFolderIds })
      }

      let targetWishlistId = wishlistId
      if (!targetWishlistId && wishlistName) {
        const { data: wl, error: wlErr } = await sb.from('folders').insert({ user_id: user.id, type: 'list', name: wishlistName, description: '{}' }).select().single()
        if (wlErr) throw wlErr
        targetWishlistId = wl?.id
      }
      if (targetWishlistId && unownedAdded.length > 0) {
        const listInserts = unownedAdded.map(i => ({
          name: i.dc.name,
          scryfall_id: i.dc.scryfall_id || null,
          set_code: i.dc.set_code || null,
          collector_number: i.dc.collector_number || null,
          card_print_id: i.dc.card_print_id || null,
          foil: i.dc.foil ?? false,
          qty: i.missingQty || i.dc.qty,
        }))
        await additiveSaveWishlistItems(targetWishlistId, user.id, listInserts, 'Sync wishlist item')
      }

      const collectionApplyResult = collectionSelections?.length
        ? await applyCollectionSelectionsToBuilder(collectionSelections)
        : { nextDeckCards: deckCardsRef.current, nextMeta: deckMeta }
      const nextBuilderCards = collectionApplyResult.nextDeckCards
      const nextBuilderMeta = collectionApplyResult.nextMeta

      const allocationRows = await fetchDeckAllocations(targetDeckId)
      await replaceDeckAllocations([targetDeckId], (allocationRows || []).map(row => ({
        id: row.id, deck_id: row.deck_id, user_id: row.user_id, card_id: row.card_id, qty: row.qty,
      }))).catch(() => {})
      const currentSnapshot = buildSyncSnapshot({
        builderCards: nextBuilderCards.filter(card => normalizeBoard(card.board) !== 'maybe'),
        collectionCards: allocationRows || [],
      })
      const hasUnresolved = Object.values(resolutions || {}).some(value => value === 'keep')
      const previousSnapshot = getSyncState(deckMeta).last_sync_snapshot || { builder_cards: [], collection_cards: [] }
      const unresolvedKeys = new Set(
        [...(diff?.builderOnly || []), ...(diff?.collectionOnly || []), ...(diff?.conflicts || [])]
          .filter(row => (resolutions?.[row.key] || 'keep') === 'keep')
          .map(row => row.key)
      )
      const currentBuilderMap = new Map((currentSnapshot.builder_cards || []).map(row => [row.key, row]))
      const currentCollectionMap = new Map((currentSnapshot.collection_cards || []).map(row => [row.key, row]))
      const previousBuilderMap = new Map((previousSnapshot.builder_cards || []).map(row => [row.key, row]))
      const previousCollectionMap = new Map((previousSnapshot.collection_cards || []).map(row => [row.key, row]))
      const snapshot = {
        builder_cards: [...new Set([...currentBuilderMap.keys(), ...previousBuilderMap.keys()])]
          .map(key => unresolvedKeys.has(key) ? previousBuilderMap.get(key) : currentBuilderMap.get(key))
          .filter(Boolean),
        collection_cards: [...new Set([...currentCollectionMap.keys(), ...previousCollectionMap.keys()])]
          .map(key => unresolvedKeys.has(key) ? previousCollectionMap.get(key) : currentCollectionMap.get(key))
          .filter(Boolean),
      }
      let collectionFolderMeta = null
      if (isCollectionDeck) {
        collectionFolderMeta = parseDeckMeta(deck.description || '{}')
      } else {
        const { data: collectionFolder, error: collectionFolderErr } = await sb
          .from('folders')
          .select('description')
          .eq('id', targetDeckId)
          .maybeSingle()
        if (collectionFolderErr) throw collectionFolderErr
        collectionFolderMeta = collectionFolder?.description
          ? parseDeckMeta(collectionFolder.description)
          : { format: deckMeta.format || 'commander' }
      }
      const { builderNext } = await persistLinkedSyncSnapshot({
        builderDeckId: deckId,
        collectionDeckId: targetDeckId,
        builderMeta: nextBuilderMeta,
        collectionMeta: withLinkedPair(collectionFolderMeta, { linkedBuilderId: deckId }),
        snapshot,
        hasUnresolved,
      })
      setDeckMeta(builderNext)
      await refreshAllocationIndicators(targetDeckId)
      await invalidateCollectionPlacementQueries({ includeFolders: !!wishlistName })
      const nextDiff = buildSyncDiff({
        baseline: snapshot,
        builderCards: nextBuilderCards.filter(card => normalizeBoard(card.board) !== 'maybe'),
        collectionCards: allocationRows || [],
      })
      const nextSummary = summarizeSyncDiff(nextDiff)
      setSyncStatus({ loading: false, dirty: hasUnresolved || nextSummary.dirty, count: nextSummary.total, unavailable: false, diff: nextDiff })
      setSyncMsg(hasUnresolved ? 'Sync applied. Some differences were kept.' : 'Sync complete')
      setSyncDone(true)
    } catch (err) {
      console.error('[Sync]', err)
      setSyncMsg('Sync failed. Try again.')
      setSyncDone(true)
    }
    setSyncRunning(false)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) return <div style={{ padding: 40, color: 'var(--text-faint)' }}>Loading deck...</div>
  if (loadError) return (
    <div style={{ padding: 40 }}>
      <div style={{ color: '#e07070', marginBottom: 12 }}>{loadError}</div>
      <Link to="/builder" style={{ color: 'var(--gold)', fontSize: '0.9rem' }}>&lt;- Back to Builder</Link>
    </div>
  )

  const syncLabel = syncRunning
    ? 'Applying...'
    : syncStatus.dirty
      ? `Unsynced (${syncStatus.count || 0})`
      : 'Synced'
  const syncLabelMobile = syncRunning
    ? 'Applying'
    : syncStatus.dirty
      ? `${syncStatus.count || 0} Unsynced`
      : 'Synced'
  const renderDeckHeader = (variantClassName = '') => (
    <div className={`${styles.deckHeader}${variantClassName ? ' ' + variantClassName : ''}`}>
      <div className={styles.deckTitleBlock}>
        <input
          className={styles.deckNameInput}
          value={deckName}
          onChange={e => setDeckName(e.target.value)}
          onBlur={saveNameBlur}
          maxLength={100}
        />
        <div className={styles.deckMeta}>
          <span>{format?.label ?? 'Deck'}</span>
          <span>&middot;</span>
          <button
            type="button"
            className={`${styles.visibilityChip} ${deckMeta.is_public ? styles.visibilityChipPublic : ''}`}
            onClick={togglePublic}
            title={`Deck is ${deckMeta.is_public ? 'public' : 'private'}. Click to switch.`}
          >
            {deckMeta.is_public ? 'Public' : 'Private'}
          </button>
          {saving && <span className={styles.savingDot} />}
        </div>
      </div>
      <div className={styles.headerActions}>
        <Link className={`${styles.headerLink} ${styles.headerQuickAction}`} to="/builder" title="Back to decks">
          <span className={styles.btnIcon} aria-hidden="true"><ChevronLeftIcon size={14} /></span>
          <span className={styles.btnLabel}>Back to Decks</span>
          <span className={styles.btnLabelMobile}>Back</span>
        </Link>
        <Link className={`${styles.headerLink} ${styles.headerQuickAction}`} to={`/builder/${deckId}/playtest`} title="Playtest deck">
          <span className={styles.btnIcon} aria-hidden="true"><ExternalLinkIcon size={14} /></span>
          <span className={styles.btnLabel}>Playtest</span>
          <span className={styles.btnLabelMobile}>Test</span>
        </Link>
        {isEDH && (
          <button
            className={`${styles.headerBtnPrimary} ${styles.headerQuickAction} ${styles.headerBtnAssist}`}
            onClick={() => setShowBuildAssistant(true)}
            title="Open the guided deck builder — fill each role from your collection"
          >
            <span className={styles.btnIcon} aria-hidden="true"><LightningIcon size={14} /></span>
            <span className={styles.btnLabel}>Build Assistant</span>
            <span className={styles.btnLabelMobile}>Assist</span>
          </button>
        )}
        {(isCollectionDeck || deckMeta.linked_deck_id) && (
          <button className={styles.headerBtnPrimary} onClick={() => setShowSync(true)} disabled={syncRunning} title="Sync collection">
            <span className={styles.btnIcon} aria-hidden="true"><CollectionIcon size={14} /></span>
            <span className={styles.btnLabel}>{syncLabel}</span>
            <span className={styles.btnLabelMobile}>{syncLabelMobile}</span>
          </button>
        )}
        {!isCollectionDeck && !deckMeta.linked_deck_id && (
          <button className={styles.headerBtnPrimary} onClick={() => setShowMakeDeck(true)} disabled={makeDeckRunning} title="Make Collection Deck">
            <span className={styles.btnIcon} aria-hidden="true"><DeckIcon size={14} /></span>
            <span className={styles.btnLabel}>{makeDeckRunning ? 'Creating...' : 'Make Collection Deck'}</span>
            <span className={styles.btnLabelMobile}>{makeDeckRunning ? 'Creating...' : 'Make Deck'}</span>
          </button>
        )}
        <button
          className={`${styles.headerBtnPrimary} ${styles.headerQuickAction}`}
          onClick={handleShareDeck}
          disabled={shareBusy}
          title="Share deck"
        >
          <span className={styles.btnIcon} aria-hidden="true"><ShareIcon size={14} /></span>
          <span className={styles.btnLabel}>{shareBusy ? 'Sharing...' : 'Share'}</span>
          <span className={styles.btnLabelMobile}>{shareBusy ? '...' : 'Share'}</span>
        </button>
        <ResponsiveMenu
          title="More"
          wrapClassName={styles.headerActionsMenu}
          align="right"
          trigger={({ toggle }) => (
            <button className={`${styles.headerBtn} ${styles.headerActionsTrigger}`} onClick={toggle} title="More">
              <span className={`${styles.btnIcon} ${styles.headerActionsGear}`} aria-hidden="true"><SettingsIcon size={14} /></span>
              <span className={styles.btnLabel}>More</span>
              <span className={styles.btnLabelMobile}>More</span>
            </button>
          )}
        >
          {args => renderDeckActionsMenu({ ...args, includeQuickActions: false })}
        </ResponsiveMenu>
      </div>
    </div>
  )

  return (
    <div className={`${styles.page}${showRight ? ' ' + styles.showRight : ''}${leftCollapsed ? ' ' + styles.leftCollapsed : ''}`}>
      {/* Mobile-only: Done bar at top of the left panel — returns to deck view */}
      <button
        type="button"
        className={styles.mobileLeftDone}
        onClick={() => setShowRight(true)}
        aria-label="Done — back to deck"
      >
        <ChevronLeftIcon size={14} />
        <span>Done</span>
      </button>

      {/* ── LEFT PANEL ─────────────────────────────────────────── */}
      <div className={styles.left}>
        {leftCollapsed && (
          <button
            type="button"
            className={styles.leftRail}
            onClick={() => setLeftCollapsed(false)}
            title="Expand search panel"
            aria-label="Expand search panel"
          >
            <ChevronRightIcon size={16} className={styles.leftRailArrow} />
            <span>Search</span>
          </button>
        )}
        <div className={styles.leftContent}>
        {/* Desktop-only left header — back link, format, visibility, quick actions */}
        <div className={`${styles.leftHeader} ${styles.deskOnly}`}>
          <div className={styles.leftHeaderTopRow}>
            <Link className={styles.backToDecks} to="/builder" title="Back to decks">
              <ChevronLeftIcon size={13} />
              <span>Back to Decks</span>
            </Link>
            <button
              type="button"
              className={styles.leftCollapseBtn}
              onClick={() => setLeftCollapsed(v => !v)}
              title="Collapse search panel"
              aria-label="Collapse search panel"
            >
              <CloseIcon size={14} />
            </button>
          </div>
          <div className={styles.formatVisibilityRow}>
            <div className={styles.formatCol}>
              <span className={styles.formatLabel}>Format</span>
              <Select
                className={styles.formatSelect}
                panelClassName={styles.formatSelectPanel}
                value={deckMeta.format || 'commander'}
                onChange={e => handleFormatChange(e.target.value)}
                title="Select format"
                portal
              >
                {FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </Select>
            </div>
            <div className={styles.visibilityCol}>
              <span className={styles.formatLabel}>Visibility</span>
              <Select
                className={styles.formatSelect}
                panelClassName={styles.formatSelectPanel}
                value={deckMeta.is_public ? 'public' : 'private'}
                onChange={e => setVisibility(e.target.value === 'public')}
                title="Select visibility"
                portal
              >
                <option value="private">Private</option>
                <option value="public">Public</option>
              </Select>
            </div>
          </div>
          <div className={styles.leftActionsSection}>
            <span className={styles.formatLabel}>Actions</span>
            <div className={styles.leftActionsRow}>
              {isEDH && (
                <button
                  className={`${styles.headerBtnPrimary} ${styles.headerBtnAssist} ${styles.leftActionBtn}`}
                  onClick={() => setShowBuildAssistant(true)}
                  title="Open the guided deck builder — fill each role from your collection"
                >
                  Build Assistant
                </button>
              )}
              {(isCollectionDeck || deckMeta.linked_deck_id) ? (
                <button className={`${styles.headerBtnPrimary} ${styles.leftActionBtn}`} onClick={() => setShowSync(true)} disabled={syncRunning} title="Sync collection">
                  {syncLabel}
                </button>
              ) : (
                <button className={`${styles.headerBtnPrimary} ${styles.leftActionBtn}`} onClick={() => setShowMakeDeck(true)} disabled={makeDeckRunning} title="Make Collection Deck">
                  {makeDeckRunning ? 'Creating...' : 'Make Collection Deck'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Mobile panel toggle — rendered outside the left panel so it stays visible */}
        <div className={styles.leftTop}>
          {/* Mobile toggle for format/commander — hidden on desktop via CSS */}
          <div className={styles.leftTopToggle} onClick={() => setLeftTopOpen(v => !v)}>
            <div className={styles.leftTopToggleSummary}>
              <span>{format?.label ?? 'Format'}</span>
              {commanderCard && <span className={styles.leftTopToggleCmdr}>&middot; {commanderCard.name}</span>}
            </div>
            <span className={styles.leftTopToggleChevron} aria-hidden="true">
              {leftTopOpen ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
            </span>
          </div>

          {/* Collapsible content — always visible on desktop, animated on mobile */}
          <div className={`${styles.leftTopContent} ${!leftTopOpen ? styles.leftTopContentCollapsed : ''}`}>
            {/* Format selector */}
            <div className={styles.formatRow}>
              <span className={styles.formatLabel}>Format</span>
              <Select
                className={styles.formatSelect}
                value={deckMeta.format || 'commander'}
                onChange={e => handleFormatChange(e.target.value)}
                title="Select format"
              >
                {FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </Select>
            </div>

            {/* Oathbreaker command zone — set from the deck list via each card's menu */}
            {isEDH && format?.id === 'oathbreaker' && (
              <div className={styles.cmdSection}>
                <div className={styles.cmdLabel}>Command Zone</div>
                {commanderCards.map(c => (
                  <div key={c.id} className={styles.cmdSelected}>
                    {c.image_uri && <img className={styles.cmdImg} src={c.image_uri} alt="" />}
                    <span className={styles.cmdName}>{c.name}</span>
                    <span className={styles.cmdChange}>{isOathbreaker(c) ? 'Oathbreaker' : isSignatureSpell(c) ? 'Signature Spell' : ''}</span>
                  </div>
                ))}
                <div className={styles.cmdHint}>
                  Add a planeswalker and an instant/sorcery to your deck, then use each card&apos;s menu → Set as Oathbreaker / Signature Spell.
                </div>
              </div>
            )}

            {/* Commander picker */}
            {isEDH && format?.id !== 'oathbreaker' && (
              <div className={styles.cmdSection}>
                <div className={styles.cmdLabel}>Commander</div>
                {commanderCard && !showCmdPicker ? (
                  <div className={styles.cmdSelected} onClick={() => setShowCmdPicker(true)}>
                    {commanderCard.image_uri && (
                      <img className={styles.cmdImg} src={commanderCard.image_uri} alt="" />
                    )}
                    <span className={styles.cmdName}>{commanderCard.name}</span>
                    <span className={styles.cmdChange}>change</span>
                  </div>
                ) : (
                  <div>
                    <input
                      autoFocus={showCmdPicker}
                      className={styles.cmdInput}
                      value={cmdQuery}
                      onChange={e => handleCmdQuery(e.target.value)}
                      onBlur={() => setTimeout(() => setShowCmdPicker(false), 200)}
                      placeholder="Search for a commander..."
                    />
                    {showCmdPicker && cmdResults.length > 0 && (
                      <div className={styles.cmdDropdown}>
                        {cmdResults.map(c => (
                          <div key={c.id} className={styles.cmdResult} onMouseDown={() => pickCommander(c)}>
                            {getCardImageUri(c, 'small') && (
                              <img className={styles.cmdResultImg} src={getCardImageUri(c, 'small')} alt="" />
                            )}
                            <div>
                              <div className={styles.cmdResultName}>{c.name}</div>
                              <div className={styles.cmdResultType}>{c.type_line}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Companion — applies to Commander and Constructed formats */}
            <div className={styles.cmdSection}>
              <div className={styles.cmdLabel}>Companion</div>
              {deckMeta.companion && !showCompPicker ? (
                <>
                  <div className={styles.cmdSelected} onClick={() => setShowCompPicker(true)}>
                    {deckMeta.companion.image_uri && (
                      <img className={styles.cmdImg} src={deckMeta.companion.image_uri} alt="" />
                    )}
                    <span className={styles.cmdName}>{deckMeta.companion.name}</span>
                    <span className={styles.cmdChange} onClick={e => { e.stopPropagation(); clearCompanion() }}>clear</span>
                  </div>
                  {companionValidation && (
                    <div className={`${styles.companionStatus} ${companionValidation.ok ? styles.companionOk : styles.companionBad}`}>
                      {companionValidation.ok
                        ? `Restriction met — ${companionValidation.note}`
                        : `${companionValidation.offenders.length} card${companionValidation.offenders.length === 1 ? '' : 's'} break the restriction: ${companionValidation.offenders.slice(0, 8).join(', ')}${companionValidation.offenders.length > 8 ? '…' : ''}`}
                    </div>
                  )}
                  {companionValidation && !companionValidation.ok && (
                    <div className={styles.cmdHint}>{companionValidation.note}</div>
                  )}
                </>
              ) : (
                <div>
                  <input
                    autoFocus={showCompPicker}
                    className={styles.cmdInput}
                    value={compQuery}
                    onChange={e => handleCompQuery(e.target.value)}
                    onBlur={() => setTimeout(() => setShowCompPicker(false), 200)}
                    placeholder="Search for a companion..."
                  />
                  {showCompPicker && compResults.length > 0 && (
                    <div className={styles.cmdDropdown}>
                      {compResults.map(c => (
                        <div key={c.id} className={styles.cmdResult} onMouseDown={() => setCompanion(c)}>
                          {getCardImageUri(c, 'small') && (
                            <img className={styles.cmdResultImg} src={getCardImageUri(c, 'small')} alt="" />
                          )}
                          <div>
                            <div className={styles.cmdResultName}>{c.name}</div>
                            <div className={styles.cmdResultType}>{c.type_line}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Public/private toggle — mobile only; desktop shows it in the left header */}
            <div className={`${styles.formatRow} ${styles.visibilityControlRow} ${styles.mobileOnly}`}>
              <span className={styles.formatLabel}>Visibility</span>
              <div className={styles.visibilityToggleRow}>
                <div
                  className={`${styles.toggleTrack} ${deckMeta.is_public ? styles.toggleTrackOn : ''}`}
                  onClick={togglePublic}
                >
                  <div className={styles.toggleThumb} />
                </div>
                <span className={`${styles.visibilityText} ${deckMeta.is_public ? styles.visibilityTextOn : ''}`}>
                  {deckMeta.is_public ? 'Public' : 'Private'}
                </span>
              </div>
            </div>

          </div>
        </div>

        {/* Tabs */}
        <div className={styles.tabBar}>
          <button className={`${styles.tab}${leftTab === 'search' ? ' ' + styles.tabActive : ''}`} onClick={() => setLeftTab('search')}>
            Search
          </button>
          <button
            className={`${styles.tab}${leftTab === 'recs' ? ' ' + styles.tabActive : ''}`}
            onClick={() => {
              setLeftTab('recs')
              if (isEDH && commanderCard) {
                const fmtId = format?.id || 'commander'
                const loaded = recsLoadedForRef.current
                // Reload when commander changes, when switching from/to Commander format,
                // or when no recs are loaded yet
                const needsReload = !recs?.categories
                  || !loaded
                  || loaded.commanderName !== commanderCard.name
                  || loaded.formatId !== fmtId
                if (needsReload) loadRecs(commanderCard.name, fmtId)
              }
            }}
          >
            Recommendations
          </button>
        </div>

        {/* Search panel */}
        {leftTab === 'search' && (
          <div className={styles.searchPanel}>
            <div className={styles.searchInputRow}>
              <input
                className={styles.searchInput}
                value={searchQuery}
                onChange={e => handleSearchInput(e.target.value)}
                placeholder="Search cards..."
              />
            </div>
            <div className={styles.searchResults}>
              {searchLoading && searchPage === 1 && <div className={styles.searchEmpty}>Searching...</div>}
              {!searchLoading && searchError && (
                <div className={styles.searchEmpty}>Scryfall is unavailable. Try again in a moment.</div>
              )}
              {!searchLoading && !searchError && searchResults.length === 0 && searchQuery && (
                <div className={styles.searchEmpty}>No results. Try a different query.</div>
              )}
              {!searchLoading && !searchError && searchResults.length === 0 && !searchQuery && (
                <div className={styles.searchEmpty}>Type a card name or keyword to search.</div>
              )}
              {searchResults.map(c => (
                <SearchResultRow
                  key={c.id}
                  card={c}
                  ownedQty={ownedMap.get(c.id) ?? 0}
                  legalityWarnings={getCardLegalityWarnings({
                    card: c,
                    formatId: format?.id || deckMeta.format,
                    formatLabel: format?.label,
                    isEDH,
                    commanderColorIdentity: colorIdentity,
                  })}
                  addFeedback={addFeedback?.key === (c.id || c.name) ? addFeedback : null}
                  onAdd={addCardToDeck}
                  onOpenDetail={openSearchCardDetail}
                  onHoverEnter={CAN_HOVER && !lastInputWasTouch ? handleSearchRowHoverEnter : undefined}
                  onHoverMove={CAN_HOVER ? handleSearchRowHoverMove : undefined}
                  onHoverLeave={CAN_HOVER ? handleSearchRowHoverLeave : undefined}
                />
              ))}
              {searchHasMore && (
                <button className={styles.loadMore} onClick={loadMoreSearch}>
                  {searchLoading ? 'Loading...' : 'Load more'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Recommendations panel */}
        {leftTab === 'recs' && (
          <div className={styles.recsPanel}>
            {!isEDH && <div className={styles.recsError}>Recommendations are available for Commander / EDH format.</div>}
            {isEDH && !commanderCard && <div className={styles.recsEmpty}>Pick a commander first to see recommendations.</div>}
            {isEDH && commanderCard && (
              <>
                <div className={styles.recsToolbar}>
                  <button
                    className={`${styles.recsToggleBtn}${recsOwnedOnly ? ' ' + styles.recsToggleActive : ''}`}
                    onClick={() => setRecsOwnedOnly(v => !v)}
                    title="Show only cards you own"
                  >
                    Owned only
                  </button>
                </div>
                {recsLoading && <div className={styles.recsLoading}>Loading recommendations...</div>}
                {recsError && <div className={styles.recsError}>Recommendations unavailable for this commander.</div>}
                {!recsLoading && !recsError && recs?.categories && (
                  <div className={styles.recsList}>
                    {recCategoriesFiltered.length === 0 && (
                      <div className={styles.recsEmpty}>
                        {format?.id && format.id !== 'commander'
                          ? `No ${format.label}-legal recommendations remain for this commander.`
                          : 'All recommended cards are already in your deck.'}
                      </div>
                    )}
                    {recCategoriesFiltered.map(cat => {
                      const collapsed = collapsedCats.has(cat.tag)
                      return (
                        <div key={cat.tag} className={styles.recsCatSection}>
                          <button
                            className={styles.recsCatHeader}
                            onClick={() => setCollapsedCats(prev => {
                              const next = new Set(prev)
                              next.has(cat.tag) ? next.delete(cat.tag) : next.add(cat.tag)
                              return next
                            })}
                          >
                            <span className={`${styles.groupArrow}${collapsed ? ' ' + styles.groupArrowCollapsed : ''}`} aria-hidden="true">
                              <ChevronDownIcon size={12} />
                            </span>
                            <span className={styles.recsCatName}>{cat.header}</span>
                            <span className={styles.recsCatCount}>{cat.cards.length}</span>
                          </button>
                          {!collapsed && cat.cards.map(rec => (
                            <RecRow
                              key={rec.name}
                              rec={rec}
                              imageUri={recImages[rec.name] || null}
                              ownedQty={ownedNameMap.get(rec.name.toLowerCase()) ?? 0}
                              onAdd={addCardToDeck}
                              onHoverEnter={CAN_HOVER && !lastInputWasTouch ? (uri, e) => { updateHoverPos(e.clientX, e.clientY); setHoverImages(uri ? [uri] : []) } : undefined}
                              onHoverMove={CAN_HOVER ? e => updateHoverPos(e.clientX, e.clientY) : undefined}
                              onHoverLeave={CAN_HOVER ? () => clearHoverPreview() : undefined}
                              onOpenDetail={openCardDetailByName}
                            />
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── RIGHT PANEL ────────────────────────────────────────── */}
      </div>
      <div className={styles.right}>
        {/* Right panel tab bar */}
        <div className={`${styles.tabBar} ${styles.rightTabBar}`}>
          {[
            { id: 'deck',   label: 'Deck',   badge: `${totalCards}/${deckSize}`, over: totalCards > deckSize },
            { id: 'stats',  label: 'Stats',  badge: null },
            { id: 'combos', label: 'Combos', badge: combosFetched ? String(combosIncluded.length) : null },
          ].filter(Boolean).map(({ id, label, badge, over }) => (
            <button
              key={id}
              className={`${styles.tab} ${styles.rightTab}${rightTab === id ? ' ' + styles.tabActive : ''}`}
              onClick={() => {
                setRightTab(id)
                if (id === 'stats') loadDeckGameResults()
                if (id === 'combos' && !combosFetched && !combosLoading && deckCards.length > 0) fetchCombos()
              }}
            >
              {label}
              {badge != null && (
                <span className={`${styles.tabBadge}${over ? ' ' + styles.tabBadgeOver : ''}`}>
                  {badge}
                </span>
              )}
            </button>
          ))}
          {/* Deck actions gear — desktop only; pinned to the always-visible tab bar
              so it never scrolls out of view with the banner. */}
          <div className={`${styles.tabBarGear} ${styles.deskOnly}`}>
            <ResponsiveMenu
              title="More"
              align="right"
              portal
              trigger={({ toggle }) => (
                <button className={styles.cmdArtGearBtn} onClick={toggle} title="More" aria-label="More">
                  <SettingsIcon size={15} />
                  <span>More</span>
                </button>
              )}
            >
              {args => renderDeckActionsMenu({ ...args, includeQuickActions: true })}
            </ResponsiveMenu>
          </div>
        </div>

        {visibleDeckWarnings.length > 0 && (() => {
          const errorCount = visibleDeckWarnings.filter(w => w.level === 'error').length
          const summary = `${visibleDeckWarnings.length} ${visibleDeckWarnings.length === 1 ? 'warning' : 'warnings'}`
          const details = visibleDeckWarnings.map(w => w.summary || w.text)
          const showTooltip = (x, y) => setWarningTooltip({ summary, details, x, y })
          const hideTooltip = () => setWarningTooltip(null)
          return (
            <div className={styles.warningPanel}>
              <button
                type="button"
                className={`${styles.warningSummaryBtn}${errorCount > 0 ? ' ' + styles.warningSummaryBtnError : ''}`}
                onMouseEnter={CAN_HOVER ? e => showTooltip(e.clientX, e.clientY) : undefined}
                onMouseMove={CAN_HOVER ? e => setWarningTooltip(prev => prev ? { ...prev, x: e.clientX, y: e.clientY } : prev) : undefined}
                onMouseLeave={CAN_HOVER ? hideTooltip : undefined}
                onFocus={CAN_HOVER ? e => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  showTooltip(rect.left, rect.bottom)
                } : undefined}
                onBlur={CAN_HOVER ? hideTooltip : undefined}
                onClick={!CAN_HOVER ? e => {
                  if (warningTooltip) { hideTooltip(); return }
                  const rect = e.currentTarget.getBoundingClientRect()
                  showTooltip(rect.left, rect.bottom)
                } : undefined}
              >
                <span className={styles.warningSummaryIcon} aria-hidden="true">!</span>
                <span className={styles.warningSummaryLabel}>{summary}</span>
              </button>
            </div>
          )
        })()}

        {/* Deck list tab */}
        <div
          ref={deckListScrollRef}
          className={`${styles.deckList}${rightTab !== 'deck' ? ' ' + styles.tabPaneHidden : ''}`}
        >
            {renderDeckHeader(styles.deckHeaderMobile)}

            {/* Art banner — deck name always shown; commander art + names when set */}
            <div className={`${styles.cmdArt}${commanderCards.length === 0 ? ' ' + styles.cmdArtNoCmdr : ''}`}>
              {/* Blurred background layer — falls back to a plain gradient with no commander */}
              {commanderCards.length > 0 && (
                <div className={styles.cmdArtBg}
                  style={{ backgroundImage: `url(${toArtCropImg(commanderCards[0].image_uri)})` }} />
              )}
              {/* Art thumbnail — single pane; two commanders blend into one merged image
                  (same crossfade technique as the deck-tile art on the Builder index). */}
              {commanderCards.length > 0 && (
                <div
                  className={styles.cmdArtPane}
                  {...(commanderCards.length === 1
                    ? { onClick: () => openDeckCardDetail(commanderCards[0]), title: 'Click to view card details' }
                    : {})}
                >
                  {commanderCards.length === 1 ? (
                    commanderCards[0].image_uri
                      ? <img className={styles.cmdArtImg} src={toArtCropImg(commanderCards[0].image_uri)} alt={commanderCards[0].name} />
                      : <div className={styles.cmdArtImgPlaceholder} />
                  ) : (
                    commanderCards.map((card, i) => {
                      const isPair = commanderCards.length === 2
                      return (
                        <div
                          key={card.id}
                          className={styles.cmdArtSlice}
                          style={{
                            left: isPair ? (i === 0 ? '0%' : '42%') : `${(i / commanderCards.length) * 100}%`,
                            width: isPair ? '58%' : `${100 / commanderCards.length}%`,
                            backgroundImage: card.image_uri ? `url(${toArtCropImg(card.image_uri)})` : undefined,
                          }}
                          onClick={() => openDeckCardDetail(card)}
                          title={`Click to view ${card.name}`}
                        />
                      )
                    })
                  )}
                </div>
              )}
              {/* Info panel */}
              <div className={styles.cmdArtOverlay}>
                <div className={styles.cmdArtInfo}>
                  <div className={styles.cmdArtNameRow}>
                    <input
                      className={styles.cmdArtNameInput}
                      value={deckName}
                      onChange={e => setDeckName(e.target.value)}
                      onBlur={saveNameBlur}
                      maxLength={100}
                    />
                    {saving && <span className={styles.savingDot} />}
                  </div>
                  {colorIdentity.length > 0 && (
                    <div className={styles.cmdColorPips}>
                      {colorIdentity.map(c => (
                        <img key={c} src={manaSymbolUrl(`{${c}}`)} alt={c} width={18} height={18}
                          style={{ display: 'block', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.7))' }} />
                      ))}
                    </div>
                  )}
                  {(commanderCards.length > 0 || deckMeta.companion) && (
                    <span className={styles.cmdArtCommander}>
                      {commanderCards.map(c => c.name).join(' & ')}
                      {commanderCards.length > 0 && deckMeta.companion && ' · '}
                      {deckMeta.companion && `${deckMeta.companion.name} (Companion)`}
                    </span>
                  )}
                  <div className={styles.cmdArtMeta}>
                    {format && <span>{format.label}</span>}
                    {totalDeckPrice > 0 && <span style={{ color: 'var(--green)' }}>{formatPrice(totalDeckPrice, price_source)}</span>}
                  </div>
                  {isEDH && bracketAnalysis && (
                    <div className={styles.cmdArtBracketRow}>
                      <BracketBadge
                        analysis={bracketAnalysis}
                        bracket={effectiveBracket}
                        isOverridden={statsBracketOverride != null}
                        variant="onArt"
                        onOverride={(n) => {
                          setStatsBracketOverride(n)
                          logDeckChange(deckId, user?.id, 'Bracket', n == null ? 'Reset to auto' : `Set to ${n}`)
                        }}
                        combos={{ fetched: combosFetched, loading: combosLoading, nameLists: comboNameLists, onCheck: fetchCombos }}
                      />
                    </div>
                  )}
                </div>

                {/* Description + Tags — free space to the right (desktop only) */}
                <div className={`${styles.cmdArtNotes} ${styles.deskOnly}`}>
                  <textarea
                    className={styles.deckMetaDesc}
                    value={cmdDescription}
                    onChange={e => setCmdDescription(e.target.value)}
                    onBlur={e => saveDescription(e.target.value)}
                    placeholder="Add description..."
                    rows={3}
                    maxLength={1000}
                  />
                  <div className={styles.deckMetaTagRow}>
                    {cmdTags.map(tag => (
                      <span key={tag} className={styles.deckMetaTag}>
                        {tag}
                        <button className={styles.deckMetaTagRemove} onClick={() => removeTag(tag)}><CloseIcon size={13} /></button>
                      </span>
                    ))}
                    <input
                      className={styles.deckMetaTagInput}
                      value={newTagInput}
                      onChange={e => setNewTagInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(newTagInput) } }}
                      onBlur={() => { if (newTagInput.trim()) addTag(newTagInput) }}
                      placeholder={cmdTags.length === 0 ? 'Add tags...' : '+'}
                      maxLength={30}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Description + Tags — mobile only (no room for it in the compact banner) */}
            {(cmdDescription.trim() || cmdTags.length > 0) && (
            <div className={`${styles.deckMetaPanel} ${styles.mobileOnly}`}>
              <textarea
                className={styles.deckMetaDesc}
                value={cmdDescription}
                onChange={e => setCmdDescription(e.target.value)}
                onBlur={e => saveDescription(e.target.value)}
                placeholder="Add description..."
                rows={3}
                maxLength={1000}
              />
              <div className={styles.deckMetaTagRow}>
                {cmdTags.map(tag => (
                  <span key={tag} className={styles.deckMetaTag}>
                    {tag}
                    <button className={styles.deckMetaTagRemove} onClick={() => removeTag(tag)}><CloseIcon size={13} /></button>
                  </span>
                ))}
                <input
                  className={styles.deckMetaTagInput}
                  value={newTagInput}
                  onChange={e => setNewTagInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(newTagInput) } }}
                  onBlur={() => { if (newTagInput.trim()) addTag(newTagInput) }}
                  placeholder={cmdTags.length === 0 ? 'Add tags...' : '+'}
                  maxLength={30}
                />
              </div>
            </div>
            )}

            {/* View / Sort / Group toolbar */}
            {deckCards.length > 0 && (
              <div className={styles.deckToolbar}>
                <ResponsiveMenu
                  title="View Style"
                  wrapClassName={`${styles.columnMenuWrap} ${styles.deskOnly}`}
                  portal
                  trigger={({ toggle }) => {
                    const ViewIcon = (
                      deckView === 'compact' ? TableViewIcon :
                      deckView === 'stacks'  ? StacksViewIcon :
                      deckView === 'grid'    ? GridViewIcon :
                      ListViewIcon
                    )
                    return (
                      <button
                        className={`${styles.groupToggle} ${styles.groupToggleIcon}`}
                        onClick={toggle}
                        title="View style"
                        aria-label="View style"
                      >
                        <ViewIcon size={15} />
                        <span className={styles.toggleLabel}>View</span>
                      </button>
                    )
                  }}
                >
                  {({ close }) => (
                    <div className={uiStyles.responsiveMenuList}>
                      {[
                        ['list',    'List',    ListViewIcon],
                        ['compact', 'Compact', TableViewIcon],
                        ['stacks',  'Stacks',  StacksViewIcon],
                        ['grid',    'Grid',    GridViewIcon],
                      ].map(([v, label, ViewIcon]) => (
                        <button
                          key={v}
                          className={`${styles.columnMenuItem} ${deckView === v ? styles.columnMenuItemActive : ''}`}
                          onClick={() => { setDeckView(v); close?.() }}
                        >
                          <ViewIcon size={13} />
                          <span className={styles.columnMenuLabel}>{label}</span>
                          <span className={styles.columnMenuCheck} aria-hidden="true">
                            {deckView === v ? <CheckIcon size={11} /> : ''}
                          </span>
                        </button>
                      ))}
                      <div className={styles.menuDivider} />
                      <button
                        className={styles.columnMenuItem}
                        onClick={() => { addCustomCategory(); close?.() }}
                      >
                        <span className={styles.columnMenuLabel}>Add Category</span>
                        <AddIcon size={12} />
                      </button>
                    </div>
                  )}
                </ResponsiveMenu>
                <ResponsiveMenu
                  title="Sort By"
                  wrapClassName={styles.columnMenuWrap}
                  portal
                  trigger={({ toggle }) => (
                    <button
                      className={`${styles.groupToggle} ${styles.groupToggleIcon}${deckSort ? ' '+styles.groupToggleActive : ''}`}
                      onClick={toggle}
                      title="Sort cards"
                      aria-label="Sort cards"
                    >
                      <SortIcon size={15} />
                      <span className={styles.toggleLabel}>Sort</span>
                    </button>
                  )}
                >
                  {({ close }) => (
                    <div className={uiStyles.responsiveMenuList}>
                      {[['type','Type'],['color','Color'],['name','Name A→Z'],['name_desc','Name Z→A'],['cmc_asc','Mana Value ↑'],['cmc_desc','Mana Value ↓'],['rarity_desc','Rarity ↓'],['rarity_asc','Rarity ↑'],['price_desc','Price ↓'],['price_asc','Price ↑'],['set','Set']].map(([s, label]) => (
                        <button
                          key={s}
                          className={`${styles.columnMenuItem} ${deckSort === s ? styles.columnMenuItemActive : ''}`}
                          onClick={() => { setDeckSort(s); close?.() }}
                        >
                          <span className={styles.columnMenuLabel}>{label}</span>
                          <span className={styles.columnMenuCheck} aria-hidden="true">
                            {deckSort === s ? <CheckIcon size={11} /> : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </ResponsiveMenu>
                <ResponsiveMenu
                  title="Group By"
                  wrapClassName={styles.columnMenuWrap}
                  portal
                  trigger={({ toggle }) => (
                    <button
                      className={`${styles.groupToggle} ${styles.groupToggleIcon}${groupBy !== 'none' ? ' '+styles.groupToggleActive : ''}`}
                      onClick={toggle}
                      title="Group cards"
                      aria-label="Group cards"
                    >
                      <GridViewIcon size={15} />
                      <span className={styles.toggleLabel}>Group</span>
                    </button>
                  )}
                >
                  {({ close }) => (
                    <div className={uiStyles.responsiveMenuList}>
                      {[['none','None'],['type','By Type'],['category','By Category'],['cmc','By Mana Value'],['color','By Color'],['rarity','By Rarity'],['set','By Set']].map(([v, label]) => (
                        <button
                          key={v}
                          className={`${styles.columnMenuItem} ${groupBy === v ? styles.columnMenuItemActive : ''}`}
                          onClick={() => { setGroupBy(v); close?.() }}
                        >
                          <span className={styles.columnMenuLabel}>{label}</span>
                          <span className={styles.columnMenuCheck} aria-hidden="true">
                            {groupBy === v ? <CheckIcon size={11} /> : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </ResponsiveMenu>
                <ResponsiveMenu
                  title="Filter Deck"
                  wrapClassName={`${styles.columnMenuWrap} ${styles.deckFilterMenuWrap} ${styles.deskOnly}`}
                  portal
                  trigger={({ toggle }) => {
                    const activeCount = countActiveCardFilters(deckFilters)
                      + (deckSearch.trim() ? 1 : 0) + (boardFilter !== 'all' ? 1 : 0)
                    return (
                      <button
                        className={`${styles.groupToggle} ${styles.groupToggleIcon}${activeCount ? ' '+styles.groupToggleActive : ''}`}
                        onClick={toggle}
                        title="Filter deck"
                        aria-label="Filter deck"
                      >
                        <SearchIcon size={15} />
                        <span className={styles.toggleLabel}>Filter</span>
                        {activeCount > 0 && <span className={styles.filterCountBadge}>{activeCount}</span>}
                      </button>
                    )
                  }}
                >
                  {() => (
                    <DeckFilterPanel
                      filters={deckFilters}
                      setFilters={setDeckFilters}
                      boardFilter={boardFilter}
                      setBoardFilter={setBoardFilter}
                      showSearch
                      deckSearch={deckSearch}
                      setDeckSearch={setDeckSearch}
                    />
                  )}
                </ResponsiveMenu>
                {(deckView === 'list' || deckView === 'compact') && (
                  <ResponsiveMenu
                    title="Visible Columns"
                    wrapClassName={`${styles.columnMenuWrap} ${styles.deskOnly}`}
                    portal
                    trigger={({ toggle }) => (
                      <button
                        className={`${styles.groupToggle} ${styles.groupToggleIcon}`}
                        onClick={toggle}
                        title="Visible columns"
                        aria-label="Visible columns"
                      >
                        <SettingsIcon size={15} />
                        <span className={styles.toggleLabel}>Columns</span>
                      </button>
                    )}
                  >
                    {() => (
                      <div className={uiStyles.responsiveMenuList}>
                          {[
                            ['set', 'Set'],
                            ['manaValue', 'Mana Value'],
                            ['cmc', 'CMC'],
                            ['price', 'Price'],
                            ['status', 'Status'],
                            ['actions', 'Actions'],
                            ['qty', 'Qty'],
                            ['remove', 'Remove'],
                          ].map(([key, label]) => (
                            <label key={key} className={`${styles.columnMenuItem} ${activeColumns[key] ? styles.columnMenuItemActive : ''}`}>
                              <input
                                type="checkbox"
                                className={styles.columnMenuCheckbox}
                                checked={activeColumns[key]}
                                onChange={() => setActiveColumns(prev => ({ ...prev, [key]: !prev[key] }))}
                              />
                              <span className={styles.columnMenuLabel}>{label}</span>
                              <span className={styles.columnMenuCheck} aria-hidden="true">
                                {activeColumns[key] ? <CheckIcon size={11} /> : ''}
                              </span>
                            </label>
                          ))}
                        </div>
                    )}
                  </ResponsiveMenu>
                )}
                {/* Mobile-only: Add / Recs / Settings — gateways to left panel */}
                <button
                  className={`${styles.groupToggle} ${styles.groupToggleIcon} ${styles.pillOnly}`}
                  onClick={() => { setLeftTab('search'); setShowRight(false) }}
                  title="Add cards"
                  aria-label="Add cards"
                >
                  <AddIcon size={15} />
                  <span className={styles.toggleLabel}>Add</span>
                </button>
                {/* Mobile-only: Sync / Make Deck + Deck Actions copies */}
                {(isCollectionDeck || deckMeta.linked_deck_id) && (
                  <button
                    className={`${styles.groupToggle} ${styles.groupToggleIcon} ${styles.pillOnly}`}
                    onClick={() => setShowSync(true)}
                    disabled={syncRunning}
                    title="Sync collection"
                    aria-label="Sync collection"
                  >
                    <SyncIcon size={15} />
                    <span className={styles.toggleLabel}>Sync</span>
                  </button>
                )}
                {!isCollectionDeck && !deckMeta.linked_deck_id && (
                  <button
                    className={`${styles.groupToggle} ${styles.groupToggleIcon} ${styles.pillOnly}`}
                    onClick={() => setShowMakeDeck(true)}
                    disabled={makeDeckRunning}
                    title="Make Collection Deck"
                    aria-label="Make Collection Deck"
                  >
                    <DeckIcon size={15} />
                    <span className={styles.toggleLabel}>Make</span>
                  </button>
                )}
                <ResponsiveMenu
                  title="More"
                  wrapClassName={`${styles.columnMenuWrap} ${styles.pillOnly}`}
                  portal
                  trigger={({ toggle }) => (
                    <button
                      className={`${styles.groupToggle} ${styles.groupToggleIcon}`}
                      onClick={toggle}
                      title="More"
                      aria-label="More"
                    >
                      <MenuIcon size={15} />
                      <span className={styles.toggleLabel}>More</span>
                    </button>
                  )}
                >
                  {renderDeckActionsMenu}
                </ResponsiveMenu>
              </div>
            )}

            {deckCards.length > 0 && (
              <div className={styles.deckFilterBar}>
                <input
                  className={styles.deckSearchInput}
                  value={deckSearch}
                  onChange={e => setDeckSearch(e.target.value)}
                  placeholder="Search deck..."
                />
                {/* Funnel button: full filter panel (board + colors/type/rarity/CMC) */}
                <ResponsiveMenu
                  title="Filter Deck"
                  wrapClassName={styles.filterFunnelWrap}
                  portal
                  align="right"
                  trigger={({ toggle }) => {
                    const activeCount = countActiveCardFilters(deckFilters) + (boardFilter !== 'all' ? 1 : 0)
                    return (
                      <button
                        className={`${styles.filterFunnelBtn}${activeCount ? ' ' + styles.filterFunnelActive : ''}`}
                        onClick={toggle}
                        title="Filter deck"
                        aria-label="Filter deck"
                      >
                        <FilterIcon size={15} />
                        {activeCount > 0 && <span className={styles.filterCountBadge}>{activeCount}</span>}
                      </button>
                    )
                  }}
                >
                  {() => (
                    <DeckFilterPanel
                      filters={deckFilters}
                      setFilters={setDeckFilters}
                      boardFilter={boardFilter}
                      setBoardFilter={setBoardFilter}
                    />
                  )}
                </ResponsiveMenu>
                <div className={`${styles.boardFilterGroup} ${styles.mobileOnly}`}>
                  {BOARD_FILTERS.map(filter => (
                    <button
                      key={filter.id}
                      className={`${styles.boardFilterBtn}${boardFilter === filter.id ? ' ' + styles.boardFilterBtnActive : ''}`}
                      onClick={() => setBoardFilter(filter.id)}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
                <div className={`${styles.filterBarRow} ${styles.mobileOnly}`}>
                <ResponsiveMenu
                  title="View Style"
                  wrapClassName={styles.filterBarMenuWrap}
                  portal
                  trigger={({ toggle }) => {
                    const viewLabel = (
                      deckView === 'compact' ? 'Compact' :
                      deckView === 'stacks'  ? 'Stacks' :
                      deckView === 'grid'    ? 'Grid' :
                      'List'
                    )
                    return (
                      <button
                        className={styles.filterBarTextBtn}
                        onClick={toggle}
                        title="View style"
                      >
                        {viewLabel}
                        <ChevronDownIcon size={11} />
                      </button>
                    )
                  }}
                >
                  {({ close }) => (
                    <div className={uiStyles.responsiveMenuList}>
                      {[
                        ['list',    'List',    ListViewIcon],
                        ['compact', 'Compact', TableViewIcon],
                        ['stacks',  'Stacks',  StacksViewIcon],
                        ['grid',    'Grid',    GridViewIcon],
                      ].map(([v, label, ViewIcon]) => (
                        <button
                          key={v}
                          className={`${styles.columnMenuItem} ${deckView === v ? styles.columnMenuItemActive : ''}`}
                          onClick={() => { setDeckView(v); close?.() }}
                        >
                          <ViewIcon size={13} />
                          <span className={styles.columnMenuLabel}>{label}</span>
                          <span className={styles.columnMenuCheck} aria-hidden="true">
                            {deckView === v ? <CheckIcon size={11} /> : ''}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </ResponsiveMenu>
                {(deckView === 'list' || deckView === 'compact') && (
                  <ResponsiveMenu
                    title="Visible Columns"
                    wrapClassName={styles.filterBarMenuWrap}
                    portal
                    trigger={({ toggle }) => (
                      <button
                        className={styles.filterBarTextBtn}
                        onClick={toggle}
                        title="Visible columns"
                      >
                        Columns
                        <ChevronDownIcon size={11} />
                      </button>
                    )}
                  >
                    {() => (
                      <div className={uiStyles.responsiveMenuList}>
                        {[
                          ['set', 'Set'],
                          ['manaValue', 'Mana Value'],
                          ['cmc', 'CMC'],
                          ['price', 'Price'],
                          ['status', 'Status'],
                          ['actions', 'Actions'],
                          ['qty', 'Qty'],
                          ['remove', 'Remove'],
                        ].map(([key, label]) => (
                          <label key={key} className={`${styles.columnMenuItem} ${activeColumns[key] ? styles.columnMenuItemActive : ''}`}>
                            <input
                              type="checkbox"
                              className={styles.columnMenuCheckbox}
                              checked={activeColumns[key]}
                              onChange={() => setActiveColumns(prev => ({ ...prev, [key]: !prev[key] }))}
                            />
                            <span className={styles.columnMenuLabel}>{label}</span>
                            <span className={styles.columnMenuCheck} aria-hidden="true">
                              {activeColumns[key] ? <CheckIcon size={11} /> : ''}
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </ResponsiveMenu>
                )}
                </div>
              </div>
            )}

            {deckCards.length === 0 && (
              <div style={{ color: 'var(--text-faint)', fontSize: '0.85rem', padding: '24px 0', textAlign: 'center' }}>
                Add cards using the search on the left.
              </div>
            )}

            {deckCards.length > 0 && visibleDeckCards.length === 0 && (
              <div style={{ color: 'var(--text-faint)', fontSize: '0.85rem', padding: '24px 0', textAlign: 'center' }}>
                No cards match the current deck filters.
              </div>
            )}

            {/* Render cards - supports all view x sort x group combinations */}
            {visibleDeckCards.length > 0 && (
              <div
                className={deckView === 'list' ? `${styles.deckListWide} ${styles.deckListTableScroller}` : undefined}
                style={deckView === 'list' ? { '--deck-list-min-width': listGridMinWidth, '--deck-list-columns': listGridTemplate } : undefined}
              >
              {(() => {
              const deckRowProps = (dc) => {
                return {
                dc,
                ...getCardOwnershipProps(dc),
                onChangeQty: changeQty,
                onRemove:    removeCardFromDeck,
                onMouseEnter: CAN_HOVER ? (e) => showHoverPreviewForDeckCard(dc, e) : undefined,
                onMouseLeave: CAN_HOVER ? () => clearHoverPreview() : undefined,
                onMouseMove:  CAN_HOVER ? (e) => updateHoverPos(e.clientX, e.clientY) : undefined,
                onContextMenu: (e) => openDeckCardContextMenu(dc, e),
                touchContextMenuHandlers: bindTouchContextMenu(e => openDeckCardContextMenu(dc, e)),
                onDragStart: (e) => handleCardDragStart(dc, e),
                onPickVersion: (card, options = {}) => setVersionPickCard({ ...card, ...options }),
                onToggleFoil:  toggleFoil,
                onSetCommander: setCardAsCommander,
                onMoveBoard: moveCardToBoard,
                onOpenCategoryPicker: setCategoryPickCard,
                isEDH,
                formatId: format?.id,
                visibleColumns,
                listGridTemplate,
                listGridMinWidth,
                priceLabel: getDeckCardPriceLabel(dc),
                onOpenDetail: openDeckCardDetail,
                legalityWarnings: deckCardLegalityWarnings.get(dc.id) || [],
                builderSfMap,
                };
              }

              const renderCard = (dc, stackContext = null) => {
                if (deckView === 'list') return <DeckCardRow key={dc.id} {...deckRowProps(dc)} />
                const legalityWarnings = deckCardLegalityWarnings.get(dc.id) || []
                const warningTitle = legalityWarnings.map(w => w.text).join('\n')
                return (
                  <DeckCard
                    key={dc.id}
                    view={deckView}
                    dc={dc}
                    stackContext={stackContext}
                    legalityWarnings={legalityWarnings}
                    warningTitle={warningTitle}
                    compactVisibleColumns={compactVisibleColumns}
                    canHover={CAN_HOVER}
                    lastInputWasTouch={lastInputWasTouch}
                    stackHoverState={stackHoverState}
                    touchActiveStack={touchActiveStack}
                    setStackHoverState={setStackHoverState}
                    setTouchActiveStack={setTouchActiveStack}
                    priceLabel={getDeckCardPriceLabel(dc)}
                    ownership={getCardOwnershipProps(dc)}
                    isEDH={isEDH}
                    formatId={format?.id}
                    builderSfMap={builderSfMap}
                    onChangeQty={changeQty}
                    onRemove={removeCardFromDeck}
                    onOpenDetail={openDeckCardDetail}
                    onContextMenu={openDeckCardContextMenu}
                    onDragStart={handleCardDragStart}
                    onHoverEnter={showHoverPreviewForDeckCard}
                    onHoverLeave={clearHoverPreview}
                    onHoverMove={updateHoverPos}
                    onPickVersion={(card, options = {}) => setVersionPickCard({ ...card, ...options })}
                    onToggleFoil={toggleFoil}
                    onSetCommander={setCardAsCommander}
                    onMoveBoard={moveCardToBoard}
                    onOpenCategoryPicker={setCategoryPickCard}
                  />
                )
              }

              const renderListHeader = () => deckView === 'list' && (
                <div className={styles.deckListHeader} style={{ '--deck-list-columns': listGridTemplate, '--deck-list-min-width': listGridMinWidth }}>
                  <span className={styles.deckListHeaderCard}>Card</span>
                  {visibleColumns.set && <span className={styles.deckListHeaderSet}>Set</span>}
                  {visibleColumns.manaValue && <span className={styles.deckListHeaderMetric}>Mana Value</span>}
                  {visibleColumns.cmc && <span className={styles.deckListHeaderMetric}>CMC</span>}
                  {visibleColumns.price && <span className={styles.deckListHeaderMetric}>Price</span>}
                  {visibleColumns.status && <span className={styles.deckListHeaderStatus}>Status</span>}
                  {visibleColumns.qty && <span className={styles.deckListHeaderQty}>Qty</span>}
                  {visibleColumns.actions && <span className={styles.deckListHeaderActions} aria-label="Actions" />}
                  {visibleColumns.remove && <span className={styles.deckListHeaderRemove} aria-label="Remove" />}
                </div>
              )

              // getDeckCardGroup / getCategoryRow / getCategoryOrder are hoisted
              // to component scope as useCallback so they aren't reconstructed
              // on every render. See definitions near categoryNameOrder above.

              const renderStacks = (cards, board) => {
                const groupOrder = getGroupOrder(cards)

                const groups = groupBy !== 'none'
                  ? groupOrder
                      .map(group => {
                        const groupCards = cards.filter(dc => getDeckCardGroup(dc) === group)
                        return groupCards.length ? { group, cards: groupCards } : null
                      })
                      .filter(Boolean)
                  : [{ group: BOARD_LABELS[board], cards }]

                return (
                  <div className={styles.stacksWrap}>
                    {groups.map(({ group, cards: groupCards }) => {
                      const groupQty = groupCards.reduce((s, dc) => s + dc.qty, 0)
                      const collapsedKey = `${board}:stack:${group}`
                      const collapsed = collapsedGroups.has(collapsedKey)
                      return (
                        <div key={collapsedKey} className={styles.stackColumn} onDragOver={groupBy === 'category' ? e => e.preventDefault() : undefined} onDrop={groupBy === 'category' ? e => handleCategoryDrop(group, e) : undefined}>
                          <div className={styles.stackGroup}>
                            <DeckCategoryHeader
                              group={group}
                              groupQty={groupQty}
                              collapsed={collapsed}
                              collapsedKey={collapsedKey}
                              isStacksView
                              isCategoryGroup={groupBy === 'category'}
                              draggedCategoryId={draggedCategoryId}
                              category={getCategoryRow(group)}
                              isDefaultCategory={CAT_ORDER.includes(group) || group === UNCATEGORIZED}
                              groupOrder={groupOrder}
                              onToggleCollapsed={toggleGroupCollapsed}
                              onDragStart={e => onCategoryHeaderDragStart(e, group)}
                              onDrop={onCategoryHeaderDrop}
                              onMoveCategory={moveRenderedCategory}
                              onRenameCategory={renameCustomCategory}
                              onDeleteCategory={removeCustomCategory}
                            />
                            {!collapsed && <div className={styles.stackCards}>{groupCards.map((dc, idx) => renderCard(dc, { group, idx }))}</div>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              }

              const renderCardSet = (cards, board) => {
                if (deckView === 'stacks') return renderStacks(cards, board)

                if (groupBy !== 'none') {
                  const baseOrder = getGroupOrder(cards)
                  const groupMap = new Map(baseOrder.map(g => [g, []]))
                  for (const dc of cards) {
                    const g = getDeckCardGroup(dc)
                    if (!groupMap.has(g)) groupMap.set(g, [])
                    groupMap.get(g).push(dc)
                  }
                  return [...groupMap.entries()].map(([group, groupCards]) => {
                    if (!groupCards?.length) return null
                    const groupQty = groupCards.reduce((s, dc) => s + dc.qty, 0)
                    const groupPrice = groupCards.reduce((sum, dc) => {
                      const sf = builderSfMap[getScryfallKey(dc)]
                      const p = sf ? getPrice(sf, dc.foil, { price_source }) : null
                      return sum + (p != null ? p * (dc.qty || 1) : 0)
                    }, 0)
                    const collapsedKey = `${board}:${group}`
                    const collapsed = collapsedGroups.has(collapsedKey)
                    const groupColor = groupBy === 'category' ? CAT_COLORS[group] : groupBy === 'rarity' ? RARITY_COLORS[group] : undefined
                    return (
                      <DeckCardSection
                        key={collapsedKey}
                        cards={groupCards}
                        view={deckView}
                        visualMin={visualCardMinWidth}
                        collapsed={collapsed}
                        collapsedKey={collapsedKey}
                        isCategoryGroup={groupBy === 'category'}
                        onCardDrop={e => handleCategoryDrop(group, e)}
                        renderCard={renderCard}
                        renderListHeader={renderListHeader}
                        header={
                          <DeckCategoryHeader
                            group={group}
                            groupQty={groupQty}
                            groupPrice={groupPrice}
                            groupColor={groupColor}
                            collapsed={collapsed}
                            collapsedKey={collapsedKey}
                            isCategoryGroup={groupBy === 'category'}
                            draggedCategoryId={draggedCategoryId}
                            category={getCategoryRow(group)}
                            isDefaultCategory={CAT_ORDER.includes(group) || group === UNCATEGORIZED}
                            groupOrder={baseOrder}
                            priceSource={price_source}
                            onToggleCollapsed={toggleGroupCollapsed}
                            onDragStart={e => onCategoryHeaderDragStart(e, group)}
                            onDrop={onCategoryHeaderDrop}
                            onMoveCategory={moveRenderedCategory}
                            onRenameCategory={renameCustomCategory}
                            onDeleteCategory={removeCustomCategory}
                          />
                        }
                      />
                    )
                  })
                }

                if (deckView === 'grid') {
                  return <div className={styles.visualGrid} style={{ '--deckbuilder-grid-min': `${visualCardMinWidth}px` }}>{cards.map(dc => renderCard(dc))}</div>
                }

                return (
                  <>
                    {renderListHeader()}
                    {cards.map(dc => renderCard(dc))}
                  </>
                )
              }

              return BOARD_ORDER.map(board => {
                const cards = sortedDeckCards.filter(dc => normalizeBoard(dc.board) === board)
                if (!cards.length) return null
                const boardQty = cards.reduce((sum, dc) => sum + (dc.qty || 0), 0)
                return (
                  <section key={board} className={styles.boardSection}>
                    <div className={styles.boardHeader}>
                      <span className={styles.boardName}>{BOARD_LABELS[board]}</span>
                      <span className={styles.boardCount}>{boardQty}</span>
                    </div>
                    {renderCardSet(cards, board)}
                  </section>
                )
              })
            })()}
              </div>
            )}
        </div>

        {/* Stats tab */}
        {rightTab === 'stats' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* ── Winrate section ── */}
            <DeckWinrateMini results={deckGameResults} loading={deckGameResultsLoading} deckName={deckName} />

            {/* ── Deck composition stats ── */}
            {deckCards.length > 0
              ? <DeckStats
                  cards={normalizedStatsCards}
                  price_source={price_source}
                  bracketOverride={statsBracketOverride}
                  onBracketOverride={(n) => {
                    setStatsBracketOverride(n)
                    logDeckChange(deckId, user?.id, 'Bracket', n == null ? 'Reset to auto' : `Set to ${n}`)
                  }}
                  showBracket={isEDH}
                  bracketAnalysis={bracketAnalysis}
                  gameChangerNames={gameChangerNames}
                  combos={{ fetched: combosFetched, loading: combosLoading, nameLists: comboNameLists, onCheck: fetchCombos }}
                />
              : <div style={{ color: 'var(--text-faint)', fontSize: '0.85rem', padding: '20px 0', textAlign: 'center' }}>
                  Add cards to see deck stats.
                </div>
            }

          </div>
        )}

        {/* Combos tab */}
        {rightTab === 'combos' && (
          <CombosTab
            deckCards={deckCards}
            combosFetched={combosFetched}
            combosLoading={combosLoading}
            combosIncluded={combosIncluded}
            combosAlmost={combosAlmost}
            comboSectionsOpen={comboSectionsOpen}
            onToggleSection={toggleComboSection}
            onFetchCombos={fetchCombos}
            onAddCard={addCardToDeck}
            onOpenDetail={openCardDetailByName}
            deckImagesMap={deckImagesMap}
          />
        )}

      </div>

      {/* Make Deck modal */}
      {showMakeDeck && (
        <MakeDeckModal
          deckCards={deckCards}
          userId={user.id}
          onConfirm={handleMakeDeck}
          onClose={() => setShowMakeDeck(false)}
        />
      )}

      {confirmState && (
        <div className={styles.confirmOverlay} onClick={() => handleConfirm(false)}>
          <div className={styles.confirmDialog} onClick={e => e.stopPropagation()}>
            <div className={styles.confirmMsg}>
              {confirmState.message.split('\n\n').map((p, i) => <p key={i}>{p}</p>)}
            </div>
            <div className={styles.confirmActions}>
              <button className={styles.confirmCancel} onClick={() => handleConfirm(false)}>Cancel</button>
              <button className={styles.confirmOk} onClick={() => handleConfirm(true)}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      {promptState && (
        <PromptDialog
          state={promptState}
          onCancel={() => handlePromptResolve(null)}
          onSubmit={(value) => handlePromptResolve(value)}
        />
      )}

      {showMetaModal && (
        <DeckMetaModal
          description={cmdDescription}
          onDescriptionChange={setCmdDescription}
          onDescriptionBlur={saveDescription}
          tags={cmdTags}
          newTagInput={newTagInput}
          onNewTagChange={setNewTagInput}
          onAddTag={addTag}
          onRemoveTag={removeTag}
          onClose={() => setShowMetaModal(false)}
        />
      )}

      {showOptimize && (
        <Modal onClose={() => { if (!optimizeBusy) setShowOptimize(false) }}>
          <h2 className={styles.optimizeTitle}>Optimize Printings</h2>
          <p className={styles.optimizeHint}>
            Re-pick the printing of every card in this deck. Price modes use your
            current price source and each card&apos;s foil setting.
          </p>
          <div className={styles.optimizeGrid}>
            {PRINTING_MODES.map(m => (
              <button
                key={m.id}
                className={styles.optimizeBtn}
                disabled={!!optimizeBusy}
                onClick={() => optimizePrintings(m.id)}
              >
                {optimizeBusy === m.id ? 'Working…' : m.label}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {showHistory && (
        <Modal onClose={() => setShowHistory(false)}>
          <h2 className={styles.optimizeTitle}>Deck History</h2>
          {history === null ? (
            <p className={styles.optimizeHint}>Loading…</p>
          ) : history.length === 0 ? (
            <p className={styles.optimizeHint}>No deck actions recorded yet. Changes like printing optimizations, visibility, bracket, imports and commander show up here.</p>
          ) : (
            <div className={styles.historyList}>
              {history.map(h => (
                <div key={h.id} className={styles.historyRow}>
                  <span className={styles.historyAction}>{h.action}</span>
                  {h.detail && <span className={styles.historyDetail}>{h.detail}</span>}
                  <span className={styles.historyTime}>
                    {new Date(h.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {showBasics && (
        <Modal onClose={() => { if (!basicsBusy) setShowBasics(false) }}>
          <h2 className={styles.optimizeTitle}>Add Basic Lands</h2>
          <p className={styles.optimizeHint}>
            Set how many of each basic land are in the main deck. Quantities save instantly.
          </p>
          <div className={styles.basicsList}>
            {BASIC_LAND_TYPES.map(land => {
              const row = deckCards.find(dc =>
                !dc.is_commander && normalizeBoard(dc.board) === 'main' &&
                (dc.name || '').toLowerCase() === land.name.toLowerCase())
              const count = row?.qty || 0
              const busy = basicsBusy === land.name
              return (
                <div key={land.name} className={styles.basicsRow}>
                  <img className={styles.basicsManaIcon} src={manaSymbolUrl(land.color)} alt={land.color} loading="lazy" />
                  <span className={styles.basicsName}>{land.name}</span>
                  <div className={styles.basicsStepper}>
                    <button className={styles.basicsBtn} disabled={busy || count <= 0}
                      onClick={() => setBasicLandCount(land, count - 1)} aria-label={`Remove ${land.name}`}>−</button>
                    <input
                      className={styles.basicsInput}
                      type="number" min="0" max="99" value={count} disabled={busy}
                      onChange={e => setBasicLandCount(land, e.target.value)}
                    />
                    <button className={styles.basicsBtn} disabled={busy}
                      onClick={() => setBasicLandCount(land, count + 1)} aria-label={`Add ${land.name}`}>+</button>
                  </div>
                </div>
              )
            })}
          </div>
        </Modal>
      )}

      {showMissing && (
        <Modal onClose={() => { if (!missingBusy) setShowMissing(false) }}>
          <h2 className={styles.optimizeTitle}>Add Missing to Wishlist</h2>
          {missingCards.length === 0 ? (
            <p className={styles.optimizeHint}>You already own every card in this deck. Nothing to add.</p>
          ) : (
            <>
              <p className={styles.optimizeHint}>
                {missingCards.length} card{missingCards.length === 1 ? '' : 's'} in this deck {missingCards.length === 1 ? 'is' : 'are'} not in your collection (basic lands excluded). Add {missingCards.length === 1 ? 'it' : 'them'} to a wishlist:
              </p>
              {missingWishlists === null ? (
                <p className={styles.optimizeHint}>Loading wishlists…</p>
              ) : (
                <div className={styles.missingWishForm}>
                  {missingWishlists.length > 0 && (
                    <div className={styles.missingWishRow}>
                      <Select title="Choose wishlist" value={missingTargetId} onChange={e => setMissingTargetId(e.target.value)}>
                        {missingWishlists.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                      </Select>
                      <button className={styles.optimizeBtn} disabled={missingBusy || !missingTargetId}
                        onClick={() => addMissingToWishlistAction(missingTargetId)}>
                        {missingBusy ? 'Adding…' : `Add ${missingCards.length}`}
                      </button>
                    </div>
                  )}
                  <div className={styles.missingWishDivider}>
                    <span>{missingWishlists.length > 0 ? 'or create a new one' : 'create a wishlist'}</span>
                  </div>
                  <div className={styles.missingWishRow}>
                    <input
                      className={styles.basicsInput}
                      style={{ flex: 1, width: 'auto', textAlign: 'left', padding: '0 10px' }}
                      value={missingNewName}
                      onChange={e => setMissingNewName(e.target.value)}
                      placeholder="New wishlist name"
                      maxLength={80}
                    />
                    <button className={styles.optimizeBtn} disabled={missingBusy || !missingNewName.trim()}
                      onClick={() => addMissingToWishlistAction(null)}>
                      {missingBusy ? 'Adding…' : 'Create & add'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </Modal>
      )}

      <ShareDeckModal
        state={shareState}
        deckId={deckId}
        onCopyLink={async (url) => {
          const copied = await copyShareLink(url)
          setShareState(prev => prev ? { ...prev, copied } : prev)
        }}
        onClose={() => setShareState(null)}
      />

      {showExport && (
        <ExportModal
          cards={deckCards}
          sfMap={{}}
          title={deckName || 'Deck'}
          folderType="deck"
          includeFoilIndicator={false}
          onClose={() => setShowExport(false)}
        />
      )}

      {/* Sync modal */}
      {showSync && (
        <SyncModal
          deckId={deckId}
          deckCards={deckCards}
          deckMeta={deckMeta}
          userId={user.id}
          isCollectionDeck={isCollectionDeck}
          onConfirm={handleSync}
          onClose={() => setShowSync(false)}
        />
      )}

      {pendingOwnedMove && (
        <MoveOwnedCardsModal
          title={pendingOwnedMove.title}
          message={pendingOwnedMove.message}
          items={pendingOwnedMove.items}
          folders={pendingOwnedMove.folders}
          onConfirm={pendingOwnedMove.onConfirm}
          onClose={() => setPendingOwnedMove(null)}
        />
      )}

      {/* Version picker modal */}
      {versionPickCard && (
        <VersionPickerModal
          dc={versionPickCard}
          ownedMap={ownedMap}
          userId={user.id}
          priceSource={price_source}
          onSelect={p => updateCardVersion(versionPickCard, p)}
          onClose={() => setVersionPickCard(null)}
        />
      )}

      {/* Floating card preview */}
      <FloatingPreview ref={floatingPreviewRef} />

      {contextMenu && createPortal(
        contextMenu.useResponsiveSheet ? (
          <>
            <button
              type="button"
              className={`${uiStyles.responsiveMenuBackdrop} ${uiStyles.responsiveMenuBackdropForceSheet}`}
              aria-label="Close Card Actions"
              onMouseDown={e => { e.stopPropagation(); closeContextMenu() }}
              onClick={e => { e.stopPropagation(); closeContextMenu() }}
            />
            <div
              className={`${uiStyles.responsiveMenuPanel} ${uiStyles.responsiveMenuPanelForceSheet}`}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
              onContextMenu={e => e.preventDefault()}
            >
              <div className={uiStyles.responsiveMenuHeader}>
                <div className={uiStyles.responsiveMenuHeaderTop}>
                  <span className={uiStyles.responsiveMenuTitle}>Card Actions</span>
                  <button type="button" className={uiStyles.responsiveMenuClose} onClick={closeContextMenu} aria-label="Close Card Actions">
                    <CloseIcon />
                  </button>
                </div>
              </div>
              <div className={uiStyles.responsiveMenuBody}>
                <DeckCardActionsMenuBody
                  dc={contextMenu.dc}
                  isEDH={isEDH}
                  formatId={format?.id}
                  onSetCommander={setCardAsCommander}
                  onToggleFoil={toggleFoil}
                  onPickVersion={(card, options = {}) => setVersionPickCard({ ...card, ...options })}
                  onMoveBoard={moveCardToBoard}
                  onOpenCategoryPicker={setCategoryPickCard}
                  close={closeContextMenu}
                  builderSfMap={builderSfMap}
                />
              </div>
            </div>
          </>
        ) : (
          <div
            className={styles.cardContextMenu}
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            onContextMenu={e => e.preventDefault()}
          >
            <DeckCardActionsMenuBody
              dc={contextMenu.dc}
              isEDH={isEDH}
              formatId={format?.id}
              onSetCommander={setCardAsCommander}
              onToggleFoil={toggleFoil}
              onPickVersion={(card, options = {}) => setVersionPickCard({ ...card, ...options })}
              onMoveBoard={moveCardToBoard}
              onOpenCategoryPicker={setCategoryPickCard}
              close={closeContextMenu}
              builderSfMap={builderSfMap}
            />
          </div>
        ),
        document.body
      )}

      {categoryPickCard && (
        <CategoryPickerModal
          card={categoryPickCard}
          categories={categoryOptions}
          onSelect={async category => {
            await moveDeckCardToCategory(categoryPickCard.id, category)
            setCategoryPickCard(null)
          }}
          onCreate={async name => {
            const category = await ensureDeckCategoryForName(name)
            await moveDeckCardToCategory(categoryPickCard.id, category || { name })
            setCategoryPickCard(null)
          }}
          onClear={async () => {
            await clearDeckCardCategory(categoryPickCard.id)
            setCategoryPickCard(null)
          }}
          onClose={() => setCategoryPickCard(null)}
        />
      )}

      {/* ── Build-from-collection assistant ───────────────────────── */}
      {showBuildAssistant && (
        <BuildAssistant
          userId={user.id}
          commander={commanderCard ? { name: commanderCard.name, color_identity: colorIdentity } : null}
          deckCards={deckCards}
          accessToken={session?.access_token}
          onAddCard={addCardToDeck}
          onRemoveCard={removeCardFromDeck}
          onAddToWishlist={addUpgradeToWishlist}
          onAddBasics={async (counts) => {
            // Top up the manabase with the assistant's pip-weighted basics
            // (additive: add to whatever's already on the main board).
            for (const [name, add] of Object.entries(counts || {})) {
              if (!add) continue
              const existing = deckCardsRef.current.find(dc =>
                !dc.is_commander && normalizeBoard(dc.board) === 'main' &&
                (dc.name || '').toLowerCase() === name.toLowerCase())
              await setBasicLandCount({ name }, (existing?.qty || 0) + add)
            }
          }}
          onClose={() => {
            // Drop the cached wishlist target so a reopened assistant re-resolves
            // against the current deck name (it may have been renamed since).
            assistantWishlistRef.current = null
            setShowBuildAssistant(false)
          }}
        />
      )}

      {/* ── Import modal ──────────────────────────────────────────── */}
      <DeckImportModal
        open={showImport}
        onClose={() => setShowImport(false)}
        deckId={deckId}
        userId={user.id}
        deckCardsRef={deckCardsRef}
        setDeckCards={setDeckCards}
        onImported={(copies) => logDeckChange(deckId, user?.id, 'Import', `Imported ${copies} card${copies === 1 ? '' : 's'}`)}
      />

      {/* Read-only card detail modal */}
      {detailCard && (
        <CardDetail
          card={detailCard.card}
          sfCard={detailCard.sfCard}
          priceSource={price_source}
          readOnly
          onClose={() => setDetailCard(null)}
        />
      )}
      <WarningTooltip tooltip={warningTooltip} />
    </div>
  )
}

