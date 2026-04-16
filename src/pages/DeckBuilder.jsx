import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import {
  FORMATS, TYPE_GROUPS, classifyCardType,
  parseDeckMeta, serializeDeckMeta, getCardImageUri, nameToSlug,
  searchCards, searchCommanders, fetchCardsByNames, fetchCardsByScryfallIds, getDeckBuilderCardMeta,
  fetchEdhrecCommander, makeDebouncer,
  importDeckFromUrl, parseTextDecklist,
} from '../lib/deckBuilderApi'
import {
  getLocalCards, getDeckCards, putDeckCards, deleteDeckCardLocal, getMeta, setMeta, getScryfallEntry,
} from '../lib/db'
import styles from './DeckBuilder.module.css'
import uiStyles from '../components/UI.module.css'
import { ResponsiveMenu, Select } from '../components/UI'
import { CardDetail } from '../components/CardComponents'
import DeckStats, { normalizeDeckBuilderCards } from '../components/DeckStats'
import ExportModal from '../components/ExportModal'
import { pruneUnplacedCards } from '../lib/collectionOwnership'
import { fetchDeckAllocations, fetchDeckAllocationsForUser, fetchDeckCards, upsertDeckAllocations } from '../lib/deckData'
import { planDeckAllocations } from '../lib/deckAllocationPlanner'
import { formatPrice, getPrice } from '../lib/scryfall'
import { getPublicAppUrl } from '../lib/publicUrl'
import { ListViewIcon, StacksViewIcon, GridViewIcon, SettingsIcon } from '../icons'

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

// ── Color identity helpers ────────────────────────────────────────────────────
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
              style={{ width: size, height: size }}
            />
          ))}
        </span>
      ))}
    </span>
  )
}

function OwnershipBadge({ ownedQty, ownedAlt, ownedInDeck, inCollDeck }) {
  if (inCollDeck) return <span className={`${styles.stateBadge} ${styles.stateBadgeAssigned}`} title="Assigned to this collection deck">In Deck</span>
  if (ownedQty > 0 && !ownedInDeck) return <span className={`${styles.stateBadge} ${styles.stateBadgeOwned}`} title="Owned and available">Owned</span>
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
    keys.push(`sf:${cardLike.scryfall_id}`)
  }
  const nameKey = (cardLike.name || '').trim().toLowerCase()
  if (nameKey) {
    keys.push(`name:${nameKey}|${foilKey}`)
    keys.push(`name:${nameKey}`)
  }
  return [...new Set(keys)]
}

function allocationSetHas(set, cardLike) {
  return deckAllocationKeys(cardLike).some(key => set.has(key))
}

// ── Floating card preview ─────────────────────────────────────────────────────
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

// ── Single card row in search results ─────────────────────────────────────────
function SearchResultRow({ card, ownedQty, onAdd, addFeedback, onOpenDetail }) {
  const img = getCardImageUri(card, 'small')
  return (
    <div className={styles.searchRow} onClick={() => onOpenDetail?.(card)} style={{ cursor: 'pointer' }}>
      {img
        ? <img className={styles.searchThumb} src={img} alt="" loading="lazy" />
        : <div className={styles.searchThumbPlaceholder} />
      }
      <div className={styles.searchInfo}>
        <div className={styles.searchName}>
          <span>{card.name}</span>
          {addFeedback?.count > 0 && (
            <span style={{ marginLeft:8, color:'var(--green)', fontSize:'0.74rem', fontWeight:600 }}>
              {`+${addFeedback.count}`}
            </span>
          )}
        </div>
        <div className={styles.searchType}>{card.type_line}</div>
        </div>
      <div className={styles.searchMeta}>
        {ownedQty > 0 && <span className={styles.ownedBadge}>✓ {ownedQty}x</span>}
      </div>
      <button className={styles.addBtn} onClick={e => { e.stopPropagation(); onAdd(card) }} title="Add to deck">+</button>
    </div>
  )
}

// ── Single card row in EDHRec recommendations ─────────────────────────────────
function RecRow({ rec, imageUri, ownedQty, onAdd, onHoverEnter, onHoverLeave, onHoverMove, onOpenDetail }) {
  const inclusionPct = rec.potentialDecks > 0
    ? Math.round((rec.inclusion / rec.potentialDecks) * 100)
    : (rec.inclusion ?? 0)
  const synergyPct = Math.round((rec.synergy ?? 0) * 100)
  // Scryfall CDN URLs have the size in the path — swap small → normal for hover preview
  const largeUri = imageUri ? imageUri.replace('/small/', '/normal/') : null
  return (
    <div
      className={styles.recRow}
      style={{ cursor: 'pointer' }}
      onClick={() => onOpenDetail?.(rec.name)}
      onMouseEnter={e => largeUri && onHoverEnter?.(largeUri, e)}
      onMouseMove={e => onHoverMove?.(e)}
      onMouseLeave={() => onHoverLeave?.()}
    >
      {imageUri
        ? <img className={styles.recThumb} src={imageUri} alt="" loading="lazy" />
        : <div className={styles.recThumbPlaceholder} />
      }
      <div className={styles.recInfo}>
        <div className={styles.recName}>{rec.name}</div>
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
              title={`${synergyPct > 0 ? '+' : ''}${synergyPct}% synergy — appears ${Math.abs(synergyPct)}% ${synergyPct > 0 ? 'more' : 'less'} often in this commander's decks than average`}
            >
              {synergyPct > 0 ? '+' : ''}{synergyPct}
            </span>
          )}
          {ownedQty > 0 && <span className={styles.ownedBadge}>✓</span>}
        </div>
      </div>
      <button className={styles.addBtn} onClick={e => { e.stopPropagation(); onAdd(rec) }} title="Add to deck">+</button>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function canBeCommander(dc) {
  if (!dc.type_line) return true // unknown type — allow the option
  const tl = dc.type_line.toLowerCase()
  return tl.includes('legendary creature') ||
    (tl.includes('legendary') && tl.includes('planeswalker'))
}

// ── Edit dropdown (⚙) shared by list + compact views ─────────────────────────
function EditMenu({ dc, isEDH, onSetCommander, onToggleFoil, onPickVersion }) {
  return (
    <ResponsiveMenu
      title="Card Actions"
      wrapClassName={styles.editMenuCell}
      trigger={({ toggle }) => (
        <button
          className={styles.editBtn}
          onClick={e => { e.stopPropagation(); toggle() }}
          title="Edit"
        ><SettingsIcon size={13} /></button>
      )}
    >
      {({ close }) => (
        <div className={uiStyles.responsiveMenuList}>
          {isEDH && dc.is_commander && (
            <button className={uiStyles.responsiveMenuAction} onClick={() => { onSetCommander(dc, false); close() }}>
              <span>Unset as Commander</span>
            </button>
          )}
          {isEDH && !dc.is_commander && canBeCommander(dc) && (
            <button className={uiStyles.responsiveMenuAction} onClick={() => { onSetCommander(dc, true); close() }}>
              <span>♛ Set as Commander</span>
            </button>
          )}
          <button className={uiStyles.responsiveMenuAction} onClick={() => { onToggleFoil(dc.id); close() }}>
            <span>{dc.foil ? '✦ Remove Foil' : '◇ Mark as Foil'}</span>
          </button>
          <button className={uiStyles.responsiveMenuAction} onClick={() => { onPickVersion(dc); close() }}>
            <span><SettingsIcon size={12} /> Change Version</span>
          </button>
          {dc.qty > 1 && (
            <button className={uiStyles.responsiveMenuAction} onClick={() => { onPickVersion(dc, { splitOne: true }); close() }}>
              <span>Split 1x To Other Version</span>
            </button>
          )}
        </div>
      )}
    </ResponsiveMenu>
  )
}

// ── Deck card row in right panel ──────────────────────────────────────────────
function DeckCardRow({ dc, ownedQty, ownedAlt, ownedInDeck, inCollDeck, onChangeQty, onRemove, onMouseEnter, onMouseLeave, onMouseMove, onPickVersion, onToggleFoil, onSetCommander, isEDH, visibleColumns, listGridTemplate }) {
  const setLabel = dc.set_code ? `${String(dc.set_code).toUpperCase()}${dc.collector_number ? ` #${dc.collector_number}` : ''}` : '—'
  return (
    <div className={`${styles.deckCardRow}${dc.is_commander ? ' ' + styles.isCommander : ''}`} style={{ '--deck-list-columns': listGridTemplate }}>
      <div className={styles.deckCardLeft}>
        {dc.image_uri
          ? <img className={styles.deckThumb} src={dc.image_uri} alt="" loading="lazy" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove} />
          : <div className={styles.deckThumbPlaceholder} />
        }
        <span className={styles.deckCardName} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove}>{dc.name}</span>
        {dc.foil && <span className={styles.foilBadge} title="Foil">✦</span>}
      </div>
      {visibleColumns.set && <div className={styles.deckCardSet}>{setLabel}</div>}
      {visibleColumns.status && (
        <div className={styles.deckCardStatus}>
          <OwnershipBadge ownedQty={ownedQty} ownedAlt={ownedAlt} ownedInDeck={ownedInDeck} inCollDeck={inCollDeck} />
        </div>
      )}
      {visibleColumns.actions && <EditMenu dc={dc} isEDH={isEDH} onSetCommander={onSetCommander} onToggleFoil={onToggleFoil} onPickVersion={onPickVersion} />}
      {visibleColumns.qty && (
        <div className={styles.qtyControls}>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, -1)}>−</button>
          <span className={styles.qtyVal}>{dc.qty}</span>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, +1)}>+</button>
        </div>
      )}
      {visibleColumns.remove && <button className={styles.removeBtn} onClick={() => onRemove(dc.id)}>✕</button>}
    </div>
  )
}

function DeckCardRowV2({
  dc, ownedQty, ownedAlt, ownedInDeck, inCollDeck,
  onChangeQty, onRemove, onMouseEnter, onMouseLeave, onMouseMove,
  onPickVersion, onToggleFoil, onSetCommander, isEDH,
  visibleColumns, listGridTemplate, priceLabel, onOpenDetail,
}) {
  const setLabel = dc.set_code ? `${String(dc.set_code).toUpperCase()}${dc.collector_number ? ` #${dc.collector_number}` : ''}` : '—'
  return (
    <div className={`${styles.deckCardRow}${dc.is_commander ? ' ' + styles.isCommander : ''}`} style={{ '--deck-list-columns': listGridTemplate }}>
      <div className={styles.deckCardLeft} style={{ cursor: 'pointer' }} onClick={() => onOpenDetail?.(dc)}>
        {dc.image_uri
          ? <img className={styles.deckThumb} src={dc.image_uri} alt="" loading="lazy" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove} />
          : <div className={styles.deckThumbPlaceholder} />
        }
        <span className={styles.deckCardName} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove}>{dc.name}</span>
        {dc.foil && <span className={styles.foilBadge} title="Foil">✦</span>}
      </div>
      {visibleColumns.set && <div className={styles.deckCardSet}>{setLabel}</div>}
      {visibleColumns.manaValue && <div className={styles.deckCardMetric}><ManaCostInline cost={dc.mana_cost} size={14} /></div>}
      {visibleColumns.cmc && <div className={styles.deckCardMetric}>{dc.cmc ?? '—'}</div>}
      {visibleColumns.price && <div className={styles.deckCardMetric}>{priceLabel}</div>}
      {visibleColumns.status && (
        <div className={styles.deckCardStatus}>
          <OwnershipBadge ownedQty={ownedQty} ownedAlt={ownedAlt} ownedInDeck={ownedInDeck} inCollDeck={inCollDeck} />
        </div>
      )}
      {visibleColumns.actions && <EditMenu dc={dc} isEDH={isEDH} onSetCommander={onSetCommander} onToggleFoil={onToggleFoil} onPickVersion={onPickVersion} />}
      {visibleColumns.qty && (
        <div className={styles.qtyControls}>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, -1)}>−</button>
          <span className={styles.qtyVal}>{dc.qty}</span>
          <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, +1)}>+</button>
        </div>
      )}
      {visibleColumns.remove && <button className={styles.removeBtn} onClick={() => onRemove(dc.id)}>✕</button>}
    </div>
  )
}

// ── Combo components ──────────────────────────────────────────────────────────
const _comboImgCache = {}

function useComboCardImage(name, existingUri) {
  const [img, setImg] = useState(existingUri || (_comboImgCache[name] ?? null))
  useEffect(() => {
    if (existingUri || !name || _comboImgCache[name] !== undefined) return
    _comboImgCache[name] = null
    fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const url = d?.image_uris?.large || d?.card_faces?.[0]?.image_uris?.large || d?.image_uris?.normal || d?.card_faces?.[0]?.image_uris?.normal || null
        _comboImgCache[name] = url
        if (url) setImg(url)
      })
      .catch(() => { _comboImgCache[name] = null })
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
        border: `1px solid ${inDeck ? 'rgba(201,168,76,0.5)' : 'rgba(255,255,255,0.12)'}`,
        background: 'rgba(255,255,255,0.04)',
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
            {adding ? '…' : '+ Add'}
          </button>
        )}
      </div>
      <div style={{ fontSize: '0.64rem', color: inDeck ? 'var(--text-faint)' : '#e08878', textAlign: 'center', maxWidth: 110, lineHeight: 1.2, wordBreak: 'break-word' }}>
        {inDeck ? name : `⊕ ${name}`}
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
      background: highlight ? 'rgba(201,168,76,0.07)' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${highlight ? 'rgba(201,168,76,0.28)' : 'rgba(255,255,255,0.07)'}`,
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

// ── Basic lands set ───────────────────────────────────────────────────────────
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

// ── Make Deck row ─────────────────────────────────────────────────────────────
function MakeDeckRow({ item }) {
  const { dc, neededQty, addExact, addOther, totalAdd, missingQty } = item
  const img = dc.image_uri
  let statusColor, statusIcon, statusDetail
  if (totalAdd === 0) {
    statusColor = '#e07070'; statusIcon = '✗'; statusDetail = 'not owned'
  } else if (missingQty === 0 && addOther === 0) {
    statusColor = 'var(--green, #4a9a5a)'; statusIcon = '✓'; statusDetail = `${totalAdd}× exact`
  } else {
    statusColor = '#c9a84c'; statusIcon = '↔'
    const parts = []
    if (addExact > 0) parts.push(`${addExact}× exact`)
    if (addOther > 0) parts.push(`${addOther}× other print`)
    if (missingQty > 0) parts.push(`${missingQty}× missing`)
    statusDetail = parts.join(', ')
  }
  const allocationDetail = (item.allocations || [])
    .map(row => {
      const print = row.set_code && row.collector_number ? `${String(row.set_code).toUpperCase()} #${row.collector_number}` : 'owned print'
      return `${row.qty}× ${print}${row.foil ? ' foil' : ''}`
    })
    .join(', ')
  return (
    <div style={{ display:'flex', alignItems:'center', padding:'5px 20px', borderBottom:'1px solid rgba(255,255,255,0.04)', gap:10, minHeight:36 }}>
      {img
        ? <img src={img} alt="" style={{ width:26, height:18, objectFit:'cover', borderRadius:2, flexShrink:0 }} />
        : <div style={{ width:26, height:18, background:'rgba(255,255,255,0.06)', borderRadius:2, flexShrink:0 }} />
      }
      <div style={{ flex:1, minWidth:0 }}>
        <span style={{ fontSize:'0.84rem', color:'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', display:'block' }}>
          {neededQty > 1 ? `${neededQty}× ` : ''}{dc.name}
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
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:'pointer' }}>✕</button>
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
                background: selectedCardId === option.card_id ? 'rgba(201,168,76,0.12)' : 'rgba(255,255,255,0.03)',
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
                : <div style={{ width:'100%', aspectRatio:'63 / 88', background:'rgba(255,255,255,0.05)', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-faint)', fontSize:'0.75rem', textAlign:'center', padding:8 }}>{option.name}</div>}
              <div style={{ fontSize:'0.8rem', fontWeight:600 }}>{option.set_name}</div>
              <div style={{ fontSize:'0.73rem', color:'var(--text-faint)' }}>
                {option.set_code ? `${String(option.set_code).toUpperCase()} #${option.collector_number || '?'}` : 'Owned printing'}
              </div>
              <div style={{ fontSize:'0.73rem', color:'var(--text-faint)' }}>
                {option.available_qty}× available{option.foil ? ' • foil' : ''}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Make Deck modal ────────────────────────────────────────────────────────────
function MakeDeckModal({ deckCards, userId, inOtherDeckSet, onConfirm, onClose }) {
  const [loading, setLoading] = useState(true)
  const [previewItems, setPreviewItems] = useState([])
  const [skipBasicLands, setSkipBasicLands] = useState(true)
  const [exactVersionOnly, setExactVersionOnly] = useState(true)
  const [pullFromOtherDecks, setPullFromOtherDecks] = useState(false)
  const [wishlists, setWishlists] = useState([])
  const [selectedWishlistId, setSelectedWishlistId] = useState('')
  const [newWishlistName, setNewWishlistName] = useState('')
  const [chosenOtherCardIds, setChosenOtherCardIds] = useState({})
  const [pickerItem, setPickerItem] = useState(null)

  useEffect(() => {
    async function load() {
      // Use IDB (same source as the green bar) so counts are consistent
      const collCards = await getLocalCards(userId)
      const items = planDeckAllocations(
        deckCards.filter(dc => !dc.is_commander),
        collCards || []
      )
      const { data: wls } = await sb.from('folders').select('id, name').eq('user_id', userId).eq('type', 'list').order('name')
      setPreviewItems(items)
      setWishlists(wls || [])
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
  const wishlistReady = missingCount === 0 || !selectedWishlistId ? true : selectedWishlistId === 'new' ? !!newWishlistName.trim() : true
  const canConfirm    = addItems.length > 0 && wishlistReady

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:700, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:560, maxWidth:'95vw', maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>Make Collection Deck</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:'pointer' }}>✕</button>
        </div>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'var(--text-faint)', fontSize:'0.85rem' }}>Checking your collection…</div>
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
            <div style={{ padding:'8px 20px', background:'rgba(255,255,255,0.03)', borderBottom:'1px solid var(--border)', display:'flex', gap:16, fontSize:'0.81rem', flexWrap:'wrap' }}>
              <span style={{ color:'var(--green, #4a9a5a)' }}>✓ {exactCount} exact</span>
              {fallbackCount > 0 && <span style={{ color:'#c9a84c' }}>↔ {fallbackCount} different printing</span>}
              {missingCount > 0 && <span style={{ color:'#e07070' }}>✗ {missingCount} missing</span>}
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
                <div style={{ fontSize:'0.82rem', color:'var(--text-dim)', marginBottom:8 }}>
                  Add {missingItems.reduce((s, i) => s + i.missingQty, 0)} missing card{missingCount !== 1 ? 's' : ''} to wishlist:
                </div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <Select value={selectedWishlistId} onChange={e => setSelectedWishlistId(e.target.value)}
                    menuDirection="up"
                    style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'6px 10px', color:'var(--text)', fontSize:'0.84rem', flex:1, minWidth:0 }}
                    title="Select wishlist">
                    <option value="">— Skip missing —</option>
                    {wishlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
                    <option value="new">+ Create new wishlist…</option>
                  </Select>
                  {selectedWishlistId === 'new' && (
                    <input autoFocus placeholder="Wishlist name…" value={newWishlistName} onChange={e => setNewWishlistName(e.target.value)}
                      style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'6px 10px', color:'var(--text)', fontSize:'0.84rem', flex:1 }} />
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
                  wishlistId: selectedWishlistId === 'new' ? null : (selectedWishlistId || null),
                  wishlistName: selectedWishlistId === 'new' ? newWishlistName.trim() : null,
                })}
                disabled={!canConfirm}
                style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green, #4a9a5a)', fontSize:'0.83rem', cursor:'pointer', opacity:canConfirm ? 1 : 0.45 }}>
                Create Deck ({addItems.reduce((s, i) => s + i.totalAdd, 0)} cards)
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

// ── Sync modal ────────────────────────────────────────────────────────────────
function SyncModal({ deckId, deckCards, deckMeta, userId, isCollectionDeck, onConfirm, onClose }) {
  const [loading, setLoading] = useState(true)
  const [baseDiff, setBaseDiff] = useState(null)
  const [folders, setFolders] = useState([])
  const [wishlists, setWishlists] = useState([])
  const [exactVersionOnly, setExactVersionOnly] = useState(true)
  const [globalDest, setGlobalDest] = useState('')
  const [wishlistId, setWishlistId] = useState('')
  const [newWishlistName, setNewWishlistName] = useState('')
  const [chosenOtherCardIds, setChosenOtherCardIds] = useState({})
  const [pickerItem, setPickerItem] = useState(null)

  useEffect(() => {
    async function load() {
      const targetDeckId = isCollectionDeck ? deckId : deckMeta.linked_deck_id
      if (!targetDeckId) { setLoading(false); return }
      const [collCards, { data: allocations }, { data: foldersData }, { data: wls }] = await Promise.all([
        getLocalCards(userId),
        sb.from('deck_allocations_view').select('*').eq('deck_id', targetDeckId),
        sb.from('folders').select('id, name, type').eq('user_id', userId).in('type', ['deck', 'binder']).neq('id', targetDeckId).order('name'),
        sb.from('folders').select('id, name').eq('user_id', userId).eq('type', 'list').order('name'),
      ])
      const collMap = new Map()
      for (const row of allocations || []) collMap.set(row.card_id, row)
      const builderCards = deckCards.filter(dc => dc.board !== 'side')
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
      const desiredByCardId = new Map()
      for (const item of planned) {
        for (const row of item.allocations) {
          desiredByCardId.set(row.card_id, (desiredByCardId.get(row.card_id) || 0) + row.qty)
        }
      }
      const added = [], changed = []
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

        if (addCandidate.totalAdd > 0 || item.missingQty > 0) {
          added.push({
            ...addCandidate,
          })
        }
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
      setFolders(foldersData || [])
      setWishlists(wls || [])
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
        Comparing deck with collection…
      </div>
    </div>
  )

  const diff = (() => {
    if (!baseDiff) return null
    const normalizedAdded = (baseDiff.added || []).map(item => {
      const chosen = buildChosenAllocations(item, exactVersionOnly, chosenOtherCardIds[item.dc.id])
      return {
        ...item,
        ...chosen,
      }
    })
    return { ...baseDiff, added: normalizedAdded }
  })()

  const { added = [], changed = [], removed = [] } = diff || {}
  const ownedAdded   = added.filter(i => i.totalAdd > 0)
  const unownedAdded = added.filter(i => i.missingQty > 0)
  const hasChanges   = ownedAdded.length || removed.length || changed.length || unownedAdded.length
  const movedOwnedRows = [
    ...changed
      .filter(i => i.newQty < i.oldQty)
      .map(i => ({
        key: `changed:${i.allocRow.id}`,
        name: i.dc.name,
        qty: i.oldQty - i.newQty,
      })),
    ...removed.map(r => ({
      key: `removed:${r.allocRow.id}`,
      name: r.name,
      qty: r.allocRow.qty || 0,
    })),
  ]

  if (!hasChanges) return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, padding:32, width:380, display:'flex', flexDirection:'column', gap:16 }}>
        <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)' }}>Sync to Collection</span>
        <p style={{ color:'var(--text-dim)', fontSize:'0.85rem', margin:0 }}>No changes — your collection deck is up to date.</p>
        <div style={{ display:'flex', justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:'pointer' }}>Close</button>
        </div>
      </div>
    </div>
  )

  const canConfirm = movedOwnedRows.length === 0 || !!globalDest

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:560, maxWidth:'95vw', maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>Sync to Collection</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:'pointer' }}>✕</button>
        </div>
        <div style={{ flex:1, overflowY:'auto', minHeight:0, padding:'16px 20px', display:'flex', flexDirection:'column', gap:16 }}>
          <div>
            <label style={{ display:'flex', alignItems:'flex-start', gap:8, cursor:'pointer' }}>
              <input type="checkbox" checked={exactVersionOnly} onChange={e => setExactVersionOnly(e.target.checked)} style={{ accentColor:'var(--gold)', marginTop:2, flexShrink:0 }} />
              <span>
                <div style={{ fontSize:'0.84rem', color:'var(--text-dim)' }}>Use specified version only</div>
                <div style={{ fontSize:'0.75rem', color:'var(--text-faint)' }}>Won't substitute a different printing during sync</div>
              </span>
            </label>
          </div>
          {ownedAdded.length > 0 && (
            <div>
              <div style={secLabel}>Adding to collection deck ({ownedAdded.length})</div>
              {ownedAdded.map(i => (
                <div key={i.dc.id} style={{ display:'flex', flexDirection:'column', gap:2, padding:'3px 0', fontSize:'0.84rem', color:'var(--text)' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', gap:8 }}>
                    <span>{i.totalAdd > 1 ? `${i.totalAdd}× ` : ''}{i.dc.name}</span>
                    <span style={{ color:'var(--green, #4a9a5a)', fontSize:'0.78rem' }}>✓ owned</span>
                  </div>
                  {!!i.allocations?.length && (
                    <div style={{ color:'var(--text-faint)', fontSize:'0.74rem' }}>
                      Uses: {i.allocations.map(row => {
                        const print = row.set_code && row.collector_number ? `${String(row.set_code).toUpperCase()} #${row.collector_number}` : 'owned print'
                        return `${row.qty}× ${print}${row.foil ? ' foil' : ''}`
                      }).join(', ')}
                    </div>
                  )}
                  {!exactVersionOnly && (i.otherCandidates?.length || 0) > 1 && (
                    <div>
                      <button
                        onClick={() => setPickerItem(i)}
                        style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'5px 10px', color:'var(--text-dim)', fontSize:'0.76rem', cursor:'pointer', marginTop:4 }}>
                        Choose owned printing
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {changed.length > 0 && (
            <div>
              <div style={secLabel}>Quantity changes ({changed.length})</div>
              {changed.map(i => (
                <div key={i.dc.id} style={{ display:'flex', justifyContent:'space-between', padding:'3px 0', fontSize:'0.84rem', color:'var(--text)' }}>
                  <span>{i.dc.name}</span>
                  <span style={{ color:'var(--text-dim)', fontSize:'0.78rem' }}>{i.oldQty} → {i.newQty}</span>
                </div>
              ))}
            </div>
          )}
          {removed.length > 0 && (
            <div>
              <div style={secLabel}>Removed from owned allocation ({removed.length})</div>
              {removed.map(r => (
                <div key={r.allocRow.id} style={{ display:'flex', justifyContent:'space-between', padding:'3px 0', fontSize:'0.84rem', color:'var(--text)' }}>
                  <span>{r.name}</span>
                  <span style={{ color:'var(--text-faint)', fontSize:'0.78rem' }}>move required</span>
                </div>
              ))}
            </div>
          )}
          {movedOwnedRows.length > 0 && (
            <div>
              <div style={secLabel}>Move removed owned copies to</div>
              <Select value={globalDest} onChange={e => setGlobalDest(e.target.value)} style={{ ...s, width:'100%' }} title="Select destination">
                <option value="">— Select binder or deck —</option>
                {folders.map(folder => (
                  <option key={folder.id} value={folder.id}>
                    {folder.type === 'binder' ? 'Binder' : 'Deck'}: {folder.name}
                  </option>
                ))}
              </Select>
              <div style={{ display:'flex', flexDirection:'column', gap:4, marginTop:10 }}>
                {movedOwnedRows.map(row => (
                  <div key={row.key} style={{ display:'flex', justifyContent:'space-between', fontSize:'0.8rem', color:'var(--text-dim)' }}>
                    <span>{row.name}</span>
                    <span>{row.qty}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {unownedAdded.length > 0 && (
            <div>
              <div style={secLabel}>Not owned — add to wishlist? ({unownedAdded.length})</div>
              <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:10 }}>
                {unownedAdded.map(item => (
                  <div key={item.dc.id} style={{ display:'flex', justifyContent:'space-between', fontSize:'0.84rem', color:'var(--text)' }}>
                    <span>{item.dc.name}</span>
                    <span style={{ color:'var(--text-faint)', fontSize:'0.78rem' }}>
                      {item.missingQty || item.dc.qty || 1}×
                    </span>
                  </div>
                ))}
              </div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <Select value={wishlistId} onChange={e => setWishlistId(e.target.value)} style={{ ...s, flex:1 }} title="Select wishlist">
                  <option value="">— Skip —</option>
                  {wishlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
                  <option value="new">+ Create new wishlist…</option>
                </Select>
                {wishlistId === 'new' && (
                  <input autoFocus value={newWishlistName} onChange={e => setNewWishlistName(e.target.value)}
                    placeholder="Wishlist name…"
                    style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'5px 8px', color:'var(--text)', fontSize:'0.83rem', flex:1 }} />
                )}
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
            {movedOwnedRows.length > 0 ? 'Owned cards must be reassigned to another binder or deck before sync can finish.' : ''}
          </span>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={onClose} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:'pointer' }}>Cancel</button>
            <button
              disabled={!canConfirm}
              onClick={() => canConfirm && onConfirm({
                diff,
                addItems: ownedAdded,
                missingItems: unownedAdded,
                printingSelections: buildChosenPrintingSelections(added, chosenOtherCardIds),
                moveDestinationId: globalDest || null,
                wishlistId: wishlistId === 'new' ? null : (wishlistId || null),
                wishlistName: wishlistId === 'new' ? newWishlistName.trim() : null,
              })}
              style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green, #4a9a5a)', fontSize:'0.83rem', cursor:canConfirm ? 'pointer' : 'not-allowed', opacity:canConfirm ? 1 : 0.45 }}>
              Apply Sync
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
          <button onClick={onClose} disabled={busy} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:busy ? 'default' : 'pointer' }}>✕</button>
        </div>
        <div style={{ padding:'16px 20px', display:'flex', flexDirection:'column', gap:14 }}>
          <p style={{ margin:0, color:'var(--text-dim)', fontSize:'0.84rem', lineHeight:1.6 }}>{message}</p>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {items.map(item => (
              <div key={item.key} style={{ display:'flex', justifyContent:'space-between', fontSize:'0.84rem', color:'var(--text)' }}>
                <span>{item.name}</span>
                <span style={{ color:'var(--text-faint)' }}>{item.qty}×</span>
              </div>
            ))}
          </div>
          <Select value={targetId} onChange={e => setTargetId(e.target.value)} style={inputStyle} title="Select destination">
            <option value="">— Select binder or deck —</option>
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
            {busy ? 'Moving…' : 'Move & Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Version picker modal ──────────────────────────────────────────────────────
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
            Choose version — {dc.name}
          </span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.1rem', cursor:'pointer' }}>✕</button>
        </div>
        {loading
          ? <div style={{ color:'var(--text-faint)', fontSize:'0.85rem', padding:'20px 0', textAlign:'center' }}>Loading printings…</div>
          : (
            <div style={{ overflowY:'auto', display:'flex', flexWrap:'wrap', gap:10 }}>
              {printings.map(p => {
                const img = getCardImageUri(p, 'normal')
                const isActive  = p.id === dc.scryfall_id
                const isOwned   = (ownedMap.get(p.id) ?? 0) > 0
                return (
                  <button key={p.id} onClick={() => onSelect(p)}
                    style={{
                      background: isActive ? 'rgba(201,168,76,0.12)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${isActive ? 'rgba(201,168,76,0.5)' : 'rgba(255,255,255,0.1)'}`,
                      borderRadius:6, padding:6, cursor:'pointer', display:'flex', flexDirection:'column',
                      alignItems:'center', gap:5, width:88, flexShrink:0, transition:'all 0.13s',
                    }}>
                    {img
                      ? <img src={img} alt={p.set_name} style={{ width:76, height:106, objectFit:'cover', borderRadius:4 }} loading="lazy" />
                      : <div style={{ width:76, height:106, background:'rgba(255,255,255,0.06)', borderRadius:4 }} />
                    }
                    <div style={{ fontSize:'0.62rem', color: isActive ? 'var(--gold)' : 'var(--text-dim)', textAlign:'center', lineHeight:1.3, wordBreak:'break-word' }}>
                      {p.set_name}
                    </div>
                    {isOwned && (
                      <div style={{ fontSize:'0.58rem', color:'var(--green)', fontWeight:600 }}>✓ owned</div>
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

// ── Main DeckBuilder component ────────────────────────────────────────────────
export default function DeckBuilderPage() {
  const { id: deckId } = useParams()
  const { user }       = useAuth()
  const { grid_density, price_source, default_grouping } = useSettings()
  const navigate       = useNavigate()

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
  const [deckView,    setDeckView]    = useState('list')   // 'list' | 'compact' | 'visual'
  const [showRight, setShowRight] = useState(false)
  const [deckSort,    setDeckSort]    = useState('type')   // 'name' | 'cmc' | 'color' | 'type'
  const [groupByType, setGroupByType] = useState(default_grouping !== 'none')
  const [visibleColumns, setVisibleColumns] = useState(DEFAULT_LIST_COLUMNS)
  const [compactVisibleColumns, setCompactVisibleColumns] = useState(DEFAULT_COMPACT_COLUMNS)
  const [builderSfMap, setBuilderSfMap] = useState({})
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())

  // Combos (Commander Spellbook)
  const [combosIncluded, setCombosIncluded] = useState([])
  const [combosAlmost,   setCombosAlmost]   = useState([])
  const [combosLoading,  setCombosLoading]  = useState(false)
  const [combosFetched,  setCombosFetched]  = useState(false)

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

  // Mobile leftTop collapse: auto-collapses when commander is first set on mobile
  const [leftTopOpen, setLeftTopOpen] = useState(true)
  const leftTopAutoCollapsedRef = useRef(false)

  // Refs
  const deckCardsRef    = useRef(deckCards)
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
    setGroupByType(default_grouping !== 'none')
  }, [default_grouping])

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

  // ── Load on mount ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!deckId) return
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
            const fetched = (row.scryfall_id && fetchedById.get(row.scryfall_id)) || fetchedByName.get((row.name || '').toLowerCase())
            if (!fetched) return row
            const meta = getDeckBuilderCardMeta(fetched)

            const next = {
              ...row,
              scryfall_id: row.scryfall_id || meta.scryfall_id,
              set_code: row.set_code || meta.set_code,
              collector_number: row.collector_number || meta.collector_number,
              type_line: row.type_line || meta.type_line,
              mana_cost: row.mana_cost || meta.mana_cost,
              cmc: row.cmc ?? meta.cmc,
              color_identity: (row.color_identity && row.color_identity.length > 0)
                ? row.color_identity
                : (meta.color_identity || []),
              image_uri: row.image_uri || meta.image_uri || null,
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
          const allocations = await fetchDeckAllocations(deckId)
          if ((allocations || []).length > 0) {
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
            if (hydrateErr) throw hydrateErr
            cardList = await enrichDeckCardsWithMetadata(hydratedRows)
          }
        } else {
          cardList = await enrichDeckCardsWithMetadata(cardList)
        }

        setDeckCards(cardList)
        putDeckCards(cardList).catch(() => {})

        // Build owned maps from IDB
        const owned = await getLocalCards(user.id)
        const map = new Map()
        const nameMap = new Map()
        for (const c of owned) {
          if (c.scryfall_id) map.set(c.scryfall_id, (map.get(c.scryfall_id) ?? 0) + (c.qty || 1))
          const n = (c.name || '').toLowerCase()
          if (n) nameMap.set(n, (nameMap.get(n) ?? 0) + (c.qty || 1))
        }
        setOwnedMap(map)
        setOwnedNameMap(nameMap)

        const thisAllocations = await fetchDeckAllocations(deckId)
        setCollDeckSfSet(new Set((thisAllocations || []).flatMap(row => deckAllocationKeys(row))))

        const allAllocations = await fetchDeckAllocationsForUser(user.id)
        setInOtherDeckSet(new Set(
          (allAllocations || [])
            .filter(row => row.deck_id !== deckId)
            .flatMap(row => deckAllocationKeys(row))
        ))
      } catch (err) {
        setLoadError('Failed to load deck')
        console.error(err)
      }
      setLoading(false)
    })()
  }, [deckId, user.id])

  // ── Computed ─────────────────────────────────────────────────────────────────
  const format         = useMemo(() => FORMATS.find(f => f.id === deckMeta.format), [deckMeta.format])
  const isEDH          = format?.isEDH ?? false
  const commanderCards = useMemo(() => deckCards.filter(dc => dc.is_commander), [deckCards])
  const commanderCard  = commanderCards[0] ?? null

  // Auto-collapse format/commander section on mobile once commander is set
  useEffect(() => {
    if (commanderCard && !leftTopAutoCollapsedRef.current && window.innerWidth <= 900) {
      leftTopAutoCollapsedRef.current = true
      setLeftTopOpen(false)
    }
  }, [commanderCard])
  const partnerCard    = commanderCards[1] ?? null
  const totalCards     = useMemo(() => deckCards.reduce((s, dc) => s + dc.qty, 0), [deckCards])
  const ownedCount     = useMemo(() => deckCards.filter(dc =>
    (ownedMap.get(dc.scryfall_id) ?? 0) > 0 ||
    (ownedNameMap.get((dc.name || '').toLowerCase()) ?? 0) > 0
  ).length, [deckCards, ownedMap, ownedNameMap])
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

  const getDeckCardPriceLabel = useCallback((dc) => {
    if (!dc?.set_code || !dc?.collector_number) return '—'
    const sf = builderSfMap[`${dc.set_code}-${dc.collector_number}`]
    if (!sf) return '—'
    const price = getPrice(sf, dc.foil, { price_source })
    return price != null ? formatPrice(price, price_source) : '—'
  }, [builderSfMap, price_source])
  const colorIdentity  = useMemo(() => {
    const cols = new Set()
    for (const c of commanderCards) for (const col of (c.color_identity || [])) cols.add(col)
    return [...cols]
  }, [commanderCards])
  const deckSize       = format?.deckSize ?? 60

  const isCollectionDeck = deck?.type === 'deck'

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

  // Open card detail modal by card name (recs / combos — no scryfall_id available)
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


  const sortedDeckCards = useMemo(() => {
    if (deckSort === 'type') return deckCards // type uses grouped rendering
    const cards = [...deckCards]
    if (deckSort === 'name') return cards.sort((a, b) => a.name.localeCompare(b.name))
    if (deckSort === 'cmc')  return cards.sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0) || a.name.localeCompare(b.name))
    if (deckSort === 'color') return cards.sort((a, b) => {
      const ca = (a.color_identity || []).join('')
      const cb = (b.color_identity || []).join('')
      return ca.localeCompare(cb) || a.name.localeCompare(b.name)
    })
    return deckCards
  }, [deckCards, deckSort])

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

  // ── Format change ─────────────────────────────────────────────────────────
  async function handleFormatChange(fmtId) {
    const newMeta = { ...deckMeta, format: fmtId }
    if (!FORMATS.find(f => f.id === fmtId)?.isEDH) {
      delete newMeta.commanderName
      delete newMeta.commanderScryfallId
    }
    setDeckMeta(newMeta)
    await saveMeta(newMeta)
  }

  // ── Save helpers ──────────────────────────────────────────────────────────
  async function saveMeta(meta) {
    clearTimeout(saveMetaTimer.current)
    saveMetaTimer.current = setTimeout(async () => {
      await sb.from('folders').update({ description: serializeDeckMeta(meta) }).eq('id', deckId)
    }, 600)
  }

  function saveDescription(val) {
    const newMeta = { ...deckMeta, deckDescription: val }
    setDeckMeta(newMeta)
    saveMeta(newMeta)
  }

  function addTag(raw) {
    const tag = raw.trim()
    if (!tag || cmdTags.includes(tag)) return
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

  // ── Commander search ──────────────────────────────────────────────────────
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

    // Remove any existing commander — use ref to avoid stale closure
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

    // Update state and persist — read ref again for current non-commander cards
    const nonCmdCards = deckCardsRef.current.filter(dc => !dc.is_commander)
    setDeckCards([cmdRow, ...nonCmdCards])
    // Upsert all rows: this handles collection decks where non-commander cards came from the
    // folder_cards fallback and were never saved to deck_cards in Supabase. Without this,
    // a reload after picking a commander would show only 1 card (just the commander).
    await sb.from('deck_cards').upsert([cmdRow, ...nonCmdCards], { onConflict: 'id' })
    putDeckCards([cmdRow, ...nonCmdCards]).catch(() => {})

    // Save meta immediately (not debounced) so navigation away won't lose the commander
    clearTimeout(saveMetaTimer.current)
    await sb.from('folders').update({ description: serializeDeckMeta(newMeta) }).eq('id', deckId)

  }

  // ── Card search ───────────────────────────────────────────────────────────
  const doSearch = useCallback(async (q, page = 1) => {
    setSearchLoading(true)
    setSearchError(false)
    setSearchPage(page)
    const { cards, hasMore, error } = await searchCards({
      query: q,
      format: deckMeta.format,
      colorIdentity: isEDH && colorIdentity.length ? colorIdentity : undefined,
      page,
    })
    if (page === 1) setSearchResults(cards)
    else setSearchResults(prev => [...prev, ...cards])
    setSearchHasMore(hasMore)
    if (error) setSearchError(true)
    setSearchLoading(false)
  }, [deckMeta.format, isEDH, colorIdentity])

  function handleSearchInput(q) {
    setSearchQuery(q)
    searchDebounce.current(() => doSearch(q, 1))
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
      // EDHRec rec — enrich from scryfall cache or fetch
      name       = sfCardOrRec.name
      scryfallId = null
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

    // Check if already in deck
    const existing = deckCards.find(dc =>
      ((scryfallId && dc.scryfall_id === scryfallId) || dc.name === name) && !!dc.foil === false
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

    const newRow = {
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
    }

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

    if (delta < 0) {
      getOwnedMoveRowsForDeckCard(current, nextQty)
        .then(rows => {
          if (!rows.length) {
            setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? { ...dc, qty: nextQty } : dc))
            if (qtyTimers.current.has(deckCardId)) clearTimeout(qtyTimers.current.get(deckCardId))
            const timer = setTimeout(async () => {
              const latest = deckCardsRef.current.find(dc => dc.id === deckCardId)
              if (!latest || latest.qty <= 0) return
              await sb.from('deck_cards').update({ qty: latest.qty, updated_at: new Date().toISOString() }).eq('id', deckCardId)
              qtyTimers.current.delete(deckCardId)
            }, 600)
            qtyTimers.current.set(deckCardId, timer)
            return
          }

          promptToMoveOwnedCopies({
            title: 'Move owned copy',
            message: 'This card is assigned to this deck in your collection. Choose where to move the owned copy before reducing it in the decklist.',
            items: rows,
            onComplete: async () => {
              setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? { ...dc, qty: nextQty } : dc))
              await sb.from('deck_cards').update({ qty: nextQty, updated_at: new Date().toISOString() }).eq('id', deckCardId)
            },
          }).catch(err => {
            console.error('[DeckBuilder move decrease]', err)
          })
        })
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

    const rows = await getOwnedMoveRowsForDeckCard(current, 0)
    if (rows.length) {
      await promptToMoveOwnedCopies({
        title: 'Move owned copy',
        message: 'This card is assigned to this deck in your collection. Choose where to move the owned copy before removing it from the decklist.',
        items: rows,
        onComplete: async () => {
          setDeckCards(prev => prev.filter(dc => dc.id !== deckCardId))
          await sb.from('deck_cards').delete().eq('id', deckCardId)
          deleteDeckCardLocal(deckCardId).catch(() => {})
        },
      })
      return
    }

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

  async function setCardAsCommander(dc, nextIsCommander = true) {
    if (!nextIsCommander) {
      await unsetCommander(dc.id)
      return
    }
    const alreadyHasCmd = deckCardsRef.current.some(c => c.is_commander)
    const updated = { ...dc, is_commander: true }
    setDeckCards(prev => prev.map(c => c.id === dc.id ? updated : c))
    putDeckCards([updated]).catch(() => {})
    await sb.from('deck_cards').update({ is_commander: true, updated_at: new Date().toISOString() }).eq('id', dc.id)
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
    // Save meta immediately (not debounced) — navigating away quickly would lose the commander name otherwise
    clearTimeout(saveMetaTimer.current)
    await sb.from('folders').update({ description: serializeDeckMeta(newMeta) }).eq('id', deckId)
    // Recs are loaded lazily when the Recommendations tab is opened
  }

  async function unsetCommander(deckCardId) {
    setDeckCards(prev => prev.map(dc => dc.id === deckCardId ? { ...dc, is_commander: false } : dc))
    await sb.from('deck_cards').update({ is_commander: false }).eq('id', deckCardId)
  }

  // ── EDHRec recommendations ────────────────────────────────────────────────
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

  // ── Commander Spellbook combos ────────────────────────────────────────────
  async function fetchCombos() {
    if (combosLoading) return
    setCombosLoading(true)
    try {
      const body = {
        commanders: commanderCard ? [{ card: commanderCard.name }] : [],
        main: deckCards.filter(dc => !dc.is_commander).map(dc => ({ card: dc.name })),
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
            'Authorization': `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
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

  // ── Convert to collection deck ────────────────────────────────────────────
  // ── Deck import ──────────────────────────────────────────────────────────
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
        parsed = result.cards
        importedName = result.name
      } else {
        parsed = parseTextDecklist(importText)
      }

      if (!parsed.length) throw new Error('No cards found in the import.')

      // Batch-fetch Scryfall data for all card names
      const names = [...new Set(parsed.map(c => c.name))]
      const sfCards = await fetchCardsByNames(names)
      const sfByName = new Map(sfCards.map(c => [c.name.toLowerCase(), c]))

      // Build deck_cards rows
      const now = new Date().toISOString()
      const newRows = []
      let commanderSet = false

      for (const entry of parsed) {
        const sf = sfByName.get(entry.name.toLowerCase())
        const meta = getDeckBuilderCardMeta(sf)
        const isCmd = entry.isCommander && !commanderSet
        if (isCmd) commanderSet = true

        newRows.push({
          id:               crypto.randomUUID(),
          deck_id:          deckId,
          user_id:          user.id,
          scryfall_id:      meta.scryfall_id,
          name:             entry.name,
          set_code:         entry.setCode ?? meta.set_code,
          collector_number: entry.collectorNumber ?? meta.collector_number,
          type_line:        meta.type_line,
          mana_cost:        meta.mana_cost,
          cmc:              meta.cmc,
          color_identity:   meta.color_identity ?? [],
          image_uri:        meta.image_uri,
          qty:              entry.qty,
          foil:             entry.foil ?? false,
          is_commander:     isCmd,
          board:            entry.board || 'main',
          created_at:       now,
          updated_at:       now,
        })
      }

      // Save to Supabase
      await sb.from('deck_cards').insert(newRows)
      putDeckCards(newRows).catch(() => {})

      // Update deck name if blank and we have one from import
      if (importedName && (!deckName || deckName === 'New Deck')) {
        setDeckName(importedName)
        await sb.from('folders').update({ name: importedName }).eq('id', deckId)
      }

      setDeckCards(prev => [...prev, ...newRows])
      setImportDone(`Imported ${newRows.length} card${newRows.length !== 1 ? 's' : ''}`)
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
    const updated = {
      scryfall_id:      meta.scryfall_id,
      set_code:         meta.set_code,
      collector_number: meta.collector_number,
      type_line:        meta.type_line,
      mana_cost:        meta.mana_cost,
      cmc:              meta.cmc,
      color_identity:   meta.color_identity,
      image_uri:        meta.image_uri,
    }
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
      await sb.from('deck_cards').insert(splitRow)
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

  function matchesAllocationRow(dc, row) {
    if (dc.scryfall_id && row.scryfall_id) return dc.scryfall_id === row.scryfall_id && !!dc.foil === !!row.foil
    return (dc.name || '').toLowerCase() === (row.name || '').toLowerCase() && !!dc.foil === !!row.foil
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
      .select('id, name, type')
      .eq('user_id', user.id)
      .in('type', ['binder', 'deck'])
      .neq('id', excludeDeckId)
      .order('type')
      .order('name')

    if (error) throw error
    return data || []
  }

  async function moveOwnedCopiesOutOfDeck(rows, destination) {
    if (!rows?.length || !destination?.id) return

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

    if (destination.type === 'deck') {
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

    for (const row of normalizedRows) {
      const nextQty = (row.allocRow.qty || 0) - row.qty
      if (nextQty > 0) {
        const { error } = await sb.from('deck_allocations').update({ qty: nextQty }).eq('id', row.allocRow.id)
        if (error) throw error
      } else {
        const { error } = await sb.from('deck_allocations').delete().eq('id', row.allocRow.id)
        if (error) throw error
      }
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
        await moveOwnedCopiesOutOfDeck(items, destination)
        await onComplete?.(destination)
        await refreshAllocationIndicators()
        setPendingOwnedMove(null)
      },
    })
  }

  async function reassignPlacementsToDeck(targetDeckId, rows) {
    if (!rows?.length) return

    const cardIds = [...new Set(rows.map(row => row.card_id).filter(Boolean))]
    if (!cardIds.length) return

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

        remaining -= usedQty
      }
    }
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

    const updates = []
    const now = new Date().toISOString()
    setDeckCards(prev => prev.map(dc => {
      const desired = desiredByDeckCardId.get(dc.id)
      if (!desired) return dc
      const fetched = desired.scryfall_id ? fetchedById.get(desired.scryfall_id) : null
      const meta = fetched ? getDeckBuilderCardMeta(fetched) : null
      const next = {
        ...dc,
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
      }
      updates.push({
        id: dc.id,
        scryfall_id: next.scryfall_id,
        set_code: next.set_code,
        collector_number: next.collector_number,
        type_line: next.type_line,
        mana_cost: next.mana_cost,
        cmc: next.cmc,
        color_identity: next.color_identity,
        image_uri: next.image_uri,
        foil: next.foil,
        updated_at: now,
      })
      return next
    }))

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

    setDeckCards(prev => prev.map(dc => {
      const selection = selections.find(row => row.deckCardId === dc.id)
      if (!selection) return dc
      const candidate = selection.candidate
      const fetched = candidate.scryfall_id ? fetchedById.get(candidate.scryfall_id) : null
      const meta = fetched ? getDeckBuilderCardMeta(fetched) : null
      return {
        ...dc,
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
      }
    }))

    for (const selection of selections) {
      const candidate = selection.candidate
      const fetched = candidate.scryfall_id ? fetchedById.get(candidate.scryfall_id) : null
      const meta = fetched ? getDeckBuilderCardMeta(fetched) : null
      await sb.from('deck_cards').update({
        scryfall_id: candidate.scryfall_id || null,
        set_code: candidate.set_code || meta?.set_code || null,
        collector_number: candidate.collector_number || meta?.collector_number || null,
        type_line: meta?.type_line || null,
        mana_cost: meta?.mana_cost || null,
        cmc: meta?.cmc ?? null,
        color_identity: meta?.color_identity || [],
        image_uri: meta?.image_uri || null,
        foil: !!candidate.foil,
        updated_at: now,
      }).eq('id', selection.deckCardId)
    }
  }

  async function handleMakeDeck({ addItems, missingItems, printingSelections, wishlistId, wishlistName }) {
    if (makeDeckRunning) return
    setMakeDeckRunning(true)
    setShowMakeDeck(false)
    try {
      // Transform this builder deck into a collection deck in-place (no new folder)
      const { error: typeErr } = await sb.from('folders').update({ type: 'deck' }).eq('id', deckId)
      if (typeErr) throw typeErr
      await applyExplicitPrintingSelections(printingSelections)

      if (addItems.length > 0) {
        const allocationRows = addItems
          .flatMap(item => (item.allocations || []).map(row => ({
            id: crypto.randomUUID(),
            card_id: row.card_id,
            qty: row.qty,
          })))

        await syncDeckRowsToAllocatedPrintings(addItems)
        await upsertDeckAllocations(deckId, user.id, allocationRows)
        await reassignPlacementsToDeck(deckId, allocationRows)
      }

      let targetWishlistId = wishlistId
      if (!targetWishlistId && wishlistName) {
        const { data: wl, error: wlErr } = await sb.from('folders').insert({ user_id: user.id, type: 'list', name: wishlistName, description: '{}' }).select().single()
        if (wlErr) throw wlErr
        targetWishlistId = wl?.id
      }
      if (targetWishlistId && missingItems.length > 0) {
        const listInserts = missingItems.map(i => ({ id: crypto.randomUUID(), folder_id: targetWishlistId, user_id: user.id, name: i.dc.name, scryfall_id: i.dc.scryfall_id || null, set_code: i.dc.set_code || null, collector_number: i.dc.collector_number || null, foil: i.dc.foil ?? false, qty: i.missingQty }))
        await sb.from('list_items').insert(listInserts)
      }

      setDeck(prev => ({ ...prev, type: 'deck' }))
      await refreshAllocationIndicators(deckId)

      const addCount = addItems.reduce((s, i) => s + i.totalAdd, 0)
      const misCount = missingItems.reduce((s, i) => s + i.missingQty, 0)
      let msg = `${addCount} card${addCount !== 1 ? 's' : ''} added to collection deck`
      if (targetWishlistId && misCount > 0) msg += `, ${misCount} added to wishlist`
      setMakeDeckMsg(msg)
      setMakeDeckDone(true)
    } catch (err) {
      console.error('[MakeDeck]', err)
      setMakeDeckMsg('Failed to make collection deck. Try again.')
      setMakeDeckDone(true)
    }
    setMakeDeckRunning(false)
  }

  async function handleSync({ diff, addItems, missingItems, printingSelections, moveDestinationId, wishlistId, wishlistName }) {
    if (syncRunning) return
    setSyncRunning(true)
    setShowSync(false)
    try {
      const targetDeckId = diff?.targetDeckId || getAllocationDeckId()
      if (!targetDeckId) throw new Error('No linked collection deck to sync.')
      await applyExplicitPrintingSelections(printingSelections)
      const { added, changed, removed } = diff
      const ownedAdded = addItems || []
      const unownedAdded = missingItems || []

      if (ownedAdded.length > 0) {
        const addedRows = ownedAdded.flatMap(i => (i.allocations || []).map(row => ({
          id: crypto.randomUUID(),
          card_id: row.card_id,
          qty: row.qty,
        })))
        await syncDeckRowsToAllocatedPrintings(ownedAdded)
        await upsertDeckAllocations(targetDeckId, user.id, addedRows)
        await reassignPlacementsToDeck(targetDeckId, addedRows)
      }
      const increased = changed.filter(c => c.newQty > c.oldQty)
      const decreased = changed.filter(c => c.newQty < c.oldQty)
      for (const c of increased) {
        await sb.from('deck_allocations').update({ qty: c.newQty }).eq('id', c.allocRow.id)
      }
      const increasedRows = increased
        .map(c => ({ card_id: c.cardId, qty: c.newQty - c.oldQty }))
      if (increasedRows.length > 0) {
        await reassignPlacementsToDeck(targetDeckId, increasedRows)
      }

      const moveRows = [
        ...decreased.map(c => ({
          key: `changed:${c.allocRow.id}`,
          card_id: c.cardId,
          qty: c.oldQty - c.newQty,
          name: c.dc.name,
          allocRow: c.allocRow,
        })),
        ...removed.map(r => ({
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
        await moveOwnedCopiesOutOfDeck(moveRows, destination)
      }

      let targetWishlistId = wishlistId
      if (!targetWishlistId && wishlistName) {
        const { data: wl } = await sb.from('folders').insert({ user_id: user.id, type: 'list', name: wishlistName, description: '{}' }).select().single()
        targetWishlistId = wl?.id
      }
      if (targetWishlistId && unownedAdded.length > 0) {
        const listInserts = unownedAdded.map(i => ({ id: crypto.randomUUID(), folder_id: targetWishlistId, user_id: user.id, name: i.dc.name, scryfall_id: i.dc.scryfall_id || null, set_code: i.dc.set_code || null, collector_number: i.dc.collector_number || null, foil: i.dc.foil ?? false, qty: i.missingQty || i.dc.qty }))
        await sb.from('list_items').insert(listInserts)
      }

      await refreshAllocationIndicators(targetDeckId)
      setSyncMsg('Sync complete')
      setSyncDone(true)
    } catch (err) {
      console.error('[Sync]', err)
      setSyncMsg('Sync failed. Try again.')
      setSyncDone(true)
    }
    setSyncRunning(false)
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) return <div style={{ padding: 40, color: 'var(--text-faint)' }}>Loading deck…</div>
  if (loadError) return (
    <div style={{ padding: 40 }}>
      <div style={{ color: '#e07070', marginBottom: 12 }}>{loadError}</div>
      <Link to="/builder" style={{ color: 'var(--gold)', fontSize: '0.9rem' }}>← Back to Builder</Link>
    </div>
  )

  return (
    <div className={`${styles.page}${showRight ? ' ' + styles.showRight : ''}`}>
      {/* Mobile two-tab toggle */}
      <div className={styles.mobilePanelToggle}>
        <button
          className={`${styles.mobilePanelBtn} ${!showRight ? styles.mobilePanelBtnActive : ''}`}
          onClick={() => setShowRight(false)}
        >🔍 Search</button>
        <button
          className={`${styles.mobilePanelBtn} ${showRight ? styles.mobilePanelBtnActive : ''}`}
          onClick={() => setShowRight(true)}
        >📋 Deck</button>
      </div>

      <div className={styles.deckHeader}>
        <input
          className={styles.deckNameInput}
          value={deckName}
          onChange={e => setDeckName(e.target.value)}
          onBlur={saveNameBlur}
        />
        <div className={styles.deckMeta}>
          {saving && <span className={styles.savingDot} />}
        </div>
        <div className={styles.headerActions}>
          {(isCollectionDeck || deckMeta.linked_deck_id) && (
            <button className={styles.headerBtnPrimary} onClick={() => setShowSync(true)} disabled={syncRunning} title="Sync collection">
              <span className={styles.btnIcon}>{syncRunning ? '…' : '↺'}</span>
              <span className={styles.btnLabel}>{syncRunning ? 'Syncing...' : 'Sync'}</span>
            </button>
          )}
          <button className={styles.headerBtn} onClick={() => { setShowImport(true); setImportDone(null); setImportError(null) }} title="Import decklist">
            <span className={styles.btnIcon}>↓</span>
            <span className={styles.btnLabel}>Import</span>
          </button>
          <button className={styles.headerBtn} onClick={() => setShowExport(true)} title="Export decklist">
            <span className={styles.btnIcon}>↑</span>
            <span className={styles.btnLabel}>Export</span>
          </button>
          <button
            className={styles.headerBtn}
            onClick={() => {
              navigator.clipboard.writeText(getPublicAppUrl(`/d/${deckId}`))
              setShareCopied(true)
              setTimeout(() => setShareCopied(false), 2000)
            }}
            title="Copy shareable link"
          >
            <span className={styles.btnIcon}>{shareCopied ? '✓' : '⎘'}</span>
            <span className={styles.btnLabel}>{shareCopied ? 'Copied' : 'Share'}</span>
          </button>
          {!isCollectionDeck && !deckMeta.linked_deck_id && (
            <button className={styles.headerBtnPrimary} onClick={() => setShowMakeDeck(true)} disabled={makeDeckRunning} title="Make Collection Deck">
              <span className={styles.btnIcon}>{makeDeckRunning ? '…' : '⊕'}</span>
              <span className={styles.btnLabel}>{makeDeckRunning ? 'Creating...' : 'Make Collection Deck'}</span>
            </button>
          )}
          <Link className={styles.headerLink} to="/builder" title="Back to Decks">
            <span className={styles.btnIcon}>←</span>
            <span className={styles.btnLabel}>Back to Decks</span>
          </Link>
        </div>
      </div>

      {/* ── LEFT PANEL ─────────────────────────────────────────── */}
      <div className={styles.left}>
        {/* Mobile panel toggle — rendered outside the left panel so it stays visible */}
        <div className={styles.leftTop}>
          {/* Mobile toggle for format/commander — hidden on desktop via CSS */}
          <div className={styles.leftTopToggle} onClick={() => setLeftTopOpen(v => !v)}>
            <div className={styles.leftTopToggleSummary}>
              <span>{format?.label ?? 'Format'}</span>
              {commanderCard && <span className={styles.leftTopToggleCmdr}>· {commanderCard.name}</span>}
            </div>
            <span className={styles.leftTopToggleChevron}>{leftTopOpen ? '▲' : '▼'}</span>
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
                      placeholder="Search for a commander…"
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
                placeholder="Search cards…"
              />
            </div>
            <div className={styles.searchResults}>
              {searchLoading && searchPage === 1 && <div className={styles.searchEmpty}>Searching…</div>}
              {!searchLoading && searchError && (
                <div className={styles.searchEmpty}>Scryfall is unavailable — try again in a moment.</div>
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
                  addFeedback={addFeedback?.key === (c.id || c.name) ? addFeedback : null}
                  onAdd={addCardToDeck}
                  onOpenDetail={openSearchCardDetail}
                />
              ))}
              {searchHasMore && (
                <button className={styles.loadMore} onClick={() => doSearch(searchQuery, searchPage + 1)}>
                  {searchLoading ? 'Loading…' : 'Load more'}
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
                {recsLoading && <div className={styles.recsLoading}>Loading recommendations…</div>}
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
                            <span className={`${styles.groupArrow}${collapsed ? ' ' + styles.groupArrowCollapsed : ''}`}>▾</span>
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
                              onHoverEnter={(uri, e) => { setHoverImages(uri ? [uri] : []); setHoverPos({ x: e.clientX, y: e.clientY }) }}
                              onHoverMove={e => setHoverPos({ x: e.clientX, y: e.clientY })}
                              onHoverLeave={() => clearHoverPreview()}
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
      <div className={styles.right}>
        {/* Commander art display — supports partners */}
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
                {format && <span>·</span>}
                <span style={{ color: totalCards > deckSize ? '#e07070' : 'var(--text-dim)' }}>
                  {totalCards}/{deckSize} cards
                </span>
              </div>
            </div>
            {/* Description + Tags */}
            <div className={styles.cmdArtDetails}>
              <textarea
                className={styles.cmdDescInput}
                value={cmdDescription}
                onChange={e => setCmdDescription(e.target.value)}
                onBlur={e => saveDescription(e.target.value)}
                placeholder="Add description…"
                rows={2}
              />
              <div className={styles.cmdTagRow}>
                {cmdTags.map(tag => (
                  <span key={tag} className={styles.cmdTag}>
                    {tag}
                    <button className={styles.cmdTagRemove} onClick={() => removeTag(tag)}>×</button>
                  </span>
                ))}
                <input
                  className={styles.cmdTagInput}
                  value={newTagInput}
                  onChange={e => setNewTagInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(newTagInput) } }}
                  onBlur={() => { if (newTagInput.trim()) addTag(newTagInput) }}
                  placeholder={cmdTags.length === 0 ? 'Add tags…' : '+'}
                />
              </div>
            </div>
            {/* Color pips */}
            {colorIdentity.length > 0 && (
              <div className={styles.cmdColorPips}>
                {colorIdentity.map(c => <ColorPip key={c} color={c} />)}
              </div>
            )}
          </div>
        )}

        {/* Right panel tab bar */}
        <div className={styles.tabBar}>
          {[
            { id: 'deck',   label: 'Deck',   badge: `${totalCards}/${deckSize}`, over: totalCards > deckSize },
            { id: 'stats',  label: 'Stats',  badge: null },
            { id: 'combos', label: 'Combos', badge: combosFetched ? String(combosIncluded.length) : null },
          ].filter(Boolean).map(({ id, label, badge, over }) => (
            <button
              key={id}
              className={`${styles.tab}${rightTab === id ? ' ' + styles.tabActive : ''}`}
              onClick={() => {
                setRightTab(id)
                if (id === 'combos' && !combosFetched && !combosLoading && deckCards.length > 0) fetchCombos()
              }}
            >
              {label}
              {badge != null && (
                <span style={{
                  marginLeft: 5, fontSize: '0.68rem', padding: '1px 6px',
                  borderRadius: 10, background: 'rgba(255,255,255,0.08)',
                  color: over ? '#e07070' : 'var(--text-faint)',
                }}>
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Deck list tab */}
        {rightTab === 'deck' && (
          <div className={styles.deckList}>
            {/* View / Sort / Group toolbar */}
            {deckCards.length > 0 && (
              <div className={styles.deckToolbar}>
                <div className={styles.toolbarGroup}>
                  {[
                    ['list',    ListViewIcon],
                    ['compact', StacksViewIcon],
                    ['visual',  GridViewIcon],
                  ].map(([v, ViewIcon]) => (
                    <button key={v} className={`${styles.viewBtn}${deckView === v ? ' '+styles.viewBtnActive : ''}`}
                      onClick={() => setDeckView(v)} title={v}>
                      <ViewIcon size={13} />
                    </button>
                  ))}
                </div>
                <div className={styles.toolbarGroup}>
                  {[['name','A–Z'],['cmc','CMC'],['color','Color'],['type','Type']].map(([s, label]) => (
                    <button key={s} className={`${styles.sortPill}${deckSort === s ? ' '+styles.sortPillActive : ''}`}
                      onClick={() => setDeckSort(s)}>
                      {label}
                    </button>
                  ))}
                </div>
                <button
                  className={`${styles.groupToggle}${groupByType ? ' '+styles.groupToggleActive : ''}`}
                  onClick={() => setGroupByType(v => !v)}
                  title="Toggle type grouping">
                  <ListViewIcon size={12} /> Grouped
                </button>
                {(deckView === 'list' || deckView === 'compact') && (
                  <ResponsiveMenu
                    title="Visible Columns"
                    wrapClassName={styles.columnMenuWrap}
                    trigger={({ toggle }) => (
                      <button
                        className={styles.groupToggle}
                        onClick={toggle}
                        title="Choose visible columns"
                      >
                        Columns
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
                                {activeColumns[key] ? '✓' : ''}
                              </span>
                            </label>
                          ))}
                        </div>
                    )}
                  </ResponsiveMenu>
                )}
              </div>
            )}

            {deckCards.length === 0 && (
              <div style={{ color: 'var(--text-faint)', fontSize: '0.85rem', padding: '24px 0', textAlign: 'center' }}>
                Add cards using the search on the left.
              </div>
            )}

            {/* Render cards — supports all view × sort × group combinations */}
            {deckCards.length > 0 && (() => {
              const deckRowProps = (dc) => ({
                dc,
                ownedQty:    ownedMap.get(dc.scryfall_id) ?? 0,
                ownedAlt:    ownedNameMap.get((dc.name || '').toLowerCase()) ?? 0,
                ownedInDeck: allocationSetHas(inOtherDeckSet, dc),
                inCollDeck:  allocationSetHas(collDeckSfSet, dc),
                onChangeQty: changeQty,
                onRemove:    removeCardFromDeck,
                onMouseEnter: e => showHoverPreviewForDeckCard(dc, e),
                onMouseLeave: () => clearHoverPreview(),
                onMouseMove:  e => setHoverPos({ x: e.clientX, y: e.clientY }),
                onPickVersion: (dc, options = {}) => setVersionPickCard({ ...dc, ...options }),
                onToggleFoil:  toggleFoil,
                onSetCommander: setCardAsCommander,
                isEDH,
                visibleColumns,
                listGridTemplate,
                priceLabel: getDeckCardPriceLabel(dc),
                onOpenDetail: openDeckCardDetail,
              })

              const renderCard = (dc) => {
                if (deckView === 'visual') return (
                  <div key={dc.id} className={`${styles.visualCard}${dc.is_commander ? ' '+styles.isCommander : ''}`}
                    onClick={() => openDeckCardDetail(dc)}
                    onMouseEnter={e => showHoverPreviewForDeckCard(dc, e)}
                    onMouseLeave={() => clearHoverPreview()}
                    onMouseMove={e => setHoverPos({ x: e.clientX, y: e.clientY })}>
                    {dc.image_uri
                      ? <img src={dc.image_uri} alt={dc.name} className={styles.visualCardImg} loading="lazy" />
                      : <div className={styles.visualCardPlaceholder}>{dc.name}</div>}
                    {dc.qty > 1 && <span className={styles.visualCardQty}>×{dc.qty}</span>}
                    {dc.foil && <span className={styles.visualCardFoil} title="Foil">✦</span>}
                    <div className={styles.visualCardTop}>
                      <OwnershipBadge
                        ownedQty={ownedMap.get(dc.scryfall_id) ?? 0}
                        ownedAlt={ownedNameMap.get((dc.name || '').toLowerCase()) ?? 0}
                        ownedInDeck={allocationSetHas(inOtherDeckSet, dc)}
                        inCollDeck={allocationSetHas(collDeckSfSet, dc)}
                      />
                      <EditMenu dc={dc} isEDH={isEDH} onSetCommander={setCardAsCommander} onToggleFoil={toggleFoil} onPickVersion={(card, options = {}) => setVersionPickCard({ ...card, ...options })} />
                    </div>
                    <div className={styles.visualCardBottom}>
                      <div className={styles.visualCardName}>{dc.name}</div>
                      <div className={styles.visualCardControls}>
                        <button className={styles.visualCardBtn} onClick={(ev) => { ev.stopPropagation(); changeQty(dc.id, -1) }}>−</button>
                        <span className={styles.visualCardCount}>{dc.qty}</span>
                        <button className={styles.visualCardBtn} onClick={(ev) => { ev.stopPropagation(); changeQty(dc.id, +1) }}>+</button>
                        <button className={styles.visualCardBtn} onClick={(ev) => { ev.stopPropagation(); removeCardFromDeck(dc.id) }}>✕</button>
                      </div>
                    </div>
                  </div>
                )
                if (deckView === 'compact') return (
                  <div key={dc.id} className={`${styles.compactRow}${dc.is_commander ? ' '+styles.isCommander : ''}`}>
                    <span className={styles.compactQty}>{dc.qty}</span>
                    <span className={styles.compactName}
                      style={{ cursor: 'pointer' }}
                      onClick={() => openDeckCardDetail(dc)}
                      onMouseEnter={e => showHoverPreviewForDeckCard(dc, e)}
                      onMouseLeave={() => clearHoverPreview()}
                      onMouseMove={e => setHoverPos({ x: e.clientX, y: e.clientY })}>
                      {dc.name}
                    </span>
                    {dc.foil && <span className={styles.foilBadge} title="Foil">✦</span>}
                    {compactVisibleColumns.set && <span className={styles.compactMeta}>{dc.set_code ? `${String(dc.set_code).toUpperCase()}${dc.collector_number ? ` #${dc.collector_number}` : ''}` : '—'}</span>}
                    {compactVisibleColumns.manaValue && <span className={styles.compactMeta}><ManaCostInline cost={dc.mana_cost} size={13} /></span>}
                    {compactVisibleColumns.cmc && <span className={styles.compactMeta}>{dc.cmc ?? '—'}</span>}
                    {compactVisibleColumns.price && <span className={styles.compactMeta}>{getDeckCardPriceLabel(dc)}</span>}
                    {compactVisibleColumns.status && (
                      <OwnershipBadge
                        ownedQty={ownedMap.get(dc.scryfall_id) ?? 0}
                        ownedAlt={ownedNameMap.get((dc.name || '').toLowerCase()) ?? 0}
                        ownedInDeck={allocationSetHas(inOtherDeckSet, dc)}
                        inCollDeck={allocationSetHas(collDeckSfSet, dc)}
                      />
                    )}
                    {compactVisibleColumns.actions && <EditMenu dc={dc} isEDH={isEDH} onSetCommander={setCardAsCommander} onToggleFoil={toggleFoil} onPickVersion={(card, options = {}) => setVersionPickCard({ ...card, ...options })} />}
                    {compactVisibleColumns.qty && (
                      <div className={styles.qtyControls}>
                        <button className={styles.qtyBtn} onClick={() => changeQty(dc.id, -1)}>−</button>
                        <span className={styles.qtyVal}>{dc.qty}</span>
                        <button className={styles.qtyBtn} onClick={() => changeQty(dc.id, +1)}>+</button>
                      </div>
                    )}
                    {compactVisibleColumns.remove && <button className={styles.removeBtn} onClick={() => removeCardFromDeck(dc.id)}>✕</button>}
                  </div>
                )
                // list view
                return <DeckCardRowV2 key={dc.id} {...deckRowProps(dc)} />
              }

              if (groupByType) {
                // Group sortedDeckCards by type (preserving sort order within groups)
                const groupMap = new Map(TYPE_GROUPS.map(g => [g, []]))
                for (const dc of sortedDeckCards) {
                  const g = dc.is_commander ? 'Commander' : classifyCardType(dc.type_line)
                  const target = groupMap.has(g) ? g : 'Other'
                  groupMap.get(target).push(dc)
                }
                return TYPE_GROUPS.map(group => {
                  const cards = groupMap.get(group)
                  if (!cards?.length) return null
                  const groupQty = cards.reduce((s, dc) => s + dc.qty, 0)
                  const collapsed = collapsedGroups.has(group)
                  return (
                    <div key={group} className={styles.deckGroup}>
                      <div
                        className={styles.groupHeader}
                        onClick={() => setCollapsedGroups(prev => {
                          const next = new Set(prev)
                          next.has(group) ? next.delete(group) : next.add(group)
                          return next
                        })}
                        style={{ cursor: 'pointer' }}
                      >
                        <span className={`${styles.groupArrow}${collapsed ? ' ' + styles.groupArrowCollapsed : ''}`}>▾</span>
                        <span className={styles.groupName}>{group}</span>
                        <span className={styles.groupCount}>{groupQty}</span>
                      </div>
                      {!collapsed && (deckView === 'visual'
                        ? <div className={styles.visualGrid} style={{ '--deckbuilder-grid-min': `${visualCardMinWidth}px` }}>{cards.map(dc => renderCard(dc))}</div>
                        : (
                          <>
                            {deckView === 'list' && (
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
                            )}
                            {cards.map(dc => renderCard(dc))}
                          </>
                        )
                      )}
                    </div>
                  )
                })
              }

              // Flat (no grouping)
              if (deckView === 'visual') {
                return <div className={styles.visualGrid} style={{ '--deckbuilder-grid-min': `${visualCardMinWidth}px` }}>{sortedDeckCards.map(dc => renderCard(dc))}</div>
              }
              return (
                <>
                  {deckView === 'list' && (
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
                  )}
                  {sortedDeckCards.map(dc => renderCard(dc))}
                </>
              )
            })()}
          </div>
        )}

        {/* Stats tab */}
        {rightTab === 'stats' && (
          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px' }}>
            {deckCards.length > 0
              ? <DeckStats
                  cards={normalizeDeckBuilderCards(deckCards)}
                  bracketOverride={statsBracketOverride}
                  onBracketOverride={setStatsBracketOverride}
                />
              : <div style={{ color: 'var(--text-faint)', fontSize: '0.85rem', padding: '40px 0', textAlign: 'center' }}>
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
                  ⟳ Find Combos
                </button>
                <div style={{ fontSize: '0.73rem', color: 'var(--text-faint)', marginTop: 8 }}>via Commander Spellbook</div>
              </div>
            )}
            {combosLoading && (
              <div style={{ color: 'var(--text-faint)', textAlign: 'center', paddingTop: 40, fontSize: '0.85rem' }}>
                ⟳ Checking Commander Spellbook…
              </div>
            )}
            {combosFetched && !combosLoading && (
              <>
                {combosIncluded.length > 0 ? (
                  <div>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.68rem', color: 'var(--gold)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
                      ✓ Complete Combos ({combosIncluded.length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {combosIncluded.map((c, i) => (
                        <ComboResultCard key={i} combo={c} highlight deckCardNames={deckCards.map(dc => dc.name)} deckImages={deckImagesMap} onAddCard={name => addCardToDeck({ name })} onOpenDetail={openCardDetailByName} />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--text-faint)', fontSize: '0.82rem' }}>No complete combos found in this deck.</div>
                )}
                {combosAlmost.length > 0 && (
                  <div>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: '0.68rem', color: 'var(--text-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
                      ⋯ Missing 1 Card ({combosAlmost.length})
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {combosAlmost.slice(0, 20).map((c, i) => (
                        <ComboResultCard key={i} combo={c} highlight={false} deckCardNames={deckCards.map(dc => dc.name)} deckImages={deckImagesMap} onAddCard={name => addCardToDeck({ name })} onOpenDetail={openCardDetailByName} />
                      ))}
                    </div>
                    {combosAlmost.length > 20 && (
                      <div style={{ color: 'var(--text-faint)', fontSize: '0.78rem' }}>+ {combosAlmost.length - 20} more partial combos</div>
                    )}
                  </div>
                )}
                <button onClick={fetchCombos} style={{ alignSelf: 'flex-start', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 12px', color: 'var(--text-faint)', fontSize: '0.78rem', cursor: 'pointer' }}>
                  ⟳ Refresh
                </button>
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div className={styles.deckFooter}>
          {makeDeckDone || syncDone ? (
            <>
              <div className={styles.convertDone}>✓ {makeDeckDone ? makeDeckMsg : syncMsg}</div>
              {makeDeckDone && (
                <Link to="/decks" style={{ fontSize:'0.82rem', color:'var(--gold)', textDecoration:'none' }}>
                  View in Decks →
                </Link>
              )}
            </>
          ) : (
            <>
              {!isCollectionDeck && deckMeta.linked_deck_id && (
                <div style={{ fontSize:'0.74rem', color:'var(--text-faint)', textAlign:'center', marginTop:2 }}>↔ linked to collection deck</div>
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

      {/* ── Import modal ──────────────────────────────────────────── */}
      {showImport && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={e => { if (e.target === e.currentTarget) setShowImport(false) }}>
          <div style={{ background: 'var(--bg-card, #1e1e1e)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, width: 480, maxWidth: '95vw', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', fontSize: '1rem' }}>Import Deck</span>
              <button onClick={() => setShowImport(false)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: '1.1rem', cursor: 'pointer' }}>✕</button>
            </div>

            {/* Tab switcher */}
            <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)' }}>
              {[['url', '🔗 URL'], ['text', '📋 Paste List'], ['file', '📂 Upload File']].map(([id, label]) => (
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
                  placeholder="https://archidekt.com/decks/12345/…"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', color: 'var(--text)', fontSize: '0.88rem', outline: 'none' }}
                />
                <p style={{ fontSize: '0.72rem', color: 'var(--text-faint)', margin: 0 }}>
                  ⚠ Moxfield may require logging in — if it fails, use Paste List instead.
                </p>
              </div>
            )}
            {importTab === 'text' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <p style={{ fontSize: '0.78rem', color: 'var(--text-faint)', margin: 0 }}>
                  Paste a decklist in standard format. Optionally prefix with <code style={{ color: 'var(--gold)' }}>Commander:</code> section.
                </p>
                <textarea
                  autoFocus
                  value={importText}
                  onChange={e => setImportText(e.target.value)}
                  placeholder={"Commander:\n1 Sheoldred, the Apocalypse\n\nDeck:\n1 Sol Ring\n1 Swamp\n..."}
                  rows={10}
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', color: 'var(--text)', fontSize: '0.83rem', outline: 'none', resize: 'vertical', fontFamily: 'monospace' }}
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
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)', padding: '10px 16px', fontSize: '0.83rem', cursor: 'pointer', textAlign: 'left' }}>
                  {importText ? `✓ File loaded — ${importText.split('\n').filter(Boolean).length} lines` : 'Choose file…'}
                </button>
                {importText && (
                  <textarea
                    readOnly
                    value={importText}
                    rows={6}
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', color: 'var(--text-faint)', fontSize: '0.78rem', outline: 'none', resize: 'vertical', fontFamily: 'monospace' }}
                  />
                )}
              </div>
            )}

            {importError && <p style={{ color: '#e07070', fontSize: '0.82rem', margin: 0 }}>{importError}</p>}
            {importDone  && <p style={{ color: 'var(--green)', fontSize: '0.82rem', margin: 0 }}>✓ {importDone}</p>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowImport(false)}
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)', padding: '7px 14px', fontSize: '0.83rem', cursor: 'pointer' }}>
                {importDone ? 'Close' : 'Cancel'}
              </button>
              {!importDone && (
                <button onClick={handleImport}
                  disabled={importing || (importTab === 'url' ? !importUrl.trim() : !importText.trim())}
                  style={{ background: 'rgba(201,168,76,0.15)', border: '1px solid rgba(201,168,76,0.4)', borderRadius: 4, color: 'var(--gold)', padding: '7px 18px', fontSize: '0.83rem', cursor: 'pointer', opacity: importing ? 0.6 : 1 }}>
                  {importing ? 'Importing…' : 'Import'}
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
    </div>
  )
}
