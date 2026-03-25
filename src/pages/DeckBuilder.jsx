import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import {
  FORMATS, TYPE_GROUPS, classifyCardType,
  parseDeckMeta, serializeDeckMeta, getCardImageUri, nameToSlug,
  searchCards, searchCommanders, fetchCardsByNames,
  fetchEdhrecCommander, makeDebouncer,
  importDeckFromUrl, parseTextDecklist,
} from '../lib/deckBuilderApi'
import {
  getLocalCards, getDeckCards, putDeckCards, deleteDeckCardLocal,
  getLocalFolderCards, getScryfallEntry,
} from '../lib/db'
import styles from './DeckBuilder.module.css'
import DeckStats, { normalizeDeckBuilderCards } from '../components/DeckStats'

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

// ── Floating card preview ─────────────────────────────────────────────────────
function FloatingPreview({ imageUri, x, y }) {
  if (!imageUri) return null
  const left = x > window.innerWidth - 280 ? x - 240 : x + 16
  const top  = Math.min(y - 30, window.innerHeight - 330)
  return (
    <div className={styles.floatingPreview} style={{ left, top }}>
      <img className={styles.floatingImg} src={imageUri} alt="" />
    </div>
  )
}

// ── Single card row in search results ─────────────────────────────────────────
function SearchResultRow({ card, ownedQty, onAdd }) {
  const img = getCardImageUri(card, 'small')
  return (
    <div className={styles.searchRow}>
      {img
        ? <img className={styles.searchThumb} src={img} alt="" loading="lazy" />
        : <div className={styles.searchThumbPlaceholder} />
      }
      <div className={styles.searchInfo}>
        <div className={styles.searchName}>{card.name}</div>
        <div className={styles.searchType}>{card.type_line}</div>
      </div>
      <div className={styles.searchMeta}>
        {ownedQty > 0 && <span className={styles.ownedBadge}>✓ {ownedQty}x</span>}
      </div>
      <button className={styles.addBtn} onClick={() => onAdd(card)} title="Add to deck">+</button>
    </div>
  )
}

// ── Single card row in EDHRec recommendations ─────────────────────────────────
function RecRow({ rec, imageUri, ownedQty, onAdd, onHoverEnter, onHoverLeave, onHoverMove }) {
  const synergyPct = Math.round((rec.synergy ?? 0) * 100)
  // Scryfall CDN URLs have the size in the path — swap small → normal for hover preview
  const largeUri = imageUri ? imageUri.replace('/small/', '/normal/') : null
  return (
    <div
      className={styles.recRow}
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
            <div className={styles.inclusionFill} style={{ width: `${rec.inclusion ?? 0}%` }} />
          </div>
          <span className={styles.inclusionPct}>{rec.inclusion ?? 0}%</span>
          {synergyPct !== 0 && (
            <span className={synergyPct > 0 ? styles.synergyPos : styles.synergyNeg}>
              {synergyPct > 0 ? '+' : ''}{synergyPct}
            </span>
          )}
          {ownedQty > 0 && <span className={styles.ownedBadge}>✓</span>}
        </div>
      </div>
      <button className={styles.addBtn} onClick={() => onAdd(rec)} title="Add to deck">+</button>
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
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        className={styles.editBtn}
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        title="Edit"
      >⚙</button>
      {open && (
        <div className={styles.editMenuPopover}>
          {isEDH && !dc.is_commander && canBeCommander(dc) && (
            <button className={styles.editMenuItem} onClick={() => { onSetCommander(dc); setOpen(false) }}>
              ♛ Set as Commander
            </button>
          )}
          <button className={styles.editMenuItem} onClick={() => { onToggleFoil(dc.id); setOpen(false) }}>
            {dc.foil ? '✦ Remove Foil' : '◇ Mark as Foil'}
          </button>
          <button className={styles.editMenuItem} onClick={() => { onPickVersion(dc); setOpen(false) }}>
            ⚙ Change Version
          </button>
        </div>
      )}
    </div>
  )
}

// ── Deck card row in right panel ──────────────────────────────────────────────
function DeckCardRow({ dc, ownedQty, ownedAlt, ownedInDeck, onChangeQty, onRemove, onMouseEnter, onMouseLeave, onMouseMove, onPickVersion, onToggleFoil, onSetCommander, isEDH }) {
  return (
    <div className={`${styles.deckCardRow}${dc.is_commander ? ' ' + styles.isCommander : ''}`}>
      <div className={styles.deckCardLeft} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove}>
        {dc.image_uri
          ? <img className={styles.deckThumb} src={dc.image_uri} alt="" loading="lazy" />
          : <div className={styles.deckThumbPlaceholder} />
        }
        <span className={styles.deckCardName}>{dc.name}</span>
        {dc.foil && <span className={styles.foilBadge} title="Foil">✦</span>}
      </div>
      {/* 3-state ownership dot */}
      {ownedQty > 0 && !ownedInDeck
        ? <span className={styles.ownedDot} title="Owned (free)" />
        : ownedInDeck
          ? <span className={styles.ownedDotInDeck} title="Owned (in another deck)" />
          : ownedAlt > 0
            ? <span className={styles.ownedDotAlt} title="Different version owned" />
            : null
      }
      <EditMenu dc={dc} isEDH={isEDH} onSetCommander={onSetCommander} onToggleFoil={onToggleFoil} onPickVersion={onPickVersion} />
      <div className={styles.qtyControls}>
        <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, -1)}>−</button>
        <span className={styles.qtyVal}>{dc.qty}</span>
        <button className={styles.qtyBtn} onClick={() => onChangeQty(dc.id, +1)}>+</button>
      </div>
      <button className={styles.removeBtn} onClick={() => onRemove(dc.id)}>✕</button>
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

function ComboCardThumb({ name, inDeck, existingUri }) {
  const img = useComboCardImage(name, existingUri)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: inDeck ? 1 : 0.45 }}>
      <div style={{
        width: 120, height: 168, borderRadius: 7, overflow: 'hidden', flexShrink: 0,
        border: `1px solid ${inDeck ? 'rgba(201,168,76,0.5)' : 'rgba(255,255,255,0.12)'}`,
        background: 'rgba(255,255,255,0.04)',
      }}>
        {img
          ? <img src={img} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
          : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.73rem', color: 'var(--text-faint)', padding: 8, textAlign: 'center', lineHeight: 1.3 }}>{name}</div>}
      </div>
      <div style={{ fontSize: '0.64rem', color: inDeck ? 'var(--text-faint)' : '#e08878', textAlign: 'center', maxWidth: 110, lineHeight: 1.2, wordBreak: 'break-word' }}>
        {inDeck ? name : `⊕ ${name}`}
      </div>
    </div>
  )
}

function ComboResultCard({ combo, highlight, deckCardNames, deckImages }) {
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
          <ComboCardThumb key={i} name={name} inDeck={!deckCardNames || deckSet.has(name)} existingUri={deckImages?.[name]} />
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
      </div>
      <div style={{ fontSize:'0.79rem', color:statusColor, flexShrink:0, display:'flex', alignItems:'center', gap:4 }}>
        <span>{statusIcon}</span><span>{statusDetail}</span>
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

  useEffect(() => {
    async function load() {
      // Use IDB (same source as the green bar) so counts are consistent
      const collCards = await getLocalCards(userId)
      const sfIdMap = new Map()   // scryfall_id → { cardId, qty }
      const nameQtyMap = new Map() // name_lower → { cardId, qty }
      for (const c of collCards || []) {
        const qty = c.qty || 1
        if (c.scryfall_id) {
          if (!sfIdMap.has(c.scryfall_id)) sfIdMap.set(c.scryfall_id, { cardId: c.id, qty })
          else sfIdMap.get(c.scryfall_id).qty += qty
        }
        const n = (c.name || '').toLowerCase()
        if (n) {
          if (!nameQtyMap.has(n)) nameQtyMap.set(n, { cardId: c.id, qty })
          else nameQtyMap.get(n).qty += qty
        }
      }
      const items = []
      for (const dc of deckCards) {
        if (dc.is_commander) continue
        const nameLower = (dc.name || '').toLowerCase()
        const exactEntry = sfIdMap.get(dc.scryfall_id)
        const anyEntry   = nameQtyMap.get(nameLower)
        const exactQty   = exactEntry?.qty ?? 0
        const totalQty   = anyEntry?.qty ?? 0
        const otherQty   = Math.max(0, totalQty - exactQty)
        const needed     = dc.qty
        const addExact   = Math.min(exactQty, needed)
        const remaining  = needed - addExact
        const addOther   = Math.min(otherQty, remaining)
        const totalAdd   = addExact + addOther
        const missingQty = needed - totalAdd
        const cardId     = addExact > 0 ? exactEntry.cardId : (addOther > 0 ? anyEntry.cardId : null)
        items.push({ dc, neededQty: needed, addExact, addOther, totalAdd, missingQty, cardId })
      }
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
      const effectiveOther = exactVersionOnly ? 0 : i.addOther
      const totalAdd   = i.addExact + effectiveOther
      const missingQty = i.neededQty - totalAdd
      return { ...i, addOther: effectiveOther, totalAdd, missingQty }
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
                : filtered.map(item => <MakeDeckRow key={item.dc.id} item={item} />)
              }
            </div>
            {missingCount > 0 && (
              <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)' }}>
                <div style={{ fontSize:'0.82rem', color:'var(--text-dim)', marginBottom:8 }}>
                  Add {missingItems.reduce((s, i) => s + i.missingQty, 0)} missing card{missingCount !== 1 ? 's' : ''} to wishlist:
                </div>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <select value={selectedWishlistId} onChange={e => setSelectedWishlistId(e.target.value)}
                    style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'6px 10px', color:'var(--text)', fontSize:'0.84rem', flex:1, minWidth:0 }}>
                    <option value="">— Skip missing —</option>
                    {wishlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
                    <option value="new">+ Create new wishlist…</option>
                  </select>
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
                onClick={() => onConfirm({ addItems, missingItems, wishlistId: selectedWishlistId === 'new' ? null : (selectedWishlistId || null), wishlistName: selectedWishlistId === 'new' ? newWishlistName.trim() : null })}
                disabled={!canConfirm}
                style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green, #4a9a5a)', fontSize:'0.83rem', cursor:'pointer', opacity:canConfirm ? 1 : 0.45 }}>
                Create Deck ({addItems.reduce((s, i) => s + i.totalAdd, 0)} cards)
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Sync modal ────────────────────────────────────────────────────────────────
function SyncModal({ deckId, deckCards, deckMeta, userId, isCollectionDeck, onConfirm, onClose }) {
  const [loading, setLoading] = useState(true)
  const [diff, setDiff] = useState(null)
  const [folders, setFolders] = useState([])
  const [wishlists, setWishlists] = useState([])
  const [moveDestinations, setMoveDestinations] = useState({})
  const [globalDest, setGlobalDest] = useState('')
  const [wishlistId, setWishlistId] = useState('')
  const [newWishlistName, setNewWishlistName] = useState('')

  useEffect(() => {
    async function load() {
      const targetFolderId = isCollectionDeck ? deckId : deckMeta.linked_deck_id
      if (!targetFolderId) { setLoading(false); return }
      const [{ data: fc }, { data: collCards }, { data: foldersData }, { data: wls }] = await Promise.all([
        sb.from('folder_cards').select('id, card_id, qty, cards(id, scryfall_id, name)').eq('folder_id', targetFolderId),
        sb.from('cards').select('id, scryfall_id, name').eq('user_id', userId),
        sb.from('folders').select('id, name, type').eq('user_id', userId).in('type', ['deck', 'binder']).neq('id', targetFolderId).order('name'),
        sb.from('folders').select('id, name').eq('user_id', userId).eq('type', 'list').order('name'),
      ])
      const sfIdToCardId = new Map()
      const nameToCardId = new Map()
      for (const c of collCards || []) {
        if (c.scryfall_id && !sfIdToCardId.has(c.scryfall_id)) sfIdToCardId.set(c.scryfall_id, c.id)
        const n = (c.name || '').toLowerCase()
        if (n && !nameToCardId.has(n)) nameToCardId.set(n, c.id)
      }
      const collMap = new Map()
      for (const row of fc || []) collMap.set(row.card_id, row)
      const builderCards = deckCards.filter(dc => !dc.is_commander && !BASIC_LANDS.has(dc.name))
      const added = [], changed = []
      const builderCardIds = new Set()
      for (const dc of builderCards) {
        const cardId = sfIdToCardId.get(dc.scryfall_id) ?? nameToCardId.get((dc.name || '').toLowerCase())
        if (!cardId) { added.push({ dc, cardId: null, owned: false }); continue }
        builderCardIds.add(cardId)
        const existing = collMap.get(cardId)
        if (!existing) added.push({ dc, cardId, owned: true })
        else if (existing.qty !== dc.qty) changed.push({ dc, cardId, fcRow: existing, oldQty: existing.qty, newQty: dc.qty })
      }
      const removed = []
      for (const [cardId, fcRow] of collMap) {
        if (!builderCardIds.has(cardId)) removed.push({ cardId, fcRow, name: fcRow.cards?.name || '?' })
      }
      setDiff({ added, changed, removed, targetFolderId })
      setFolders(foldersData || [])
      setWishlists(wls || [])
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    if (!globalDest || !diff?.removed.length) return
    const updates = {}
    for (const r of diff.removed) updates[r.fcRow.id] = globalDest
    setMoveDestinations(updates)
  }, [globalDest, diff])

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

  const { added = [], changed = [], removed = [] } = diff || {}
  const ownedAdded   = added.filter(i => i.owned)
  const unownedAdded = added.filter(i => !i.owned)
  const hasChanges   = ownedAdded.length || removed.length || changed.length || unownedAdded.length

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

  const allRemovesMapped = !removed.length || removed.every(r => moveDestinations[r.fcRow.id])
  const canConfirm = allRemovesMapped

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:560, maxWidth:'95vw', maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>Sync to Collection</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:'pointer' }}>✕</button>
        </div>
        <div style={{ flex:1, overflowY:'auto', minHeight:0, padding:'16px 20px', display:'flex', flexDirection:'column', gap:16 }}>
          {ownedAdded.length > 0 && (
            <div>
              <div style={secLabel}>Adding to collection deck ({ownedAdded.length})</div>
              {ownedAdded.map(i => (
                <div key={i.dc.id} style={{ display:'flex', justifyContent:'space-between', padding:'3px 0', fontSize:'0.84rem', color:'var(--text)' }}>
                  <span>{i.dc.qty > 1 ? `${i.dc.qty}× ` : ''}{i.dc.name}</span>
                  <span style={{ color:'var(--green, #4a9a5a)', fontSize:'0.78rem' }}>✓ owned</span>
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
              <div style={secLabel}>Removed — choose destination ({removed.length})</div>
              <div style={{ marginBottom:8, display:'flex', gap:8, alignItems:'center' }}>
                <span style={{ fontSize:'0.79rem', color:'var(--text-faint)', whiteSpace:'nowrap' }}>All to:</span>
                <select value={globalDest} onChange={e => setGlobalDest(e.target.value)} style={{ ...s, flex:1 }}>
                  <option value="">— Pick individually —</option>
                  {folders.map(f => <option key={f.id} value={f.id}>{f.name} ({f.type})</option>)}
                </select>
              </div>
              {removed.map(r => (
                <div key={r.fcRow.id} style={{ display:'flex', gap:8, alignItems:'center', marginBottom:4 }}>
                  <span style={{ flex:1, fontSize:'0.84rem', color:'var(--text)' }}>{r.name}</span>
                  <select
                    value={moveDestinations[r.fcRow.id] || ''}
                    onChange={e => setMoveDestinations(prev => ({ ...prev, [r.fcRow.id]: e.target.value }))}
                    style={{ ...s, minWidth:160 }}>
                    <option value="">— Required —</option>
                    {folders.map(f => <option key={f.id} value={f.id}>{f.name} ({f.type})</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}
          {unownedAdded.length > 0 && (
            <div>
              <div style={secLabel}>Not owned — add to wishlist? ({unownedAdded.length})</div>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <select value={wishlistId} onChange={e => setWishlistId(e.target.value)} style={{ ...s, flex:1 }}>
                  <option value="">— Skip —</option>
                  {wishlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
                  <option value="new">+ Create new wishlist…</option>
                </select>
                {wishlistId === 'new' && (
                  <input autoFocus value={newWishlistName} onChange={e => setNewWishlistName(e.target.value)}
                    placeholder="Wishlist name…"
                    style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'5px 8px', color:'var(--text)', fontSize:'0.83rem', flex:1 }} />
                )}
              </div>
            </div>
          )}
        </div>
        <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', display:'flex', gap:8, justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:'0.79rem', color:'#e07070' }}>
            {!allRemovesMapped && removed.length > 0 ? '⚠ All removed cards need a destination' : ''}
          </span>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={onClose} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:'pointer' }}>Cancel</button>
            <button
              disabled={!canConfirm}
              onClick={() => canConfirm && onConfirm({ diff, moveDestinations, wishlistId: wishlistId === 'new' ? null : (wishlistId || null), wishlistName: wishlistId === 'new' ? newWishlistName.trim() : null })}
              style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green, #4a9a5a)', fontSize:'0.83rem', cursor:canConfirm ? 'pointer' : 'not-allowed', opacity:canConfirm ? 1 : 0.45 }}>
              Apply Sync
            </button>
          </div>
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

  // Search
  const [searchQuery,   setSearchQuery]   = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchHasMore, setSearchHasMore] = useState(false)
  const [searchPage,    setSearchPage]    = useState(1)

  // Recommendations
  const [recs,         setRecs]         = useState([])
  const [recImages,    setRecImages]    = useState({}) // name -> image_uri
  const [recsLoading,  setRecsLoading]  = useState(false)
  const [recsError,    setRecsError]    = useState(null)
  const [collapsedCats, setCollapsedCats] = useState(new Set())

  // Collection
  const [ownedMap,       setOwnedMap]       = useState(new Map())
  const [ownedNameMap,   setOwnedNameMap]   = useState(new Map())
  const [inOtherDeckSet, setInOtherDeckSet] = useState(new Set())
  // Version picker
  const [versionPickCard, setVersionPickCard] = useState(null)
  // Share button
  const [shareCopied, setShareCopied] = useState(false)

  // Hover preview
  const [hoverImg, setHoverImg] = useState(null)
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 })

  // Right panel tabs: 'deck' | 'stats' | 'combos'
  const [rightTab,            setRightTab]            = useState('deck')
  const [statsBracketOverride, setStatsBracketOverride] = useState(null)
  const [deckView,    setDeckView]    = useState('list')   // 'list' | 'compact' | 'visual'
  const [showRight, setShowRight] = useState(false)
  const [deckSort,    setDeckSort]    = useState('type')   // 'name' | 'cmc' | 'color' | 'type'
  const [groupByType, setGroupByType] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())

  // Combos (Commander Spellbook)
  const [combosIncluded, setCombosIncluded] = useState([])
  const [combosAlmost,   setCombosAlmost]   = useState([])
  const [combosLoading,  setCombosLoading]  = useState(false)
  const [combosFetched,  setCombosFetched]  = useState(false)

  // Import
  const [showImport,    setShowImport]    = useState(false)
  const [importUrl,     setImportUrl]     = useState('')
  const [importText,    setImportText]    = useState('')
  const [importTab,     setImportTab]     = useState('url') // 'url' | 'text'
  const [importing,     setImporting]     = useState(false)
  const [importError,   setImportError]   = useState(null)
  const [importDone,    setImportDone]    = useState(null)  // summary string

  // Make Deck / Sync
  const [showMakeDeck,    setShowMakeDeck]    = useState(false)
  const [showSync,        setShowSync]        = useState(false)
  const [makeDeckDone,    setMakeDeckDone]    = useState(false)
  const [makeDeckMsg,     setMakeDeckMsg]     = useState('')
  const [makeDeckRunning, setMakeDeckRunning] = useState(false)
  const [syncRunning,     setSyncRunning]     = useState(false)
  const [syncDone,        setSyncDone]        = useState(false)
  const [syncMsg,         setSyncMsg]         = useState('')

  // Description & tags
  const [cmdDescription, setCmdDescription] = useState('')
  const [cmdTags,        setCmdTags]        = useState([])
  const [newTagInput,    setNewTagInput]    = useState('')

  // Refs
  const deckCardsRef    = useRef(deckCards)
  const searchDebounce  = useRef(makeDebouncer(350))
  const cmdDebounce     = useRef(makeDebouncer(300))
  const qtyTimers       = useRef(new Map())
  const saveMetaTimer   = useRef(null)

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

        // Load deck cards from Supabase
        const { data: cards } = await sb.from('deck_cards').select('*').eq('deck_id', deckId).order('is_commander', { ascending: false })
        let cardList = cards || []

        // For collection decks (type='deck'), migrate folder_cards → deck_cards when needed.
        // This runs when: (a) deck_cards is empty (first open), or (b) folder_cards has more
        // non-commander cards than deck_cards (corrupted state after a partial commander save).
        if (folder.type === 'deck') {
          const fcRows = await getLocalFolderCards(deckId)
          // Only migrate when folder_cards has more entries than ALL deck_cards (including
          // commanders). Comparing against non-commander count caused re-migration every
          // time a card was promoted to commander, duplicating the entire deck.
          if (fcRows?.length && fcRows.length > cardList.length) {
            const ownedAll = await getLocalCards(user.id)
            const cardById = new Map(ownedAll.map(c => [c.id, c]))
            const now = new Date().toISOString()
            const built = await Promise.all(
              fcRows.map(async r => {
                const c = cardById.get(r.card_id)
                if (!c) return null
                const sfKey = c.set_code && c.collector_number ? `${c.set_code}-${c.collector_number}` : null
                const sf = sfKey ? await getScryfallEntry(sfKey) : null
                const imageUri = sf?.image_uris?.normal ?? sf?.image_uris?.small ?? (sf?.card_faces?.[0]?.image_uris?.normal) ?? null
                return {
                  id:               crypto.randomUUID(),
                  deck_id:          deckId,
                  user_id:          user.id,
                  scryfall_id:      c.scryfall_id ?? null,
                  name:             c.name,
                  set_code:         c.set_code ?? null,
                  collector_number: c.collector_number ?? null,
                  type_line:        sf?.type_line ?? null,
                  mana_cost:        sf?.mana_cost ?? null,
                  cmc:              sf?.cmc ?? null,
                  color_identity:   sf?.color_identity ?? [],
                  image_uri:        imageUri,
                  qty:              r.qty || 1,
                  foil:             c.foil ?? false,
                  is_commander:     false,
                  board:            'main',
                  created_at:       now,
                  updated_at:       now,
                }
              })
            )
            const newRows = built.filter(Boolean)
            if (newRows.length) {
              // Combine with any existing deck_cards (e.g. a commander already saved)
              // then persist to Supabase so the migration survives reloads
              cardList = [...cardList.filter(dc => dc.is_commander), ...newRows]
              sb.from('deck_cards').upsert(newRows, { onConflict: 'id' })
                .then(({ error }) => { if (error) console.error('[DeckBuilder] folder_cards migration failed:', error) })
            }
          }
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

        // Find scryfall_ids of cards already assigned to other collection decks
        const { data: deckFolders } = await sb.from('folders').select('id').eq('user_id', user.id).eq('type', 'deck')
        if (deckFolders?.length) {
          const dIds = deckFolders.map(d => d.id)
          const { data: fcRows } = await sb.from('folder_cards').select('card_id').in('folder_id', dIds)
          if (fcRows?.length) {
            const cIds = [...new Set(fcRows.map(r => r.card_id))]
            const { data: cRows } = await sb.from('cards').select('id, scryfall_id').in('id', cIds)
            setInOtherDeckSet(new Set((cRows || []).map(c => c.scryfall_id).filter(Boolean)))
          }
        }
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
  const partnerCard    = commanderCards[1] ?? null
  const totalCards     = useMemo(() => deckCards.reduce((s, dc) => s + dc.qty, 0), [deckCards])
  const ownedCount     = useMemo(() => deckCards.filter(dc =>
    (ownedMap.get(dc.scryfall_id) ?? 0) > 0 ||
    (ownedNameMap.get((dc.name || '').toLowerCase()) ?? 0) > 0
  ).length, [deckCards, ownedMap, ownedNameMap])
  const colorIdentity  = useMemo(() => {
    const cols = new Set()
    for (const c of commanderCards) for (const col of (c.color_identity || [])) cols.add(col)
    return [...cols]
  }, [commanderCards])
  const deckSize       = format?.deckSize ?? 60

  const isCollectionDeck = deck?.type === 'deck'

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

  const recCategoriesFiltered = useMemo(() => {
    if (!recs?.categories) return []
    return recs.categories.map(c => ({
      ...c,
      cards: c.cards.filter(r => !deckNameSet.has(r.name.toLowerCase())),
    })).filter(c => c.cards.length > 0)
  }, [recs, deckNameSet])

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
    setSearchPage(page)
    const { cards, hasMore } = await searchCards({
      query: q,
      format: deckMeta.format,
      colorIdentity: isEDH && colorIdentity.length ? colorIdentity : undefined,
      page,
    })
    if (page === 1) setSearchResults(cards)
    else setSearchResults(prev => [...prev, ...cards])
    setSearchHasMore(hasMore)
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
      name       = sfCardOrRec.name
      scryfallId = sfCardOrRec.id
      setCode    = sfCardOrRec.set
      collNum    = sfCardOrRec.collector_number
      typeLine   = sfCardOrRec.type_line
      manaCost   = sfCardOrRec.mana_cost
      cmc        = sfCardOrRec.cmc
      colorId    = sfCardOrRec.color_identity
      imageUri   = getCardImageUri(sfCardOrRec, 'normal')
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
          scryfallId = full.id
          setCode    = full.set
          collNum    = full.collector_number
          typeLine   = full.type_line
          manaCost   = full.mana_cost
          cmc        = full.cmc
          colorId    = full.color_identity
          imageUri   = getCardImageUri(full, 'normal')
        }
      } catch {}
    }

    // Check if already in deck
    const existing = deckCards.find(dc =>
      (scryfallId && dc.scryfall_id === scryfallId) || dc.name === name
    )

    if (existing) {
      // Increment qty
      changeQty(existing.id, +1)
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
  }

  function changeQty(deckCardId, delta) {
    setDeckCards(prev => prev.map(dc => {
      if (dc.id !== deckCardId) return dc
      const qty = dc.qty + delta
      if (qty <= 0) return dc // handled via remove
      return { ...dc, qty }
    }))

    // Debounce Supabase update
    if (qtyTimers.current.has(deckCardId)) clearTimeout(qtyTimers.current.get(deckCardId))
    const timer = setTimeout(async () => {
      const current = deckCardsRef.current.find(dc => dc.id === deckCardId)
      if (!current) return
      if (current.qty <= 0) return
      await sb.from('deck_cards').update({ qty: current.qty, updated_at: new Date().toISOString() }).eq('id', deckCardId)
      qtyTimers.current.delete(deckCardId)
    }, 600)
    qtyTimers.current.set(deckCardId, timer)
  }

  async function removeCardFromDeck(deckCardId) {
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

  async function setCardAsCommander(dc) {
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
          coverArtUri: dc.image_uri ?? deckMeta.coverArtUri,
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
      const res = await fetch('/api/combos/find-my-combos/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        const isCmd = entry.isCommander && !commanderSet
        if (isCmd) commanderSet = true

        newRows.push({
          id:               crypto.randomUUID(),
          deck_id:          deckId,
          user_id:          user.id,
          scryfall_id:      sf?.id ?? null,
          name:             entry.name,
          set_code:         entry.setCode ?? sf?.set ?? null,
          collector_number: entry.collectorNumber ?? sf?.collector_number ?? null,
          type_line:        sf?.type_line ?? null,
          mana_cost:        sf?.mana_cost ?? null,
          cmc:              sf?.cmc ?? null,
          color_identity:   sf?.color_identity ?? [],
          image_uri:        getCardImageUri(sf, 'normal'),
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
  }

  async function updateCardVersion(dcId, sfCard) {
    const updated = {
      scryfall_id:      sfCard.id,
      set_code:         sfCard.set,
      collector_number: sfCard.collector_number,
      image_uri:        getCardImageUri(sfCard, 'normal'),
    }
    setDeckCards(prev => prev.map(d => d.id === dcId ? { ...d, ...updated } : d))
    await sb.from('deck_cards').update(updated).eq('id', dcId)
    setVersionPickCard(null)
  }

  async function handleMakeDeck({ addItems, missingItems, wishlistId, wishlistName }) {
    if (makeDeckRunning) return
    setMakeDeckRunning(true)
    setShowMakeDeck(false)
    try {
      const collMeta = {
        format: deckMeta.format,
        commanderName: deckMeta.commanderName,
        commanderScryfallId: deckMeta.commanderScryfallId,
        commanderColorIdentity: deckMeta.commanderColorIdentity,
        coverArtUri: deckMeta.coverArtUri,
        linked_builder_id: deckId,
      }
      const { data: newDeck, error: deckErr } = await sb.from('folders').insert({
        user_id: user.id, type: 'deck', name: deck.name,
        description: serializeDeckMeta(collMeta),
      }).select().single()
      if (deckErr || !newDeck) throw deckErr || new Error('Failed to create deck')

      if (addItems.length > 0) {
        const inserts = addItems.map(i => ({ id: crypto.randomUUID(), folder_id: newDeck.id, card_id: i.cardId, qty: i.totalAdd, foil: i.dc.foil ?? false }))
        const { error: fcErr } = await sb.from('folder_cards').insert(inserts)
        if (fcErr) throw fcErr
      }

      let targetWishlistId = wishlistId
      if (!targetWishlistId && wishlistName) {
        const { data: wl, error: wlErr } = await sb.from('folders').insert({ user_id: user.id, type: 'list', name: wishlistName, description: '{}' }).select().single()
        if (wlErr) throw wlErr
        targetWishlistId = wl?.id
      }
      if (targetWishlistId && missingItems.length > 0) {
        const listInserts = missingItems.map(i => ({ id: crypto.randomUUID(), folder_id: targetWishlistId, name: i.dc.name, scryfall_id: i.dc.scryfall_id || null, set_code: i.dc.set_code || null, collector_number: i.dc.collector_number || null, foil: i.dc.foil ?? false, qty: i.missingQty }))
        await sb.from('list_items').insert(listInserts)
      }

      const updatedMeta = { ...deckMeta, linked_deck_id: newDeck.id }
      setDeckMeta(updatedMeta)
      await sb.from('folders').update({ description: serializeDeckMeta(updatedMeta) }).eq('id', deckId)

      const addCount = addItems.reduce((s, i) => s + i.totalAdd, 0)
      const misCount = missingItems.reduce((s, i) => s + i.missingQty, 0)
      let msg = `${addCount} card${addCount !== 1 ? 's' : ''} added to collection deck`
      if (targetWishlistId && misCount > 0) msg += `, ${misCount} added to wishlist`
      setMakeDeckMsg(msg)
      setMakeDeckDone(true)
    } catch (err) {
      console.error('[MakeDeck]', err)
      setMakeDeckMsg('Failed to create deck. Try again.')
      setMakeDeckDone(true)
    }
    setMakeDeckRunning(false)
  }

  async function handleSync({ diff, moveDestinations, wishlistId, wishlistName }) {
    if (syncRunning) return
    setSyncRunning(true)
    setShowSync(false)
    try {
      const { added, changed, removed, targetFolderId } = diff
      const ownedAdded   = added.filter(i => i.owned)
      const unownedAdded = added.filter(i => !i.owned)

      if (ownedAdded.length > 0) {
        const inserts = ownedAdded.map(i => ({ id: crypto.randomUUID(), folder_id: targetFolderId, card_id: i.cardId, qty: i.dc.qty, foil: i.dc.foil ?? false }))
        await sb.from('folder_cards').insert(inserts)
      }
      for (const c of changed) {
        await sb.from('folder_cards').update({ qty: c.newQty }).eq('id', c.fcRow.id)
      }
      for (const r of removed) {
        const destId = moveDestinations[r.fcRow.id]
        if (destId) await sb.from('folder_cards').update({ folder_id: destId }).eq('id', r.fcRow.id)
      }

      let targetWishlistId = wishlistId
      if (!targetWishlistId && wishlistName) {
        const { data: wl } = await sb.from('folders').insert({ user_id: user.id, type: 'list', name: wishlistName, description: '{}' }).select().single()
        targetWishlistId = wl?.id
      }
      if (targetWishlistId && unownedAdded.length > 0) {
        const listInserts = unownedAdded.map(i => ({ id: crypto.randomUUID(), folder_id: targetWishlistId, name: i.dc.name, scryfall_id: i.dc.scryfall_id || null, set_code: i.dc.set_code || null, collector_number: i.dc.collector_number || null, foil: i.dc.foil ?? false, qty: i.dc.qty }))
        await sb.from('list_items').insert(listInserts)
      }

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

      {/* ── LEFT PANEL ─────────────────────────────────────────── */}
      <div className={styles.left}>
        {/* Mobile panel toggle — rendered outside the left panel so it stays visible */}
        <div className={styles.leftTop}>
          {/* Format selector */}
          <div className={styles.formatRow}>
            <span className={styles.formatLabel}>Format</span>
            <select
              className={styles.formatSelect}
              value={deckMeta.format || 'commander'}
              onChange={e => handleFormatChange(e.target.value)}
            >
              {FORMATS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
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
              <button className={styles.searchBtn} onClick={() => doSearch(searchQuery, 1)}>→</button>
            </div>

            <div className={styles.searchResults}>
              {searchLoading && searchPage === 1 && <div className={styles.searchEmpty}>Searching…</div>}
              {!searchLoading && searchResults.length === 0 && searchQuery && (
                <div className={styles.searchEmpty}>No results. Try a different query.</div>
              )}
              {!searchLoading && searchResults.length === 0 && !searchQuery && (
                <div className={styles.searchEmpty}>Type a card name or keyword to search.</div>
              )}
              {searchResults.map(c => (
                <SearchResultRow
                  key={c.id}
                  card={c}
                  ownedQty={ownedMap.get(c.id) ?? 0}
                  onAdd={addCardToDeck}
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
                              onHoverEnter={(uri, e) => { setHoverImg(uri); setHoverPos({ x: e.clientX, y: e.clientY }) }}
                              onHoverMove={e => setHoverPos({ x: e.clientX, y: e.clientY })}
                              onHoverLeave={() => setHoverImg(null)}
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
        {/* Deck header */}
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
          <button className={styles.importBtn} onClick={() => { setShowImport(true); setImportDone(null); setImportError(null) }}>
            ↓ Import
          </button>
          <button
            className={styles.shareBtn}
            onClick={() => {
              navigator.clipboard.writeText(window.location.origin + (import.meta.env.BASE_URL || '/').replace(/\/$/, '') + '/d/' + deckId)
              setShareCopied(true)
              setTimeout(() => setShareCopied(false), 2000)
            }}
            title="Copy shareable link"
          >
            {shareCopied ? '✓ Copied' : '⧉ Share'}
          </button>
          {!isCollectionDeck && !deckMeta.linked_deck_id && (
            <button className={styles.importBtn} onClick={() => setShowMakeDeck(true)} disabled={makeDeckRunning}>
              {makeDeckRunning ? 'Creating…' : '⊕ Create Collection Deck'}
            </button>
          )}
          <Link to="/builder" style={{ fontSize: '0.8rem', color: 'var(--text-faint)', textDecoration: 'none' }}>
            ← Decks
          </Link>
        </div>

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
            !isCollectionDeck && { id: 'combos', label: 'Combos', badge: combosFetched ? String(combosIncluded.length) : null },
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
                  {[['list','≡'],['compact','⊟'],['visual','⊞']].map(([v, icon]) => (
                    <button key={v} className={`${styles.viewBtn}${deckView === v ? ' '+styles.viewBtnActive : ''}`}
                      onClick={() => setDeckView(v)} title={v}>
                      {icon}
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
                  ≡ Grouped
                </button>
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
                ownedQty:   ownedMap.get(dc.scryfall_id) ?? 0,
                ownedAlt:   ownedNameMap.get((dc.name || '').toLowerCase()) ?? 0,
                ownedInDeck: inOtherDeckSet.has(dc.scryfall_id),
                onChangeQty: changeQty,
                onRemove:    removeCardFromDeck,
                onMouseEnter: () => setHoverImg(toLargeImg(dc.image_uri)),
                onMouseLeave: () => setHoverImg(null),
                onMouseMove:  e => setHoverPos({ x: e.clientX, y: e.clientY }),
                onPickVersion: setVersionPickCard,
                onToggleFoil:  toggleFoil,
                onSetCommander: setCardAsCommander,
                isEDH,
              })

              const renderCard = (dc) => {
                if (deckView === 'visual') return (
                  <div key={dc.id} className={`${styles.visualCard}${dc.is_commander ? ' '+styles.isCommander : ''}`}
                    onMouseEnter={() => setHoverImg(toLargeImg(dc.image_uri))}
                    onMouseLeave={() => setHoverImg(null)}
                    onMouseMove={e => setHoverPos({ x: e.clientX, y: e.clientY })}>
                    {dc.image_uri
                      ? <img src={dc.image_uri} alt={dc.name} className={styles.visualCardImg} loading="lazy" />
                      : <div className={styles.visualCardPlaceholder}>{dc.name}</div>}
                    {dc.qty > 1 && <span className={styles.visualCardQty}>×{dc.qty}</span>}
                    {dc.foil && <span className={styles.visualCardFoil} title="Foil">✦</span>}
                  </div>
                )
                if (deckView === 'compact') return (
                  <div key={dc.id} className={`${styles.compactRow}${dc.is_commander ? ' '+styles.isCommander : ''}`}>
                    <span className={styles.compactQty}>{dc.qty}</span>
                    {dc.foil && <span className={styles.foilBadge} title="Foil">✦</span>}
                    <span className={styles.compactName}
                      onMouseEnter={() => setHoverImg(toLargeImg(dc.image_uri))}
                      onMouseLeave={() => setHoverImg(null)}
                      onMouseMove={e => setHoverPos({ x: e.clientX, y: e.clientY })}>
                      {dc.name}
                    </span>
                    <EditMenu dc={dc} isEDH={isEDH} onSetCommander={setCardAsCommander} onToggleFoil={toggleFoil} onPickVersion={setVersionPickCard} />
                    <div className={styles.qtyControls}>
                      <button className={styles.qtyBtn} onClick={() => changeQty(dc.id, -1)}>−</button>
                      <span className={styles.qtyVal}>{dc.qty}</span>
                      <button className={styles.qtyBtn} onClick={() => changeQty(dc.id, +1)}>+</button>
                    </div>
                    <button className={styles.removeBtn} onClick={() => removeCardFromDeck(dc.id)}>✕</button>
                  </div>
                )
                // list view
                return <DeckCardRow key={dc.id} {...deckRowProps(dc)} />
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
                        ? <div className={styles.visualGrid}>{cards.map(dc => renderCard(dc))}</div>
                        : cards.map(dc => renderCard(dc))
                      )}
                    </div>
                  )
                })
              }

              // Flat (no grouping)
              return deckView === 'visual'
                ? <div className={styles.visualGrid}>{sortedDeckCards.map(dc => renderCard(dc))}</div>
                : sortedDeckCards.map(dc => renderCard(dc))
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
                        <ComboResultCard key={i} combo={c} highlight deckCardNames={deckCards.map(dc => dc.name)} deckImages={deckImagesMap} />
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
                        <ComboResultCard key={i} combo={c} highlight={false} deckCardNames={deckCards.map(dc => dc.name)} deckImages={deckImagesMap} />
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
              {(isCollectionDeck || deckMeta.linked_deck_id) && (
                <button className={styles.convertBtn} onClick={() => setShowSync(true)} disabled={syncRunning}>
                  {syncRunning ? 'Syncing…' : 'Sync →'}
                </button>
              )}
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

      {/* Version picker modal */}
      {versionPickCard && (
        <VersionPickerModal
          dc={versionPickCard}
          ownedMap={ownedMap}
          onSelect={p => updateCardVersion(versionPickCard.id, p)}
          onClose={() => setVersionPickCard(null)}
        />
      )}

      {/* Floating card preview */}
      <FloatingPreview imageUri={hoverImg} x={hoverPos.x} y={hoverPos.y} />

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
              {[['url', '🔗 URL'], ['text', '📋 Paste List']].map(([id, label]) => (
                <button key={id} onClick={() => setImportTab(id)}
                  style={{ flex: 1, padding: '7px 0', background: 'none', border: 'none', borderBottom: importTab === id ? '2px solid var(--gold)' : '2px solid transparent', color: importTab === id ? 'var(--gold)' : 'var(--text-dim)', fontSize: '0.83rem', cursor: 'pointer', marginBottom: -1 }}>
                  {label}
                </button>
              ))}
            </div>

            {importTab === 'url' ? (
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
            ) : (
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

            {importError && <p style={{ color: '#e07070', fontSize: '0.82rem', margin: 0 }}>{importError}</p>}
            {importDone  && <p style={{ color: 'var(--green)', fontSize: '0.82rem', margin: 0 }}>✓ {importDone}</p>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowImport(false)}
                style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)', padding: '7px 14px', fontSize: '0.83rem', cursor: 'pointer' }}>
                {importDone ? 'Close' : 'Cancel'}
              </button>
              {!importDone && (
                <button onClick={handleImport} disabled={importing || (importTab === 'url' ? !importUrl.trim() : !importText.trim())}
                  style={{ background: 'rgba(201,168,76,0.15)', border: '1px solid rgba(201,168,76,0.4)', borderRadius: 4, color: 'var(--gold)', padding: '7px 18px', fontSize: '0.83rem', cursor: 'pointer', opacity: importing ? 0.6 : 1 }}>
                  {importing ? 'Importing…' : 'Import'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
