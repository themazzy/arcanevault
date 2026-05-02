import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import {
  FORMATS, TYPE_GROUPS, classifyCardType,
  parseDeckMeta, serializeDeckMeta, getCardImageUri,
  searchCards, searchCommanders, fetchCardsByNames, fetchCardsByScryfallIds, getDeckBuilderCardMeta,
  fetchEdhrecCommander, makeDebouncer,
  importDeckFromUrl,
} from '../lib/deckBuilderApi'
import { normalizeImportedDeckCards, parseImportText, resolveImportEntries } from '../lib/importFlow'
import {
  getLocalCards, getDeckCards, putDeckCards, deleteDeckCardLocal, getMeta, setMeta, getScryfallEntry,
  deleteDeckAllocationsByIds, replaceDeckAllocations, putDeckAllocations, putFolderCards, putCards,
  replaceLocalFolderCards,
} from '../lib/db'
import styles from './DeckBuilder.module.css'
import uiStyles from '../components/UI.module.css'
import { ResponsiveMenu, Select, Modal } from '../components/UI'
import { CardDetail } from '../components/CardComponents'
import DeckStats, { normalizeDeckBuilderCards, getCardCategory, CAT_COLORS, CAT_ORDER } from '../components/DeckStats'
import ExportModal from '../components/ExportModal'
import { fetchDeckAllocations, fetchDeckAllocationsForUser, fetchDeckCards, mergeAllocationRows, upsertDeckAllocations } from '../lib/deckData'
import { planDeckAllocations } from '../lib/deckAllocationPlanner'
import { getCardLegalityWarnings } from '../lib/deckLegality'
import {
  buildSyncDiff,
  buildSyncSnapshot,
  getSyncState,
  getLogicalKey,
  persistLinkedSyncSnapshot,
  summarizeSyncDiff,
  withLinkedPair,
} from '../lib/deckSync'
import { formatPrice, getPrice } from '../lib/scryfall'
import { getPublicAppUrl } from '../lib/publicUrl'
import { ensureCardPrints, getCardPrint, withCardPrint } from '../lib/cardPrints'
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
  MenuIcon,
  AddIcon,
  CheckIcon,
} from '../icons'
import { lastInputWasTouch } from '../lib/inputType'

const CAN_HOVER = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches
const RARITY_ORDER = ['mythic', 'rare', 'uncommon', 'common']
const RARITY_COLORS = { mythic: '#e07020', rare: '#c9a84c', uncommon: '#a0a8b8', common: 'var(--text-faint)' }
const BOARD_ORDER = ['main', 'side', 'maybe']
const BOARD_LABELS = {
  main: 'Mainboard',
  side: 'Sideboard',
  maybe: 'Maybeboard',
}
const BOARD_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'main', label: 'Main' },
  { id: 'side', label: 'Side' },
  { id: 'maybe', label: 'Maybe' },
]

function normalizeBoard(board) {
  return BOARD_ORDER.includes(board) ? board : 'main'
}

function normalizeCardName(name) {
  return String(name || '').trim().toLowerCase()
}

function isGroupFolder(folder) {
  try { return JSON.parse(folder?.description || '{}').isGroup === true } catch { return false }
}

const DECK_CARD_DB_COLS = new Set([
  'id','deck_id','user_id','scryfall_id','name','set_code','collector_number',
  'type_line','mana_cost','cmc','color_identity','image_uri','qty','foil',
  'is_commander','board','created_at','updated_at','card_print_id',
])
function toDeckCardRow(row) {
  const out = {}
  for (const k of DECK_CARD_DB_COLS) if (k in row) out[k] = row[k]
  return out
}

function toCardPrintSource(row) {
  return {
    scryfall_id: row?.scryfall_id || null,
    name: row?.name || null,
    set_code: row?.set_code || row?.set || null,
    collector_number: row?.collector_number || row?.collNum || null,
    type_line: row?.type_line || null,
    mana_cost: row?.mana_cost || null,
    cmc: row?.cmc ?? null,
    color_identity: row?.color_identity || [],
    image_uri: row?.image_uri || null,
    art_crop_uri: row?.art_crop_uri || null,
  }
}

async function requireCardPrintIds(rows, context = 'Card') {
  const needsPrint = (rows || []).filter(row => !row.card_print_id)
  if (!needsPrint.length) return rows || []

  const printMap = await ensureCardPrints(needsPrint.map(toCardPrintSource))
  const hydrated = (rows || []).map(row => {
    if (row.card_print_id) return row
    return withCardPrint(row, getCardPrint(printMap, toCardPrintSource(row)))
  })
  const missing = hydrated.find(row => !row.card_print_id)
  if (missing) throw new Error(`${context} could not resolve a card print for ${missing.name || 'unknown card'}.`)
  return hydrated
}

function ownedCardKey(row) {
  return [
    row.card_print_id,
    row.foil ? '1' : '0',
    row.language || 'en',
    row.condition || 'near_mint',
  ].join('|')
}

async function additiveSaveOwnedCards(rows, context = 'Owned card') {
  const hydratedRows = await requireCardPrintIds(rows, context)
  const merged = new Map()
  for (const row of hydratedRows) {
    const key = ownedCardKey(row)
    const existing = merged.get(key)
    merged.set(key, existing ? { ...existing, qty: (existing.qty || 0) + (row.qty || 0) } : row)
  }

  const incomingRows = [...merged.values()]
  if (!incomingRows.length) return []
  const printIds = [...new Set(incomingRows.map(row => row.card_print_id))]
  let existingRows = []
  if (printIds.length) {
    const { data, error } = await sb.from('cards')
      .select('id,user_id,name,set_code,collector_number,scryfall_id,foil,qty,condition,language,purchase_price,currency,card_print_id,added_at')
      .eq('user_id', incomingRows[0].user_id)
      .in('card_print_id', printIds)
    if (error) throw error
    existingRows = data || []
  }

  const existingByKey = new Map(existingRows.map(row => [ownedCardKey(row), row]))
  const rowsToSave = incomingRows.map(row => {
    const existing = existingByKey.get(ownedCardKey(row))
    return existing
      ? {
          ...existing,
          ...row,
          id: existing.id,
          qty: (existing.qty || 0) + (row.qty || 0),
          purchase_price: existing.purchase_price ?? row.purchase_price ?? 0,
          currency: existing.currency || row.currency || 'EUR',
        }
      : row
  })

  const { data, error } = await sb.from('cards')
    .upsert(rowsToSave, { onConflict: 'user_id,card_print_id,foil,language,condition' })
    .select('id,user_id,name,set_code,collector_number,scryfall_id,foil,qty,condition,language,purchase_price,currency,card_print_id,added_at')
  if (error) throw error
  return data || []
}

async function additiveSaveWishlistItems(folderId, userId, rows, context = 'Wishlist item') {
  const hydratedRows = await requireCardPrintIds(
    (rows || []).map(row => ({ ...row, folder_id: folderId, user_id: userId })),
    context
  )
  const merged = new Map()
  for (const row of hydratedRows) {
    const key = `${row.card_print_id}|${row.foil ? '1' : '0'}`
    const existing = merged.get(key)
    merged.set(key, existing ? { ...existing, qty: (existing.qty || 0) + (row.qty || 0) } : row)
  }

  const incomingRows = [...merged.values()]
  if (!incomingRows.length) return []
  const printIds = [...new Set(incomingRows.map(row => row.card_print_id))]
  let existingRows = []
  if (printIds.length) {
    const { data, error } = await sb.from('list_items')
      .select('card_print_id,foil,qty')
      .eq('folder_id', folderId)
      .in('card_print_id', printIds)
    if (error) throw error
    existingRows = data || []
  }

  const existingQtyByKey = new Map(existingRows.map(row => [`${row.card_print_id}|${row.foil ? '1' : '0'}`, row.qty || 0]))
  const rowsToSave = incomingRows.map(row => ({
    folder_id: row.folder_id,
    user_id: row.user_id,
    name: row.name,
    set_code: row.set_code || null,
    collector_number: row.collector_number || null,
    scryfall_id: row.scryfall_id || null,
    card_print_id: row.card_print_id,
    foil: row.foil ?? false,
    qty: (row.qty || 0) + (existingQtyByKey.get(`${row.card_print_id}|${row.foil ? '1' : '0'}`) || 0),
  }))

  const { data, error } = await sb.from('list_items')
    .upsert(rowsToSave, { onConflict: 'folder_id,card_print_id,foil' })
    .select('*')
  if (error) throw error
  return data || []
}

// Upgrade a Scryfall CDN image to large quality regardless of stored size variant
function toLargeImg(uri) {
  if (!uri) return uri
  return uri.replace(/\/(small|art_crop|normal|png)\//, '/large/')
}

// Convert any Scryfall image URI to art_crop format (used for background panels)
function toArtCropImg(uri) {
  if (!uri) return uri
  return uri.replace(/\/(small|normal|large|png|border_crop)\//, '/art_crop/')
}

// â”€â”€ Color identity helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PIP_COLORS = { W: '#f8f0d8', U: '#4488cc', B: '#8855aa', R: '#cc4444', G: '#44884a', C: '#aaaaaa' }

function ColorPip({ color }) {
  return (
    <span className={styles.colorPip} style={{ background: PIP_COLORS[color] || '#666', color: '#000' }}>
      {color}
    </span>
  )
}

function manaSymbolUrl(sym) {
  return `https://svgs.scryfall.io/card-symbols/${String(sym || '').replace(/[{}]/g, '').replace(/\//g, '').toUpperCase()}.svg`
}

function ManaCostInline({ cost, size = 14 }) {
  if (!cost) return <span>&mdash;</span>
  const sides = String(cost).split(' // ')
  const symbolCount = (String(cost).match(/\{[^}]+\}/g) || []).length
  const effectiveSize = symbolCount >= 5
    ? Math.max(9, size - 4)
    : symbolCount >= 4
      ? Math.max(10, size - 3)
      : symbolCount >= 3
        ? Math.max(11, size - 2)
        : size
  return (
    <span className={styles.manaCostInline}>
      {sides.map((side, sideIndex) => (
        <span key={`${side}:${sideIndex}`} className={styles.manaCostInline}>
          {sideIndex > 0 && <span className={styles.manaCostDivider}>//</span>}
          {(side.match(/\{[^}]+\}/g) || []).map((sym, symIndex) => (
            <img
              key={`${sym}:${symIndex}`}
              className={styles.manaSymbolInline}
              src={manaSymbolUrl(sym)}
              alt={sym}
              loading="lazy"
              style={{ width: effectiveSize, height: effectiveSize }}
            />
          ))}
        </span>
      ))}
    </span>
  )
}

function OwnershipBadge({ ownedQty, ownedFoilAlt, ownedAlt, ownedInDeck, inCollDeck }) {
  if (inCollDeck) return <span className={`${styles.stateBadge} ${styles.stateBadgeAssigned}`} title="Assigned to this collection deck">In Deck</span>
  if (ownedQty > 0 && !ownedInDeck) return <span className={`${styles.stateBadge} ${styles.stateBadgeOwned}`} title="Owned and available">Owned</span>
  if (ownedFoilAlt > 0) return <span className={`${styles.stateBadge} ${styles.stateBadgeAlt}`} title="Owned as opposite foil variant">Wrong Foil</span>
  if (ownedAlt > 0) return <span className={`${styles.stateBadge} ${styles.stateBadgeAlt}`} title="A different version is owned">Other Print</span>
  if (ownedInDeck) return <span className={`${styles.stateBadge} ${styles.stateBadgeCommitted}`} title="Owned, but committed to another deck">In Other Deck</span>
  return <span className={`${styles.stateBadge} ${styles.stateBadgeMissing}`} title="Not owned in collection">Not Owned</span>
}

function deckAllocationKeys(cardLike) {
  if (!cardLike) return []
  const keys = []
  const foilKey = cardLike.foil ? '1' : '0'
  if (cardLike.card_print_id) keys.push(`print:${cardLike.card_print_id}`)
  if (cardLike.scryfall_id) {
    keys.push(`sf:${cardLike.scryfall_id}|${foilKey}`)
  }
  const nameKey = (cardLike.name || '').trim().toLowerCase()
  if (nameKey) {
    keys.push(`name:${nameKey}|${foilKey}`)
  }
  return [...new Set(keys)]
}

function allocationSetHas(set, cardLike) {
  return deckAllocationKeys(cardLike).some(key => set.has(key))
}

// â”€â”€ Floating card preview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function FloatingPreview({ imageUris, x, y }) {
  if (!imageUris?.length) return null
  const width = imageUris.length > 1 ? 400 : 300
  const left = x > window.innerWidth - (width + 40) ? x - (width - 60) : x + 16
  const top  = Math.min(y - 30, window.innerHeight - 330)
  return (
    <div className={styles.floatingPreview} style={{ left, top }}>
      <div className={styles.floatingPreviewStack}>
        {imageUris.map((uri, index) => (
          <img key={`${uri}:${index}`} className={styles.floatingImg} src={uri} alt="" />
        ))}
      </div>
    </div>
  )
}

function WarningTooltip({ tooltip }) {
  if (!tooltip) return null
  const left = Math.min(tooltip.x + 14, window.innerWidth - 320)
  const top = Math.min(tooltip.y + 14, window.innerHeight - 160)
  return createPortal(
    <div className={styles.warningTooltip} style={{ left, top }}>
      {tooltip.summary && <div className={styles.warningTooltipTitle}>{tooltip.summary}</div>}
      {Array.isArray(tooltip.details) ? (
        <ul className={styles.warningTooltipList}>
          {tooltip.details.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : (
        <div className={styles.warningTooltipBody}>{tooltip.detail}</div>
      )}
    </div>,
    document.body
  )
}

// â”€â”€ Single card row in search results â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Single card row in EDHRec recommendations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function canBeCommander(dc) {
  if (!dc.type_line) return true // unknown type â€” allow the option
  const tl = dc.type_line.toLowerCase()
  return tl.includes('legendary creature') ||
    (tl.includes('legendary') && tl.includes('planeswalker'))
}

// â”€â”€ Edit dropdown (âš™) shared by list + compact views â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function DeckCardActionsMenuBody({ dc, isEDH, onSetCommander, onToggleFoil, onPickVersion, onMoveBoard, close }) {
  const currentBoard = normalizeBoard(dc.board)
  const boardOptions = BOARD_ORDER.filter(board => board !== currentBoard && !(dc.is_commander && board !== 'main'))
  return (
    <div className={uiStyles.responsiveMenuList}>
      {isEDH && dc.is_commander && (
        <button className={uiStyles.responsiveMenuAction} onClick={() => { onSetCommander(dc, false); close() }}>
          <span>Unset as Commander</span>
        </button>
      )}
      {isEDH && !dc.is_commander && canBeCommander(dc) && (
        <button className={uiStyles.responsiveMenuAction} onClick={() => { onSetCommander(dc, true); close() }}>
          <span>Set as Commander</span>
        </button>
      )}
      {boardOptions.map(board => (
        <button key={board} className={uiStyles.responsiveMenuAction} onClick={() => { onMoveBoard?.(dc.id, board); close() }}>
          <span>Move to {BOARD_LABELS[board]}</span>
        </button>
      ))}
      <button className={uiStyles.responsiveMenuAction} onClick={() => { onToggleFoil(dc.id); close() }}>
        <span>{dc.foil ? 'Remove Foil' : 'Mark as Foil'}</span>
      </button>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { onPickVersion(dc); close() }}>
        <span>Change Version</span>
      </button>
      {dc.qty > 1 && (
        <button className={uiStyles.responsiveMenuAction} onClick={() => { onPickVersion(dc, { splitOne: true }); close() }}>
          <span>Split 1x To Other Version</span>
        </button>
      )}
    </div>
  )
}

function EditMenu({ dc, isEDH, onSetCommander, onToggleFoil, onPickVersion, onMoveBoard }) {
  return (
    <ResponsiveMenu
      title="Card Actions"
      wrapClassName={styles.editMenuCell}
      portal
      trigger={({ toggle }) => (
        <button
          className={styles.editBtn}
          onClick={e => { e.stopPropagation(); toggle() }}
          title="Edit"
        ><SettingsIcon size={13} /></button>
      )}
    >
      {({ close }) => (
        <DeckCardActionsMenuBody
          dc={dc}
          isEDH={isEDH}
          onSetCommander={onSetCommander}
          onToggleFoil={onToggleFoil}
          onPickVersion={onPickVersion}
          onMoveBoard={onMoveBoard}
          close={close}
        />
      )}
    </ResponsiveMenu>
  )
}

function DeckCardRowV2({
  dc, ownedQty, ownedFoilAlt, ownedAlt, ownedInDeck, inCollDeck,
  onChangeQty, onRemove, onMouseEnter, onMouseLeave, onMouseMove, onContextMenu,
  onPickVersion, onToggleFoil, onSetCommander, onMoveBoard, isEDH,
  visibleColumns, listGridTemplate, priceLabel, onOpenDetail, legalityWarnings = [],
}) {
  const setLabel = dc.set_code ? `${String(dc.set_code).toUpperCase()}${dc.collector_number ? ` #${dc.collector_number}` : ''}` : '-'
  return (
    <div className={`${styles.deckCardRow}${dc.is_commander ? ' ' + styles.isCommander : ''}${legalityWarnings.length ? ' ' + styles.deckCardIllegal : ''}`} title={(legalityWarnings.map(w => w.text).join('\n')) || undefined} style={{ '--deck-list-columns': listGridTemplate }} onContextMenu={onContextMenu}>
      <div className={styles.deckCardLeft} style={{ cursor: 'pointer' }} onClick={() => onOpenDetail?.(dc)}>
        {dc.image_uri
          ? <img className={styles.deckThumb} src={dc.image_uri} alt="" loading="lazy" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove} />
          : <div className={styles.deckThumbPlaceholder} />
        }
        <span className={styles.deckCardName} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove}>{dc.name}</span>
        {legalityWarnings.length > 0 && <span className={styles.illegalMark} title={legalityWarnings.map(w => w.text).join('\n')}>!</span>}
        {dc.foil && <span className={styles.foilBadge} title="Foil">*</span>}
      </div>
      {visibleColumns.set && <div className={styles.deckCardSet}>{setLabel}</div>}
      {visibleColumns.manaValue && <div className={styles.deckCardMetric}><ManaCostInline cost={dc.mana_cost} size={14} /></div>}
      {visibleColumns.cmc && <div className={styles.deckCardMetric}>{dc.cmc ?? '-'}</div>}
      {visibleColumns.price && <div className={styles.deckCardMetric}>{priceLabel}</div>}
      {visibleColumns.status && (
        <div className={styles.deckCardStatus}>
          <OwnershipBadge ownedQty={ownedQty} ownedFoilAlt={ownedFoilAlt} ownedAlt={ownedAlt} ownedInDeck={ownedInDeck} inCollDeck={inCollDeck} />
        </div>
      )}
      {visibleColumns.actions && <EditMenu dc={dc} isEDH={isEDH} onSetCommander={onSetCommander} onToggleFoil={onToggleFoil} onPickVersion={onPickVersion} onMoveBoard={onMoveBoard} />}
      {visibleColumns.qty && (
        <div className={styles.qtyControls}>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, -1)}>-</button>
          <span className={styles.qtyVal}>{dc.qty}</span>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, +1)}>+</button>
        </div>
      )}
      {visibleColumns.remove && <button className={styles.removeBtn} onClick={() => onRemove(dc.id)}>x</button>}
    </div>
  )
}

// â”€â”€ Combo components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function useComboCardImage(name, existingUri) {
  const cache = useRef({})
  const [img, setImg] = useState(existingUri || (cache.current[name] ?? null))
  useEffect(() => {
    if (existingUri || !name || cache.current[name] !== undefined) return
    cache.current[name] = null
    fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const url = d?.image_uris?.large || d?.card_faces?.[0]?.image_uris?.large || d?.image_uris?.normal || d?.card_faces?.[0]?.image_uris?.normal || null
        cache.current[name] = url
        if (url) setImg(url)
      })
      .catch(() => { cache.current[name] = null })
  }, [name, existingUri])
  return existingUri || img
}

function ComboCardThumb({ name, inDeck, existingUri, onAdd, onOpenDetail }) {
  const img = useComboCardImage(name, existingUri)
  const [adding, setAdding] = useState(false)
  const handleAdd = async e => {
    e.stopPropagation()
    if (adding) return
    setAdding(true)
    try { await onAdd(name) } finally { setAdding(false) }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: inDeck ? 1 : 0.6, cursor: 'pointer' }} onClick={() => onOpenDetail?.(name)}>
      <div style={{ position: 'relative', width: 120, height: 168, borderRadius: 7, overflow: 'hidden', flexShrink: 0,
        border: `1px solid ${inDeck ? 'rgba(201,168,76,0.5)' : 'var(--s-border2)'}`,
        background: 'var(--s2)',
      }}>
        {img
          ? <img src={img} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
          : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.73rem', color: 'var(--text-faint)', padding: 8, textAlign: 'center', lineHeight: 1.3 }}>{name}</div>}
        {!inDeck && onAdd && (
          <button
            onClick={handleAdd}
            disabled={adding}
            style={{
              position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)',
              background: adding ? 'rgba(201,168,76,0.25)' : 'rgba(20,20,30,0.85)',
              border: '1px solid rgba(201,168,76,0.6)', borderRadius: 4,
              color: 'var(--gold)', fontSize: '0.7rem', padding: '3px 10px',
              cursor: adding ? 'default' : 'pointer', whiteSpace: 'nowrap',
              backdropFilter: 'blur(4px)',
            }}
          >
            {adding ? '...' : '+ Add'}
          </button>
        )}
        </div>
      <div style={{ fontSize: '0.64rem', color: inDeck ? 'var(--text-faint)' : '#e08878', textAlign: 'center', maxWidth: 110, lineHeight: 1.2, wordBreak: 'break-word' }}>
        {inDeck ? name : `Add ${name}`}
      </div>
    </div>
  )
}

function ComboResultCard({ combo, highlight, deckCardNames, deckImages, onAddCard, onOpenDetail }) {
  const uses    = (combo.uses    || []).map(u => u.card?.name || u.template?.name || '').filter(Boolean)
  const results = (combo.produces || []).map(p => p.feature?.name || '').filter(Boolean)
  const deckSet = new Set(deckCardNames || [])
  const steps   = combo.description || ''
  return (
    <div style={{
      background: highlight ? 'rgba(201,168,76,0.07)' : 'var(--s1)',
      border: `1px solid ${highlight ? 'rgba(201,168,76,0.28)' : 'var(--s-border)'}`,
      borderRadius: 6, padding: '14px',
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: (results.length || steps) ? 12 : 0 }}>
        {uses.map((name, i) => (
          <ComboCardThumb key={i} name={name} inDeck={!deckCardNames || deckSet.has(name)} existingUri={deckImages?.[name]} onAdd={!deckCardNames || deckSet.has(name) ? undefined : onAddCard} onOpenDetail={onOpenDetail} />
        ))}
      </div>
      {results.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: steps ? 8 : 0 }}>
          {results.slice(0, 6).map((r, i) => (
            <span key={i} style={{ fontSize: '0.68rem', background: 'rgba(100,100,160,0.2)', border: '1px solid rgba(100,100,160,0.3)', borderRadius: 3, padding: '2px 7px', color: 'var(--text-faint)' }}>{r}</span>
          ))}
        </div>
      )}
      {steps && (
        <div style={{ fontSize: '0.79rem', color: 'var(--text-dim)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{steps}</div>
      )}
    </div>
  )
}

// â”€â”€ Basic lands set â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BASIC_LANDS = new Set(['Island', 'Plains', 'Forest', 'Mountain', 'Swamp', 'Wastes'])
const DEFAULT_LIST_COLUMNS = {
  set: false,
  manaValue: true,
  cmc: false,
  price: false,
  status: true,
  actions: true,
  qty: true,
  remove: true,
}
const DEFAULT_COMPACT_COLUMNS = {
  set: false,
  manaValue: false,
  cmc: false,
  price: false,
  status: false,
  actions: true,
  qty: false,
  remove: true,
}

// â”€â”€ Make Deck row â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function MakeDeckRow({ item }) {
  const { dc, neededQty, addExact, addOther, totalAdd, missingQty } = item
  const img = dc.image_uri
  let statusColor, statusIcon, statusDetail
  if (totalAdd === 0) {
    statusColor = '#e07070'; statusIcon = 'x'; statusDetail = 'not owned'
  } else if (missingQty === 0 && addOther === 0) {
    statusColor = 'var(--green, #4a9a5a)'; statusIcon = 'OK'; statusDetail = `${totalAdd}x exact`
  } else {
    statusColor = '#c9a84c'; statusIcon = 'Alt'
    const parts = []
    if (addExact > 0) parts.push(`${addExact}x exact`)
    if (addOther > 0) parts.push(`${addOther}x other print`)
    if (missingQty > 0) parts.push(`${missingQty}x missing`)
    statusDetail = parts.join(', ')
  }
  const allocationDetail = (item.allocations || [])
    .map(row => {
      const print = row.set_code && row.collector_number ? `${String(row.set_code).toUpperCase()} #${row.collector_number}` : 'owned print'
      return `${row.qty}x ${print}${row.foil ? ' foil' : ''}`
    })
    .join(', ')
  return (
    <div style={{ display:'flex', alignItems:'center', padding:'5px 20px', borderBottom:'1px solid var(--s-border)', gap:10, minHeight:36 }}>
      {img
        ? <img src={img} alt="" style={{ width:26, height:18, objectFit:'cover', borderRadius:2, flexShrink:0 }} />
        : <div style={{ width:26, height:18, background:'var(--s3)', borderRadius:2, flexShrink:0 }} />
      }
      <div style={{ flex:1, minWidth:0 }}>
        <span style={{ fontSize:'0.84rem', color:'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', display:'block' }}>
          {neededQty > 1 ? `${neededQty}x ` : ''}{dc.name}
        </span>
        {allocationDetail && (
          <span style={{ fontSize:'0.72rem', color:'var(--text-faint)', display:'block', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
            Uses: {allocationDetail}
          </span>
        )}
      </div>
      <div style={{ fontSize:'0.79rem', color:statusColor, flexShrink:0, display:'flex', alignItems:'center', gap:4 }}>
        <span>{statusIcon}</span><span>{statusDetail}</span>
      </div>
    </div>
  )
}

function buildChosenAllocations(item, exactVersionOnly, chosenOtherCardId) {
  const exactAllocations = item.exactAllocations || []
  const exactQty = exactAllocations.reduce((sum, row) => sum + row.qty, 0)
  let otherAllocations = exactVersionOnly ? [] : (item.otherAllocations || [])

  if (!exactVersionOnly && chosenOtherCardId) {
    const candidate = (item.otherCandidates || []).find(row => row.card_id === chosenOtherCardId)
    const remainingNeeded = Math.max(0, (item.neededQty || 0) - exactQty)
    if (candidate && remainingNeeded > 0 && (candidate.available_qty || 0) >= remainingNeeded) {
      otherAllocations = [{
        card_id: candidate.card_id,
        qty: remainingNeeded,
        card_print_id: candidate.card_print_id || null,
        scryfall_id: candidate.scryfall_id || null,
        name: candidate.name || item.dc.name,
        set_code: candidate.set_code || null,
        collector_number: candidate.collector_number || null,
        foil: !!candidate.foil,
      }]
    }
  }

  const addExact = exactQty
  const addOther = otherAllocations.reduce((sum, row) => sum + row.qty, 0)
  const totalAdd = addExact + addOther
  return {
    exactAllocations,
    otherAllocations,
    allocations: [...exactAllocations, ...otherAllocations],
    addExact,
    addOther,
    totalAdd,
    missingQty: Math.max(0, (item.neededQty || 0) - totalAdd),
  }
}

function buildChosenPrintingSelections(items, chosenOtherCardIds) {
  return (items || [])
    .map(item => {
      const chosenCardId = chosenOtherCardIds?.[item.dc.id]
      if (!chosenCardId) return null
      const candidate = (item.otherCandidates || []).find(row => row.card_id === chosenCardId)
      if (!candidate) return null
      return {
        deckCardId: item.dc.id,
        candidate,
      }
    })
    .filter(Boolean)
}

function formatOwnedPrinting(row) {
  if (!row) return 'owned printing'
  const setPart = row.set_code ? String(row.set_code).toUpperCase() : null
  const numberPart = row.collector_number ? `#${row.collector_number}` : null
  const parts = [setPart, numberPart].filter(Boolean)
  const label = parts.length ? parts.join(' ') : 'owned printing'
  return row.foil ? `${label} foil` : label
}

function formatQtyLabel(qty, suffix = 'copy') {
  if (qty === 1) return `${qty} ${suffix}`
  return `${qty} ${suffix === 'copy' ? 'copies' : `${suffix}s`}`
}

function getDecisionCategory(row, builderOnly, collectionOnly) {
  if (builderOnly.some(item => item.key === row.key)) return 'builderOnly'
  if (collectionOnly.some(item => item.key === row.key)) return 'collectionOnly'
  return 'conflict'
}

function getDecisionPreview(row, resolution, context = {}) {
  const {
    addedByKey = new Map(),
    changedByKey = new Map(),
    removedByKey = new Map(),
    selectedMoveTarget = null,
  } = context

  const name = row.builder?.name || row.collection?.name || 'Card'
  if (resolution === 'keep') return `${name} stays unchanged in both places for now.`
  if (resolution === 'collection') {
    if ((row.collectionQty || 0) === (row.builderQty || 0)) return `${name} already matches the current Collection Deck.`
    return `Deck Builder will change from ${row.builderQty || 0} to ${row.collectionQty || 0}. Collection cards stay where they are.`
  }

  const addItem = addedByKey.get(row.key)
  if (addItem) {
    if (addItem.totalAdd > 0 && addItem.missingQty > 0) {
      return `Move ${addItem.totalAdd} owned ${addItem.totalAdd === 1 ? 'copy' : 'copies'} into Collection Deck. ${addItem.missingQty} ${addItem.missingQty === 1 ? 'copy is' : 'copies are'} still missing.`
    }
    if (addItem.totalAdd > 0) {
      return `Move ${addItem.totalAdd} owned ${addItem.totalAdd === 1 ? 'copy' : 'copies'} into Collection Deck.`
    }
    if (addItem.missingQty > 0) {
      return `${addItem.missingQty} ${addItem.missingQty === 1 ? 'copy is' : 'copies are'} missing, so no collection copies can move in.`
    }
  }

  const changedItem = changedByKey.get(row.key)
  if (changedItem) {
    if (changedItem.newQty > changedItem.oldQty) {
      const delta = changedItem.newQty - changedItem.oldQty
      return `Increase Collection Deck by ${delta} ${delta === 1 ? 'copy' : 'copies'}.`
    }
    if (changedItem.newQty < changedItem.oldQty) {
      const delta = changedItem.oldQty - changedItem.newQty
      const destLabel = selectedMoveTarget
        ? `${selectedMoveTarget.type === 'binder' ? 'Binder' : 'Deck'}: ${selectedMoveTarget.name}`
        : 'your chosen destination'
      return `Move ${delta} ${delta === 1 ? 'copy' : 'copies'} out of Collection Deck to ${destLabel}.`
    }
  }

  const removedItem = removedByKey.get(row.key)
  if (removedItem) {
    const delta = removedItem.allocRow?.qty || 0
    const destLabel = selectedMoveTarget
      ? `${selectedMoveTarget.type === 'binder' ? 'Binder' : 'Deck'}: ${selectedMoveTarget.name}`
      : 'your chosen destination'
    return `Move all ${delta} ${delta === 1 ? 'copy' : 'copies'} out of Collection Deck to ${destLabel}.`
  }

  return `${name} will follow the Deck Builder version.`
}

function getDecisionOptionLabels(row, context = {}) {
  const { addedByKey = new Map() } = context
  if (row.category === 'builderOnly') {
    const addItem = addedByKey.get(row.key)
    const hasOwned = (addItem?.totalAdd || 0) > 0
    const hasMissing = (addItem?.missingQty || 0) > 0
    const builderLabel = hasOwned && hasMissing
      ? 'Add owned copies, keep rest missing'
      : hasOwned
        ? 'Add owned copy to Collection Deck'
        : 'Keep as missing in Deck Builder'
    return {
      builder: builderLabel,
      collection: 'Remove from Deck Builder',
      keep: 'Leave unsynced',
    }
  }

  if (row.category === 'collectionOnly') {
    return {
      builder: 'Move out of Collection Deck',
      collection: 'Add back to Deck Builder',
      keep: 'Leave in Collection Deck only',
    }
  }

  return {
    builder: 'Match Collection Deck to Builder',
    collection: 'Match Builder to Collection Deck',
    keep: 'Leave quantity mismatch',
  }
}

function getFolderKindLabel(folderOrType) {
  const type = typeof folderOrType === 'string' ? folderOrType : folderOrType?.type
  return type === 'binder' ? 'Binder' : type === 'deck' ? 'Deck' : 'Folder'
}

function formatPlacementLabel(folder) {
  if (!folder) return 'Collection'
  return `${getFolderKindLabel(folder)}: ${folder.name || 'Untitled'}`
}

function summarizePlacementParts(parts) {
  const merged = new Map()
  for (const part of parts || []) {
    const key = `${part.type || ''}:${part.name || ''}`
    const existing = merged.get(key) || { ...part, qty: 0 }
    existing.qty += part.qty || 0
    merged.set(key, existing)
  }
  const labels = [...merged.values()].map(part => `${part.qty}x ${formatPlacementLabel(part)}`)
  if (!labels.length) return 'available collection placements'
  if (labels.length <= 2) return labels.join(', ')
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2} more`
}

function findCommanderTransferHint(row, currentDeckCards) {
  if (row?.builder?.is_commander) return { is_commander: true }

  const name = String(row?.collection?.name || row?.builder?.name || '').trim().toLowerCase()
  if (!name) return { is_commander: false }

  const matchingCommander = (currentDeckCards || []).find(card =>
    card?.is_commander && String(card.name || '').trim().toLowerCase() === name
  )

  return matchingCommander
    ? { is_commander: true }
    : { is_commander: false }
}

function PrintingPickerModal({ cardName, options, selectedCardId, onSelect, onClose }) {
  const [details, setDetails] = useState([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const ids = [...new Set(options.map(option => option.scryfall_id).filter(Boolean))]
      const fetched = ids.length ? await fetchCardsByScryfallIds(ids) : []
      if (cancelled) return
      const byId = new Map(fetched.map(card => [card.id, card]))
      setDetails(options.map(option => {
        const sf = option.scryfall_id ? byId.get(option.scryfall_id) : null
        return {
          ...option,
          image_uri: getCardImageUri(sf, 'normal'),
          set_name: sf?.set_name || (option.set_code ? String(option.set_code).toUpperCase() : 'Unknown set'),
        }
      }))
    }
    load()
    return () => { cancelled = true }
  }, [options])

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:730, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:760, maxWidth:'95vw', maxHeight:'88vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>Choose owned printing</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:'pointer' }}>x</button>
        </div>
        <div style={{ padding:'12px 20px', color:'var(--text-dim)', fontSize:'0.84rem' }}>
          Select which owned printing to use for {cardName}.
        </div>
        <div style={{ padding:'0 20px 20px', overflowY:'auto', display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:12 }}>
          {details.map(option => (
            <button
              key={option.card_id}
              onClick={() => onSelect(option.card_id)}
              style={{
                background: selectedCardId === option.card_id ? 'rgba(201,168,76,0.12)' : 'var(--s1)',
                border: selectedCardId === option.card_id ? '1px solid rgba(201,168,76,0.45)' : '1px solid var(--border)',
                borderRadius:8,
                padding:10,
                display:'flex',
                flexDirection:'column',
                gap:8,
                cursor:'pointer',
                color:'var(--text)',
                textAlign:'left',
              }}>
              {option.image_uri
                ? <img src={option.image_uri} alt={option.name} style={{ width:'100%', aspectRatio:'63 / 88', objectFit:'cover', borderRadius:6 }} loading="lazy" />
                : <div style={{ width:'100%', aspectRatio:'63 / 88', background:'var(--s2)', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-faint)', fontSize:'0.75rem', textAlign:'center', padding:8 }}>{option.name}</div>}
              <div style={{ fontSize:'0.8rem', fontWeight:600 }}>{option.set_name}</div>
              <div style={{ fontSize:'0.73rem', color:'var(--text-faint)' }}>
                {option.set_code ? `${String(option.set_code).toUpperCase()} #${option.collector_number || '?'}` : 'Owned printing'}
              </div>
              <div style={{ fontSize:'0.73rem', color:'var(--text-faint)' }}>
                {`${option.available_qty}x available${option.foil ? ' / foil' : ''}`}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// â”€â”€ Make Deck modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function MakeDeckModal({ deckCards, userId, inOtherDeckSet, onConfirm, onClose }) {
  const [loading, setLoading] = useState(true)
  const [previewItems, setPreviewItems] = useState([])
  const [skipBasicLands, setSkipBasicLands] = useState(true)
  const [exactVersionOnly, setExactVersionOnly] = useState(true)
  const [pullFromOtherDecks, setPullFromOtherDecks] = useState(false)
  const [wishlists, setWishlists] = useState([])
  const [missingAction, setMissingAction] = useState('skip') // 'skip' | 'add' | 'wishlist'
  const [selectedWishlistId, setSelectedWishlistId] = useState('')
  const [newWishlistName, setNewWishlistName] = useState('')
  const [chosenOtherCardIds, setChosenOtherCardIds] = useState({})
  const [pickerItem, setPickerItem] = useState(null)

  // Intentional: modal mounts fresh on each open - one-shot load from current props snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    async function load() {
      // Use IDB (same source as the green bar) so counts are consistent
      const collCards = await getLocalCards(userId)
      const items = planDeckAllocations(
        deckCards,
        collCards || []
      )
      const { data: wls } = await sb.from('folders').select('id, name, description').eq('user_id', userId).eq('type', 'list').order('name')
      setPreviewItems(items)
      setWishlists((wls || []).filter(folder => !isGroupFolder(folder)))
      setLoading(false)
    }
    load()
  }, [])

  const filtered = previewItems
    .filter(i => !skipBasicLands || !BASIC_LANDS.has(i.dc.name))
    .filter(i => pullFromOtherDecks || !inOtherDeckSet?.has(i.dc.scryfall_id))
    .map(i => {
      const chosen = buildChosenAllocations(i, exactVersionOnly, chosenOtherCardIds[i.dc.id])
      return {
        ...i,
        ...chosen,
      }
    })
  const addItems      = filtered.filter(i => i.totalAdd > 0)
  const missingItems  = filtered.filter(i => i.missingQty > 0)
  const exactCount    = filtered.filter(i => i.missingQty === 0 && i.addOther === 0 && i.totalAdd > 0).length
  const fallbackCount = filtered.filter(i => i.addOther > 0).length
  const missingCount  = missingItems.length
  const wishlistReady = missingCount === 0
    || missingAction === 'skip'
    || missingAction === 'add'
    || (selectedWishlistId ? (selectedWishlistId === 'new' ? !!newWishlistName.trim() : true) : true)
  const canConfirm    = (addItems.length > 0 || missingAction === 'add') && wishlistReady

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:700, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:560, maxWidth:'95vw', maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>Make Collection Deck</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:'pointer' }}>x</button>
        </div>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'var(--text-faint)', fontSize:'0.85rem' }}>Checking your collection...</div>
        ) : (
          <>
            <div style={{ padding:'10px 20px', borderBottom:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:8 }}>
              {[
                [skipBasicLands,    setSkipBasicLands,    'Skip basic lands',                          'Island, Plains, Forest, Mountain, Swamp'],
                [exactVersionOnly,  setExactVersionOnly,  'Use specified version only',                'Won\'t substitute a different printing'],
                [!pullFromOtherDecks, v => setPullFromOtherDecks(!v), 'Skip cards already in another deck', 'Avoids pulling the same copy into two decks'],
              ].map(([val, set, label, sub]) => (
                <label key={label} style={{ display:'flex', alignItems:'flex-start', gap:8, cursor:'pointer' }}>
                  <input type="checkbox" checked={val} onChange={e => set(e.target.checked)} style={{ accentColor:'var(--gold)', marginTop:2, flexShrink:0 }} />
                  <span>
                    <div style={{ fontSize:'0.84rem', color:'var(--text-dim)' }}>{label}</div>
                    <div style={{ fontSize:'0.75rem', color:'var(--text-faint)' }}>{sub}</div>
                  </span>
                </label>
              ))}
            </div>
            <div style={{ padding:'8px 20px', background:'var(--s1)', borderBottom:'1px solid var(--border)', display:'flex', gap:16, fontSize:'0.81rem', flexWrap:'wrap' }}>
              <span style={{ color:'var(--green, #4a9a5a)' }}>OK {exactCount} exact</span>
              {fallbackCount > 0 && <span style={{ color:'#c9a84c' }}>Alt {fallbackCount} different printing</span>}
              {missingCount > 0 && <span style={{ color:'#e07070' }}>x {missingCount} missing</span>}
            </div>
            <div style={{ flex:1, overflowY:'auto', minHeight:0 }}>
              {filtered.length === 0
                ? <div style={{ padding:40, textAlign:'center', color:'var(--text-faint)', fontSize:'0.85rem' }}>No cards to add.</div>
                : filtered.map(item => (
                  <div key={item.dc.id}>
                    <MakeDeckRow item={item} />
                    {!exactVersionOnly && (item.otherCandidates?.length || 0) > 1 && item.totalAdd > 0 && (
                      <div style={{ padding:'0 20px 8px' }}>
                        <button
                          onClick={() => setPickerItem(item)}
                          style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'5px 10px', color:'var(--text-dim)', fontSize:'0.76rem', cursor:'pointer' }}>
                          Choose owned printing
                        </button>
                      </div>
                    )}
                  </div>
                ))
              }
            </div>
            {missingCount > 0 && (
              <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)' }}>
                <div style={{ fontSize:'0.82rem', color:'var(--text-dim)', marginBottom:10 }}>
                  {missingItems.reduce((s, i) => s + i.missingQty, 0)} missing card{missingCount !== 1 ? 's' : ''}:
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {[
                    ['skip', 'Skip missing cards',     'They will not be added to the deck'],
                    ['add',  'Add to collection',      'Creates owned copies placed directly in this deck'],
                    ['wishlist', 'Add to wishlist',    'Save to a wishlist for future tracking'],
                  ].map(([value, label, sub]) => (
                    <label key={value} style={{ display:'flex', alignItems:'flex-start', gap:8, cursor:'pointer' }}>
                      <input type="radio" name="missingAction" value={value} checked={missingAction === value}
                        onChange={() => setMissingAction(value)}
                        style={{ accentColor:'var(--gold)', marginTop:2, flexShrink:0 }} />
                      <span>
                        <div style={{ fontSize:'0.84rem', color:'var(--text-dim)' }}>{label}</div>
                        <div style={{ fontSize:'0.75rem', color:'var(--text-faint)' }}>{sub}</div>
                      </span>
                    </label>
                  ))}
                  {missingAction === 'wishlist' && (
                    <div style={{ display:'flex', gap:8, alignItems:'center', paddingLeft:24 }}>
                      <Select value={selectedWishlistId} onChange={e => setSelectedWishlistId(e.target.value)}
                        menuDirection="up"
                        style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'6px 10px', color:'var(--text)', fontSize:'0.84rem', flex:1, minWidth:0 }}
                        title="Select wishlist">
                        <option value="">Choose wishlist</option>
                        {wishlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
                        <option value="new">+ Create new wishlist...</option>
                      </Select>
                      {selectedWishlistId === 'new' && (
                        <input autoFocus placeholder="Wishlist name..." value={newWishlistName} onChange={e => setNewWishlistName(e.target.value)}
                          maxLength={100}
                          style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'6px 10px', color:'var(--text)', fontSize:'0.84rem', flex:1 }} />
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={onClose} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:'pointer' }}>Cancel</button>
              <button
                onClick={() => onConfirm({
                  addItems,
                  missingItems,
                  printingSelections: buildChosenPrintingSelections(filtered, chosenOtherCardIds),
                  addMissing: missingAction === 'add',
                  wishlistId: missingAction === 'wishlist' && selectedWishlistId !== 'new' ? (selectedWishlistId || null) : null,
                  wishlistName: missingAction === 'wishlist' && selectedWishlistId === 'new' ? newWishlistName.trim() : null,
                })}
                disabled={!canConfirm}
                style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green, #4a9a5a)', fontSize:'0.83rem', cursor:'pointer', opacity:canConfirm ? 1 : 0.45 }}>
                Create Deck ({addItems.reduce((s, i) => s + i.totalAdd, 0) + (missingAction === 'add' ? missingItems.reduce((s, i) => s + i.missingQty, 0) : 0)} cards)
              </button>
            </div>
          </>
        )}
      </div>
      {pickerItem && (
        <PrintingPickerModal
          cardName={pickerItem.dc.name}
          options={pickerItem.otherCandidates || []}
          selectedCardId={chosenOtherCardIds[pickerItem.dc.id] || ''}
          onSelect={(cardId) => {
            setChosenOtherCardIds(prev => ({ ...prev, [pickerItem.dc.id]: cardId }))
            setPickerItem(null)
          }}
          onClose={() => setPickerItem(null)}
        />
      )}
    </div>
  )
}

// â”€â”€ Sync modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function SyncModal({ deckId, deckCards, deckMeta, userId, isCollectionDeck, onConfirm, onClose }) {
  const [loading, setLoading] = useState(true)
  const [baseDiff, setBaseDiff] = useState(null)
  const [reviewDiff, setReviewDiff] = useState(null)
  const [resolutions, setResolutions] = useState({})
  const [folders, setFolders] = useState([])
  const [wishlists, setWishlists] = useState([])
  const [exactVersionOnly, setExactVersionOnly] = useState(true)
  const [globalDest, setGlobalDest] = useState('')
  const [wishlistId, setWishlistId] = useState('')
  const [newWishlistName, setNewWishlistName] = useState('')
  const [chosenOtherCardIds, setChosenOtherCardIds] = useState({})
  const [pickerItem, setPickerItem] = useState(null)

  // Intentional: modal mounts fresh on each open - one-shot load from current props snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    async function load() {
      const targetDeckId = isCollectionDeck ? deckId : deckMeta.linked_deck_id
      if (!targetDeckId) { setLoading(false); return }
      const baseline = getSyncState(deckMeta).last_sync_snapshot || { builder_cards: [], collection_cards: [] }
      const [collCards, { data: allocations }, { data: foldersData }, { data: wls }] = await Promise.all([
        getLocalCards(userId),
        sb.from('deck_allocations_view').select('*').eq('deck_id', targetDeckId),
        sb.from('folders').select('id, name, type, description').eq('user_id', userId).in('type', ['deck', 'binder']).neq('id', targetDeckId).order('name'),
        sb.from('folders').select('id, name, description').eq('user_id', userId).eq('type', 'list').order('name'),
      ])
      const collMap = new Map()
      for (const row of allocations || []) collMap.set(row.card_id, row)
      const builderCards = deckCards.filter(dc => normalizeBoard(dc.board) !== 'maybe')
      const allocationMatchesDeckCard = (dc, row) => {
        if (dc.scryfall_id && row.scryfall_id) return dc.scryfall_id === row.scryfall_id && !!dc.foil === !!row.foil
        return (dc.name || '').trim().toLowerCase() === (row.name || '').trim().toLowerCase() && !!dc.foil === !!row.foil
      }

      const remainingCurrentByCardId = new Map((allocations || []).map(row => [row.card_id, row.qty || 0]))
      const preservedByCardId = new Map()
      const plannedBase = builderCards.map(dc => {
        let remainingQty = dc.qty || 0
        const preservedAllocations = []
        const matchingAllocations = (allocations || []).filter(row => allocationMatchesDeckCard(dc, row))

        for (const row of matchingAllocations) {
          if (remainingQty <= 0) break
          const available = remainingCurrentByCardId.get(row.card_id) || 0
          if (available <= 0) continue
          const usedQty = Math.min(available, remainingQty)
          preservedAllocations.push({ card_id: row.card_id, qty: usedQty })
          preservedByCardId.set(row.card_id, (preservedByCardId.get(row.card_id) || 0) + usedQty)
          remainingCurrentByCardId.set(row.card_id, available - usedQty)
          remainingQty -= usedQty
        }

        return {
          dc,
          neededQty: dc.qty || 0,
          preservedAllocations,
          remainingQty,
        }
      })

      const remainingOwnedCards = (collCards || []).map(card => ({
        ...card,
        qty: Math.max(0, (card.qty || 0) - (preservedByCardId.get(card.id) || 0)),
      }))
      const plannedRemainder = planDeckAllocations(
        plannedBase.map(item => ({ ...item.dc, qty: item.remainingQty })),
        remainingOwnedCards
      )
      const planned = plannedBase.map((base, index) => {
        const remainder = plannedRemainder[index]
        const exactAllocations = [
          ...base.preservedAllocations,
          ...(remainder?.exactAllocations || []),
        ]
        const otherAllocations = remainder?.otherAllocations || []
        const allocationsForDeck = [...exactAllocations, ...otherAllocations]
        const exactQty = exactAllocations.reduce((sum, row) => sum + row.qty, 0)
        const otherQty = otherAllocations.reduce((sum, row) => sum + row.qty, 0)
        const totalAdd = allocationsForDeck.reduce((sum, row) => sum + row.qty, 0)
        return {
          dc: base.dc,
          neededQty: base.neededQty,
          addExact: exactQty,
          addOther: otherQty,
          totalAdd,
          missingQty: Math.max(0, base.neededQty - totalAdd),
          exactAllocations,
          otherAllocations,
          exactCandidates: remainder?.exactCandidates || [],
          otherCandidates: remainder?.otherCandidates || [],
          allocations: allocationsForDeck,
        }
      })

      const folderById = new Map((foldersData || []).map(folder => [folder.id, folder]))
      const allocationCardIds = [...new Set(planned.flatMap(item => (item.allocations || []).map(row => row.card_id).filter(Boolean)))]
      const sourceRowsByCardId = new Map()
      if (allocationCardIds.length > 0) {
        const [{ data: folderPlacements, error: folderPlacementErr }, { data: deckPlacements, error: deckPlacementErr }] = await Promise.all([
          sb.from('folder_cards')
            .select('id, folder_id, card_id, qty')
            .in('card_id', allocationCardIds),
          sb.from('deck_allocations')
            .select('id, deck_id, card_id, qty')
            .in('card_id', allocationCardIds)
            .neq('deck_id', targetDeckId),
        ])
        if (folderPlacementErr) throw folderPlacementErr
        if (deckPlacementErr) throw deckPlacementErr

        for (const row of folderPlacements || []) {
          const folder = folderById.get(row.folder_id)
          const list = sourceRowsByCardId.get(row.card_id) || []
          list.push({
            id: row.id,
            rank: 0,
            qty: row.qty || 0,
            name: folder?.name || 'Unknown binder',
            type: folder?.type || 'binder',
          })
          sourceRowsByCardId.set(row.card_id, list)
        }
        for (const row of deckPlacements || []) {
          const folder = folderById.get(row.deck_id)
          const list = sourceRowsByCardId.get(row.card_id) || []
          list.push({
            id: row.id,
            rank: 1,
            qty: row.qty || 0,
            name: folder?.name || 'Unknown deck',
            type: folder?.type || 'deck',
          })
          sourceRowsByCardId.set(row.card_id, list)
        }
        for (const [cardId, rows] of sourceRowsByCardId) {
          sourceRowsByCardId.set(cardId, rows.sort((a, b) => a.rank - b.rank || (a.qty || 0) - (b.qty || 0)))
        }
      }

      const sourceCursorByCardId = new Map([...sourceRowsByCardId.entries()].map(([cardId, rows]) => [
        cardId,
        rows.map(row => ({ ...row })),
      ]))
      const takeSourceParts = (cardId, qty) => {
        const rows = sourceCursorByCardId.get(cardId) || []
        const parts = []
        let remaining = qty || 0
        for (const row of rows) {
          if (remaining <= 0) break
          if ((row.qty || 0) <= 0) continue
          const usedQty = Math.min(row.qty || 0, remaining)
          parts.push({ type: row.type, name: row.name, qty: usedQty })
          row.qty = (row.qty || 0) - usedQty
          remaining -= usedQty
        }
        return parts
      }
      for (const item of planned) {
        const annotate = row => ({
          ...row,
          sourceParts: takeSourceParts(row.card_id, row.qty),
        })
        item.exactAllocations = (item.exactAllocations || []).map(annotate)
        item.otherAllocations = (item.otherAllocations || []).map(annotate)
        item.allocations = [...item.exactAllocations, ...item.otherAllocations]
      }

      const desiredByCardId = new Map()
      for (const item of planned) {
        for (const row of item.allocations) {
          desiredByCardId.set(row.card_id, (desiredByCardId.get(row.card_id) || 0) + row.qty)
        }
      }
      const added = []
      const changed = []
      for (const item of planned) {
        const newExactAllocations = item.exactAllocations.filter(row => !collMap.has(row.card_id))
        const newOtherAllocations = item.otherAllocations.filter(row => !collMap.has(row.card_id))
        const newAllocations = [...newExactAllocations, ...newOtherAllocations]
        const addCandidate = {
          ...item,
          exactAllocations: newExactAllocations,
          otherAllocations: newOtherAllocations,
          otherCandidates: item.otherCandidates || [],
          allocations: newAllocations,
          addExact: newExactAllocations.reduce((sum, row) => sum + row.qty, 0),
          addOther: newOtherAllocations.reduce((sum, row) => sum + row.qty, 0),
          totalAdd: newAllocations.reduce((sum, row) => sum + row.qty, 0),
          owned: item.totalAdd > 0,
        }

        if (addCandidate.totalAdd > 0 || item.missingQty > 0) added.push({ ...addCandidate })
        for (const row of item.allocations) {
          const desiredQty = desiredByCardId.get(row.card_id)
          const existing = collMap.get(row.card_id)
          if (existing && existing.qty !== desiredQty && !changed.some(c => c.cardId === row.card_id)) {
            changed.push({ dc: item.dc, cardId: row.card_id, allocRow: existing, oldQty: existing.qty, newQty: desiredQty })
          }
        }
      }
      const removed = []
      for (const [cardId, fcRow] of collMap) {
        if (!desiredByCardId.has(cardId)) removed.push({ cardId, allocRow: fcRow, name: fcRow.name || '?' })
      }
      setBaseDiff({ added, changed, removed, targetDeckId })

      const allocationRowsByKey = new Map()
      for (const row of allocations || []) {
        const key = getLogicalKey(row)
        const list = allocationRowsByKey.get(key) || []
        list.push(row)
        allocationRowsByKey.set(key, list)
      }

      const nextReviewDiff = buildSyncDiff({
        baseline,
        builderCards: deckCards.filter(dc => normalizeBoard(dc.board) !== 'maybe'),
        collectionCards: allocations || [],
      })
      const withRows = list => list.map(row => ({
        ...row,
        allocationRows: allocationRowsByKey.get(row.key) || [],
      }))
      const normalizedReview = {
        builderOnly: withRows(nextReviewDiff.builderOnly),
        collectionOnly: withRows(nextReviewDiff.collectionOnly),
        conflicts: withRows(nextReviewDiff.conflicts),
        targetDeckId,
        allocations: allocations || [],
      }
      setReviewDiff(normalizedReview)
      setResolutions(() => {
        const next = {}
        for (const row of normalizedReview.builderOnly) next[row.key] = 'builder'
        for (const row of normalizedReview.collectionOnly) next[row.key] = 'collection'
        for (const row of normalizedReview.conflicts) next[row.key] = 'keep'
        return next
      })
      const destinationFolders = (foldersData || []).filter(folder => !isGroupFolder(folder))
      setFolders(destinationFolders)
      setWishlists((wls || []).filter(folder => !isGroupFolder(folder)))
      if (destinationFolders.length === 1) setGlobalDest(destinationFolders[0].id)
      setLoading(false)
    }
    load()
  }, [])

  const overlay = { position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:700, display:'flex', alignItems:'center', justifyContent:'center' }
  const s = { background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'5px 8px', color:'var(--text)', fontSize:'0.83rem' }
  const secLabel = { fontSize:'0.74rem', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', color:'var(--text-faint)', marginBottom:6 }

  if (loading) return (
    <div style={overlay}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, padding:32, color:'var(--text-faint)', fontSize:'0.9rem' }}>
        Comparing deck with collection...
      </div>
    </div>
  )

  const diff = (() => {
    if (!baseDiff) return null
    const normalizedAdded = (baseDiff.added || []).map(item => {
      const chosen = buildChosenAllocations(item, exactVersionOnly, chosenOtherCardIds[item.dc.id])
      return { ...item, ...chosen }
    })
    return { ...baseDiff, added: normalizedAdded }
  })()

  const { added = [], changed = [], removed = [] } = diff || {}
  const builderOnly = reviewDiff?.builderOnly || []
  const collectionOnly = reviewDiff?.collectionOnly || []
  const conflicts = reviewDiff?.conflicts || []
  const reviewRows = [...builderOnly, ...collectionOnly, ...conflicts]
  const selectedBuilderKeys = new Set(reviewRows.filter(row => resolutions[row.key] === 'builder').map(row => row.key))
  const selectedCollectionRows = reviewRows.filter(row => resolutions[row.key] === 'collection')
  const unresolvedRows = reviewRows.filter(row => (resolutions[row.key] || 'keep') === 'keep')
  const ownedAdded = added.filter(i => selectedBuilderKeys.has(getLogicalKey(i.dc)) && i.totalAdd > 0)
  const unownedAdded = added.filter(i => selectedBuilderKeys.has(getLogicalKey(i.dc)) && i.missingQty > 0)
  const changedSelected = changed.filter(i => selectedBuilderKeys.has(getLogicalKey(i.dc)))
  const removedSelected = removed.filter(r => selectedBuilderKeys.has(getLogicalKey(r.allocRow)))
  const hasChanges = reviewRows.length > 0
  const movedOwnedRows = [
    ...changedSelected
      .filter(i => i.newQty < i.oldQty)
      .map(i => ({
        key: `changed:${i.allocRow.id}`,
        name: i.dc.name,
        qty: i.oldQty - i.newQty,
      })),
    ...removedSelected.map(r => ({
      key: `removed:${r.allocRow.id}`,
      name: r.name,
      qty: r.allocRow.qty || 0,
    })),
  ]
  const builderUpdateRows = selectedCollectionRows.filter(row => (row.collectionQty || 0) !== (row.builderQty || 0))
  const commanderRiskRows = [
    ...builderUpdateRows.filter(row => !!row.builder?.is_commander && !(row.collectionQty > 0)),
    ...unresolvedRows.filter(row => !!row.builder?.is_commander),
  ]
  const selectedMoveTarget = folders.find(folder => folder.id === globalDest) || null
  const canConfirm = (movedOwnedRows.length === 0 || !!globalDest)
    && (wishlistId !== 'new' || !!newWishlistName.trim())
  const addedByKey = new Map(added.map(item => [getLogicalKey(item.dc), item]))
  const changedByKey = new Map(changed.map(item => [getLogicalKey(item.dc), item]))
  const removedByKey = new Map(removed.map(item => [getLogicalKey(item.allocRow), item]))
  const increaseRows = changedSelected.filter(item => item.newQty > item.oldQty)
  const collectionImpactCount = ownedAdded.length + changedSelected.length + removedSelected.length
  const builderImpactCount = builderUpdateRows.length
  const wishlistCount = wishlistId ? unownedAdded.length : 0
  const actionCount = collectionImpactCount + builderImpactCount + unresolvedRows.length + wishlistCount
  const decisionRows = reviewRows.map(row => ({
    ...row,
    resolution: resolutions[row.key] || 'keep',
    category: getDecisionCategory(row, builderOnly, collectionOnly),
    summary: getDecisionPreview(row, resolutions[row.key] || 'keep', {
      addedByKey,
      changedByKey,
      removedByKey,
      selectedMoveTarget,
    }),
    printing: formatOwnedPrinting(row.builder || row.collection),
  }))
  const collectionDeckLabel = `Collection Deck${deckMeta?.name ? `: ${deckMeta.name}` : ''}`
  const moveOutDestinationLabel = selectedMoveTarget ? formatPlacementLabel(selectedMoveTarget) : 'Select destination'
  const moveInCopyCount = ownedAdded.reduce((sum, item) => sum + (item.totalAdd || 0), 0)
    + increaseRows.reduce((sum, item) => sum + Math.max(0, (item.newQty || 0) - (item.oldQty || 0)), 0)
  const moveOutCopyCount = movedOwnedRows.reduce((sum, row) => sum + (row.qty || 0), 0)
  const missingCopyCount = unownedAdded.reduce((sum, item) => sum + (item.missingQty || 0), 0)

  if (!hasChanges) return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, padding:32, width:380, display:'flex', flexDirection:'column', gap:16 }}>
        <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)' }}>Update Collection Deck</span>
        <p style={{ color:'var(--text-dim)', fontSize:'0.85rem', margin:0 }}>No sync differences found.</p>
        <div style={{ display:'flex', justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:'pointer' }}>Close</button>
        </div>
      </div>
    </div>
  )

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:760, maxWidth:'96vw', maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>Update Collection Deck</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:'pointer' }}>x</button>
        </div>
        <div style={{ flex:1, overflowY:'auto', minHeight:0, padding:'16px 20px', display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ padding:'12px 14px', border:'1px solid var(--border)', borderRadius:8, background:'var(--s1)', display:'flex', flexDirection:'column', gap:6 }}>
            <div style={{ color:'var(--text)', fontSize:'0.86rem' }}>
              Sync compares Deck Builder with {collectionDeckLabel}.
            </div>
            <div style={{ color:'var(--text-faint)', fontSize:'0.76rem', lineHeight:1.5 }}>
              Use Deck Builder to move owned cards into or out of the Collection Deck. Use Collection Deck only when the builder list should change and owned cards should stay where they are.
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:10 }}>
            <div style={{ padding:'12px', border:'1px solid rgba(74,154,90,0.38)', borderRadius:8, background:'rgba(74,154,90,0.08)' }}>
              <div style={{ color:'var(--text-faint)', fontSize:'0.72rem', textTransform:'uppercase', letterSpacing:'0.06em' }}>Move Into Deck</div>
              <div style={{ color:'var(--text)', fontSize:'1.1rem', marginTop:4 }}>{moveInCopyCount}</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginTop:4 }}>
                from binders/decks to Collection Deck
              </div>
            </div>
            <div style={{ padding:'12px', border:'1px solid rgba(224,112,32,0.38)', borderRadius:8, background:'rgba(224,112,32,0.08)' }}>
              <div style={{ color:'var(--text-faint)', fontSize:'0.72rem', textTransform:'uppercase', letterSpacing:'0.06em' }}>Too Many In Deck</div>
              <div style={{ color:'var(--text)', fontSize:'1.1rem', marginTop:4 }}>{moveOutCopyCount}</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginTop:4 }}>
                from Collection Deck to chosen place
              </div>
            </div>
            <div style={{ padding:'12px', border:'1px solid rgba(224,92,92,0.38)', borderRadius:8, background:'rgba(224,92,92,0.08)' }}>
              <div style={{ color:'var(--text-faint)', fontSize:'0.72rem', textTransform:'uppercase', letterSpacing:'0.06em' }}>Missing Cards</div>
              <div style={{ color:'var(--text)', fontSize:'1.1rem', marginTop:4 }}>{missingCopyCount}</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginTop:4 }}>
                not owned, optional wishlist
              </div>
            </div>
            <div style={{ padding:'12px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)' }}>
              <div style={{ color:'var(--text-faint)', fontSize:'0.72rem', textTransform:'uppercase', letterSpacing:'0.06em' }}>Deck List Only</div>
              <div style={{ color:'var(--text)', fontSize:'1.1rem', marginTop:4 }}>{builderImpactCount}</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginTop:4 }}>collection cards stay put</div>
            </div>
          </div>

          <div>
            <div style={secLabel}>Card Decisions</div>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {decisionRows.map(row => {
                const name = row.builder?.name || row.collection?.name || 'Card'
                const label = row.category === 'builderOnly'
                  ? 'Needed by Deck Builder'
                  : row.category === 'collectionOnly'
                    ? 'Only in Collection Deck'
                    : 'Different quantities'
                const optionLabels = getDecisionOptionLabels(row, { addedByKey })
                return (
                  <div key={row.key} style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) 220px', gap:12, alignItems:'center', padding:'10px 12px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)' }}>
                    <div style={{ minWidth:0, display:'flex', flexDirection:'column', gap:4 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
                        <span style={{ color:'var(--text)', fontSize:'0.85rem', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{name}</span>
                        {row.builder?.is_commander && (
                          <span style={{ color:'var(--gold)', fontSize:'0.7rem', border:'1px solid rgba(201,168,76,0.35)', borderRadius:999, padding:'2px 8px', flexShrink:0 }}>Commander</span>
                        )}
                        <span style={{ color:'var(--text-faint)', fontSize:'0.72rem', border:'1px solid var(--border)', borderRadius:999, padding:'2px 8px', flexShrink:0 }}>{label}</span>
                      </div>
                      <div style={{ color:'var(--text-faint)', fontSize:'0.74rem' }}>
                        {row.printing} · Deck Builder {row.builderQty ?? 0} · Collection Deck {row.collectionQty ?? 0}
                      </div>
                      <div style={{ color: row.resolution === 'keep' ? 'var(--text-faint)' : 'var(--text-dim)', fontSize:'0.76rem', lineHeight:1.45 }}>
                        {row.summary}
                      </div>
                    </div>
                    <Select
                      value={row.resolution}
                      onChange={e => setResolutions(prev => ({ ...prev, [row.key]: e.target.value }))}
                      style={{ ...s, width:'100%' }}
                      title="Action for this card"
                    >
                      <option value="builder">{optionLabels.builder}</option>
                      <option value="collection">{optionLabels.collection}</option>
                      <option value="keep">{optionLabels.keep}</option>
                    </Select>
                  </div>
                )
              })}
            </div>
          </div>

          <div>
            <label style={{ display:'flex', alignItems:'flex-start', gap:8, cursor:'pointer' }}>
              <input type="checkbox" checked={exactVersionOnly} onChange={e => setExactVersionOnly(e.target.checked)} style={{ accentColor:'var(--gold)', marginTop:2, flexShrink:0 }} />
              <span>
                <div style={{ fontSize:'0.84rem', color:'var(--text-dim)' }}>Use specified version only</div>
                <div style={{ fontSize:'0.75rem', color:'var(--text-faint)' }}>Exact version first. If off, another owned printing can be used, like ManaBox.</div>
              </span>
            </label>
          </div>

          {commanderRiskRows.length > 0 && (
            <div>
              <div style={secLabel}>Commander Attention</div>
              <div style={{ padding:'10px 12px', border:'1px solid rgba(201,168,76,0.28)', borderRadius:8, background:'rgba(201,168,76,0.08)', display:'flex', flexDirection:'column', gap:6 }}>
                {commanderRiskRows.map(row => (
                  <div key={`commander-${row.key}`} style={{ color:'var(--text-dim)', fontSize:'0.8rem' }}>
                    {(row.builder?.name || row.collection?.name || 'Card')}: collection choices may remove or leave unresolved commander status in Deck Builder.
                  </div>
                ))}
              </div>
            </div>
          )}

          {(ownedAdded.length > 0 || increaseRows.length > 0) && (
            <div style={{ border:'1px solid rgba(74,154,90,0.28)', borderRadius:8, background:'rgba(74,154,90,0.05)', padding:12 }}>
              <div style={secLabel}>Move Into Collection Deck</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginBottom:10 }}>
                Source: owned cards in binders or other decks. Destination: {collectionDeckLabel}.
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {ownedAdded.map(i => (
                  <div key={i.dc.id} style={{ padding:'10px 12px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)', display:'flex', flexDirection:'column', gap:5 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', gap:8, fontSize:'0.84rem', color:'var(--text)' }}>
                      <span>{i.dc.name}</span>
                      <span style={{ color:'var(--green, #4a9a5a)' }}>{formatQtyLabel(i.totalAdd)}</span>
                    </div>
                    {!!i.allocations?.length && (
                      <>
                        <div style={{ color:'var(--text-faint)', fontSize:'0.74rem' }}>
                          From: {summarizePlacementParts(i.allocations.flatMap(row => row.sourceParts || []))}
                        </div>
                        <div style={{ color:'var(--text-faint)', fontSize:'0.74rem' }}>
                          Printing: {i.allocations.map(row => `${row.qty}x ${formatOwnedPrinting(row)}`).join(', ')}
                        </div>
                      </>
                    )}
                    {!exactVersionOnly && (i.otherCandidates?.length || 0) > 1 && (
                      <div>
                        <button
                          onClick={() => setPickerItem(i)}
                          style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'5px 10px', color:'var(--text-dim)', fontSize:'0.76rem', cursor:'pointer' }}>
                          Choose owned printing
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {increaseRows.map(i => (
                  <div key={`inc-${i.cardId}:${i.dc.id}`} style={{ display:'flex', flexDirection:'column', gap:4, padding:'8px 10px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)', fontSize:'0.84rem', color:'var(--text)' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', gap:8 }}>
                      <span>{i.dc.name}</span>
                      <span style={{ color:'var(--green, #4a9a5a)', fontSize:'0.78rem' }}>{`add ${i.newQty - i.oldQty}`}</span>
                    </div>
                    <div style={{ color:'var(--text-faint)', fontSize:'0.74rem' }}>
                      From: matching owned copies elsewhere in collection. To: {collectionDeckLabel}.
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {movedOwnedRows.length > 0 && (
            <div style={{ border:'1px solid rgba(224,112,32,0.28)', borderRadius:8, background:'rgba(224,112,32,0.05)', padding:12 }}>
              <div style={secLabel}>Too Many In Collection Deck</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginBottom:8 }}>
                Source: {collectionDeckLabel}. Destination: {moveOutDestinationLabel}.
              </div>
              <Select value={globalDest} onChange={e => setGlobalDest(e.target.value)} style={{ ...s, width:'100%' }} title="Select destination" portal searchable>
                <option value="">Select binder or deck</option>
                {folders.map(folder => (
                  <option key={folder.id} value={folder.id}>
                    {folder.type === 'binder' ? 'Binder' : 'Deck'}: {folder.name}
                  </option>
                ))}
              </Select>
              {selectedMoveTarget && (
                <div style={{ color:'var(--text-dim)', fontSize:'0.76rem', marginTop:8 }}>
                  These copies will move from {collectionDeckLabel} to {formatPlacementLabel(selectedMoveTarget)}.
                </div>
              )}
              <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:10 }}>
                {movedOwnedRows.map(row => (
                  <div key={row.key} style={{ display:'flex', flexDirection:'column', gap:3, padding:'8px 10px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:'0.82rem', color:'var(--text)' }}>
                      <span>{row.name}</span>
                      <span style={{ color:'var(--text-faint)' }}>{row.qty}x</span>
                    </div>
                    <div style={{ color:'var(--text-faint)', fontSize:'0.73rem' }}>
                      {collectionDeckLabel} to {moveOutDestinationLabel}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unownedAdded.length > 0 && (
            <div style={{ border:'1px solid rgba(224,92,92,0.28)', borderRadius:8, background:'rgba(224,92,92,0.05)', padding:12 }}>
              <div style={secLabel}>Missing Cards</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginBottom:8 }}>
                These are in Deck Builder but no owned copy is available to move into {collectionDeckLabel}.
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:10 }}>
                {unownedAdded.map(item => (
                  <div key={item.dc.id} style={{ display:'flex', justifyContent:'space-between', fontSize:'0.84rem', color:'var(--text)' }}>
                    <span>{item.dc.name}</span>
                    <span style={{ color:'var(--text-faint)', fontSize:'0.78rem' }}>
                      {item.missingQty || item.dc.qty || 1}x
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginBottom:8 }}>
                These cards are not owned, so they will not be placed into the Collection Deck.
              </div>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <Select value={wishlistId} onChange={e => setWishlistId(e.target.value)} style={{ ...s, flex:1 }} title="Select wishlist">
                  <option value="">Skip</option>
                  {wishlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
                  <option value="new">+ Create new wishlist...</option>
                </Select>
                {wishlistId === 'new' && (
                  <input
                    autoFocus
                    value={newWishlistName}
                    onChange={e => setNewWishlistName(e.target.value)}
                    placeholder="Wishlist name..."
                    maxLength={100}
                    style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'5px 8px', color:'var(--text)', fontSize:'0.83rem', flex:1 }}
                  />
                )}
              </div>
            </div>
          )}

          {builderUpdateRows.length > 0 && (
            <div>
              <div style={secLabel}>Deck List Changes Only</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginBottom:8 }}>
                These decisions change the Deck Builder list to match the current Collection Deck. No collection cards will move.
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {builderUpdateRows.map(row => (
                  <div key={`builder-${row.key}`} style={{ display:'flex', justifyContent:'space-between', gap:8, padding:'8px 10px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)', fontSize:'0.84rem', color:'var(--text)' }}>
                    <span>{row.collection?.name || row.builder?.name || 'Card'}</span>
                    <span style={{ color:'var(--text-dim)', fontSize:'0.78rem' }}>{`Deck Builder ${row.builderQty ?? 0} to ${row.collectionQty ?? 0}`}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unresolvedRows.length > 0 && (
            <div>
              <div style={secLabel}>Keep Separate For Now</div>
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {unresolvedRows.map(row => (
                  <div key={`keep-${row.key}`} style={{ display:'flex', justifyContent:'space-between', fontSize:'0.8rem', color:'var(--text-dim)' }}>
                    <span>{row.builder?.name || row.collection?.name || 'Card'}</span>
                    <span>no change</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {pickerItem && (
          <PrintingPickerModal
            cardName={pickerItem.dc.name}
            options={pickerItem.otherCandidates || []}
            selectedCardId={chosenOtherCardIds[pickerItem.dc.id] || ''}
            onSelect={(cardId) => {
              setChosenOtherCardIds(prev => ({ ...prev, [pickerItem.dc.id]: cardId }))
              setPickerItem(null)
            }}
            onClose={() => setPickerItem(null)}
          />
        )}
        <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', display:'flex', gap:8, justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:'0.79rem', color:'var(--text-faint)' }}>
            {movedOwnedRows.length > 0
              ? (selectedMoveTarget ? `Moving excess cards to ${formatPlacementLabel(selectedMoveTarget)}.` : 'Choose a destination for cards leaving the Collection Deck.')
              : ''}
          </span>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={onClose} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:'pointer' }}>Cancel</button>
            <button
              disabled={!canConfirm}
              onClick={() => canConfirm && onConfirm({
                diff: reviewDiff,
                resolutions,
                builderPlan: {
                  addItems: ownedAdded,
                  missingItems: unownedAdded,
                  changedItems: changedSelected,
                  removedItems: removedSelected,
                  printingSelections: buildChosenPrintingSelections(added.filter(i => selectedBuilderKeys.has(getLogicalKey(i.dc))), chosenOtherCardIds),
                  moveDestinationId: globalDest || null,
                  wishlistId: wishlistId === 'new' ? null : (wishlistId || null),
                  wishlistName: wishlistId === 'new' ? newWishlistName.trim() : null,
                },
                collectionSelections: selectedCollectionRows,
              })}
              style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green, #4a9a5a)', fontSize:'0.83rem', cursor:canConfirm ? 'pointer' : 'not-allowed', opacity:canConfirm ? 1 : 0.45 }}>
              {`Apply ${actionCount} Decision${actionCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function MoveOwnedCardsModal({ title, message, items, folders, onConfirm, onClose }) {
  const [targetId, setTargetId] = useState('')
  const [busy, setBusy] = useState(false)
  const canConfirm = !!targetId && !busy

  const overlay = { position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:720, display:'flex', alignItems:'center', justifyContent:'center' }
  const inputStyle = { background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'8px 10px', color:'var(--text)', fontSize:'0.84rem', width:'100%' }

  async function handleConfirm() {
    const target = folders.find(folder => folder.id === targetId)
    if (!target) return
    setBusy(true)
    try {
      await onConfirm(target)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:520, maxWidth:'94vw', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>{title}</span>
          <button onClick={onClose} disabled={busy} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:busy ? 'default' : 'pointer' }}>x</button>
        </div>
        <div style={{ padding:'16px 20px', display:'flex', flexDirection:'column', gap:14 }}>
          <p style={{ margin:0, color:'var(--text-dim)', fontSize:'0.84rem', lineHeight:1.6 }}>{message}</p>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {items.map(item => (
              <div key={item.key} style={{ display:'flex', justifyContent:'space-between', fontSize:'0.84rem', color:'var(--text)' }}>
                <span>{item.name}</span>
                <span style={{ color:'var(--text-faint)' }}>{item.qty}x</span>
              </div>
            ))}
          </div>
          <Select value={targetId} onChange={e => setTargetId(e.target.value)} style={inputStyle} title="Select destination" portal searchable>
            <option value="">Select binder or deck</option>
            {folders.map(folder => (
              <option key={folder.id} value={folder.id}>
                {folder.type === 'binder' ? 'Binder' : 'Deck'}: {folder.name}
              </option>
            ))}
          </Select>
          {folders.length === 0 && (
            <div style={{ color:'#d48d6a', fontSize:'0.8rem' }}>
              No other binders or decks are available. Create one first, then try again.
            </div>
          )}
        </div>
        <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', display:'flex', justifyContent:'flex-end', gap:8 }}>
          <button onClick={onClose} disabled={busy} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:busy ? 'default' : 'pointer' }}>Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green, #4a9a5a)', fontSize:'0.83rem', cursor:canConfirm ? 'pointer' : 'not-allowed', opacity:canConfirm ? 1 : 0.45 }}>
            {busy ? 'Moving...' : 'Move & Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}

// â”€â”€ Version picker modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function VersionPickerModal({ dc, ownedMap, onSelect, onClose }) {
  const [printings, setPrintings] = useState([])
  const [loading,   setLoading]   = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(`!"${dc.name}"`)}&unique=prints&order=released`)
      .then(r => r.json())
      .then(d => {
        if (!cancelled) {
          const raw = d.data || []
          const sorted = [
            ...raw.filter(p => (ownedMap.get(p.id) ?? 0) > 0),
            ...raw.filter(p => (ownedMap.get(p.id) ?? 0) === 0),
          ]
          setPrintings(sorted)
          setLoading(false)
        }
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [dc.name])

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:700, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background:'var(--bg-card,#1e1e1e)', border:'1px solid var(--border)', borderRadius:8, padding:20, width:560, maxWidth:'96vw', maxHeight:'80vh', display:'flex', flexDirection:'column', gap:14 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'0.95rem' }}>
            Choose version - {dc.name}
          </span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.1rem', cursor:'pointer' }}>x</button>
        </div>
        {loading
          ? <div style={{ color:'var(--text-faint)', fontSize:'0.85rem', padding:'20px 0', textAlign:'center' }}>Loading printings...</div>
          : (
            <div style={{ overflowY:'auto', display:'flex', flexWrap:'wrap', gap:10 }}>
              {printings.map(p => {
                const img = getCardImageUri(p, 'normal')
                const isActive  = p.id === dc.scryfall_id
                const isOwned   = (ownedMap.get(p.id) ?? 0) > 0
                return (
                  <button key={p.id} onClick={() => onSelect(p)}
                    style={{
                      background: isActive ? 'rgba(201,168,76,0.12)' : 'var(--s2)',
                      border: `1px solid ${isActive ? 'rgba(201,168,76,0.5)' : 'var(--s-border2)'}`,
                      borderRadius:6, padding:6, cursor:'pointer', display:'flex', flexDirection:'column',
                      alignItems:'center', gap:5, width:88, flexShrink:0, transition:'all 0.13s',
                    }}>
                    {img
                      ? <img src={img} alt={p.set_name} style={{ width:76, height:106, objectFit:'cover', borderRadius:4 }} loading="lazy" />
                      : <div style={{ width:76, height:106, background:'var(--s3)', borderRadius:4 }} />
                    }
                    <div style={{ fontSize:'0.62rem', color: isActive ? 'var(--gold)' : 'var(--text-dim)', textAlign:'center', lineHeight:1.3, wordBreak:'break-word' }}>
                      {p.set_name}
                    </div>
                    {isOwned && (
                      <div style={{ fontSize:'0.58rem', color:'var(--green)', fontWeight:600 }}>Owned</div>
                    )}
                  </button>
                )
              })}
            </div>
          )
        }
      </div>
    </div>
  )
}

// â”€â”€ Deck win-rate mini widget (shown in stats tab) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function DeckWinrateMini({ results, loading, deckName }) {
  const games  = results.length
  const wins   = results.filter(r => Number(r.placement) === 1).length
  const losses = games - wins
  const rate   = games > 0 ? Math.round((wins / games) * 100) : null

  const sectionLabel = {
    fontFamily: 'var(--font-display)', fontSize: '0.65rem', letterSpacing: '0.12em',
    color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 10,
  }

  if (loading) return (
    <div>
      <div style={sectionLabel}>Win Rate</div>
      <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>Loading...</div>
    </div>
  )

  if (!games) return (
    <div>
      <div style={sectionLabel}>Win Rate</div>
      <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>
        No games tracked yet. Log a game in Life Tracker to see stats here.
      </div>
    </div>
  )

  const recentFive = results.slice(0, 5)

  return (
    <div>
      <div style={sectionLabel}>Win Rate</div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
        <div style={{ flex: 1, background: 'var(--s2)', borderRadius: 6, padding: '10px 12px', borderTop: '2px solid var(--gold)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--gold)', lineHeight: 1 }}>{rate}%</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-faint)', marginTop: 3 }}>Win Rate</div>
        </div>
        <div style={{ flex: 1, background: 'var(--s2)', borderRadius: 6, padding: '10px 12px', borderTop: '2px solid var(--s-border2)' }}>
          <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>{games}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-faint)', marginTop: 3 }}>Games</div>
        </div>
        <div style={{ flex: 1, background: 'var(--s2)', borderRadius: 6, padding: '10px 12px', borderTop: '2px solid var(--s-border2)' }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, lineHeight: 1 }}>
            <span style={{ color: 'var(--green)' }}>{wins}W</span>
            <span style={{ color: 'var(--text-faint)', fontSize: '0.8rem', margin: '0 3px' }}>&middot;</span>
            <span style={{ color: '#e07070' }}>{losses}L</span>
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-faint)', marginTop: 3 }}>Record</div>
        </div>
      </div>
      {/* Win bar */}
      <div style={{ height: 6, borderRadius: 3, background: 'var(--s-border2)', overflow: 'hidden', marginBottom: 10 }}>
        <div style={{ height: '100%', width: `${rate}%`, background: 'var(--gold)', borderRadius: 3, transition: 'width 0.4s' }} />
      </div>
      {/* Recent games */}
      {recentFive.length > 0 && (
        <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)', marginBottom: 4 }}>Recent games</div>
      )}
      <div style={{ display: 'flex', gap: 4 }}>
        {recentFive.map(r => {
          const place = Number(r.placement) || 1
          const isWin = place === 1
          return (
            <div key={r.id} title={`#${place} · ${r.played_at ? new Date(r.played_at).toLocaleDateString() : ''}`}
              style={{
                width: 22, height: 22, borderRadius: 4, fontSize: '0.62rem', fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: isWin ? 'rgba(201,168,76,0.18)' : 'var(--s3)',
                color: isWin ? 'var(--gold)' : 'var(--text-faint)',
                border: `1px solid ${isWin ? 'rgba(201,168,76,0.35)' : 'transparent'}`,
              }}
            >
              {place === 1 ? '1st' : `#${place}`}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// â”€â”€ Main DeckBuilder component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function DeckBuilderPage() {
  const { id: deckId } = useParams()
  const { user, session } = useAuth()
  const { grid_density, price_source, default_grouping } = useSettings()
  const navigate       = useNavigate()
  const location       = useLocation()

  // Deck state
  const [deck,       setDeck]       = useState(null)
  const [deckMeta,   setDeckMeta]   = useState({})
  const [deckCards,  setDeckCards]  = useState([])
  const [deckName,   setDeckName]   = useState('')
  const [saving,     setSaving]     = useState(false)
  const [loading,    setLoading]    = useState(true)
  const [loadError,  setLoadError]  = useState(null)

  // Left panel
  const [leftTab,       setLeftTab]       = useState('search')

  // Commander picker
  const [cmdQuery,      setCmdQuery]      = useState('')
  const [cmdResults,    setCmdResults]    = useState([])
  const [cmdLoading,    setCmdLoading]    = useState(false)
  const [showCmdPicker, setShowCmdPicker] = useState(false)

  // Card detail modal (read-only, used throughout the builder)
  const [detailCard, setDetailCard] = useState(null) // { card, sfCard }
  const [contextMenu, setContextMenu] = useState(null) // { dc, x, y }

  // Search
  const [searchQuery,   setSearchQuery]   = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchHasMore, setSearchHasMore] = useState(false)
  const [searchPage,    setSearchPage]    = useState(1)
  const [searchError,   setSearchError]   = useState(false)

  // Recommendations
  const [recs,         setRecs]         = useState([])
  const [recImages,    setRecImages]    = useState({}) // name -> image_uri
  const [recsLoading,   setRecsLoading]   = useState(false)
  const [recsError,     setRecsError]     = useState(null)
  const [recsOwnedOnly, setRecsOwnedOnly] = useState(false)
  const [collapsedCats, setCollapsedCats] = useState(new Set())

  // Collection
  const [ownedMap,       setOwnedMap]       = useState(new Map())
  const [ownedNameMap,   setOwnedNameMap]   = useState(new Map())
  const [ownedFoilMap,   setOwnedFoilMap]   = useState(new Map())
  const [inOtherDeckSet,  setInOtherDeckSet]  = useState(new Set())
  const [collDeckSfSet,   setCollDeckSfSet]   = useState(new Set())
  // Version picker
  const [versionPickCard, setVersionPickCard] = useState(null)
  const [addFeedback, setAddFeedback] = useState(null)
  // Share button
  const [shareCopied, setShareCopied] = useState(false)

  // Hover preview
  const [hoverImages, setHoverImages] = useState([])
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 })

  // Right panel tabs: 'deck' | 'stats' | 'combos'
  const [rightTab,            setRightTab]            = useState('deck')
  const [statsBracketOverride, setStatsBracketOverride] = useState(null)
  const [deckGameResults,        setDeckGameResults]        = useState([])
  const [deckGameResultsLoading, setDeckGameResultsLoading] = useState(false)
  const [deckGameResultsLoaded,  setDeckGameResultsLoaded]  = useState(false)
  const [deckView,    setDeckView]    = useState('list')   // 'list' | 'compact' | 'stacks' | 'grid'
  const [showRight, setShowRight] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 900)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [deckSort,    setDeckSort]    = useState('type')   // 'name' | 'cmc' | 'color' | 'type'
  const [groupBy, setGroupBy] = useState(default_grouping === 'category' ? 'category' : default_grouping === 'none' ? 'none' : 'type')
  const [visibleColumns, setVisibleColumns] = useState(DEFAULT_LIST_COLUMNS)
  const [compactVisibleColumns, setCompactVisibleColumns] = useState(DEFAULT_COMPACT_COLUMNS)
  const [builderSfMap, setBuilderSfMap] = useState({})
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())
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
  const [cmdArtHidden, setCmdArtHidden] = useState(false)
  const [syncStatus, setSyncStatus] = useState({ loading: false, dirty: false, count: 0, unavailable: false })

  // Combos (Commander Spellbook)
  const [combosIncluded, setCombosIncluded] = useState([])
  const [combosAlmost,   setCombosAlmost]   = useState([])
  const [combosLoading,  setCombosLoading]  = useState(false)
  const [combosFetched,  setCombosFetched]  = useState(false)
  const [comboSectionsOpen, setComboSectionsOpen] = useState({ complete: true, incomplete: true })

  // Import
  const [showImport,    setShowImport]    = useState(false)
  const [showExport,    setShowExport]    = useState(false)
  const [importUrl,     setImportUrl]     = useState('')
  const [importText,    setImportText]    = useState('')
  const [importTab,     setImportTab]     = useState('url') // 'url' | 'text' | 'file'
  const [importing,     setImporting]     = useState(false)
  const [importError,   setImportError]   = useState(null)
  const [importDone,    setImportDone]    = useState(null)  // summary string
  const importFileRef = useRef(null)

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

  // Mobile leftTop collapse: auto-collapses when commander is first set on mobile
  const [leftTopOpen, setLeftTopOpen] = useState(true)
  const leftTopAutoCollapsedRef = useRef(false)

  // Refs
  const deckCardsRef    = useRef(deckCards)
  const deckMetaRef     = useRef(deckMeta)
  const searchDebounce  = useRef(makeDebouncer(350))
  const cmdDebounce     = useRef(makeDebouncer(300))
  const qtyTimers       = useRef(new Map())
  const saveMetaTimer   = useRef(null)
  const hoverPreviewCache = useRef(new Map())
  const hoverPreviewPromises = useRef(new Map())
  const addFeedbackTimer = useRef(null)
  const addFeedbackRef = useRef(null)
  const hoverPreviewKey = useRef(null)
  const hoverPreviewTimer = useRef(null)
  const importingRef = useRef(false)
  const lastDeckScrollTopRef = useRef(0)
  useEffect(() => () => { importingRef.current = false }, [])

  useEffect(() => {
    return () => {
      clearTimeout(saveMetaTimer.current)
      clearTimeout(addFeedbackTimer.current)
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
    setGroupBy(default_grouping === 'category' ? 'category' : default_grouping === 'none' ? 'none' : 'type')
  }, [default_grouping])

  useEffect(() => {
    if (rightTab !== 'deck') {
      setCmdArtHidden(false)
      lastDeckScrollTopRef.current = 0
    }
  }, [rightTab])

  useEffect(() => {
    let cancelled = false
    const keys = [...new Set(deckCards
      .map(dc => (dc.set_code && dc.collector_number) ? `${dc.set_code}-${dc.collector_number}` : null)
      .filter(Boolean))]
    if (!keys.length) {
      setBuilderSfMap({})
      return
    }
    Promise.all(keys.map(async key => [key, await getScryfallEntry(key)]))
      .then(entries => {
        if (cancelled) return
        setBuilderSfMap(Object.fromEntries(entries.filter(([, value]) => !!value)))
      })
      .catch(() => {
        if (!cancelled) setBuilderSfMap({})
      })
    return () => { cancelled = true }
  }, [deckCards])

  useEffect(() => { deckCardsRef.current = deckCards }, [deckCards])
  useEffect(() => { deckMetaRef.current = deckMeta }, [deckMeta])

  // â”€â”€ Load on mount â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    if (!deckId) return
    let ignore = false
    ;(async () => {
      setLoading(true)
      try {
        // Load deck folder
        const { data: folder, error } = await sb.from('folders').select('*').eq('id', deckId).single()
        if (error || !folder) { setLoadError('Deck not found'); setLoading(false); return }
        if (folder.user_id !== user.id) { setLoadError('Access denied'); setLoading(false); return }

        const meta = parseDeckMeta(folder.description)
        // Default collection decks to commander format if no format set
        if (folder.type === 'deck' && !meta.format) {
          meta.format = 'commander'
        }
        // Re-show in builder list if user navigated here directly (e.g. "Edit in Builder")
        if (meta.hideFromBuilder) {
          delete meta.hideFromBuilder
          sb.from('folders').update({ description: serializeDeckMeta(meta) }).eq('id', deckId)
        }
        setDeck(folder)
        setDeckMeta(meta)
        deckMetaRef.current = meta
        setDeckName(folder.name)
        setCmdDescription(meta.deckDescription || '')
        setCmdTags(meta.tags || [])

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
          const updates = []
          const enrichedRows = (rows || []).map(row => {
            const resolvedById   = row.scryfall_id ? fetchedById.get(row.scryfall_id) : null
            const resolvedByName = !resolvedById   ? fetchedByName.get((row.name || '').toLowerCase()) : null
            const fetched = resolvedById || resolvedByName
            if (!fetched) return row
            const meta = getDeckBuilderCardMeta(fetched)

            // Only update printing-identity fields (scryfall_id, set, image) when:
            // - resolved via the card's own ID (safe â€” same card), OR
            // - the row genuinely has no printing info yet (name-only, e.g. text import)
            // Never overwrite an existing scryfall_id with a name lookup â€” that
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

            if (changed) {
              updates.push({
                id: row.id,
                scryfall_id: next.scryfall_id,
                set_code: next.set_code,
                collector_number: next.collector_number,
                type_line: next.type_line,
                mana_cost: next.mana_cost,
                cmc: next.cmc,
                color_identity: next.color_identity,
                image_uri: next.image_uri,
                updated_at: new Date().toISOString(),
              })
            }

            return next
          })

          for (const update of updates) {
            const { id, ...payload } = update
            await sb.from('deck_cards').update(payload).eq('id', id)
          }

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
                created_at: now,
                updated_at: now,
              }))
              const { error: hydrateErr } = await sb.from('deck_cards').insert(hydratedRows)
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

        // Build owned maps — failures here must not block the deck display
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
          setOwnedMap(map)
          setOwnedNameMap(nameMap)
          setOwnedFoilMap(foilMap)

          // For linked builder decks, allocations live on the paired collection deck
          const allocDeckId = meta.linked_deck_id || (folder.type === 'deck' ? deckId : null) || deckId
          const thisAllocations = await fetchDeckAllocations(allocDeckId)
          setCollDeckSfSet(new Set((thisAllocations || []).flatMap(row => deckAllocationKeys(row))))

          const allAllocations = await fetchDeckAllocationsForUser(user.id)
          setInOtherDeckSet(new Set(
            (allAllocations || [])
              .filter(row => row.deck_id !== deckId && row.deck_id !== allocDeckId)
              .flatMap(row => deckAllocationKeys(row))
          ))
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

  // â”€â”€ Computed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const format         = useMemo(() => FORMATS.find(f => f.id === (deckMeta.format || 'commander')), [deckMeta.format])
  const isEDH          = format?.isEDH ?? false
  const commanderCards = useMemo(() => deckCards.filter(dc => dc.is_commander), [deckCards])
  const commanderCard  = commanderCards[0] ?? null
  const mainDeckCards  = useMemo(() => deckCards.filter(dc => normalizeBoard(dc.board) === 'main'), [deckCards])

  // Auto-collapse format/commander section on mobile once commander is set
  useEffect(() => {
    if (commanderCard && !leftTopAutoCollapsedRef.current && window.innerWidth <= 900) {
      leftTopAutoCollapsedRef.current = true
      setLeftTopOpen(false)
    }
  }, [commanderCard])
  const totalCards     = useMemo(() => deckCards.reduce((s, dc) => s + dc.qty, 0), [deckCards])
  const totalDeckPrice = useMemo(() => mainDeckCards.reduce((sum, dc) => {
    const sf = builderSfMap[`${dc.set_code}-${dc.collector_number}`]
    const p = sf ? getPrice(sf, dc.foil, { price_source }) : null
    return sum + (p != null ? p * (dc.qty || 1) : 0)
  }, 0), [mainDeckCards, builderSfMap, price_source])
  const listGridTemplate = useMemo(() => {
    const cols = ['minmax(0, 1fr)']
    if (visibleColumns.set) cols.push('88px')
    if (visibleColumns.manaValue) cols.push('88px')
    if (visibleColumns.cmc) cols.push('56px')
    if (visibleColumns.price) cols.push('78px')
    if (visibleColumns.status) cols.push('94px')
    if (visibleColumns.actions) cols.push('64px')
    if (visibleColumns.qty) cols.push('58px')
    if (visibleColumns.remove) cols.push('56px')
    return cols.join(' ')
  }, [visibleColumns])

  const activeColumns = deckView === 'compact' ? compactVisibleColumns : visibleColumns
  const setActiveColumns = deckView === 'compact' ? setCompactVisibleColumns : setVisibleColumns
  const getCardOwnershipProps = useCallback((dc) => ({
    ownedQty: ownedFoilMap.get(`${dc.scryfall_id}|${dc.foil ? '1' : '0'}`) ?? 0,
    ownedFoilAlt: ownedFoilMap.get(`${dc.scryfall_id}|${dc.foil ? '0' : '1'}`) ?? 0,
    ownedAlt: ownedNameMap.get((dc.name || '').toLowerCase()) ?? 0,
    ownedInDeck: allocationSetHas(inOtherDeckSet, dc),
    inCollDeck: allocationSetHas(collDeckSfSet, dc),
  }), [ownedFoilMap, ownedNameMap, inOtherDeckSet, collDeckSfSet])

  const getDeckCardPriceLabel = useCallback((dc) => {
    if (!dc?.set_code || !dc?.collector_number) return 'â€”'
    const sf = builderSfMap[`${dc.set_code}-${dc.collector_number}`]
    if (!sf) return 'â€”'
    const price = getPrice(sf, dc.foil, { price_source })
    return price != null ? formatPrice(price, price_source) : 'â€”'
  }, [builderSfMap, price_source])
  const handleSearchRowHoverEnter = useCallback((uri, e) => {
    setHoverImages(uri ? [uri] : [])
    setHoverPos({ x: e.clientX, y: e.clientY })
  }, [])
  const handleSearchRowHoverMove = useCallback((e) => {
    setHoverPos({ x: e.clientX, y: e.clientY })
  }, [])
  const handleSearchRowHoverLeave = useCallback(() => {
    setHoverImages([])
  }, [])
  const colorIdentity  = useMemo(() => {
    const cols = new Set()
    for (const c of commanderCards) for (const col of (c.color_identity || [])) cols.add(col)
    return [...cols]
  }, [commanderCards])
  const deckSize       = format?.deckSize ?? 60

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
    if (isEDH && commanderCards.length === 0) pushWarning({ key: 'no-commander', level: 'error', summary: 'Commander missing', detail: 'Commander format requires a commander before the deck is legal.' })
    if (isEDH && commanderCards.length > 2) pushWarning({ key: 'too-many-commanders', level: 'error', summary: `${commanderCards.length} commanders marked`, detail: 'Commander format allows at most two commanders, and only when the pair is valid together.' })
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
        const typeLine = String(sample?.type_line || '').toLowerCase()
        if (!typeLine.includes('basic land')) {
          pushWarning({ key: `duplicate:${name}`, level: 'error', summary: `${sample?.name || name}: ${qty} copies`, detail: `${sample?.name || name} exceeds singleton limits for this format.` })
        }
      }
    }

    let unknownLegalityCount = 0
    for (const dc of playableCards) {
      const sf = dc.set_code && dc.collector_number ? builderSfMap[`${dc.set_code}-${dc.collector_number}`] : null
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

    return warnings
  }, [builderSfMap, colorIdentity, commanderCards, deckCards, deckSize, format, isEDH, mainDeckCards])

  const visibleDeckWarnings = useMemo(
    () => deckWarnings.filter(w => w.level === 'error'),
    [deckWarnings]
  )

  const deckCardLegalityWarnings = useMemo(() => {
    const warningsById = new Map()
    const playableCards = deckCards.filter(dc => normalizeBoard(dc.board) !== 'maybe')
    const formatId = format?.id || 'commander'
    const addWarnings = (id, warnings) => {
      if (!id || !warnings?.length) return
      warningsById.set(id, [...(warningsById.get(id) || []), ...warnings])
    }

    for (const dc of playableCards) {
      const sf = dc.set_code && dc.collector_number ? builderSfMap[`${dc.set_code}-${dc.collector_number}`] : null
      if (!dc.is_commander) {
        addWarnings(dc.id, getCardLegalityWarnings({
          card: { ...dc, legalities: sf?.legalities || dc.legalities },
          formatId,
          formatLabel: format?.label,
          isEDH,
          commanderColorIdentity: colorIdentity,
        }))
      }

      const legality = sf?.legalities?.[formatId]
      if (legality === 'restricted' && (dc.qty || 0) > 1) {
        addWarnings(dc.id, [{
          reason: 'restricted',
          text: `${dc.name} is restricted in ${format?.label || formatId}.`,
        }])
      }
    }

    if (isEDH) {
      const nameGroups = new Map()
      for (const dc of playableCards) {
        const name = normalizeCardName(dc.name)
        if (!name) continue
        nameGroups.set(name, [...(nameGroups.get(name) || []), dc])
      }
      for (const [name, cards] of nameGroups) {
        const qty = cards.reduce((sum, dc) => sum + (dc.qty || 0), 0)
        if (qty <= 1) continue
        const typeLine = String(cards[0]?.type_line || '').toLowerCase()
        if (typeLine.includes('basic land')) continue
        for (const dc of cards) {
          addWarnings(dc.id, [{
            reason: 'duplicate',
            text: `${dc.name} has ${qty} copies in a singleton format.`,
          }])
        }
      }
    }

    return warningsById
  }, [builderSfMap, colorIdentity, deckCards, format, isEDH])

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

  const toggleComboSection = useCallback((section) => {
    setComboSectionsOpen(prev => ({ ...prev, [section]: !prev[section] }))
  }, [])

  const renderDeckActionsMenu = ({ close }) => (
    <div className={uiStyles.responsiveMenuList}>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowImport(true); setImportDone(null); setImportError(null); close() }}>
        <span>Import</span>
      </button>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowExport(true); close() }}>
        <span>Export</span>
      </button>
      <Link className={uiStyles.responsiveMenuAction} to={`/builder/${deckId}/playtest`} onClick={close}>
        <span>Playtest</span>
      </Link>
      <button className={uiStyles.responsiveMenuAction} onClick={() => { setShowMetaModal(true); close() }}>
        <span>Description &amp; Tags</span>
      </button>
      <button
        className={uiStyles.responsiveMenuAction}
        onClick={() => {
          navigator.clipboard.writeText(getPublicAppUrl(`/d/${deckId}`))
          setShareCopied(true)
          setTimeout(() => setShareCopied(false), 2000)
          close()
        }}
      >
        <span>{shareCopied ? 'Copied Share Link' : 'Share'}</span>
      </button>
      <Link className={uiStyles.responsiveMenuAction} to="/builder" onClick={close}>
        <span>Back to Decks</span>
      </Link>
    </div>
  )

  // Open card detail modal by card name (recs / combos â€” no scryfall_id available)
  const openCardDetailByName = useCallback(async (name) => {
    try {
      const res = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`)
      if (!res.ok) return
      const data = await res.json()
      setDetailCard({
        card: { scryfall_id: data.id, set_code: data.set, collector_number: data.collector_number, name: data.name, qty: 1, foil: false },
        sfCard: data,
      })
    } catch {}
  }, [])


  const visibleDeckCards = useMemo(() => {
    const q = deckSearch.trim().toLowerCase()
    return deckCards.filter(dc => {
      if (boardFilter !== 'all' && normalizeBoard(dc.board) !== boardFilter) return false
      if (!q) return true
      return [
        dc.name,
        dc.type_line,
        dc.mana_cost,
        dc.set_code,
        dc.collector_number,
      ].some(value => String(value || '').toLowerCase().includes(q))
    })
  }, [deckCards, deckSearch, boardFilter])

  const sortedDeckCards = useMemo(() => {
    if (deckSort === 'type') return visibleDeckCards // type uses grouped rendering
    const cards = [...visibleDeckCards]
    if (deckSort === 'name')     return cards.sort((a, b) => a.name.localeCompare(b.name))
    if (deckSort === 'cmc_asc')  return cards.sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0) || a.name.localeCompare(b.name))
    if (deckSort === 'cmc_desc') return cards.sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0) || a.name.localeCompare(b.name))
    if (deckSort === 'color') return cards.sort((a, b) => {
      const ca = (a.color_identity || []).join('')
      const cb = (b.color_identity || []).join('')
      return ca.localeCompare(cb) || a.name.localeCompare(b.name)
    })
    if (deckSort === 'price_desc' || deckSort === 'price') return cards.sort((a, b) => {
      const sfA = builderSfMap[`${a.set_code}-${a.collector_number}`]
      const sfB = builderSfMap[`${b.set_code}-${b.collector_number}`]
      const pA = getPrice(sfA, a.foil, { price_source }) ?? -1
      const pB = getPrice(sfB, b.foil, { price_source }) ?? -1
      return pB - pA
    })
    if (deckSort === 'price_asc') return cards.sort((a, b) => {
      const sfA = builderSfMap[`${a.set_code}-${a.collector_number}`]
      const sfB = builderSfMap[`${b.set_code}-${b.collector_number}`]
      const pA = getPrice(sfA, a.foil, { price_source }) ?? Infinity
      const pB = getPrice(sfB, b.foil, { price_source }) ?? Infinity
      return pA - pB
    })
    if (deckSort === 'set') return cards.sort((a, b) => {
      const sfA = builderSfMap[`${a.set_code}-${a.collector_number}`]
      const sfB = builderSfMap[`${b.set_code}-${b.collector_number}`]
      const sA = sfA?.set_name || a.set_code || ''
      const sB = sfB?.set_name || b.set_code || ''
      return sA.localeCompare(sB) || a.name.localeCompare(b.name)
    })
    if (deckSort === 'rarity_desc' || deckSort === 'rarity') return cards.sort((a, b) => {
      const sfA = builderSfMap[`${a.set_code}-${a.collector_number}`]
      const sfB = builderSfMap[`${b.set_code}-${b.collector_number}`]
      const rA = RARITY_ORDER.indexOf(sfA?.rarity || 'common')
      const rB = RARITY_ORDER.indexOf(sfB?.rarity || 'common')
      return rA - rB || a.name.localeCompare(b.name)
    })
    if (deckSort === 'rarity_asc') return cards.sort((a, b) => {
      const sfA = builderSfMap[`${a.set_code}-${a.collector_number}`]
      const sfB = builderSfMap[`${b.set_code}-${b.collector_number}`]
      const rA = RARITY_ORDER.indexOf(sfA?.rarity || 'common')
      const rB = RARITY_ORDER.indexOf(sfB?.rarity || 'common')
      return rB - rA || a.name.localeCompare(b.name)
    })
    return visibleDeckCards
  }, [visibleDeckCards, deckSort, builderSfMap, price_source])

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
    return recs.categories.map(c => ({
      ...c,
      cards: c.cards.filter(r => {
        if (deckNameSet.has(r.name.toLowerCase())) return false
        if (recsOwnedOnly && (ownedNameMap.get(r.name.toLowerCase()) ?? 0) === 0) return false
        return true
      }),
    })).filter(c => c.cards.length > 0)
  }, [recs, deckNameSet, recsOwnedOnly, ownedNameMap])

  const handleDeckListScroll = useCallback((e) => {
    const nextTop = e.currentTarget.scrollTop
    const prevTop = lastDeckScrollTopRef.current
    lastDeckScrollTopRef.current = nextTop
    if (nextTop <= 8) {
      setCmdArtHidden(false)
      return
    }
    if (nextTop > 72 && nextTop > prevTop) {
      setCmdArtHidden(true)
      return
    }
    if (nextTop < prevTop - 20) {
      setCmdArtHidden(false)
    }
  }, [])

  // â”€â”€ Format change â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function handleFormatChange(fmtId) {
    const newMeta = { ...deckMeta, format: fmtId }
    if (!FORMATS.find(f => f.id === fmtId)?.isEDH) {
      delete newMeta.commanderName
      delete newMeta.commanderScryfallId
    }
    setDeckMeta(newMeta)
    await saveMeta(newMeta)
  }

  // â”€â”€ Save helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function withPersistentMetaFields(meta, base = deckMetaRef.current) {
    const next = { ...(meta || {}) }
    if (base?.sync_state) next.sync_state = base.sync_state
    if (next.linked_deck_id == null && base?.linked_deck_id) next.linked_deck_id = base.linked_deck_id
    if (next.linked_builder_id == null && base?.linked_builder_id) next.linked_builder_id = base.linked_builder_id
    return next
  }

  async function saveMeta(meta) {
    clearTimeout(saveMetaTimer.current)
    saveMetaTimer.current = setTimeout(async () => {
      const nextMeta = withPersistentMetaFields(meta)
      await sb.from('folders').update({ description: serializeDeckMeta(nextMeta) }).eq('id', deckId)
    }, 600)
  }

  function saveDescription(val) {
    const newMeta = { ...deckMeta, deckDescription: val }
    setDeckMeta(newMeta)
    saveMeta(newMeta)
  }

  function addTag(raw) {
    const tag = raw.trim().slice(0, 30)
    if (!tag || cmdTags.includes(tag) || cmdTags.length >= 20) return
    const next = [...cmdTags, tag]
    setCmdTags(next)
    setNewTagInput('')
    const newMeta = { ...deckMeta, tags: next }
    setDeckMeta(newMeta)
    saveMeta(newMeta)
  }

  function removeTag(tag) {
    const next = cmdTags.filter(t => t !== tag)
    setCmdTags(next)
    const newMeta = { ...deckMeta, tags: next }
    setDeckMeta(newMeta)
    saveMeta(newMeta)
  }

  async function saveNameBlur() {
    if (!deckName.trim()) return
    setSaving(true)
    await sb.from('folders').update({ name: deckName.trim() }).eq('id', deckId)
    setSaving(false)
  }

  async function togglePublic() {
    const newMeta = { ...deckMeta, is_public: !deckMeta.is_public }
    setDeckMeta(newMeta)
    await sb.from('folders').update({ description: serializeDeckMeta(withPersistentMetaFields(newMeta)) }).eq('id', deckId)
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

  // â”€â”€ Commander search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function handleCmdQuery(q) {
    setCmdQuery(q)
    setShowCmdPicker(true)
    if (!q.trim()) { setCmdResults([]); return }
    cmdDebounce.current(async () => {
      setCmdLoading(true)
      const results = await searchCommanders(q)
      setCmdResults(results)
      setCmdLoading(false)
    })
  }

  async function pickCommander(sfCard) {
    setShowCmdPicker(false)
    setCmdQuery('')
    setCmdResults([])

    const newMeta = {
      ...deckMeta,
      commanderName: sfCard.name,
      commanderScryfallId: sfCard.id,
      coverArtUri: getCardImageUri(sfCard, 'art_crop'),
      commanderColorIdentity: sfCard.color_identity,
    }
    setDeckMeta(newMeta)

    // Remove any existing commander â€” use ref to avoid stale closure
    const existingCmd = deckCardsRef.current.find(dc => dc.is_commander)
    if (existingCmd) {
      await removeCardFromDeck(existingCmd.id)
    }

    // Build commander deck card
    const cmdRow = {
      id:               crypto.randomUUID(),
      deck_id:          deckId,
      user_id:          user.id,
      scryfall_id:      sfCard.id,
      name:             sfCard.name,
      set_code:         sfCard.set,
      collector_number: sfCard.collector_number,
      type_line:        sfCard.type_line,
      mana_cost:        sfCard.mana_cost,
      cmc:              sfCard.cmc,
      color_identity:   sfCard.color_identity,
      image_uri:        getCardImageUri(sfCard, 'art_crop'),
      qty:              1,
      foil:             false,
      is_commander:     true,
      board:            'main',
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    }

    // Update state and persist â€” read ref again for current non-commander cards
    const nonCmdCards = deckCardsRef.current.filter(dc => !dc.is_commander)
    setDeckCards([cmdRow, ...nonCmdCards])
    // Upsert all rows: this handles collection decks where non-commander cards came from the
    // folder_cards fallback and were never saved to deck_cards in Supabase. Without this,
    // a reload after picking a commander would show only 1 card (just the commander).
    await sb.from('deck_cards').upsert([cmdRow, ...nonCmdCards].map(toDeckCardRow), { onConflict: 'id' })
    putDeckCards([cmdRow, ...nonCmdCards]).catch(() => {})

    // Save meta immediately (not debounced) so navigation away won't lose the commander
    clearTimeout(saveMetaTimer.current)
    await sb.from('folders').update({ description: serializeDeckMeta(withPersistentMetaFields(newMeta)) }).eq('id', deckId)

  }

  // â”€â”€ Card search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const doSearch = useCallback(async (q, page = 1) => {
    setSearchLoading(true)
    setSearchError(false)
    setSearchPage(page)
    const { cards, hasMore, error } = await searchCards({
      query: q,
      format: deckMeta.format,
      page,
    })
    if (page === 1) setSearchResults(cards)
    else setSearchResults(prev => [...prev, ...cards])
    setSearchHasMore(hasMore)
    if (error) setSearchError(true)
    setSearchLoading(false)
  }, [deckMeta.format])

  function handleSearchInput(q) {
    setSearchQuery(q)
    searchDebounce.current(() => doSearch(q, 1))
  }

  // â”€â”€ Add / remove / qty â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      // EDHRec rec â€” enrich from scryfall cache or fetch
      name       = sfCardOrRec.name
      scryfallId = null
      setCode    = null
      collNum    = null
      typeLine   = sfCardOrRec.type
      cmc        = sfCardOrRec.cmc
      colorId    = sfCardOrRec.colorIdentity
      imageUri   = recImages[name] || null

      // Try to fetch full Scryfall data for the card
      try {
        const [full] = await fetchCardsByNames([name])
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

    // Check if already in deck (non-foil â€” this function always adds non-foil cards)
    const existing = deckCards.find(dc =>
      ((scryfallId && dc.scryfall_id === scryfallId) || dc.name === name) && !dc.foil && normalizeBoard(dc.board) === 'main'
    )

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

    if (existing) {
      // Increment qty
      changeQty(existing.id, +1)
      flashAddFeedback(name, scryfallId, 1)
      return
    }

    const [newRow] = await requireCardPrintIds([{
      id:               crypto.randomUUID(),
      deck_id:          deckId,
      user_id:          user.id,
      scryfall_id:      scryfallId,
      name,
      set_code:         setCode || null,
      collector_number: collNum || null,
      type_line:        typeLine || null,
      mana_cost:        manaCost || null,
      cmc:              cmc ?? null,
      color_identity:   colorId || [],
      image_uri:        imageUri,
      qty:              1,
      foil:             false,
      is_commander:     false,
      board:            'main',
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
    }], 'Deck card')

    setDeckCards(prev => [...prev, newRow])
    await sb.from('deck_cards').insert(newRow)
    putDeckCards([newRow]).catch(() => {})
    flashAddFeedback(name, scryfallId, 1)
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
      await sb.from('deck_cards').update({ qty: latest.qty, updated_at: new Date().toISOString() }).eq('id', deckCardId)
      qtyTimers.current.delete(deckCardId)
    }, 600)
    qtyTimers.current.set(deckCardId, timer)
  }

  async function removeCardFromDeck(deckCardId) {
    const current = deckCardsRef.current.find(dc => dc.id === deckCardId)
    if (!current) return

    setDeckCards(prev => prev.filter(dc => dc.id !== deckCardId))
    await sb.from('deck_cards').delete().eq('id', deckCardId)
    deleteDeckCardLocal(deckCardId).catch(() => {})
  }

  async function toggleFoil(deckCardId) {
    const card = deckCardsRef.current.find(dc => dc.id === deckCardId)
    if (!card) return
    const newFoil = !card.foil
    setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? { ...dc, foil: newFoil } : dc))
    await sb.from('deck_cards').update({ foil: newFoil, updated_at: new Date().toISOString() }).eq('id', deckCardId)
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
      await Promise.all([
        sb.from('deck_cards').update({ qty: updatedTarget.qty, updated_at: updatedTarget.updated_at }).eq('id', matchingTarget.id),
        sb.from('deck_cards').delete().eq('id', deckCardId),
      ])
      return
    }

    const updated = { ...card, board: nextBoard, updated_at: new Date().toISOString() }
    setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? updated : dc))
    putDeckCards([updated]).catch(() => {})
    await sb.from('deck_cards').update({ board: nextBoard, updated_at: updated.updated_at }).eq('id', deckCardId)
  }

  async function setCardAsCommander(dc, nextIsCommander = true) {
    if (!nextIsCommander) {
      await unsetCommander(dc.id)
      return
    }
    const alreadyHasCmd = deckCardsRef.current.some(c => c.is_commander)
    const updated = { ...dc, is_commander: true, board: 'main' }
    setDeckCards(prev => prev.map(c => c.id === dc.id ? updated : c))
    putDeckCards([updated]).catch(() => {})
    await sb.from('deck_cards').update({ is_commander: true, board: 'main', updated_at: new Date().toISOString() }).eq('id', dc.id)
    // Update deck meta
    const newMeta = alreadyHasCmd
      ? { ...deckMeta, partnerName: dc.name, partnerScryfallId: dc.scryfall_id }
      : {
          ...deckMeta,
          commanderName: dc.name,
          commanderScryfallId: dc.scryfall_id,
          coverArtUri: dc.image_uri ? toArtCropImg(dc.image_uri) : deckMeta.coverArtUri,
          commanderColorIdentity: dc.color_identity ?? [],
        }
    setDeckMeta(newMeta)
    // Save meta immediately (not debounced) â€” navigating away quickly would lose the commander name otherwise
    clearTimeout(saveMetaTimer.current)
    await sb.from('folders').update({ description: serializeDeckMeta(withPersistentMetaFields(newMeta)) }).eq('id', deckId)
    // Recs are loaded lazily when the Recommendations tab is opened
  }

  async function unsetCommander(deckCardId) {
    setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? { ...dc, is_commander: false } : dc))
    await sb.from('deck_cards').update({ is_commander: false }).eq('id', deckCardId)
  }

  // â”€â”€ EDHRec recommendations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function loadRecs(commanderName) {
    setRecsLoading(true)
    setRecsError(null)
    setRecs([])
    setRecImages({})
    setCollapsedCats(new Set())

    const data = await fetchEdhrecCommander(commanderName)
    if (!data) { setRecsError('unavailable'); setRecsLoading(false); return }

    setRecs(data)

    // Enrich images for visible recs
    const allRecNames = data.categories.flatMap(c => c.cards.map(r => r.name))
    setRecsLoading(false) // Show recs immediately, load images in background

    const sfCards = await fetchCardsByNames(allRecNames.slice(0, 150))
    const imgMap = {}
    for (const c of sfCards) {
      const uri = getCardImageUri(c, 'small')
      if (uri) imgMap[c.name] = uri
    }
    setRecImages(imgMap)
  }

  // â”€â”€ Commander Spellbook combos â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function fetchCombos() {
    if (combosLoading) return
    setCombosLoading(true)
    try {
      const body = {
        commanders: commanderCard ? [{ card: commanderCard.name }] : [],
        main: deckCards.filter(dc => !dc.is_commander && normalizeBoard(dc.board) === 'main').map(dc => ({ card: dc.name })),
      }
      // Dev: use Vite proxy (spoof Origin). Prod: use Supabase Edge Function.
      const combosUrl = import.meta.env.DEV
        ? '/api/combos/find-my-combos/'
        : `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/combo-proxy`
      const res = await fetch(combosUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(import.meta.env.DEV ? {} : {
            'apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          }),
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`API ${res.status}`)
      const data = await res.json()
      const r = data.results || {}
      setCombosIncluded(r.included || [])
      setCombosAlmost([...(r.almostIncluded || []), ...(r.almostIncludedByAddingColors || [])])
      setCombosFetched(true)
    } catch (e) {
      console.warn('[Combos]', e)
    }
    setCombosLoading(false)
  }

  // â”€â”€ Convert to collection deck â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // â”€â”€ Deck import â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function handleImport() {
    if (importingRef.current) return
    importingRef.current = true
    setImportError(null)
    setImportDone(null)
    setImporting(true)

    try {
      let parsed = []
      let importedName = null

      if (importTab === 'url') {
        const result = await importDeckFromUrl(importUrl)
        parsed = normalizeImportedDeckCards(result.cards)
        importedName = result.name
      } else {
        parsed = parseImportText(importText).entries
      }

      if (!parsed.length) throw new Error('No cards found in the import.')

      const resolvedRows = await resolveImportEntries(parsed)
      const matchedRows = resolvedRows.filter(row => row.status === 'matched' && row.sfCard)
      const missedRows = resolvedRows.filter(row => row.status !== 'matched')
      if (!matchedRows.length) throw new Error('No cards could be matched in Scryfall.')

      // Build deck_cards rows
      const now = new Date().toISOString()
      const newRows = []
      let commanderSet = false

      for (const entry of matchedRows) {
        const sf = entry.sfCard
        const meta = getDeckBuilderCardMeta(sf)
        const isCmd = entry.isCommander && !commanderSet
        if (isCmd) commanderSet = true

        newRows.push({
          id:               crypto.randomUUID(),
          deck_id:          deckId,
          user_id:          user.id,
          scryfall_id:      meta.scryfall_id,
          name:             entry.resolvedName || entry.name,
          set_code:         entry.resolvedSetCode ?? entry.setCode ?? meta.set_code,
          collector_number: entry.resolvedCollectorNumber ?? entry.collectorNumber ?? meta.collector_number,
          type_line:        meta.type_line,
          mana_cost:        meta.mana_cost,
          cmc:              meta.cmc,
          color_identity:   meta.color_identity ?? [],
          image_uri:        meta.image_uri,
          qty:              entry.qty,
          foil:             entry.foil ?? false,
          is_commander:     isCmd,
          board:            isCmd ? 'main' : normalizeBoard(entry.board),
          created_at:       now,
          updated_at:       now,
        })
      }

      const hydratedRows = await requireCardPrintIds(newRows, 'Imported deck card')

      // Save to Supabase
      await sb.from('deck_cards').insert(hydratedRows)
      putDeckCards(hydratedRows).catch(() => {})

      // Update deck name if blank and we have one from import
      if (importedName && (!deckName || deckName === 'New Deck')) {
        setDeckName(importedName)
        await sb.from('folders').update({ name: importedName }).eq('id', deckId)
      }

      setDeckCards(prev => [...prev, ...hydratedRows])
      const importedCopies = hydratedRows.reduce((sum, row) => sum + (row.qty || 0), 0)
      const boardSummary = BOARD_ORDER
        .map(board => {
          const qty = hydratedRows.filter(row => normalizeBoard(row.board) === board).reduce((sum, row) => sum + (row.qty || 0), 0)
          return qty ? `${qty} ${BOARD_LABELS[board].toLowerCase()}` : null
        })
        .filter(Boolean)
        .join(', ')
      const skipped = missedRows.length ? `, skipped ${missedRows.length} unresolved row${missedRows.length !== 1 ? 's' : ''}` : ''
      setImportDone(`Imported ${importedCopies} card${importedCopies !== 1 ? 's' : ''}${boardSummary ? ` (${boardSummary})` : ''}${skipped}`)
      setImportUrl('')
      setImportText('')
    } catch (err) {
      setImportError(err.message)
    }
    setImporting(false)
    importingRef.current = false
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
      await sb.from('deck_cards').update({ qty: original.qty - 1, updated_at: now }).eq('id', dcId)
      await sb.from('deck_cards').insert(toDeckCardRow(splitRow))
      putDeckCards([{ ...original, qty: original.qty - 1, updated_at: now }, splitRow]).catch(() => {})
      setVersionPickCard(null)
      return
    }
    setDeckCards(prev => prev.map(d => d.id === dcId ? { ...d, ...updated } : d))
    await sb.from('deck_cards').update(updated).eq('id', dcId)
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
    setHoverPos({ x: e.clientX, y: e.clientY })
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
    if (!CAN_HOVER || lastInputWasTouch) return
    e.preventDefault()
    e.stopPropagation()
    clearHoverPreview()

    const menuWidth = 240
    const menuHeight = dc.qty > 1 ? 280 : 236
    const gap = 8
    const x = Math.min(Math.max(gap, e.clientX), Math.max(gap, window.innerWidth - menuWidth - gap))
    const y = Math.min(Math.max(gap, e.clientY), Math.max(gap, window.innerHeight - menuHeight - gap))
    setContextMenu({ dc, x, y })
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

    const allAllocations = await fetchDeckAllocationsForUser(user.id)
    setInOtherDeckSet(new Set(
      (allAllocations || [])
        .filter(row => row.deck_id !== allocationDeckId)
        .flatMap(row => deckAllocationKeys(row))
    ))
  }

  useEffect(() => {
    const targetDeckId = getAllocationDeckId()
    const syncState = getSyncState(deckMeta)
    const baseline = syncState.last_sync_snapshot || { builder_cards: [], collection_cards: [] }
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
  }, [deckCards, deckMeta, deckId, isCollectionDeck, user?.id])

  useEffect(() => {
    if (!location.state?.openSync) return
    if (loading) return
    if (!(isCollectionDeck || deckMeta.linked_deck_id)) return
    setShowSync(true)
    navigate(location.pathname, { replace: true, state: {} })
  }, [location.state, location.pathname, loading, isCollectionDeck, deckMeta.linked_deck_id, navigate])

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
  }

  async function promptToMoveOwnedCopies({ title, message, items, onComplete }) {
    const folders = await loadMoveTargets(getAllocationDeckId())
    setPendingOwnedMove({
      title,
      message,
      items,
      folders,
      onConfirm: async (destination) => {
        const { deletedAllocIds, updatedAllocs, touchedDeckIds, touchedFolderIds } = await moveOwnedCopiesOutOfDeck(items, destination)
        await deleteDeckAllocationsByIds(deletedAllocIds).catch(() => {})
        if (updatedAllocs.length) await putDeckAllocations(updatedAllocs).catch(() => {})
        await refreshPlacementCaches({ deckIds: touchedDeckIds, folderIds: touchedFolderIds })
        await onComplete?.(destination)
        await refreshAllocationIndicators()
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
      await sb.from('deck_cards').update(payload).eq('id', id)
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
      await sb.from('deck_cards').update(payload).eq('id', id)
    }
  }

  async function handleMakeDeck({ addItems, missingItems, printingSelections, addMissing, wishlistId, wishlistName }) {
    if (makeDeckRunning) return
    setMakeDeckRunning(true)
    setShowMakeDeck(false)
    try {
      const builderMeta = parseDeckMeta(deck.description)
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

      const linkedBuilderMeta = withLinkedPair(builderMeta, { linkedDeckId: newCollectionDeck.id })
      const linkedCollectionMeta = withLinkedPair(parseDeckMeta(newCollectionDeck.description), { linkedBuilderId: deckId })
      await Promise.all([
        sb.from('folders').update({ description: serializeDeckMeta(linkedBuilderMeta) }).eq('id', deckId),
        sb.from('folders').update({ description: serializeDeckMeta(linkedCollectionMeta) }).eq('id', newCollectionDeck.id),
      ])
      setDeckMeta(linkedBuilderMeta)
      await applyExplicitPrintingSelections(printingSelections)

      if (addItems.length > 0) {
        const allocationRows = mergeAllocationRows(addItems
          .flatMap(item => (item.allocations || []).map(row => ({
            id: crypto.randomUUID(),
            card_id: row.card_id,
            qty: row.qty,
          }))))

        await syncDeckRowsToAllocatedPrintings(addItems)
        await upsertDeckAllocations(newCollectionDeck.id, user.id, allocationRows)
        await reassignPlacementsToDeck(newCollectionDeck.id, allocationRows)
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
      setMakeDeckMsg('Failed to make collection deck. Try again.')
      setMakeDeckDone(true)
    }
    setMakeDeckRunning(false)
  }

  function buildCommanderMetaFromCards(cards, currentMeta) {
    const commanderRows = (cards || []).filter(card => card.is_commander)
    const nextMeta = { ...currentMeta }
    const primary = commanderRows[0] || null
    const partner = commanderRows[1] || null

    if (!primary) {
      delete nextMeta.commanderName
      delete nextMeta.commanderScryfallId
      delete nextMeta.commanderColorIdentity
      delete nextMeta.coverArtUri
      delete nextMeta.partnerName
      delete nextMeta.partnerScryfallId
      return nextMeta
    }

    nextMeta.commanderName = primary.name
    nextMeta.commanderScryfallId = primary.scryfall_id || null
    nextMeta.commanderColorIdentity = primary.color_identity ?? []
    nextMeta.coverArtUri = primary.image_uri ? toArtCropImg(primary.image_uri) : (currentMeta?.coverArtUri || null)

    if (partner) {
      nextMeta.partnerName = partner.name
      nextMeta.partnerScryfallId = partner.scryfall_id || null
    } else {
      delete nextMeta.partnerName
      delete nextMeta.partnerScryfallId
    }

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

      let remaining = desiredQty
      const sorted = [...matching].sort((a, b) => {
        if (!!a.is_commander !== !!b.is_commander) return a.is_commander ? -1 : 1
        return (b.qty || 0) - (a.qty || 0)
      })
      for (let idx = 0; idx < sorted.length; idx += 1) {
        const dc = sorted[idx]
        const nextQty = idx === 0 ? remaining : 0
        remaining -= nextQty
        if (nextQty > 0) {
          updates.push({ id: dc.id, qty: nextQty, updated_at: now })
          const target = nextDeckCards.find(item => item.id === dc.id)
          if (target) target.qty = nextQty
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
      await sb.from('deck_cards').update({ qty: row.qty, updated_at: row.updated_at }).eq('id', row.id)
    }
    if (inserts.length) {
      const hydratedInserts = await requireCardPrintIds(inserts, 'Synced deck card')
      const hydratedById = new Map(hydratedInserts.map(row => [row.id, row]))
      for (let i = 0; i < nextDeckCards.length; i += 1) {
        const hydrated = hydratedById.get(nextDeckCards[i].id)
        if (hydrated) nextDeckCards[i] = hydrated
      }
      await sb.from('deck_cards').insert(hydratedInserts)
    }
    for (const id of deletes) {
      await sb.from('deck_cards').delete().eq('id', id)
      deleteDeckCardLocal(id).catch(() => {})
    }
    if (inserts.length) putDeckCards(nextDeckCards.filter(dc => inserts.some(row => row.id === dc.id))).catch(() => {})
    if (updates.length) putDeckCards(nextDeckCards.filter(dc => updates.some(u => u.id === dc.id))).catch(() => {})

    const nextMeta = buildCommanderMetaFromCards(nextDeckCards, deckMeta)
    if (serializeDeckMeta(nextMeta) !== serializeDeckMeta(deckMeta)) {
      setDeckMeta(nextMeta)
      await sb.from('folders').update({ description: serializeDeckMeta(nextMeta) }).eq('id', deckId)
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
        await sb.from('deck_allocations').update({ qty: c.newQty }).eq('id', c.allocRow.id)
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
        const { data: wl } = await sb.from('folders').insert({ user_id: user.id, type: 'list', name: wishlistName, description: '{}' }).select().single()
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

  // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      <div className={`${styles.deckHeader}${cmdArtHidden ? ' ' + styles.deckHeaderHidden : ''}`}>
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
            <span>{deckMeta.is_public ? 'Public' : 'Private'}</span>
            {saving && <span className={styles.savingDot} />}
          </div>
        </div>
        <div className={styles.headerActions}>
          {(isCollectionDeck || deckMeta.linked_deck_id) && (
            <button className={styles.headerBtnPrimary} onClick={() => setShowSync(true)} disabled={syncRunning} title="Sync collection">
              <span className={styles.btnIcon} aria-hidden="true"><CollectionIcon size={14} /></span>
              <span className={styles.btnLabel}>{syncLabel}</span>
              <span className={styles.btnLabelMobile}>{syncLabelMobile}</span>
            </button>
          )}
          <ResponsiveMenu
            title="Deck Actions"
            wrapClassName={styles.headerActionsMenu}
            align="right"
            trigger={({ toggle }) => (
              <button className={styles.headerBtn} onClick={toggle} title="Deck actions">
                <span className={styles.btnIcon} aria-hidden="true"><MenuIcon size={14} /></span>
                <span className={styles.btnLabel}>Deck Actions</span>
                <span className={styles.btnLabelMobile}>Actions</span>
              </button>
            )}
          >
            {renderDeckActionsMenu}
          </ResponsiveMenu>
          {!isCollectionDeck && !deckMeta.linked_deck_id && (
            <button className={styles.headerBtnPrimary} onClick={() => setShowMakeDeck(true)} disabled={makeDeckRunning} title="Make Collection Deck">
              <span className={styles.btnIcon} aria-hidden="true"><DeckIcon size={14} /></span>
              <span className={styles.btnLabel}>{makeDeckRunning ? 'Creating...' : 'Make Collection Deck'}</span>
              <span className={styles.btnLabelMobile}>{makeDeckRunning ? 'Creating...' : 'Make Deck'}</span>
            </button>
          )}
        </div>
      </div>

      {/* â”€â”€ LEFT PANEL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className={styles.left}>
        <button
          type="button"
          className={styles.leftCollapseBtn}
          onClick={() => setLeftCollapsed(v => !v)}
          title={leftCollapsed ? 'Expand search panel' : 'Collapse search panel'}
          aria-label={leftCollapsed ? 'Expand search panel' : 'Collapse search panel'}
        >
          {leftCollapsed ? <ChevronRightIcon size={14} /> : <ChevronLeftIcon size={14} />}
        </button>
        {leftCollapsed && (
          <button
            type="button"
            className={styles.leftRail}
            onClick={() => setLeftCollapsed(false)}
            title="Expand search panel"
          >
            <span>Search</span>
          </button>
        )}
        <div className={styles.leftContent}>
        {/* Mobile panel toggle â€” rendered outside the left panel so it stays visible */}
        <div className={styles.leftTop}>
          {/* Mobile toggle for format/commander â€” hidden on desktop via CSS */}
          <div className={styles.leftTopToggle} onClick={() => setLeftTopOpen(v => !v)}>
            <div className={styles.leftTopToggleSummary}>
              <span>{format?.label ?? 'Format'}</span>
              {commanderCard && <span className={styles.leftTopToggleCmdr}>&middot; {commanderCard.name}</span>}
            </div>
            <span className={styles.leftTopToggleChevron} aria-hidden="true">
              {leftTopOpen ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
            </span>
          </div>

          {/* Collapsible content â€” always visible on desktop, animated on mobile */}
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

            {/* Commander picker */}
            {isEDH && (
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

            {/* Public/private toggle */}
            <div className={styles.formatRow}>
              <span className={styles.formatLabel}>Visibility</span>
              <div className={styles.visibilityToggleRow}>
                <div
                  className={`${styles.toggleTrack} ${deckMeta.is_public ? styles.toggleTrackOn : ''}`}
                  onClick={togglePublic}
                >
                  <div className={styles.toggleThumb} />
                </div>
                <span className={`${styles.toggleLabel} ${deckMeta.is_public ? styles.toggleLabelOn : ''}`}>
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
              if (isEDH && commanderCard && !recs?.categories) loadRecs(commanderCard.name)
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
                <button className={styles.loadMore} onClick={() => doSearch(searchQuery, searchPage + 1)}>
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
                      <div className={styles.recsEmpty}>All recommended cards are already in your deck.</div>
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
                              ownedQty={ownedMap.get(rec.slug) ?? 0}
                              onAdd={addCardToDeck}
                              onHoverEnter={CAN_HOVER && !lastInputWasTouch ? (uri, e) => { setHoverImages(uri ? [uri] : []); setHoverPos({ x: e.clientX, y: e.clientY }) } : undefined}
                              onHoverMove={CAN_HOVER ? e => setHoverPos({ x: e.clientX, y: e.clientY }) : undefined}
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

      {/* â”€â”€ RIGHT PANEL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
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
                <span style={{
                  marginLeft: 5, fontSize: '0.68rem', padding: '1px 6px',
                  borderRadius: 10, background: 'var(--s-border2)',
                  color: over ? '#e07070' : 'var(--text-faint)',
                }}>
                  {badge}
                </span>
              )}
            </button>
          ))}
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
        <div className={`${styles.deckList}${rightTab !== 'deck' ? ' ' + styles.tabPaneHidden : ''}`} onScroll={handleDeckListScroll}>
            {/* Commander art display â€” supports partners */}
            {commanderCards.length > 0 && (
              <div className={styles.cmdArt}>
                {/* Blurred background layer */}
                <div className={styles.cmdArtBg}
                  style={{ backgroundImage: `url(${toArtCropImg(commanderCards[0].image_uri)})` }} />
                {/* Art thumbnails */}
                {commanderCards.map(card => (
                  <div key={card.id} className={styles.cmdArtPane}
                    onClick={() => unsetCommander(card.id)} title="Click to remove commander status">
                    {card.image_uri
                      ? <img className={styles.cmdArtImg} src={toArtCropImg(card.image_uri)} alt={card.name} />
                      : <div className={styles.cmdArtImgPlaceholder} />
                    }
                  </div>
                ))}
                {/* Info panel */}
                <div className={styles.cmdArtOverlay}>
                  <span className={styles.cmdArtName}>
                    {commanderCards.map(c => c.name).join(' & ')}
                  </span>
                  <div className={styles.cmdArtMeta}>
                    {format && <span>{format.label}</span>}
                    {format && <span>&middot;</span>}
                    <span style={{ color: totalCards > deckSize ? '#e07070' : 'var(--text-dim)' }}>
                      {totalCards}/{deckSize} cards
                    </span>
                    {totalDeckPrice > 0 && <span>&middot;</span>}
                    {totalDeckPrice > 0 && <span style={{ color: 'var(--green)' }}>{formatPrice(totalDeckPrice, price_source)}</span>}
                  </div>
                </div>
                {/* Color pips */}
                {colorIdentity.length > 0 && (
                  <div className={styles.cmdColorPips}>
                    {colorIdentity.map(c => (
                      <img key={c} src={manaSymbolUrl(`{${c}}`)} alt={c} width={18} height={18}
                        style={{ display: 'block', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.7))' }} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Description + Tags — always available */}
            <div className={styles.deckMetaPanel}>
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
                    <button className={styles.deckMetaTagRemove} onClick={() => removeTag(tag)}>x</button>
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
                      {[['name','A–Z'],['cmc_asc','Mana Value ↑'],['cmc_desc','Mana Value ↓'],['color','Color'],['type','Type'],['rarity_desc','Rarity ↓'],['rarity_asc','Rarity ↑'],['set','Set'],['price_desc','Price ↓'],['price_asc','Price ↑']].map(([s, label]) => (
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
                      <FilterIcon size={15} />
                      <span className={styles.toggleLabel}>Group</span>
                    </button>
                  )}
                >
                  {({ close }) => (
                    <div className={uiStyles.responsiveMenuList}>
                      {[['none','None'],['type','By Type'],['category','By Category'],['rarity','By Rarity'],['set','By Set']].map(([v, label]) => (
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
                    const filterActive = (deckSearch.trim().length > 0) || (boardFilter !== 'all')
                    return (
                      <button
                        className={`${styles.groupToggle} ${styles.groupToggleIcon}${filterActive ? ' '+styles.groupToggleActive : ''}`}
                        onClick={toggle}
                        title="Filter deck"
                        aria-label="Filter deck"
                      >
                        <SearchIcon size={15} />
                        <span className={styles.toggleLabel}>Filter</span>
                      </button>
                    )
                  }}
                >
                  {() => (
                    <div className={styles.deckFilterMenuBody}>
                      <input
                        className={styles.deckSearchInput}
                        value={deckSearch}
                        onChange={e => setDeckSearch(e.target.value)}
                        placeholder="Search deck..."
                        autoFocus
                      />
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
                    </div>
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
                    <CollectionIcon size={15} />
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
                  title="Deck Actions"
                  wrapClassName={`${styles.columnMenuWrap} ${styles.pillOnly}`}
                  portal
                  trigger={({ toggle }) => (
                    <button
                      className={`${styles.groupToggle} ${styles.groupToggleIcon}`}
                      onClick={toggle}
                      title="Deck actions"
                      aria-label="Deck actions"
                    >
                      <MenuIcon size={15} />
                      <span className={styles.toggleLabel}>Actions</span>
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
            {visibleDeckCards.length > 0 && (() => {
              const deckRowProps = (dc) => {
                return {
                dc,
                ...getCardOwnershipProps(dc),
                onChangeQty: changeQty,
                onRemove:    removeCardFromDeck,
                onMouseEnter: CAN_HOVER ? e => showHoverPreviewForDeckCard(dc, e) : undefined,
                onMouseLeave: CAN_HOVER ? () => clearHoverPreview() : undefined,
                onMouseMove:  CAN_HOVER ? e => setHoverPos({ x: e.clientX, y: e.clientY }) : undefined,
                onContextMenu: CAN_HOVER ? e => openDeckCardContextMenu(dc, e) : undefined,
                onPickVersion: (dc, options = {}) => setVersionPickCard({ ...dc, ...options }),
                onToggleFoil:  toggleFoil,
                onSetCommander: setCardAsCommander,
                onMoveBoard: moveCardToBoard,
                isEDH,
                visibleColumns,
                listGridTemplate,
                priceLabel: getDeckCardPriceLabel(dc),
                onOpenDetail: openDeckCardDetail,
                legalityWarnings: deckCardLegalityWarnings.get(dc.id) || [],
                }
              }

              const renderCard = (dc, stackContext = null) => {
                const legalityWarnings = deckCardLegalityWarnings.get(dc.id) || []
                const warningTitle = legalityWarnings.map(w => w.text).join('\n')
                if (deckView === 'grid') return (
                  <div key={dc.id} className={`${styles.visualCard}${dc.is_commander ? ' '+styles.isCommander : ''}${legalityWarnings.length ? ' '+styles.visualCardIllegal : ''}`}
                    title={warningTitle || undefined}
                    onClick={() => openDeckCardDetail(dc)}
                    onContextMenu={CAN_HOVER ? e => openDeckCardContextMenu(dc, e) : undefined}>
                    <div className={styles.visualImgWrap}>
                      {dc.image_uri
                        ? <img src={grid_density === 'compact' ? dc.image_uri?.replace(/\/(normal|large|png|border_crop|art_crop)\//, '/small/') : dc.image_uri} alt={dc.name} className={styles.visualCardImg} loading="lazy" />
                        : <div className={styles.visualCardPlaceholder}>{dc.name}</div>}
                      {dc.qty > 1 && <span className={styles.visualCardQty}>x{dc.qty}</span>}
                      {dc.foil && <span className={styles.visualCardFoil} title="Foil">*</span>}
                    </div>
                    <div className={styles.visualCardBottom}>
                      <div className={styles.visualCardInfoRow}>
                        <span className={styles.visualCardPrice}>{getDeckCardPriceLabel(dc)}</span>
                        <OwnershipBadge
                          {...getCardOwnershipProps(dc)}
                        />
                      </div>
                      <div className={styles.visualCardControls}>
                        <EditMenu dc={dc} isEDH={isEDH} onSetCommander={setCardAsCommander} onToggleFoil={toggleFoil} onPickVersion={(card, options = {}) => setVersionPickCard({ ...card, ...options })} onMoveBoard={moveCardToBoard} />
                        <button className={styles.visualCardBtn} onClick={(ev) => { ev.stopPropagation(); changeQty(dc.id, -1) }}>-</button>
                        <span className={styles.visualCardCount}>{dc.qty}</span>
                        <button className={styles.visualCardBtn} onClick={(ev) => { ev.stopPropagation(); changeQty(dc.id, +1) }}>+</button>
                        <button className={styles.visualCardBtn} onClick={(ev) => { ev.stopPropagation(); removeCardFromDeck(dc.id) }}>x</button>
                      </div>
                    </div>
                  </div>
                )
                if (deckView === 'stacks') {
                  const activeHover = stackHoverState || touchActiveStack
                  const isPushedDown = activeHover
                    && activeHover.group === stackContext?.group
                    && stackContext?.idx > activeHover.stackIdx
                  const isTouchActive = touchActiveStack?.id === dc.id
                  return (
                    <div
                      key={dc.id}
                      className={`${styles.stackCard}${dc.is_commander ? ' '+styles.isCommander : ''}${legalityWarnings.length ? ' '+styles.stackCardIllegal : ''}${isPushedDown ? ' '+styles.stackCardPushedDown : ''}${isTouchActive ? ' '+styles.stackCardActive : ''}`}
                      style={{ zIndex: isTouchActive ? 200 : (stackContext?.idx ?? 0) }}
                      title={warningTitle || dc.name}
                      onClick={() => {
                        if (!CAN_HOVER) {
                          if (isTouchActive) {
                            setTouchActiveStack(null)
                            openDeckCardDetail(dc)
                          } else {
                            setTouchActiveStack({ group: stackContext?.group, stackIdx: stackContext?.idx ?? 0, id: dc.id })
                          }
                          return
                        }
                        openDeckCardDetail(dc)
                      }}
                      onContextMenu={CAN_HOVER ? e => {
                        openDeckCardContextMenu(dc, e)
                        setStackHoverState(null)
                      } : undefined}
                      onMouseEnter={CAN_HOVER && !lastInputWasTouch ? e => {
                        setStackHoverState({ group: stackContext?.group, stackIdx: stackContext?.idx ?? 0 })
                        showHoverPreviewForDeckCard(dc, e)
                      } : undefined}
                      onMouseLeave={CAN_HOVER ? () => {
                        setStackHoverState(null)
                        clearHoverPreview()
                      } : undefined}
                      onMouseMove={CAN_HOVER ? e => setHoverPos({ x: e.clientX, y: e.clientY }) : undefined}
                    >
                      <div className={styles.stackImgWrap}>
                        {dc.image_uri
                          ? <img src={dc.image_uri} alt={dc.name} className={styles.stackCardImg} loading="lazy" />
                          : <div className={styles.stackCardPlaceholder}>{dc.name}</div>}
                        {legalityWarnings.length > 0 && <span className={styles.stackWarn} title={warningTitle}>!</span>}
                        {dc.qty > 1 && <span className={styles.stackQty}>×{dc.qty}</span>}
                        {dc.foil && <span className={styles.stackFoil} title="Foil">*</span>}
                      </div>
                      <div className={styles.stackCardControls} onClick={ev => ev.stopPropagation()}>
                        <div className={styles.stackCardInfo}>
                          <span className={styles.stackCardPrice}>{getDeckCardPriceLabel(dc)}</span>
                          <OwnershipBadge
                            {...getCardOwnershipProps(dc)}
                          />
                        </div>
                        <div className={styles.stackControlsRow}>
                          <EditMenu dc={dc} isEDH={isEDH} onSetCommander={setCardAsCommander} onToggleFoil={toggleFoil} onPickVersion={(card, options = {}) => setVersionPickCard({ ...card, ...options })} onMoveBoard={moveCardToBoard} />
                          <button className={styles.stackControlBtn} onClick={(ev) => { ev.stopPropagation(); changeQty(dc.id, -1) }}>-</button>
                          <span className={styles.stackControlCount}>{dc.qty}</span>
                          <button className={styles.stackControlBtn} onClick={(ev) => { ev.stopPropagation(); changeQty(dc.id, +1) }}>+</button>
                          <button className={styles.stackControlBtn} onClick={(ev) => { ev.stopPropagation(); removeCardFromDeck(dc.id) }}>x</button>
                        </div>
                      </div>
                    </div>
                  )
                }
                if (deckView === 'compact') return (
                  <div key={dc.id} className={`${styles.compactRow}${dc.is_commander ? ' '+styles.isCommander : ''}${legalityWarnings.length ? ' '+styles.deckCardIllegal : ''}`} title={warningTitle || undefined} onContextMenu={CAN_HOVER ? e => openDeckCardContextMenu(dc, e) : undefined}>
                    <span className={styles.compactQty}>{dc.qty}</span>
                    <span className={styles.compactName}
                      style={{ cursor: 'pointer' }}
                      onClick={() => openDeckCardDetail(dc)}
                      onMouseEnter={CAN_HOVER ? e => showHoverPreviewForDeckCard(dc, e) : undefined}
                      onMouseLeave={CAN_HOVER ? () => clearHoverPreview() : undefined}
                      onMouseMove={CAN_HOVER ? e => setHoverPos({ x: e.clientX, y: e.clientY }) : undefined}>
                      {dc.name}
                    </span>
                    {dc.foil && <span className={styles.foilBadge} title="Foil">*</span>}
                    {compactVisibleColumns.set && <span className={styles.compactMeta}>{dc.set_code ? `${String(dc.set_code).toUpperCase()}${dc.collector_number ? ` #${dc.collector_number}` : ''}` : '-'}</span>}
                    {compactVisibleColumns.manaValue && <span className={styles.compactMeta}><ManaCostInline cost={dc.mana_cost} size={13} /></span>}
                    {compactVisibleColumns.cmc && <span className={styles.compactMeta}>{dc.cmc ?? '-'}</span>}
                    {compactVisibleColumns.price && <span className={styles.compactMeta}>{getDeckCardPriceLabel(dc)}</span>}
                    {compactVisibleColumns.status && (
                      <OwnershipBadge
                        {...getCardOwnershipProps(dc)}
                      />
                    )}
                    {compactVisibleColumns.actions && <EditMenu dc={dc} isEDH={isEDH} onSetCommander={setCardAsCommander} onToggleFoil={toggleFoil} onPickVersion={(card, options = {}) => setVersionPickCard({ ...card, ...options })} onMoveBoard={moveCardToBoard} />}
                    {compactVisibleColumns.qty && (
                      <div className={styles.qtyControls}>
                        <button className={styles.qtyBtn} onClick={() => changeQty(dc.id, -1)}>-</button>
                        <span className={styles.qtyVal}>{dc.qty}</span>
                        <button className={styles.qtyBtn} onClick={() => changeQty(dc.id, +1)}>+</button>
                      </div>
                    )}
                    {compactVisibleColumns.remove && <button className={styles.removeBtn} onClick={() => removeCardFromDeck(dc.id)}>x</button>}
                  </div>
                )
                // list view
                return <DeckCardRowV2 key={dc.id} {...deckRowProps(dc)} />
              }

              const renderListHeader = () => deckView === 'list' && (
                <div className={styles.deckListHeader} style={{ '--deck-list-columns': listGridTemplate }}>
                  <span className={styles.deckListHeaderCard}>Card</span>
                  {visibleColumns.set && <span className={styles.deckListHeaderSet}>Set</span>}
                  {visibleColumns.manaValue && <span className={styles.deckListHeaderMetric}>Mana Value</span>}
                  {visibleColumns.cmc && <span className={styles.deckListHeaderMetric}>CMC</span>}
                  {visibleColumns.price && <span className={styles.deckListHeaderMetric}>Price</span>}
                  {visibleColumns.status && <span className={styles.deckListHeaderStatus}>Status</span>}
                  {visibleColumns.actions && <span className={styles.deckListHeaderActions}>Actions</span>}
                  {visibleColumns.qty && <span className={styles.deckListHeaderQty}>Qty</span>}
                  {visibleColumns.remove && <span className={styles.deckListHeaderRemove}>Remove</span>}
                </div>
              )

              const getDeckCardGroup = (dc) => {
                const sf = dc.set_code && dc.collector_number ? (builderSfMap[`${dc.set_code}-${dc.collector_number}`] || {}) : {}
                if (groupBy === 'category') {
                  const oracle = ((sf.oracle_text || '') + (sf.card_faces || []).map(f => f.oracle_text || '').join('\n'))
                  return getCardCategory(oracle.toLowerCase(), (sf.type_line || dc.type_line || '').toLowerCase(), sf.keywords || [])
                }
                if (groupBy === 'rarity') return sf.rarity || 'common'
                if (groupBy === 'set') return sf.set_name || (dc.set_code ? dc.set_code.toUpperCase() : 'Unknown')
                return dc.is_commander ? 'Commander' : classifyCardType(dc.type_line)
              }

              const renderStacks = (cards, board) => {
                const groupOrder = groupBy === 'category'
                  ? [...new Set(cards.map(getDeckCardGroup))]
                      .sort((a, b) => {
                        const ai = CAT_ORDER.indexOf(a); const bi = CAT_ORDER.indexOf(b)
                        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
                      })
                  : groupBy === 'rarity'
                  ? RARITY_ORDER.filter(r => cards.some(dc => getDeckCardGroup(dc) === r))
                  : groupBy === 'set'
                  ? [...new Set(cards.map(getDeckCardGroup))].sort()
                  : TYPE_GROUPS

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
                        <div key={collapsedKey} className={styles.stackColumn}>
                          <div className={styles.stackGroup}>
                            <button
                              className={styles.stackGroupHeader}
                              onClick={() => setCollapsedGroups(prev => {
                                const next = new Set(prev)
                                next.has(collapsedKey) ? next.delete(collapsedKey) : next.add(collapsedKey)
                                return next
                              })}
                            >
                              <span className={`${styles.groupArrow}${collapsed ? ' ' + styles.groupArrowCollapsed : ''}`} aria-hidden="true">
                                <ChevronDownIcon size={12} />
                              </span>
                              <span className={styles.stackGroupTitle}>{group}</span>
                              <span className={styles.stackGroupCount}>{groupQty}</span>
                            </button>
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
                  const baseOrder = groupBy === 'category' ? CAT_ORDER
                    : groupBy === 'rarity' ? RARITY_ORDER
                    : groupBy === 'set' ? [...new Set(cards.map(getDeckCardGroup))].sort()
                    : TYPE_GROUPS
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
                      const sf = builderSfMap[`${dc.set_code}-${dc.collector_number}`]
                      const p = sf ? getPrice(sf, dc.foil, { price_source }) : null
                      return sum + (p != null ? p * (dc.qty || 1) : 0)
                    }, 0)
                    const collapsedKey = `${board}:${group}`
                    const collapsed = collapsedGroups.has(collapsedKey)
                    const groupColor = groupBy === 'category' ? CAT_COLORS[group] : groupBy === 'rarity' ? RARITY_COLORS[group] : undefined
                    return (
                      <div key={collapsedKey} className={styles.deckGroup}>
                        <div
                          className={styles.groupHeader}
                          onClick={() => setCollapsedGroups(prev => {
                            const next = new Set(prev)
                            next.has(collapsedKey) ? next.delete(collapsedKey) : next.add(collapsedKey)
                            return next
                          })}
                          style={{ cursor: 'pointer' }}
                        >
                          <span className={`${styles.groupArrow}${collapsed ? ' ' + styles.groupArrowCollapsed : ''}`} aria-hidden="true">
                            <ChevronDownIcon size={12} />
                          </span>
                          <span className={styles.groupName} style={groupColor ? { color: groupColor } : undefined}>{group}</span>
                          {groupPrice > 0 && <span className={styles.groupPrice}>{formatPrice(groupPrice, price_source)}</span>}
                          <span className={styles.groupCount}>{groupQty}</span>
                        </div>
                        {!collapsed && (deckView === 'grid'
                          ? <div className={styles.visualGrid} style={{ '--deckbuilder-grid-min': `${visualCardMinWidth}px` }}>{groupCards.map(dc => renderCard(dc))}</div>
                          : (
                            <>
                              {renderListHeader()}
                              {groupCards.map(dc => renderCard(dc))}
                            </>
                          )
                        )}
                      </div>
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

        {/* Stats tab */}
        {rightTab === 'stats' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 18 }}>

            {/* â”€â”€ Winrate section â”€â”€ */}
            <DeckWinrateMini results={deckGameResults} loading={deckGameResultsLoading} deckName={deckName} />

            {/* â”€â”€ Deck composition stats â”€â”€ */}
            {deckCards.length > 0
              ? <DeckStats
                  cards={normalizeDeckBuilderCards(mainDeckCards, builderSfMap, { price_source })}
                  price_source={price_source}
                  bracketOverride={statsBracketOverride}
                  onBracketOverride={setStatsBracketOverride}
                />
              : <div style={{ color: 'var(--text-faint)', fontSize: '0.85rem', padding: '20px 0', textAlign: 'center' }}>
                  Add cards to see deck stats.
                </div>
            }

          </div>
        )}

        {/* Combos tab */}
        {rightTab === 'combos' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {deckCards.length === 0 && (
              <div style={{ color: 'var(--text-faint)', fontSize: '0.85rem', textAlign: 'center', paddingTop: 40 }}>
                Add cards to this deck first, then find combos.
              </div>
            )}
            {deckCards.length > 0 && !combosFetched && !combosLoading && (
              <div style={{ textAlign: 'center', paddingTop: 40 }}>
                <button onClick={fetchCombos} style={{ background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.35)', borderRadius: 4, color: 'var(--gold)', padding: '9px 22px', fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'var(--font-display)', letterSpacing: '0.05em' }}>
                  Find Combos
                </button>
                <div style={{ fontSize: '0.73rem', color: 'var(--text-faint)', marginTop: 8 }}>via Commander Spellbook</div>
              </div>
            )}
            {combosLoading && (
              <div style={{ color: 'var(--text-faint)', textAlign: 'center', paddingTop: 40, fontSize: '0.85rem' }}>
                Checking Commander Spellbook...
              </div>
            )}
            {combosFetched && !combosLoading && (
              <>
                {combosIncluded.length > 0 ? (
                  <div>
                    <button className={styles.comboSectionHeader} onClick={() => toggleComboSection('complete')}>
                      <span className={`${styles.groupArrow}${!comboSectionsOpen.complete ? ' ' + styles.groupArrowCollapsed : ''}`} aria-hidden="true">
                        <ChevronDownIcon size={12} />
                      </span>
                      <span>Complete Combos</span>
                      <span className={styles.comboSectionCount}>{combosIncluded.length}</span>
                    </button>
                    {comboSectionsOpen.complete && <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {combosIncluded.map((c, i) => (
                        <ComboResultCard key={i} combo={c} highlight deckCardNames={deckCards.map(dc => dc.name)} deckImages={deckImagesMap} onAddCard={name => addCardToDeck({ name })} onOpenDetail={openCardDetailByName} />
                      ))}
                    </div>}
                  </div>
                ) : (
                  <div style={{ color: 'var(--text-faint)', fontSize: '0.82rem' }}>No complete combos found in this deck.</div>
                )}
                {combosAlmost.length > 0 && (
                  <div>
                    <button className={styles.comboSectionHeader} onClick={() => toggleComboSection('incomplete')}>
                      <span className={`${styles.groupArrow}${!comboSectionsOpen.incomplete ? ' ' + styles.groupArrowCollapsed : ''}`} aria-hidden="true">
                        <ChevronDownIcon size={12} />
                      </span>
                      <span>Incomplete Combos</span>
                      <span className={styles.comboSectionCount}>{combosAlmost.length}</span>
                    </button>
                    {comboSectionsOpen.incomplete && <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {combosAlmost.slice(0, 20).map((c, i) => (
                        <ComboResultCard key={i} combo={c} highlight={false} deckCardNames={deckCards.map(dc => dc.name)} deckImages={deckImagesMap} onAddCard={name => addCardToDeck({ name })} onOpenDetail={openCardDetailByName} />
                      ))}
                    </div>}
                    {comboSectionsOpen.incomplete && combosAlmost.length > 20 && (
                      <div style={{ color: 'var(--text-faint)', fontSize: '0.78rem' }}>+ {combosAlmost.length - 20} more incomplete combos</div>
                    )}
                  </div>
                )}
                <button onClick={fetchCombos} style={{ alignSelf: 'flex-start', background: 'var(--s2)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 12px', color: 'var(--text-faint)', fontSize: '0.78rem', cursor: 'pointer' }}>
                  Refresh
                </button>
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div className={styles.deckFooter}>
          {makeDeckDone || syncDone ? (
            <>
              <div className={styles.convertDone}>OK {makeDeckDone ? makeDeckMsg : syncMsg}</div>
              {makeDeckDone && (
                <Link to="/decks" style={{ fontSize:'0.82rem', color:'var(--gold)', textDecoration:'none' }}>
                  View in Decks {'->'}
                </Link>
              )}
            </>
          ) : (
            <>
              {!isCollectionDeck && deckMeta.linked_deck_id && (
                <div style={{ fontSize:'0.74rem', color:'var(--text-faint)', textAlign:'center', marginTop:2 }}>&lt;&gt; linked to collection deck</div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Make Deck modal */}
      {showMakeDeck && (
        <MakeDeckModal
          deckCards={deckCards}
          userId={user.id}
          inOtherDeckSet={inOtherDeckSet}
          onConfirm={handleMakeDeck}
          onClose={() => setShowMakeDeck(false)}
        />
      )}

      {showMetaModal && (
        <Modal onClose={() => setShowMetaModal(false)} className={styles.metaModal}>
          <div className={styles.metaModalBody}>
            <h3 className={styles.metaModalTitle}>Description &amp; Tags</h3>
            <label className={styles.metaModalLabel}>Description</label>
            <textarea
              className={styles.deckMetaDesc}
              value={cmdDescription}
              onChange={e => setCmdDescription(e.target.value)}
              onBlur={e => saveDescription(e.target.value)}
              placeholder="Add description..."
              rows={5}
              maxLength={1000}
              autoFocus
            />
            <label className={styles.metaModalLabel}>Tags</label>
            <div className={styles.deckMetaTagRow}>
              {cmdTags.map(tag => (
                <span key={tag} className={styles.deckMetaTag}>
                  {tag}
                  <button className={styles.deckMetaTagRemove} onClick={() => removeTag(tag)}>x</button>
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
            <div className={styles.metaModalFooter}>
              <button className={styles.headerBtnPrimary} onClick={() => setShowMetaModal(false)}>Done</button>
            </div>
          </div>
        </Modal>
      )}

      {showExport && (
        <ExportModal
          cards={deckCards}
          sfMap={{}}
          title={deckName || 'Deck'}
          folderType="deck"
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
          onSelect={p => updateCardVersion(versionPickCard, p)}
          onClose={() => setVersionPickCard(null)}
        />
      )}

      {/* Floating card preview */}
      <FloatingPreview imageUris={hoverImages} x={hoverPos.x} y={hoverPos.y} />

      {contextMenu && createPortal(
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
            onSetCommander={setCardAsCommander}
            onToggleFoil={toggleFoil}
            onPickVersion={(card, options = {}) => setVersionPickCard({ ...card, ...options })}
            onMoveBoard={moveCardToBoard}
            close={closeContextMenu}
          />
        </div>,
        document.body
      )}

      {/* â”€â”€ Import modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {showImport && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowImport(false) }}>
          <div style={{ background: 'var(--bg-card, #1e1e1e)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, width: 480, maxWidth: '95vw', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', fontSize: '1rem' }}>Import Deck</span>
              <button onClick={() => setShowImport(false)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: '1.1rem', cursor: 'pointer' }}>x</button>
            </div>

            {/* Tab switcher */}
            <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)' }}>
              {[['url', 'URL'], ['text', 'Paste List'], ['file', 'Upload File']].map(([id, label]) => (
                <button key={id} onClick={() => setImportTab(id)}
                  style={{ flex: 1, padding: '7px 0', background: 'none', border: 'none', borderBottom: importTab === id ? '2px solid var(--gold)' : '2px solid transparent', color: importTab === id ? 'var(--gold)' : 'var(--text-dim)', fontSize: '0.83rem', cursor: 'pointer', marginBottom: -1 }}>
                  {label}
                </button>
              ))}
            </div>

            {importTab === 'url' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-faint)', margin: 0 }}>
                  Paste a deck link from Archidekt, Moxfield, or MTGGoldfish.
                </p>
                <input
                  autoFocus
                  value={importUrl}
                  onChange={e => setImportUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleImport()}
                  placeholder="https://archidekt.com/decks/12345/..."
                  style={{ background: 'var(--s3)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', color: 'var(--text)', fontSize: '0.88rem', outline: 'none' }}
                />
                <p style={{ fontSize: '0.72rem', color: 'var(--text-faint)', margin: 0 }}>
                  Moxfield may require logging in. If it fails, use Paste List instead.
                </p>
              </div>
            )}
            {importTab === 'text' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-faint)', margin: 0 }}>
                  Paste a decklist in standard format. Supports <code style={{ color: 'var(--gold)' }}>Commander:</code>, <code style={{ color: 'var(--gold)' }}>Sideboard:</code>, and <code style={{ color: 'var(--gold)' }}>Maybeboard:</code> sections.
                </p>
                <textarea
                  autoFocus
                  value={importText}
                  onChange={e => setImportText(e.target.value)}
                  placeholder={"Commander:\n1 Sheoldred, the Apocalypse\n\nDeck:\n1 Sol Ring\n1 Swamp\n\nSideboard:\n1 Duress\n\nMaybeboard:\n1 Bitterblossom"}
                  rows={10}
                  style={{ background: 'var(--s3)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', color: 'var(--text)', fontSize: '0.83rem', outline: 'none', resize: 'vertical', fontFamily: 'monospace' }}
                />
              </div>
            )}
            {importTab === 'file' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-faint)', margin: 0 }}>
                  Upload a <code style={{ color: 'var(--gold)' }}>.txt</code> decklist or <code style={{ color: 'var(--gold)' }}>.csv</code> Manabox export.
                </p>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".csv,.txt"
                  style={{ display: 'none' }}
                  onChange={async e => {
                    const file = e.target.files[0]
                    if (!file) return
                    const text = await file.text()
                    setImportText(text)
                    e.target.value = ''
                  }}
                />
                <button
                  onClick={() => importFileRef.current?.click()}
                  style={{ background: 'var(--s3)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)', padding: '10px 16px', fontSize: '0.83rem', cursor: 'pointer', textAlign: 'left' }}>
                  {importText ? `OK File loaded - ${importText.split('\n').filter(Boolean).length} lines` : 'Choose file...'}
                </button>
                {importText && (
                  <textarea
                    readOnly
                    value={importText}
                    rows={6}
                    style={{ background: 'var(--s2)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', color: 'var(--text-faint)', fontSize: '0.78rem', outline: 'none', resize: 'vertical', fontFamily: 'monospace' }}
                  />
                )}
              </div>
            )}

            {importError && <p style={{ color: '#e07070', fontSize: '0.82rem', margin: 0 }}>{importError}</p>}
            {importDone  && <p style={{ color: 'var(--green)', fontSize: '0.82rem', margin: 0 }}>OK {importDone}</p>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowImport(false)}
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)', padding: '7px 14px', fontSize: '0.83rem', cursor: 'pointer' }}>
                {importDone ? 'Close' : 'Cancel'}
              </button>
              {!importDone && (
                <button onClick={handleImport}
                  disabled={importing || (importTab === 'url' ? !importUrl.trim() : !importText.trim())}
                  style={{ background: 'rgba(201,168,76,0.15)', border: '1px solid rgba(201,168,76,0.4)', borderRadius: 4, color: 'var(--gold)', padding: '7px 18px', fontSize: '0.83rem', cursor: 'pointer', opacity: importing ? 0.6 : 1 }}>
                  {importing ? 'Importing...' : 'Import'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

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

