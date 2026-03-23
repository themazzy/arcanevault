import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import {
  FORMATS, TYPE_GROUPS, classifyCardType,
  parseDeckMeta, serializeDeckMeta, getCardImageUri, nameToSlug,
  searchCards, searchCommanders, fetchCardsByNames,
  fetchEdhrecCommander, fetchRecommander, makeDebouncer,
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
function RecRow({ rec, imageUri, ownedQty, onAdd }) {
  const synergyPct = Math.round((rec.synergy ?? 0) * 100)
  return (
    <div className={styles.recRow}>
      {imageUri
        ? <img className={styles.recThumb} src={imageUri} alt="" loading="lazy" />
        : <div className={styles.recThumbPlaceholder} />
      }
      <div className={styles.recInfo}>
        <div className={styles.recName}>{rec.name}</div>
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

// ── Create Collection Deck modal ──────────────────────────────────────────────
function CreateCollectionModal({ deckCards, ownedMap, ownedNameMap, inOtherDeckSet, onConfirm, onClose }) {
  const [skipBasicLands, setSkipBasicLands] = useState(true)
  const [skipInOtherDecks, setSkipInOtherDecks] = useState(false)

  const eligible = deckCards.filter(dc => {
    if (skipBasicLands && BASIC_LANDS.has(dc.name)) return false
    const hasExact = (ownedMap.get(dc.scryfall_id) ?? 0) > 0
    const hasAny   = (ownedNameMap.get((dc.name || '').toLowerCase()) ?? 0) > 0
    if (!hasExact && !hasAny) return false
    if (skipInOtherDecks && inOtherDeckSet.has(dc.scryfall_id)) return false
    return true
  })

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:700, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background:'var(--bg-card,#1e1e1e)', border:'1px solid var(--border)', borderRadius:8, padding:24, width:440, maxWidth:'95vw', display:'flex', flexDirection:'column', gap:16 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>Create Collection Deck</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.1rem', cursor:'pointer' }}>✕</button>
        </div>
        <div style={{ fontSize:'0.82rem', color:'var(--text-dim)', lineHeight:1.6 }}>
          This links your owned cards to a collection deck so you can track them in Decks.
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          {[
            [skipBasicLands, setSkipBasicLands, 'Skip basic lands', 'Island, Plains, Forest, Mountain, Swamp'],
            [skipInOtherDecks, setSkipInOtherDecks, 'Skip cards already in another deck', 'Keeps those decks intact'],
          ].map(([val, set, label, sub]) => (
            <label key={label} style={{ display:'flex', alignItems:'flex-start', gap:10, cursor:'pointer' }}>
              <input type="checkbox" checked={val} onChange={e => set(e.target.checked)}
                style={{ marginTop:3, accentColor:'var(--gold)', width:14, height:14, flexShrink:0 }} />
              <span>
                <div style={{ fontSize:'0.85rem', color:'var(--text)' }}>{label}</div>
                <div style={{ fontSize:'0.75rem', color:'var(--text-faint)' }}>{sub}</div>
              </span>
            </label>
          ))}
        </div>
        <div style={{ background:'rgba(255,255,255,0.04)', borderRadius:4, padding:'10px 14px', fontSize:'0.82rem', color:'var(--text-dim)' }}>
          <strong style={{ color:'var(--gold)' }}>{eligible.length}</strong> card{eligible.length !== 1 ? 's' : ''} will be linked
          {skipBasicLands && deckCards.some(dc => BASIC_LANDS.has(dc.name)) && (
            <span style={{ color:'var(--text-faint)' }}> (basic lands excluded)</span>
          )}
        </div>
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:'pointer' }}>Cancel</button>
          <button onClick={() => onConfirm({ skipBasicLands, skipInOtherDecks })}
            disabled={eligible.length === 0}
            style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green)', fontSize:'0.83rem', cursor:'pointer', opacity: eligible.length === 0 ? 0.45 : 1 }}>
            Create ({eligible.length})
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
  const [typeFilter,    setTypeFilter]    = useState(null)
  const [cmcMin,        setCmcMin]        = useState('')
  const [cmcMax,        setCmcMax]        = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchHasMore, setSearchHasMore] = useState(false)
  const [searchPage,    setSearchPage]    = useState(1)

  // Recommendations
  const [recs,         setRecs]         = useState([])
  const [recImages,    setRecImages]    = useState({}) // name -> image_uri
  const [recsLoading,  setRecsLoading]  = useState(false)
  const [recsError,    setRecsError]    = useState(null)
  const [activeCat,    setActiveCat]    = useState('all')

  // Collection
  const [ownedMap,       setOwnedMap]       = useState(new Map())
  const [ownedNameMap,   setOwnedNameMap]   = useState(new Map())
  const [inOtherDeckSet, setInOtherDeckSet] = useState(new Set())
  // Version picker
  const [versionPickCard, setVersionPickCard] = useState(null)
  // Create collection deck modal
  const [showCreateDeck, setShowCreateDeck] = useState(false)
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
  const [deckSort,    setDeckSort]    = useState('name')   // 'name' | 'cmc' | 'color' | 'type'
  const [groupByType, setGroupByType] = useState(true)

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

  const [converting,  setConverting]  = useState(false)
  const [convertDone, setConvertDone] = useState(false)
  const [convertMsg,  setConvertMsg]  = useState('')

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
        setDeck(folder)
        setDeckMeta(meta)
        setDeckName(folder.name)

        // Load deck cards from Supabase
        const { data: cards } = await sb.from('deck_cards').select('*').eq('deck_id', deckId).order('is_commander', { ascending: false })
        let cardList = cards || []

        // If this is a collection deck (type='deck') with no deck_cards yet,
        // import from folder_cards (IDB) so it's viewable/editable in the builder
        if (cardList.length === 0 && folder.type === 'deck') {
          const fcRows = await getLocalFolderCards(deckId)
          if (fcRows?.length) {
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
            if (newRows.length) cardList = newRows
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

  const recCategories = useMemo(() => {
    if (!recs?.categories) return []
    return [{ header: 'All', tag: 'all' }, ...recs.categories.map(c => ({ header: c.header, tag: c.tag }))]
  }, [recs])

  const filteredRecs = useMemo(() => {
    if (!recs?.categories) return []
    if (activeCat === 'all') return recs.categories.flatMap(c => c.cards)
    return recs.categories.find(c => c.tag === activeCat)?.cards ?? []
  }, [recs, activeCat])

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

    // Remove any existing commander
    const existingCmd = deckCards.find(dc => dc.is_commander)
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

    setDeckCards(prev => [cmdRow, ...prev.filter(dc => !dc.is_commander)])
    await sb.from('deck_cards').insert(cmdRow)
    putDeckCards([cmdRow]).catch(() => {})

    // Save meta
    await saveMeta(newMeta)

    // Load recommendations
    if (isEDH || FORMATS.find(f => f.id === newMeta.format)?.isEDH) {
      loadRecs(sfCard.name)
    }
  }

  // ── Card search ───────────────────────────────────────────────────────────
  const doSearch = useCallback(async (q, page = 1) => {
    setSearchLoading(true)
    setSearchPage(page)
    const { cards, hasMore } = await searchCards({
      query: q,
      format: deckMeta.format,
      colorIdentity: isEDH && colorIdentity.length ? colorIdentity : undefined,
      cardType: typeFilter || undefined,
      cmcMin: cmcMin !== '' ? Number(cmcMin) : undefined,
      cmcMax: cmcMax !== '' ? Number(cmcMax) : undefined,
      page,
    })
    if (page === 1) setSearchResults(cards)
    else setSearchResults(prev => [...prev, ...cards])
    setSearchHasMore(hasMore)
    setSearchLoading(false)
  }, [deckMeta.format, isEDH, colorIdentity, typeFilter, cmcMin, cmcMax])

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
    const alreadyHasCmd = commanderCards.length > 0
    const updated = { ...dc, is_commander: true }
    setDeckCards(prev => prev.map(c => c.id === dc.id ? updated : c))
    await sb.from('deck_cards').update({ is_commander: true }).eq('id', dc.id)
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
    await saveMeta(newMeta)
    if (!alreadyHasCmd && isEDH) loadRecs(dc.name)
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
    setActiveCat('all')

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

  async function convertToDeck({ skipBasicLands = false, skipInOtherDecks = false } = {}) {
    if (converting) return
    setConverting(true)
    setShowCreateDeck(false)
    try {
      const { data: collCards } = await sb.from('cards').select('id, scryfall_id, name').eq('user_id', user.id)
      const sfIdToCardId = new Map()
      const nameToCardId = new Map()
      for (const c of collCards || []) {
        if (c.scryfall_id) sfIdToCardId.set(c.scryfall_id, c.id)
        const n = (c.name || '').toLowerCase()
        if (n && !nameToCardId.has(n)) nameToCardId.set(n, c.id)
      }

      const inserts = []
      for (const dc of deckCards) {
        if (dc.is_commander) continue
        if (skipBasicLands && BASIC_LANDS.has(dc.name)) continue
        if (skipInOtherDecks && inOtherDeckSet.has(dc.scryfall_id)) continue
        const cardId = sfIdToCardId.get(dc.scryfall_id) ?? nameToCardId.get((dc.name || '').toLowerCase())
        if (!cardId) continue
        inserts.push({ id: crypto.randomUUID(), folder_id: deckId, card_id: cardId, qty: dc.qty, foil: dc.foil })
      }

      if (inserts.length > 0) await sb.from('folder_cards').insert(inserts)
      await sb.from('folders').update({ type: 'deck' }).eq('id', deckId)
      setConvertMsg(`${inserts.length} card${inserts.length !== 1 ? 's' : ''} linked from your collection`)
      setConvertDone(true)
    } catch (err) {
      console.error('[Convert]', err)
      setConvertMsg('Conversion failed. Try again.')
    }
    setConverting(false)
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
      {/* ── LEFT PANEL ─────────────────────────────────────────── */}
      <div className={styles.left}>
        {/* Mobile panel toggle */}
        <button
          className={styles.mobilePanelToggle}
          onClick={() => setShowRight(v => !v)}
        >
          {showRight ? '← Search' : 'Deck →'}
        </button>
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

            <div className={styles.typeFilters}>
              {['Creature','Instant','Sorcery','Artifact','Enchantment','Planeswalker','Land'].map(t => (
                <button
                  key={t}
                  className={`${styles.typePill}${typeFilter === t ? ' ' + styles.typePillActive : ''}`}
                  onClick={() => { setTypeFilter(typeFilter === t ? null : t); searchDebounce.current(() => doSearch(searchQuery, 1)) }}
                >
                  {t}
                </button>
              ))}
            </div>

            <div className={styles.cmcRow}>
              CMC
              <input className={styles.cmcInput} type="number" min="0" max="20" value={cmcMin} onChange={e => setCmcMin(e.target.value)} placeholder="min" />
              –
              <input className={styles.cmcInput} type="number" min="0" max="20" value={cmcMax} onChange={e => setCmcMax(e.target.value)} placeholder="max" />
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
                  <>
                    <div className={styles.recsCategoryBar}>
                      {recCategories.map(c => (
                        <button
                          key={c.tag}
                          className={`${styles.catPill}${activeCat === c.tag ? ' ' + styles.catPillActive : ''}`}
                          onClick={() => setActiveCat(c.tag)}
                        >
                          {c.header}
                        </button>
                      ))}
                    </div>
                    <div className={styles.recsList}>
                      {filteredRecs.map(rec => (
                        <RecRow
                          key={rec.name}
                          rec={rec}
                          imageUri={recImages[rec.name] || null}
                          ownedQty={ownedMap.get(rec.slug) ?? 0}
                          onAdd={addCardToDeck}
                        />
                      ))}
                    </div>
                  </>
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
          <Link to="/builder" style={{ fontSize: '0.8rem', color: 'var(--text-faint)', textDecoration: 'none' }}>
            ← Decks
          </Link>
        </div>

        {/* Commander art display — supports partners */}
        {commanderCards.length > 0 && (
          <div className={`${styles.cmdArt}${commanderCards.length > 1 ? ' ' + styles.cmdArtDuo : ''}`}>
            {commanderCards.map((card, i) => (
              <div key={card.id} className={styles.cmdArtPane}
                onClick={() => unsetCommander(card.id)} title="Click to remove commander status">
                {card.image_uri
                  ? <img className={styles.cmdArtImg} src={card.image_uri} alt={card.name} />
                  : <div className={styles.cmdArtImgPlaceholder} />
                }
                <div className={styles.cmdArtOverlay}>
                  <span className={styles.cmdArtName}>{card.name}</span>
                  {i === 0 && colorIdentity.length > 0 && (
                    <div className={styles.cmdColorPips}>
                      {colorIdentity.map(c => <ColorPip key={c} color={c} />)}
                    </div>
                  )}
                  {i === 1 && <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)' }}>Partner</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Right panel tab bar */}
        <div className={styles.tabBar}>
          {[
            { id: 'deck',   label: 'Deck',   badge: `${totalCards}/${deckSize}`, over: totalCards > deckSize },
            !isCollectionDeck && { id: 'stats',  label: 'Stats',  badge: null },
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
                  return (
                    <div key={group} className={styles.deckGroup}>
                      <div className={styles.groupHeader}>
                        <span className={styles.groupArrow}>▾</span>
                        <span className={styles.groupName}>{group}</span>
                        <span className={styles.groupCount}>{groupQty}</span>
                      </div>
                      {deckView === 'visual'
                        ? <div className={styles.visualGrid}>{cards.map(dc => renderCard(dc))}</div>
                        : cards.map(dc => renderCard(dc))
                      }
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
          {convertDone ? (
            <>
              <div className={styles.convertDone}>✓ {convertMsg}</div>
              <Link to="/decks" style={{ fontSize: '0.82rem', color: 'var(--gold)', textDecoration: 'none' }}>
                View in Decks →
              </Link>
            </>
          ) : (
            <>
              <div className={styles.ownProgress}>
                <div className={styles.ownBar}>
                  <div
                    className={styles.ownFill}
                    style={{ width: deckCards.length ? `${(ownedCount / deckCards.length) * 100}%` : '0%' }}
                  />
                </div>
                <div className={styles.ownLabel}>
                  You own {ownedCount}/{deckCards.length} cards
                  {ownedCount > 0 && ` (${Math.round((ownedCount / deckCards.length) * 100)}%)`}
                </div>
              </div>
              {!isCollectionDeck && (
                <button className={styles.convertBtn} onClick={() => setShowCreateDeck(true)} disabled={ownedCount === 0}>
                  Create Collection Deck
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Create collection deck modal */}
      {showCreateDeck && (
        <CreateCollectionModal
          deckCards={deckCards}
          ownedMap={ownedMap}
          ownedNameMap={ownedNameMap}
          inOtherDeckSet={inOtherDeckSet}
          onConfirm={convertToDeck}
          onClose={() => setShowCreateDeck(false)}
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
