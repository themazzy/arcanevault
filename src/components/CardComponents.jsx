import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { getImageUri, getPrice, formatPrice, getPriceSource } from '../lib/scryfall'
import { Modal, Badge } from './UI'
import styles from './CardComponents.module.css'
import { FolderTypeIcon } from './Icons'
import { sb } from '../lib/supabase'
import { putCards } from '../lib/db'
import { useLongPress } from '../hooks/useLongPress'

const fmt = (v, currency = 'EUR') => {
  if (v == null || isNaN(v)) return '—'
  return currency === 'EUR' ? `€${v.toFixed(2)}` : `$${v.toFixed(2)}`
}

// Build full-size Scryfall image URL directly from scryfall_id
function scryfallLargeUrl(scryfallId) {
  if (!scryfallId) return null
  const id = scryfallId.toLowerCase()
  return `https://cards.scryfall.io/large/front/${id[0]}/${id[1]}/${id}.jpg`
}

// ── CardGrid ──────────────────────────────────────────────────────────────────
function CardItem({ card, sfCard, selectMode, isSelected, onSelect, onToggleSelect, onEnterSelectMode, loading }) {
  const img = getImageUri(sfCard, 'normal')
  const scryfallPrice = getPrice(sfCard, card.foil)
  const price = scryfallPrice ?? (parseFloat(card.purchase_price) || null)
  const isBuyFallback = scryfallPrice == null && price != null
  const priceClass = price == null ? styles.priceNa : isBuyFallback ? styles.priceFallback : ''

  const longPress = useLongPress(() => {
    if (!selectMode) onEnterSelectMode?.()
  }, { delay: 500 })

  const handleClick = () => {
    if (selectMode) onToggleSelect?.(card.id)
    else onSelect?.(card)
  }

  return (
    <div
      key={card.id || card._localId}
      className={`${styles.cardWrap}${isSelected ? ' ' + styles.cardSelected : ''}`}
      onClick={handleClick}
      {...longPress}
    >
      {selectMode && (
        <div className={`${styles.checkbox}${isSelected ? ' ' + styles.checkboxChecked : ''}`}>
          {isSelected && '✓'}
        </div>
      )}
      <div className={`${styles.imgContainer}${isSelected ? ' ' + styles.imgSelected : ''}`}>
        {img
          ? <img className={styles.img} src={img} alt={card.name} loading="lazy" />
          : <div className={styles.imgPlaceholder}>{card.name}</div>
        }
        {card.qty > 1 && <div className={styles.qty}>×{card.qty}</div>}
        {card.foil && <Badge variant="foil">Foil</Badge>}
      </div>
      <div className={styles.cardInfo}>
        <div className={styles.cardName}>{card.name}</div>
        <div className={styles.cardMeta}>
          <span className={styles.setCode}>{(card.set_code || '').toUpperCase()}</span>
          <span className={`${styles.price} ${priceClass}`}>
            {price != null ? fmt(price) : loading ? '…' : '—'}
          </span>
        </div>
      </div>
    </div>
  )
}

export function CardGrid({ cards, sfMap, loading, onSelect, selectMode, selected, onToggleSelect, onEnterSelectMode }) {
  return (
    <div className={styles.grid}>
      {cards.map(card => {
        const sfCard = sfMap?.[`${card.set_code}-${card.collector_number}`]
        const isSelected = selectMode && selected?.has(card.id)
        return (
          <CardItem
            key={card.id || card._localId}
            card={card}
            sfCard={sfCard}
            selectMode={selectMode}
            isSelected={isSelected}
            onSelect={onSelect}
            onToggleSelect={onToggleSelect}
            onEnterSelectMode={onEnterSelectMode}
            loading={loading}
          />
        )
      })}
    </div>
  )
}

// ── BulkActionBar ─────────────────────────────────────────────────────────────
export function BulkActionBar({ selected, total, onSelectAll, onDeselectAll, onDelete, onMoveToFolder, folders, onCreateFolder, selectedQty }) {
  const [showMove, setShowMove] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createType, setCreateType] = useState('binder')
  const [createName, setCreateName] = useState('')
  const [createSaving, setCreateSaving] = useState(false)
  const count = selected.size

  const handleCreate = async () => {
    if (!createName.trim()) return
    setCreateSaving(true)
    try {
      await onCreateFolder?.(createType, createName.trim())
      setCreating(false)
      setCreateName('')
      setShowMove(false)
    } finally {
      setCreateSaving(false)
    }
  }

  return (
    <div className={styles.bulkBar}>
      <div className={styles.bulkLeft}>
        <span className={styles.bulkCount}>{count} {count === 1 ? 'card' : 'cards'}{selectedQty != null && selectedQty !== count ? ` (${selectedQty} copies)` : ''} selected</span>
        <button className={styles.bulkLink} onClick={onSelectAll}>Select all {total}</button>
        <button className={styles.bulkLink} onClick={onDeselectAll}>Deselect all</button>
      </div>
      <div className={styles.bulkActions}>
        <div className={styles.moveWrap}>
          <button className={styles.bulkBtn} onClick={() => { setShowMove(v => !v); setCreating(false) }}>Move to… ▾</button>
          {showMove && (
            <div className={styles.moveDropdown}>
              {/* Create new option */}
              {!creating ? (
                <button className={styles.moveCreate} onClick={() => setCreating(true)}>
                  ＋ Create New Binder/Deck
                </button>
              ) : (
                <div className={styles.moveCreateForm}>
                  <select
                    className={styles.moveCreateSelect}
                    value={createType}
                    onChange={e => setCreateType(e.target.value)}
                  >
                    <option value="binder">Binder</option>
                    <option value="deck">Deck</option>
                    <option value="list">Wishlist</option>
                  </select>
                  <input
                    autoFocus
                    className={styles.moveCreateInput}
                    value={createName}
                    onChange={e => setCreateName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
                    placeholder="Name…"
                  />
                  <div className={styles.moveCreateActions}>
                    <button className={styles.moveCreateSave} onClick={handleCreate} disabled={createSaving || !createName.trim()}>
                      {createSaving ? '…' : 'Create & Move'}
                    </button>
                    <button className={styles.moveCreateCancel} onClick={() => { setCreating(false); setCreateName('') }}>✕</button>
                  </div>
                </div>
              )}
              <div className={styles.moveDivider} />
              {['binder', 'deck', 'list'].map(type => {
                const typeFolders = folders.filter(f => f.type === type)
                if (!typeFolders.length) return null
                return (
                  <div key={type}>
                    <div className={styles.moveGroup}>{type === 'list' ? 'Wishlists' : type.charAt(0).toUpperCase() + type.slice(1) + 's'}</div>
                    {typeFolders.map(f => (
                      <button key={f.id} className={styles.moveItem}
                        onClick={() => { onMoveToFolder(f); setShowMove(false) }}>
                        {f.name}
                      </button>
                    ))}
                  </div>
                )
              })}
              {!folders.length && !creating && <div className={styles.moveEmpty}>No folders yet</div>}
            </div>
          )}
        </div>
        <button className={`${styles.bulkBtn} ${styles.bulkDelete}`} onClick={onDelete}>
          Delete {count}
        </button>
      </div>
    </div>
  )
}

// ── CardDetail ────────────────────────────────────────────────────────────────

// ── Scryfall symbol SVGs ──────────────────────────────────────────────────────
// Scryfall hosts SVGs for every symbol at cards.scryfall.io/card-symbols/{SYM}.svg
// e.g. T.svg, W.svg, 2.svg, X.svg, S.svg (snow), E.svg (energy), PW.svg etc.

function symbolUrl(sym) {
  // Normalize: {W/U} → WU, {2/W} → 2W, {T} → T, etc.
  const s = sym.replace(/[{}]/g, '').replace('/', '')
  return `https://svgs.scryfall.io/card-symbols/${s}.svg`
}

// Single mana/tap symbol rendered as an inline SVG image
function Sym({ sym, size = 16 }) {
  const s = sym.replace(/[{}]/g, '')
  return (
    <img
      src={symbolUrl(sym)}
      alt={`{${s}}`}
      title={`{${s}}`}
      width={size}
      height={size}
      style={{ display: 'inline', verticalAlign: 'middle', marginBottom: 1, flexShrink: 0 }}
      onError={e => {
        // Fall back to text if SVG fails to load
        e.target.style.display = 'none'
        e.target.insertAdjacentText('afterend', `{${s}}`)
      }}
    />
  )
}

// Parse a string containing {SYMBOL} tokens and return React nodes
function parseSymbols(text, symSize = 15) {
  if (!text) return null
  const parts = text.split(/(\{[^}]+\})/)
  return parts.map((part, i) =>
    /^\{[^}]+\}$/.test(part)
      ? <Sym key={i} sym={part} size={symSize} />
      : part
  )
}

// Mana cost row — e.g. {2}{W}{U}
function ManaSymbols({ cost, size = 18 }) {
  if (!cost) return null
  // Handle double-faced separator ' // '
  const sides = cost.split(' // ')
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
      {sides.map((side, si) => (
        <span key={si} style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
          {si > 0 && <span style={{ color: 'var(--text-faint)', margin: '0 4px' }}>//</span>}
          {(side.match(/\{[^}]+\}/g) || []).map((sym, i) => (
            <Sym key={i} sym={sym} size={size} />
          ))}
        </span>
      ))}
    </span>
  )
}

// Oracle text — renders symbols inline, italicises reminder text in (parens)
function OracleText({ text }) {
  if (!text) return <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>—</span>
  const lines = text.split('\n')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {lines.map((line, i) => {
        // Split on (reminder text) and {symbols}
        const parts = line.split(/(\([^)]+\)|\{[^}]+\})/)
        return (
          <p key={i} style={{ margin: 0, lineHeight: 1.6, fontSize: '0.88rem', color: 'var(--text)' }}>
            {parts.map((part, j) => {
              if (/^\{[^}]+\}$/.test(part)) return <Sym key={j} sym={part} size={14} />
              if (part.startsWith('(') && part.endsWith(')')) return <em key={j} style={{ color: 'var(--text-faint)' }}>{part}</em>
              return <span key={j}>{part}</span>
            })}
          </p>
        )
      })}
    </div>
  )
}

const LEGALITY_FORMATS_ORDERED = [
  ['standard','Standard'], ['pioneer','Pioneer'], ['modern','Modern'],
  ['legacy','Legacy'],     ['vintage','Vintage'], ['commander','Commander'],
  ['oathbreaker','Oathbreaker'], ['pauper','Pauper'], ['paupercommander','Pauper EDH'],
  ['explorer','Explorer'], ['historic','Historic'], ['timeless','Timeless'],
  ['alchemy','Alchemy'],   ['brawl','Brawl'],      ['standardbrawl','Standard Brawl'],
  ['duel','Duel Commander'], ['premodern','Premodern'], ['penny','Penny Dreadful'],
]

const CONDITION_LABELS = {
  near_mint: 'Near Mint', lightly_played: 'Lightly Played',
  moderately_played: 'Moderately Played', heavily_played: 'Heavily Played', damaged: 'Damaged',
}

const LANG_NAMES_FULL = {
  en:'English', de:'German', fr:'French', it:'Italian', es:'Spanish', pt:'Portuguese',
  ja:'Japanese', ko:'Korean', ru:'Russian', zhs:'Simplified Chinese', zht:'Traditional Chinese',
  he:'Hebrew', la:'Latin', grc:'Ancient Greek', ar:'Arabic', sa:'Sanskrit', ph:'Phyrexian',
}

// Fetch full card data from Scryfall — by scryfall_id if available, else by set+collector_number
const _fullCardCache = {}
async function fetchFullCard(scryfallId, setCode, collectorNumber) {
  const cacheKey = scryfallId || `${setCode}-${collectorNumber}`
  if (!cacheKey) return null
  if (_fullCardCache[cacheKey]) return _fullCardCache[cacheKey]
  try {
    const url = scryfallId
      ? `https://api.scryfall.com/cards/${scryfallId}`
      : `https://api.scryfall.com/cards/${setCode}/${collectorNumber}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    _fullCardCache[cacheKey] = data
    if (data.id) _fullCardCache[data.id] = data  // also cache by scryfall id
    return data
  } catch { return null }
}

async function fetchRulings(scryfallId, setCode, collectorNumber) {
  try {
    const url = scryfallId
      ? `https://api.scryfall.com/cards/${scryfallId}/rulings`
      : `https://api.scryfall.com/cards/${setCode}/${collectorNumber}/rulings`
    if (!scryfallId && (!setCode || !collectorNumber)) return []
    const res = await fetch(url)
    if (!res.ok) return []
    return (await res.json()).data || []
  } catch { return [] }
}

export function CardDetail({ card, sfCard, onClose, onEdit, onDelete, folders, allFolders = [], priceSource = 'cardmarket_trend', onSave }) {
  if (!card) return null

  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('collection')

  // Prevent body scroll while detail panel is open
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])
  const [fullCard, setFullCard]   = useState(null)
  const [rulings, setRulings]     = useState(null) // null = not loaded yet
  const [loadingFull, setLoadingFull] = useState(false)

  // Edit state
  const [editQty,        setEditQty]        = useState(card.qty)
  const [editFoil,       setEditFoil]       = useState(card.foil)
  const [editCondition,  setEditCondition]  = useState(card.condition || 'near_mint')
  const [editBuyPrice,   setEditBuyPrice]   = useState(parseFloat(card.purchase_price) || 0)
  const [buyPriceEdit,   setBuyPriceEdit]   = useState(false)
  const [buyPriceInput,  setBuyPriceInput]  = useState('')
  const [moveFolderText, setMoveFolderText] = useState('')
  const [saving,         setSaving]         = useState(false)
  const [saved,          setSaved]          = useState(false)
  const [saveError,      setSaveError]      = useState('')

  const cachedImg = getImageUri(sfCard, 'normal')
  const fullImg   = scryfallLargeUrl(card.scryfall_id)
  const [img, setImg]             = useState(cachedImg)
  const [imgLoaded, setImgLoaded] = useState(false)

  // Upgrade to large image
  useEffect(() => {
    setImg(cachedImg)
    setImgLoaded(false)
    if (!fullImg) return
    const image = new Image()
    image.onload = () => { setImg(fullImg); setImgLoaded(true) }
    image.src = fullImg
  }, [card.scryfall_id])

  // Fetch full card data on mount — by scryfall_id or fallback to set+collector_number
  useEffect(() => {
    setFullCard(null); setRulings(null)
    setLoadingFull(true)
    fetchFullCard(card.scryfall_id, card.set_code, card.collector_number).then(data => {
      setFullCard(data)
      setLoadingFull(false)
    })
  }, [card.scryfall_id, card.set_code, card.collector_number])

  // Lazy-load rulings only when that tab is opened
  useEffect(() => {
    if (activeTab !== 'rulings' || rulings !== null) return
    fetchRulings(card.scryfall_id, card.set_code, card.collector_number).then(setRulings)
  }, [activeTab, card.scryfall_id, card.set_code, card.collector_number])

  // Merge cached + full card data
  const fc = fullCard || sfCard || {}
  const faces = fc.card_faces || null

  // Use live prices from fullCard once it loads — same API call we already make
  const liveSfCard = fullCard ? { ...sfCard, prices: fullCard.prices } : sfCard
  const pricesAreLive = !!fullCard

  const scryPrice  = getPrice(liveSfCard, card.foil, { price_source: priceSource })
  // Fall back to buy price if no market price available
  const buyPrice   = editBuyPrice > 0 ? editBuyPrice : (parseFloat(card.purchase_price) || null)
  const price      = scryPrice ?? buyPrice
  const priceIsBuyFallback = scryPrice == null && buyPrice != null
  const totalPrice = price != null ? price * card.qty : null
  const fmt = v => formatPrice(v, priceSource)

  const saveBuyPrice = async () => {
    const parsed = parseFloat(buyPriceInput)
    const val = !isNaN(parsed) && parsed >= 0 ? parsed : 0
    setEditBuyPrice(val)
    const { error } = await sb.from('cards').update({ purchase_price: val }).eq('id', card.id)
    if (!error) {
      const updatedCard = { ...card, purchase_price: val }
      await putCards([updatedCard])
      onSave?.(updatedCard)
    }
    setBuyPriceEdit(false)
  }

  const handleSave = async () => {
    setSaving(true); setSaveError('')
    const updates = { qty: editQty, foil: editFoil, condition: editCondition }
    const { error } = await sb.from('cards').update(updates).eq('id', card.id)
    if (error) { setSaveError(error.message); setSaving(false); return }
    const updatedCard = { ...card, ...updates }
    await putCards([updatedCard])
    onSave?.(updatedCard)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    setSaving(false)
  }

  const handleMoveToFolder = async () => {
    const matched = allFolders.find(f => f.name.toLowerCase() === moveFolderText.toLowerCase() || f.id === moveFolderText)
    if (!matched) return
    const qty = editQty || 1
    const { error } = await sb.from('folder_cards')
      .upsert({ folder_id: matched.id, card_id: card.id, qty }, { onConflict: 'folder_id,card_id' })
    if (!error) {
      // Remove from all current folders (move semantics)
      if (folders?.length) {
        await sb.from('folder_cards').delete()
          .eq('card_id', card.id)
          .in('folder_id', folders.filter(f => f.id !== matched.id).map(f => f.id))
      }
      setMoveFolderText('')
      onSave?.(card)
    }
  }

  // P&L: always compare in EUR (purchase_price is stored in EUR)
  // Get EUR price from live data if available, else from sfCard
  const eurLiveSfCard = fullCard ? { ...sfCard, prices: fullCard.prices } : sfCard
  const eurPrice = getPrice(eurLiveSfCard, card.foil, { price_source: 'cardmarket_trend' })
  const pl = eurPrice != null && editBuyPrice > 0
    ? (eurPrice - editBuyPrice) * card.qty
    : null
  const plPct = eurPrice != null && editBuyPrice > 0
    ? ((eurPrice - editBuyPrice) / editBuyPrice) * 100
    : null

  const tabs = [
    { id: 'collection', label: 'Edit' },
    { id: 'overview',   label: 'Overview' },
    { id: 'rules',      label: 'Rules Text' },
    { id: 'legality',   label: 'Legality' },
    { id: 'prices',     label: 'Prices' },
    { id: 'rulings',    label: 'Rulings' },
  ]

  return (
    <Modal onClose={onClose} wide>
      <div className={styles.detail}>
        {/* Left — card image */}
        <div className={styles.detailImg} style={{ position: 'relative' }}>
          {img
            ? <img src={img} alt={card.name} style={{ transition: 'opacity 0.3s', opacity: imgLoaded || img === cachedImg ? 1 : 0.7 }} />
            : <div className={styles.imgPlaceholder}>{card.name}</div>
          }
          {card.foil && <div style={{ position: 'absolute', top: 8, left: 8 }}><Badge variant="foil">Foil</Badge></div>}
        </div>

        {/* Right — tabbed content */}
        <div className={styles.detailBody}>
          {/* Header */}
          <div className={styles.detailName}>{fc.name || card.name}</div>
          {fc.mana_cost && (
            <div style={{ marginBottom: 4 }}>
              <ManaSymbols cost={faces ? faces.map(f => f.mana_cost).filter(Boolean).join(' // ') : fc.mana_cost} />
            </div>
          )}
          <div className={styles.detailSet}>
            {fc.set_name || sfCard?.set_name || (card.set_code || '').toUpperCase()} · #{card.collector_number}
            {fc.artist && <span style={{ marginLeft: 8, opacity: 0.6 }}>· {fc.artist}</span>}
          </div>

          {/* Live price banner — shown once fullCard loads */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '10px 0 4px', flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: '1.4rem', color: 'var(--green)' }}>
              {price != null ? fmt(price) : '—'}
              {card.qty > 1 && price != null && (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)', marginLeft: 6 }}>
                  × {card.qty} = {fmt(totalPrice)}
                </span>
              )}
            </span>
            {priceIsBuyFallback
              ? <span style={{ fontSize: '0.68rem', color: 'var(--gold)', background: 'rgba(201,168,76,0.12)', border: '1px solid rgba(201,168,76,0.25)', borderRadius: 3, padding: '1px 6px' }}>
                  € Buy price
                </span>
              : pricesAreLive
                ? <span style={{ fontSize: '0.68rem', color: '#4a9a5a', background: 'rgba(74,154,90,0.12)', border: '1px solid rgba(74,154,90,0.25)', borderRadius: 3, padding: '1px 6px' }}>
                    ✓ Live price
                  </span>
                : loadingFull
                  ? <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)' }}>fetching live price…</span>
                  : null
            }
          </div>

          {/* Tabs */}
          <div className={styles.detailTabs}>
            {tabs.map(t => (
              <button key={t.id}
                className={`${styles.detailTab}${activeTab === t.id ? ' ' + styles.detailTabActive : ''}`}
                onClick={() => setActiveTab(t.id)}
              >{t.label}</button>
            ))}
          </div>

          {loadingFull && activeTab !== 'collection' && (
            <div style={{ color: 'var(--text-faint)', fontSize: '0.82rem', padding: '8px 0' }}>Loading card data…</div>
          )}

          {/* ── Overview ── */}
          {activeTab === 'overview' && (
            <div className={styles.detailSection}>
              {(fc.type_line || sfCard?.type_line) && (
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Type</span>
                  <span className={styles.detailInfoVal}>{fc.type_line || sfCard?.type_line}</span>
                </div>
              )}
              {fc.rarity && (
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Rarity</span>
                  <span className={styles.detailInfoVal} style={{ textTransform: 'capitalize' }}>{fc.rarity}</span>
                </div>
              )}
              {fc.cmc != null && (
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Mana Value</span>
                  <span className={styles.detailInfoVal}>{fc.cmc}</span>
                </div>
              )}
              {(fc.power != null || faces?.[0]?.power != null) && (
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Power / Toughness</span>
                  <span className={styles.detailInfoVal}>
                    {faces
                      ? faces.map(f => f.power != null ? `${f.power}/${f.toughness}` : null).filter(Boolean).join(' // ')
                      : `${fc.power}/${fc.toughness}`}
                  </span>
                </div>
              )}
              {fc.loyalty && (
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Loyalty</span>
                  <span className={styles.detailInfoVal}>{fc.loyalty}</span>
                </div>
              )}
              {fc.defense && (
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Defense</span>
                  <span className={styles.detailInfoVal}>{fc.defense}</span>
                </div>
              )}
              {fc.color_identity?.length > 0 && (
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Color Identity</span>
                  <span className={styles.detailInfoVal}>{fc.color_identity.join(', ')}</span>
                </div>
              )}
              {fc.keywords?.length > 0 && (
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Keywords</span>
                  <span className={styles.detailInfoVal}>{fc.keywords.join(', ')}</span>
                </div>
              )}
              {fc.artist && (
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Artist</span>
                  <span className={styles.detailInfoVal}>{fc.artist}</span>
                </div>
              )}
              {(fc.scryfall_uri || fc.purchase_uris || fc.related_uris) && (
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Links</span>
                  <span className={styles.detailInfoVal} style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {fc.scryfall_uri && (
                      <a href={fc.scryfall_uri} target="_blank" rel="noreferrer"
                         style={{ color: 'var(--gold-dim)', textDecoration: 'none', fontSize: '0.82rem' }}>
                        Scryfall ↗
                      </a>
                    )}
                    {fc.related_uris?.gatherer && (
                      <a href={fc.related_uris.gatherer} target="_blank" rel="noreferrer"
                         style={{ color: 'var(--text-dim)', textDecoration: 'none', fontSize: '0.82rem' }}>
                        Gatherer ↗
                      </a>
                    )}
                    {fc.purchase_uris?.tcgplayer && (
                      <a href={fc.purchase_uris.tcgplayer} target="_blank" rel="noreferrer"
                         style={{ color: '#5a9fd4', textDecoration: 'none', fontSize: '0.82rem' }}>
                        TCGPlayer ↗
                      </a>
                    )}
                    {fc.purchase_uris?.cardmarket && (
                      <a href={fc.purchase_uris.cardmarket} target="_blank" rel="noreferrer"
                         style={{ color: '#6abf7a', textDecoration: 'none', fontSize: '0.82rem' }}>
                        Cardmarket ↗
                      </a>
                    )}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* ── Rules Text ── */}
          {activeTab === 'rules' && (
            <div className={styles.detailSection}>
              {faces ? (
                faces.map((face, i) => (
                  <div key={i} style={{ marginBottom: i < faces.length - 1 ? 16 : 0 }}>
                    {faces.length > 1 && (
                      <div style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', fontSize: '0.9rem', marginBottom: 6 }}>{face.name}</div>
                    )}
                    {face.type_line && <div style={{ color: 'var(--text-dim)', fontSize: '0.82rem', marginBottom: 6, fontStyle: 'italic' }}>{face.type_line}</div>}
                    <OracleText text={face.oracle_text} />
                    {face.flavor_text && (
                      <p style={{ marginTop: 10, color: 'var(--text-faint)', fontStyle: 'italic', fontSize: '0.84rem', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
                        {face.flavor_text}
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <>
                  <OracleText text={fc.oracle_text} />
                  {fc.flavor_text && (
                    <p style={{ marginTop: 12, color: 'var(--text-faint)', fontStyle: 'italic', fontSize: '0.84rem', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 10 }}>
                      {fc.flavor_text}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Legality ── */}
          {activeTab === 'legality' && (
            <div className={styles.detailSection}>
              <div className={styles.legalityGrid}>
                {LEGALITY_FORMATS_ORDERED.map(([fmt, label]) => {
                  const status = fc.legalities?.[fmt]
                  if (!status) return null
                  const legal = status === 'legal'
                  const restricted = status === 'restricted'
                  const banned = status === 'banned'
                  const color = legal ? '#4a9a5a' : restricted ? '#c9a84c' : '#6a6a7a'
                  const bg    = legal ? 'rgba(74,154,90,0.1)' : restricted ? 'rgba(201,168,76,0.1)' : 'rgba(255,255,255,0.03)'
                  return (
                    <div key={fmt} className={styles.legalityRow} style={{ background: bg, borderColor: color + '44' }}>
                      <span className={styles.legalityFormat}>{label}</span>
                      <span className={styles.legalityStatus} style={{ color }}>
                        {legal ? '✓ Legal' : restricted ? '⚠ Restricted' : banned ? '✕ Banned' : 'Not Legal'}
                      </span>
                    </div>
                  )
                }).filter(Boolean)}
              </div>
            </div>
          )}

          {/* ── Prices ── */}
          {activeTab === 'prices' && (
            <div className={styles.detailSection}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>All prices</span>
                {pricesAreLive && (
                  <span style={{ fontSize: '0.68rem', color: '#4a9a5a', background: 'rgba(74,154,90,0.12)', border: '1px solid rgba(74,154,90,0.25)', borderRadius: 3, padding: '1px 6px' }}>
                    ✓ Fetched live from Scryfall
                  </span>
                )}
              </div>
              <div className={styles.pricesGrid}>
                {[
                  ['EUR', fc.prices?.eur,      false, 'Market (€)'],
                  ['EUR', fc.prices?.eur_foil,  true,  'Foil Market (€)'],
                  ['USD', fc.prices?.usd,      false, 'Market ($)'],
                  ['USD', fc.prices?.usd_foil,  true,  'Foil Market ($)'],
                  ['TIX', fc.prices?.tix,      false, 'MTGO (tix)'],
                ].map(([cur, val, isFoil, label]) => val ? (
                  <div key={label} className={styles.priceDetailBlock}>
                    <div className={styles.priceDetailLabel}>{label}</div>
                    <div className={styles.priceDetailVal} style={{ color: 'var(--green)' }}>
                      {cur === 'EUR' ? '€' : cur === 'USD' ? '$' : ''}{parseFloat(val).toFixed(2)}{cur === 'TIX' ? ' tix' : ''}
                    </div>
                    {card.qty > 1 && cur !== 'TIX' && (
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>
                        × {card.qty} = {cur === 'EUR' ? '€' : '$'}{(parseFloat(val) * card.qty).toFixed(2)}
                      </div>
                    )}
                  </div>
                ) : null)}
              </div>

              {card.purchase_price > 0 && (
                <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                  <div className={styles.detailInfoRow}>
                    <span className={styles.detailInfoLabel}>Purchase Price</span>
                    <span className={styles.detailInfoVal}>€{parseFloat(card.purchase_price).toFixed(2)}{card.qty > 1 && ` × ${card.qty} = €${(parseFloat(card.purchase_price) * card.qty).toFixed(2)}`}</span>
                  </div>
                  {pl != null && (
                    <div className={styles.detailInfoRow}>
                      <span className={styles.detailInfoLabel}>P&L</span>
                      <span className={styles.detailInfoVal} style={{ color: pl >= 0 ? 'var(--green)' : '#e05252', fontWeight: 600 }}>
                        {pl >= 0 ? '+' : ''}€{pl.toFixed(2)}
                        {plPct != null && (
                          <span style={{ fontSize: '0.82rem', fontWeight: 400, marginLeft: 6, opacity: 0.85 }}>
                            ({plPct >= 0 ? '+' : ''}{plPct.toFixed(1)}%)
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {fc.purchase_uris && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.07em' }}>Buy from</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {Object.entries(fc.purchase_uris).map(([store, url]) => (
                      <a key={store} href={url} target="_blank" rel="noreferrer"
                         style={{ fontSize: '0.78rem', padding: '4px 10px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3, color: 'var(--text-dim)', textDecoration: 'none', textTransform: 'capitalize' }}>
                        {store.replace(/_/g, ' ')}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Rulings ── */}
          {activeTab === 'rulings' && (
            <div className={styles.detailSection}>
              {rulings === null ? (
                <div style={{ color: 'var(--text-faint)', fontSize: '0.85rem' }}>Loading rulings…</div>
              ) : rulings.length === 0 ? (
                <div style={{ color: 'var(--text-faint)', fontSize: '0.85rem', fontStyle: 'italic' }}>No rulings for this card.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {rulings.map((r, i) => (
                    <div key={i} className={styles.ruling}>
                      <div className={styles.rulingDate}>{new Date(r.published_at).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })}</div>
                      <div className={styles.rulingText}>{r.comment}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Edit / My Copy ── */}
          {activeTab === 'collection' && (
            <div className={styles.detailSection}>

              {/* ── Editable fields ── */}
              <div className={styles.editGroup}>
                <span className={styles.editLabel}>Quantity</span>
                <div className={styles.qtyEditor}>
                  <button className={styles.qtyBtn} onClick={() => setEditQty(q => Math.max(1, q - 1))}>−</button>
                  <input className={styles.qtyInput} type="number" min="1" value={editQty}
                    onChange={e => setEditQty(Math.max(1, parseInt(e.target.value) || 1))} />
                  <button className={styles.qtyBtn} onClick={() => setEditQty(q => q + 1)}>+</button>
                </div>
              </div>

              <div className={styles.editGroup}>
                <span className={styles.editLabel}>Foil</span>
                <button
                  className={editFoil ? styles.foilToggleOn : styles.foilToggleOff}
                  onClick={() => setEditFoil(v => !v)}>
                  {editFoil ? '✦ Foil' : '— Non-foil'}
                </button>
              </div>

              <div className={styles.editGroup}>
                <span className={styles.editLabel}>Condition</span>
                <select className={styles.editSelect} value={editCondition} onChange={e => setEditCondition(e.target.value)}>
                  {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>

              {/* Buy Price */}
              <div className={styles.editGroup}>
                <span className={styles.editLabel}>Buy Price</span>
                {!buyPriceEdit ? (
                  <button
                    className={styles.manualPriceBtn}
                    onClick={() => { setBuyPriceEdit(true); setBuyPriceInput(editBuyPrice > 0 ? String(editBuyPrice) : '') }}>
                    {editBuyPrice > 0 ? `✎ €${editBuyPrice.toFixed(2)}` : '+ Set buy price'}
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input autoFocus type="number" min="0" step="0.01" value={buyPriceInput}
                      onChange={e => setBuyPriceInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveBuyPrice(); if (e.key === 'Escape') setBuyPriceEdit(false) }}
                      placeholder="0.00"
                      style={{ width: 80, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-hi)', borderRadius: 3, padding: '4px 8px', color: 'var(--text)', fontSize: '0.88rem', outline: 'none' }} />
                    <button onClick={saveBuyPrice} style={{ background: 'rgba(201,168,76,0.15)', border: '1px solid rgba(201,168,76,0.3)', borderRadius: 3, padding: '4px 8px', color: 'var(--gold)', fontSize: '0.75rem', cursor: 'pointer' }}>Save</button>
                    <button onClick={() => setBuyPriceEdit(false)} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer' }}>✕</button>
                  </div>
                )}
              </div>

              {/* ── Save changes ── */}
              <div className={styles.editSaveRow}>
                <button className={styles.saveBtn} onClick={handleSave} disabled={saving || saved}>
                  {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save Changes'}
                </button>
                {saveError && <span style={{ fontSize: '0.78rem', color: '#e08878' }}>{saveError}</span>}
              </div>

              {/* ── Move to deck / binder ── */}
              {allFolders.length > 0 && (
                <div className={styles.editGroup} style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                  <span className={styles.editLabel}>Move to</span>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      list="moveFolderList"
                      className={styles.editSelect}
                      style={{ flex: 1, minWidth: 140 }}
                      value={moveFolderText}
                      onChange={e => setMoveFolderText(e.target.value)}
                      placeholder="Type or select deck / binder…"
                    />
                    <datalist id="moveFolderList">
                      {allFolders.filter(f => f.type !== 'list').map(f => (
                        <option key={f.id} value={f.name}>{f.name} ({f.type})</option>
                      ))}
                    </datalist>
                    <button className={styles.addToFolderBtn}
                      onClick={handleMoveToFolder}
                      disabled={!moveFolderText || !allFolders.find(f => f.name.toLowerCase() === moveFolderText.toLowerCase())}>
                      Move
                    </button>
                  </div>
                </div>
              )}

              {/* ── Static info ── */}
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Language</span>
                  <span className={styles.detailInfoVal}>{LANG_NAMES_FULL[card.language] || (card.language || '').toUpperCase()}</span>
                </div>
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Set</span>
                  <span className={styles.detailInfoVal}>{(card.set_code || '').toUpperCase()} · #{card.collector_number}</span>
                </div>
                <div className={styles.detailInfoRow}>
                  <span className={styles.detailInfoLabel}>Added</span>
                  <span className={styles.detailInfoVal}>{card.added_at ? new Date(card.added_at).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}</span>
                </div>
                {editBuyPrice > 0 && (
                  <div className={styles.detailInfoRow}>
                    <span className={styles.detailInfoLabel}>Buy Price</span>
                    <span className={styles.detailInfoVal}>
                      €{editBuyPrice.toFixed(2)}
                      {pl != null && (
                        <span style={{ marginLeft: 8, fontSize: '0.82rem', color: pl >= 0 ? 'var(--green)' : '#e05252' }}>
                          {pl >= 0 ? '+' : ''}€{pl.toFixed(2)}
                        </span>
                      )}
                    </span>
                  </div>
                )}
                {card.misprint && <div className={styles.detailInfoRow}><span className={styles.detailInfoLabel}>Misprint</span><span className={styles.detailInfoVal}>Yes</span></div>}
                {card.altered  && <div className={styles.detailInfoRow}><span className={styles.detailInfoLabel}>Altered</span><span className={styles.detailInfoVal}>Yes</span></div>}
              </div>

              {/* ── In folders ── */}
              {folders?.length > 0 && (
                <div className={styles.detailInfoRow} style={{ alignItems: 'flex-start', marginTop: 8 }}>
                  <span className={styles.detailInfoLabel}>In</span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {folders.map((f, i) => {
                      const path = f.type === 'deck' ? '/decks' : f.type === 'binder' ? '/binders' : '/lists'
                      const dest = f.id ? `${path}?folder=${f.id}` : path
                      return (
                        <button key={i} onClick={() => { onClose?.(); navigate(dest) }} style={{
                          fontSize: '0.78rem', padding: '3px 8px', borderRadius: 3,
                          border: `1px solid ${f.type === 'deck' ? 'rgba(138,111,196,0.4)' : 'rgba(201,168,76,0.35)'}`,
                          background: f.type === 'deck' ? 'rgba(138,111,196,0.12)' : 'rgba(201,168,76,0.1)',
                          color: 'var(--text-dim)', display: 'inline-flex', alignItems: 'center', gap: 4,
                          cursor: 'pointer', transition: 'all 0.15s',
                        }}
                        onMouseEnter={e => e.currentTarget.style.color = 'var(--gold)'}
                        onMouseLeave={e => e.currentTarget.style.color = 'var(--text-dim)'}
                        >
                          <FolderTypeIcon type={f.type} size={11} />{f.name} →
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {onDelete && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  <button className={styles.deleteBtn} onClick={onDelete}>Delete Card</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}



// ── FilterBar + applyFilterSort ───────────────────────────────────────────────

const COLORS = [
  { id: 'W', symbol: 'W', title: 'White',      bg: '#f5f0d8', fg: '#5a4a00' },
  { id: 'U', symbol: 'U', title: 'Blue',       bg: '#1a4a8a', fg: '#c0d8f8' },
  { id: 'B', symbol: 'B', title: 'Black',      bg: '#1a1a2a', fg: '#c0b8d8' },
  { id: 'R', symbol: 'R', title: 'Red',        bg: '#8a2010', fg: '#f8c0a0' },
  { id: 'G', symbol: 'G', title: 'Green',      bg: '#1a5a2a', fg: '#a0d8a0' },
  { id: 'C', symbol: '◇', title: 'Colorless',  bg: '#3a3838', fg: '#c8c0a8' },
  { id: 'M', symbol: '★', title: 'Multicolor', bg: '#6a5010', fg: '#f8d878' },
]

const RARITIES = [
  { id: 'common',   label: 'Common',   color: '#6a6a7a' },
  { id: 'uncommon', label: 'Uncommon', color: '#8ab0c8' },
  { id: 'rare',     label: 'Rare',     color: '#c9a84c' },
  { id: 'mythic',   label: 'Mythic',   color: '#c46030' },
  { id: 'special',  label: 'Special',  color: '#8a6fc4' },
]

const CONDITIONS = [
  { id: 'near_mint',         label: 'NM',  title: 'Near Mint' },
  { id: 'lightly_played',    label: 'LP',  title: 'Lightly Played' },
  { id: 'moderately_played', label: 'MP',  title: 'Moderately Played' },
  { id: 'heavily_played',    label: 'HP',  title: 'Heavily Played' },
  { id: 'damaged',           label: 'DMG', title: 'Damaged' },
]

const LANG_NAMES = {
  en: 'English', de: 'German', fr: 'French', it: 'Italian',
  es: 'Spanish', pt: 'Portuguese', ja: 'Japanese', ko: 'Korean',
  ru: 'Russian', zhs: 'Simp. Chinese', zht: 'Trad. Chinese',
  he: 'Hebrew', la: 'Latin', grc: 'Ancient Greek', ar: 'Arabic', sa: 'Sanskrit', ph: 'Phyrexian',
}

const LEGALITY_FORMATS = [
  ['standard','Standard'], ['pioneer','Pioneer'], ['modern','Modern'],
  ['legacy','Legacy'],     ['vintage','Vintage'], ['commander','Commander'],
  ['pauper','Pauper'],     ['explorer','Explorer'], ['historic','Historic'],
  ['brawl','Brawl'],
]

const SPECIAL_OPTS = [
  { id: 'altered',  label: 'Altered' },
  { id: 'misprint', label: 'Misprint' },
]

export const EMPTY_FILTERS = {
  foil:       'all',
  colors:     [], colorMode: 'identity',
  rarity:     [],
  typeLine:   [],       // type/subtype tags (autocomplete from Scryfall catalog)
  oracleText: '',       // free text
  artist:     '',       // free text
  conditions: [],
  languages:  [],
  sets:       [],
  formats:    [],
  // Mana value range with operator
  cmcOp:   'any', cmcMin: '', cmcMax: '',
  // Power/Toughness
  powerOp: 'any', powerVal: '',
  toughOp: 'any', toughVal: '',
  // Price range
  priceMin: '', priceMax: '',
  // Number of colors
  colorCountMin: 0, colorCountMax: 5,
  quantity: 'any',
  specials: [],
  location: 'all',
}

function countActive(f) {
  return [
    f.foil !== 'all' ? 1 : 0,
    f.colors.length,
    f.rarity.length,
    (Array.isArray(f.typeLine) ? f.typeLine.length : (f.typeLine ? 1 : 0)),
    f.oracleText ? 1 : 0,
    f.artist     ? 1 : 0,
    f.conditions.length,
    f.languages.length,
    f.sets.length,
    f.formats.length,
    f.cmcOp !== 'any' ? 1 : 0,
    f.powerOp !== 'any' ? 1 : 0,
    f.toughOp !== 'any' ? 1 : 0,
    (f.priceMin || f.priceMax) ? 1 : 0,
    (f.colorCountMin > 0 || f.colorCountMax < 5) ? 1 : 0,
    f.quantity !== 'any' ? 1 : 0,
    f.specials.length,
    f.location !== 'all' ? 1 : 0,
  ].reduce((a, b) => a + b, 0)
}

function toggle(arr, val) {
  return arr.includes(val) ? arr.filter(x => x !== val) : [...arr, val]
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Chip({ active, onClick, children, style }) {
  return (
    <button onClick={onClick}
      className={`${styles.chip}${active ? ' ' + styles.chipActive : ''}`}
      style={style}
    >{children}</button>
  )
}

function FilterSection({ label, children, fullWidth }) {
  return (
    <div className={styles.fsection} style={fullWidth ? { gridColumn: '1 / -1' } : {}}>
      <div className={styles.fsectionLabel}>{label}</div>
      <div className={styles.fsectionBody}>{children}</div>
    </div>
  )
}

function TextFilter({ value, onChange, placeholder }) {
  return (
    <input
      className={styles.textFilter}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
    />
  )
}

// Operator + value(s) control
// ops: 'any' | '=' | '<' | '<=' | '>' | '>=' | 'between' | 'in'
export const OPS = [
  { id: 'any',     label: 'Any' },
  { id: '=',       label: '=' },
  { id: '<',       label: '<' },
  { id: '<=',      label: '≤' },
  { id: '>',       label: '>' },
  { id: '>=',      label: '≥' },
  { id: 'between', label: 'Range' },
  { id: 'in',      label: 'In list' },
]

export function NumericFilter({ opKey, valKey, val2Key, filters, set }) {
  const op = filters[opKey] || 'any'
  return (
    <div className={styles.numericFilter}>
      <div className={styles.chips} style={{ marginBottom: 6 }}>
        {OPS.map(o => (
          <Chip key={o.id} active={op === o.id} onClick={() => set(opKey, o.id)}
            style={{ padding: '3px 8px', fontSize: '0.78rem' }}>
            {o.label}
          </Chip>
        ))}
      </div>
      {op !== 'any' && (
        <div className={styles.rangeRow}>
          {op === 'in' ? (
            <input className={styles.rangeInput} type="text"
              placeholder="e.g. 1, 2, 3"
              style={{ width: '100%' }}
              value={filters[valKey] || ''}
              onChange={e => set(valKey, e.target.value)} />
          ) : (
            <>
              <input className={styles.rangeInput} type="number" min="0" step="1"
                placeholder={op === 'between' ? 'Min' : 'Value'}
                value={filters[valKey] || ''}
                onChange={e => set(valKey, e.target.value)} />
              {op === 'between' && <>
                <span className={styles.rangeSep}>—</span>
                <input className={styles.rangeInput} type="number" min="0" step="1"
                  placeholder="Max"
                  value={filters[val2Key] || ''}
                  onChange={e => set(val2Key, e.target.value)} />
              </>}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Scryfall type catalog (fetched once, cached) ─────────────────────────────
let _typeCatalog = null
async function loadTypeCatalog() {
  if (_typeCatalog) return _typeCatalog
  const endpoints = [
    { url: 'https://api.scryfall.com/catalog/supertypes',         category: 'Supertype'    },
    { url: 'https://api.scryfall.com/catalog/card-types',         category: 'Type'         },
    { url: 'https://api.scryfall.com/catalog/artifact-types',     category: 'Artifact'     },
    { url: 'https://api.scryfall.com/catalog/creature-types',     category: 'Creature'     },
    { url: 'https://api.scryfall.com/catalog/enchantment-types',  category: 'Enchantment'  },
    { url: 'https://api.scryfall.com/catalog/land-types',         category: 'Land'         },
    { url: 'https://api.scryfall.com/catalog/planeswalker-types', category: 'Planeswalker' },
    { url: 'https://api.scryfall.com/catalog/spell-types',        category: 'Spell'        },
  ]
  const results = await Promise.allSettled(
    endpoints.map(e => fetch(e.url).then(r => r.json()).then(d => ({ types: d.data || [], category: e.category })))
  )
  const combined = []
  const seen = new Set()
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const t of r.value.types) {
      if (!seen.has(t)) {
        seen.add(t)
        combined.push({ name: t, category: r.value.category })
      }
    }
  }
  combined.sort((a, b) => a.name.localeCompare(b.name))
  _typeCatalog = combined
  return combined
}

// ── Type line tag filter ──────────────────────────────────────────────────────
export function TypeLineFilter({ selected, onChange }) {
  const [query,   setQuery]   = useState('')
  const [open,    setOpen]    = useState(false)
  const [catalog, setCatalog] = useState([])
  const ref = useRef(null)

  useEffect(() => { loadTypeCatalog().then(setCatalog).catch(() => {}) }, [])

  useEffect(() => {
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const visible = query.trim()
    ? catalog.filter(t => t.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 25)
    : []

  const addType = name => {
    if (!selected.includes(name)) onChange([...selected, name])
    setQuery(''); setOpen(false)
  }

  return (
    <div className={styles.setDropWrap} ref={ref}>
      {selected.length > 0 && (
        <div className={styles.setTags}>
          {selected.map(t => (
            <span key={t} className={styles.setTag}>
              {t}
              <button className={styles.setTagRemove}
                onClick={() => onChange(selected.filter(x => x !== t))}>✕</button>
            </span>
          ))}
          <button className={styles.setTagClearAll} onClick={() => onChange([])}>Clear</button>
        </div>
      )}
      <input
        className={styles.setSearchInput}
        placeholder={selected.length ? 'Add another type…' : 'e.g. Creature, Human, Legendary…'}
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => { if (query.trim()) setOpen(true) }}
      />
      {open && visible.length > 0 && (
        <div className={styles.setDropList}>
          {visible.map(t => {
            const active = selected.includes(t.name)
            return (
              <div key={t.name}
                className={`${styles.setDropItem}${active ? ' ' + styles.setDropItemActive : ''}`}
                onMouseDown={e => { e.preventDefault(); addType(t.name) }}
              >
                <span className={styles.setDropName}>{t.name}</span>
                <span className={styles.setDropCode} style={{ marginLeft: 'auto', fontSize: '0.7rem' }}>{t.category}</span>
                {active && <span className={styles.setDropCheck}>✓</span>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Set dropdown ──────────────────────────────────────────────────────────────
function SetDropdown({ sets, selected, onChange }) {
  const [query, setQuery] = useState('')
  const [open, setOpen]   = useState(false)
  const ref               = useRef(null)

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const visible = query
    ? sets.filter(s =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        s.code.toLowerCase().includes(query.toLowerCase())
      )
    : sets

  const toggleSet = (code) => onChange(selected.includes(code) ? selected.filter(x => x !== code) : [...selected, code])
  const selectedSets = sets.filter(s => selected.includes(s.code))

  return (
    <div className={styles.setDropWrap} ref={ref}>
      {selectedSets.length > 0 && (
        <div className={styles.setTags}>
          {selectedSets.map(s => (
            <span key={s.code} className={styles.setTag}>
              <span style={{ opacity: 0.6, fontSize: '0.68rem', marginRight: 3, fontFamily: 'monospace' }}>{s.code.toUpperCase()}</span>
              {s.name}
              <button className={styles.setTagRemove} onClick={() => toggleSet(s.code)}>✕</button>
            </span>
          ))}
          <button className={styles.setTagClearAll} onClick={() => onChange([])}>Clear</button>
        </div>
      )}
      <input
        className={styles.setSearchInput}
        placeholder={selected.length ? 'Add more sets…' : 'Type set name or code…'}
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
      />
      {open && (
        <div className={styles.setDropList}>
          {visible.length === 0
            ? <div className={styles.setDropEmpty}>No sets match "{query}"</div>
            : visible.map(s => {
                const active = selected.includes(s.code)
                return (
                  <div key={s.code}
                    className={`${styles.setDropItem}${active ? ' ' + styles.setDropItemActive : ''}`}
                    onMouseDown={e => { e.preventDefault(); toggleSet(s.code) }}
                  >
                    <span className={styles.setDropCode}>{s.code.toUpperCase()}</span>
                    <span className={styles.setDropName}>{s.name}</span>
                    {active && <span className={styles.setDropCheck}>✓</span>}
                  </div>
                )
              })
          }
        </div>
      )}
    </div>
  )
}

// ── FilterBar ─────────────────────────────────────────────────────────────────
export function FilterBar({
  search, setSearch, sort, setSort,
  filters, setFilters,
  extra, selectMode, onToggleSelectMode,
  sets = [], languages = [],
}) {
  const [open, setOpen] = useState(false)
  const activeCount = countActive(filters)
  const set = (key, val) => setFilters(f => ({ ...f, [key]: val }))
  const clear = () => setFilters({ ...EMPTY_FILTERS })

  return (
    <div className={styles.filterWrap}>
      <div className={styles.filterBar}>
        <input className={styles.searchInput} placeholder="Search cards, sets…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className={styles.filterSelect} value={sort} onChange={e => setSort(e.target.value)}>
          <option value="name">Name A→Z</option>
          <option value="price_desc">Price ↓</option>
          <option value="price_asc">Price ↑</option>
          <option value="pl_desc">P&L ↓</option>
          <option value="pl_asc">P&L ↑</option>
          <option value="cmc_asc">Mana Value ↑</option>
          <option value="cmc_desc">Mana Value ↓</option>
          <option value="qty">Quantity</option>
          <option value="set">Set</option>
          <option value="rarity">Rarity</option>
          <option value="added">Recently Added</option>
        </select>
        <button
          className={`${styles.filterToggle}${open ? ' ' + styles.filterToggleOpen : ''}${activeCount ? ' ' + styles.filterToggleActive : ''}`}
          onClick={() => setOpen(v => !v)}
        >
          {activeCount > 0 ? `Filters (${activeCount})` : 'Filters'} {open ? '▲' : '▼'}
        </button>
        {extra}
        {onToggleSelectMode && (
          <button className={`${styles.selectModeBtn}${selectMode ? ' ' + styles.selectModeActive : ''}`}
            onClick={onToggleSelectMode}>{selectMode ? '✓ Selecting' : '☐ Select'}</button>
        )}
      </div>

      {open && (
        <div className={styles.filterPanel}>
          <div className={styles.filterGrid}>

            {/* Printing / Foil */}
            <FilterSection label="Printing">
              <div className={styles.chips}>
                {[['all','All'],['foil','Foil'],['nonfoil','Non-foil'],['etched','Etched']].map(([v,l]) => (
                  <Chip key={v} active={filters.foil === v} onClick={() => set('foil', v)}>{l}</Chip>
                ))}
              </div>
            </FilterSection>

            {/* Condition */}
            <FilterSection label="Condition">
              <div className={styles.chips}>
                {CONDITIONS.map(c => (
                  <Chip key={c.id} active={filters.conditions.includes(c.id)}
                    onClick={() => set('conditions', toggle(filters.conditions, c.id))}>
                    <span title={c.title}>{c.label}</span>
                  </Chip>
                ))}
              </div>
            </FilterSection>

            {/* Color */}
            <FilterSection label="Colors" fullWidth>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'flex-start' }}>
                <div>
                  <div className={styles.fsectionSubLabel}>Color identity</div>
                  <div className={styles.chips}>
                    {COLORS.map(c => (
                      <Chip key={c.id}
                        active={filters.colors.includes(c.id)}
                        onClick={() => set('colors', toggle(filters.colors, c.id))}
                        style={filters.colors.includes(c.id) ? { background: c.bg, borderColor: c.fg, color: c.fg, minWidth: 28, textAlign: 'center' } : { minWidth: 28, textAlign: 'center' }}
                      ><span title={c.title}>{c.symbol}</span></Chip>
                    ))}
                  </div>
                </div>
                {filters.colors.some(x => ['W','U','B','R','G'].includes(x)) && (
                  <div>
                    <div className={styles.fsectionSubLabel}>Match mode</div>
                    <div className={styles.chips}>
                      {[['identity','Color identity'],['including','Including'],['exact','Exactly these']].map(([v,l]) => (
                        <Chip key={v} active={filters.colorMode === v} onClick={() => set('colorMode', v)}
                          style={{ fontSize: '0.75rem' }}>{l}</Chip>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <div className={styles.fsectionSubLabel}>Number of colors</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className={styles.rangeLabel}>Min</span>
                    <select className={styles.miniSelect} value={filters.colorCountMin}
                      onChange={e => set('colorCountMin', parseInt(e.target.value))}>
                      {[0,1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <span className={styles.rangeLabel}>Max</span>
                    <select className={styles.miniSelect} value={filters.colorCountMax}
                      onChange={e => set('colorCountMax', parseInt(e.target.value))}>
                      {[0,1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                </div>
              </div>
            </FilterSection>

            {/* Rarity */}
            <FilterSection label="Rarity">
              <div className={styles.chips}>
                {RARITIES.map(r => (
                  <Chip key={r.id} active={filters.rarity.includes(r.id)}
                    onClick={() => set('rarity', toggle(filters.rarity, r.id))}
                    style={filters.rarity.includes(r.id) ? { borderColor: r.color, color: r.color } : {}}>
                    {r.label}
                  </Chip>
                ))}
              </div>
            </FilterSection>

            {/* Type line — autocomplete tags */}
            <FilterSection label="Type Line" fullWidth>
              <TypeLineFilter
                selected={Array.isArray(filters.typeLine) ? filters.typeLine : []}
                onChange={v => set('typeLine', v)}
              />
            </FilterSection>

            {/* Oracle text */}
            <FilterSection label="Oracle Text">
              <TextFilter value={filters.oracleText} onChange={v => set('oracleText', v)}
                placeholder="e.g. flying, draw a card" />
            </FilterSection>

            {/* Mana value */}
            <FilterSection label="Mana Value">
              <NumericFilter opKey="cmcOp" valKey="cmcMin" val2Key="cmcMax" filters={filters} set={set} />
            </FilterSection>

            {/* Power */}
            <FilterSection label="Power">
              <NumericFilter opKey="powerOp" valKey="powerVal" val2Key="powerVal2" filters={filters} set={set} />
            </FilterSection>

            {/* Toughness */}
            <FilterSection label="Toughness">
              <NumericFilter opKey="toughOp" valKey="toughVal" val2Key="toughVal2" filters={filters} set={set} />
            </FilterSection>

            {/* Price */}
            <FilterSection label="Price">
              <div className={styles.rangeRow}>
                <span className={styles.rangeLabel}>Min</span>
                <input className={styles.rangeInput} type="number" min="0" step="0.01"
                  placeholder="0.00" value={filters.priceMin}
                  onChange={e => set('priceMin', e.target.value)} />
                <span className={styles.rangeSep}>—</span>
                <span className={styles.rangeLabel}>Max</span>
                <input className={styles.rangeInput} type="number" min="0" step="0.01"
                  placeholder="∞" value={filters.priceMax}
                  onChange={e => set('priceMax', e.target.value)} />
              </div>
            </FilterSection>

            {/* Artist */}
            <FilterSection label="Artist">
              <TextFilter value={filters.artist} onChange={v => set('artist', v)}
                placeholder="Artist name…" />
            </FilterSection>

            {/* Format legality */}
            <FilterSection label="Format Legal" fullWidth>
              <div className={styles.chips}>
                {LEGALITY_FORMATS.map(([id, label]) => (
                  <Chip key={id} active={filters.formats.includes(id)}
                    onClick={() => set('formats', toggle(filters.formats, id))}>
                    {label}
                  </Chip>
                ))}
              </div>
            </FilterSection>

            {/* Language */}
            {languages.length > 1 && (
              <FilterSection label="Language">
                <div className={styles.chips}>
                  {languages.map(l => (
                    <Chip key={l} active={filters.languages.includes(l)}
                      onClick={() => set('languages', toggle(filters.languages, l))}>
                      {LANG_NAMES[l] || l.toUpperCase()}
                    </Chip>
                  ))}
                </div>
              </FilterSection>
            )}

            {/* Quantity */}
            <FilterSection label="Quantity">
              <div className={styles.chips}>
                {[['any','Any'],['dupes','Duplicates (qty > 1)'],['single','Singles (qty = 1)']].map(([v,l]) => (
                  <Chip key={v} active={filters.quantity === v} onClick={() => set('quantity', v)}>{l}</Chip>
                ))}
              </div>
            </FilterSection>

            {/* Location */}
            <FilterSection label="Location">
              <div className={styles.chips}>
                {[['all','Any'],['binder','In a binder'],['deck','In a deck']].map(([v,l]) => (
                  <Chip key={v} active={filters.location === v} onClick={() => set('location', v)}>{l}</Chip>
                ))}
              </div>
            </FilterSection>

            {/* Special */}
            <FilterSection label="Special">
              <div className={styles.chips}>
                {SPECIAL_OPTS.map(s => (
                  <Chip key={s.id} active={filters.specials.includes(s.id)}
                    onClick={() => set('specials', toggle(filters.specials, s.id))}>
                    {s.label}
                  </Chip>
                ))}
              </div>
            </FilterSection>

            {/* Set — full width */}
            {sets.length > 0 && (
              <FilterSection label="Set" fullWidth>
                <SetDropdown sets={sets} selected={filters.sets}
                  onChange={v => set('sets', v)} />
              </FilterSection>
            )}

          </div>

          {activeCount > 0 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 4 }}>
              <button className={styles.clearFilters} onClick={clear}>✕ Clear all filters ({activeCount})</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── applyFilterSort ───────────────────────────────────────────────────────────

function matchNumeric(valStr, op, minStr, maxStr) {
  const val = parseFloat(valStr)
  if (isNaN(val)) return op === 'any' // no value means skip for creatures, pass for lands
  if (op === 'any') return true
  if (op === 'in') {
    const nums = String(minStr).split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n))
    return nums.length > 0 && nums.some(n => n === val)
  }
  const min = parseFloat(minStr)
  const max = parseFloat(maxStr)
  if (op === '=')       return !isNaN(min) && val === min
  if (op === '<')       return !isNaN(min) && val < min
  if (op === '<=')      return !isNaN(min) && val <= min
  if (op === '>')       return !isNaN(min) && val > min
  if (op === '>=')      return !isNaN(min) && val >= min
  if (op === 'between') return !isNaN(min) && !isNaN(max) && val >= min && val <= max
  return true
}

export function applyFilterSort(cards, sfMap, search, sort, filters = {}, cardFolderMap = {}) {
  const {
    foil = 'all',
    colors = [], colorMode = 'identity',
    colorCountMin = 0, colorCountMax = 5,
    rarity = [],
    typeLine = [], oracleText = '', artist = '',
    conditions = [], languages = [], sets = [],
    formats = [],
    cmcOp = 'any', cmcMin = '', cmcMax = '',
    powerOp = 'any', powerVal = '', powerVal2 = '',
    toughOp = 'any', toughVal = '', toughVal2 = '',
    priceMin = '', priceMax = '',
    quantity = 'any', specials = [], location = 'all',
  } = filters

  let r = [...cards]

  // Foil
  if (foil === 'foil')    r = r.filter(c => c.foil)
  if (foil === 'nonfoil') r = r.filter(c => !c.foil)
  if (foil === 'etched')  r = r.filter(c => c.foil)

  // Rarity
  if (rarity.length) r = r.filter(c => rarity.includes(sfMap[`${c.set_code}-${c.collector_number}`]?.rarity))

  // Condition
  if (conditions.length) r = r.filter(c => conditions.includes(c.condition))

  // Language
  if (languages.length) r = r.filter(c => languages.includes(c.language))

  // Set
  if (sets.length) r = r.filter(c => sets.includes(c.set_code))

  // Quantity (prefer _folder_qty when inside a deck/binder view)
  const getQty = c => c._folder_qty ?? c.qty ?? 1
  if (quantity === 'dupes')  r = r.filter(c => getQty(c) > 1)
  if (quantity === 'single') r = r.filter(c => getQty(c) === 1)

  // Special
  if (specials.includes('altered'))  r = r.filter(c => c.altered)
  if (specials.includes('misprint')) r = r.filter(c => c.misprint)

  // Location
  if (location === 'binder') r = r.filter(c => (cardFolderMap[c.id] || []).some(f => f.type === 'binder'))
  if (location === 'deck')   r = r.filter(c => (cardFolderMap[c.id] || []).some(f => f.type === 'deck'))

  // Type line — all selected tags must appear in type_line
  const typeLineArr = Array.isArray(typeLine) ? typeLine : (typeLine ? typeLine.split(/\s+/) : [])
  if (typeLineArr.length > 0) {
    r = r.filter(c => {
      const tl = (sfMap[`${c.set_code}-${c.collector_number}`]?.type_line || '').toLowerCase()
      return typeLineArr.every(t => tl.includes(t.toLowerCase()))
    })
  }

  // Oracle text — free text
  if (oracleText.trim()) {
    const q = oracleText.trim().toLowerCase()
    r = r.filter(c => (sfMap[`${c.set_code}-${c.collector_number}`]?.oracle_text || '').toLowerCase().includes(q))
  }

  // Artist — free text
  if (artist.trim()) {
    const q = artist.trim().toLowerCase()
    r = r.filter(c => (sfMap[`${c.set_code}-${c.collector_number}`]?.artist || '').toLowerCase().includes(q))
  }

  // Colors
  if (colors.length) {
    r = r.filter(c => {
      const ci = sfMap[`${c.set_code}-${c.collector_number}`]?.color_identity || []
      const wantsMulti     = colors.includes('M')
      const wantsColorless = colors.includes('C')
      const selected = colors.filter(x => ['W','U','B','R','G'].includes(x))
      if (!selected.length) {
        return (wantsMulti && ci.length > 1) || (wantsColorless && ci.length === 0)
      }
      if (wantsMulti     && ci.length > 1)  return true
      if (wantsColorless && ci.length === 0) return true
      if (colorMode === 'exact')     return ci.length === selected.length && selected.every(x => ci.includes(x))
      if (colorMode === 'including') return selected.every(x => ci.includes(x))
      return selected.some(x => ci.includes(x))
    })
  }

  // Number of colors
  if (colorCountMin > 0 || colorCountMax < 5) {
    r = r.filter(c => {
      const ci = sfMap[`${c.set_code}-${c.collector_number}`]?.color_identity || []
      return ci.length >= colorCountMin && ci.length <= colorCountMax
    })
  }

  // Format legality
  if (formats.length) {
    r = r.filter(c => {
      const leg = sfMap[`${c.set_code}-${c.collector_number}`]?.legalities || {}
      return formats.some(f => leg[f] === 'legal')
    })
  }

  // Mana value
  if (cmcOp !== 'any') {
    r = r.filter(c => {
      const cmc = sfMap[`${c.set_code}-${c.collector_number}`]?.cmc
      return matchNumeric(String(cmc ?? ''), cmcOp, cmcMin, cmcMax)
    })
  }

  // Power
  if (powerOp !== 'any') {
    r = r.filter(c => {
      const p = sfMap[`${c.set_code}-${c.collector_number}`]?.power
      return matchNumeric(p, powerOp, powerVal, powerVal2)
    })
  }

  // Toughness
  if (toughOp !== 'any') {
    r = r.filter(c => {
      const t = sfMap[`${c.set_code}-${c.collector_number}`]?.toughness
      return matchNumeric(t, toughOp, toughVal, toughVal2)
    })
  }

  // Price range
  if (priceMin !== '' || priceMax !== '') {
    const min = priceMin !== '' ? parseFloat(priceMin) : null
    const max = priceMax !== '' ? parseFloat(priceMax) : null
    r = r.filter(c => {
      const p = getPrice(sfMap[`${c.set_code}-${c.collector_number}`], c.foil) ?? (parseFloat(c.purchase_price) || null)
      if (p == null) return false
      if (min != null && p < min) return false
      if (max != null && p > max) return false
      return true
    })
  }

  // Text search
  if (search) {
    const q = search.toLowerCase()
    r = r.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.set_code || '').toLowerCase().includes(q) ||
      (sfMap[`${c.set_code}-${c.collector_number}`]?.set_name || '').toLowerCase().includes(q)
    )
  }

  const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4 }
  const RARITY_ORDER2 = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4 }
  r.sort((a, b) => {
    const sfA = sfMap[`${a.set_code}-${a.collector_number}`]
    const sfB = sfMap[`${b.set_code}-${b.collector_number}`]
    const plA = (() => { const p = getPrice(sfA, a.foil); return p != null && a.purchase_price > 0 ? (p - a.purchase_price) * a.qty : null })()
    const plB = (() => { const p = getPrice(sfB, b.foil); return p != null && b.purchase_price > 0 ? (p - b.purchase_price) * b.qty : null })()
    switch (sort) {
      case 'name':       return a.name.localeCompare(b.name)
      case 'price_desc': return ((getPrice(sfB, b.foil) ?? parseFloat(b.purchase_price) ?? 0)) - ((getPrice(sfA, a.foil) ?? parseFloat(a.purchase_price) ?? 0))
      case 'price_asc':  return ((getPrice(sfA, a.foil) ?? parseFloat(a.purchase_price) ?? 0)) - ((getPrice(sfB, b.foil) ?? parseFloat(b.purchase_price) ?? 0))
      case 'pl_desc':    return (plB ?? -Infinity) - (plA ?? -Infinity)
      case 'pl_asc':     return (plA ?? Infinity)  - (plB ?? Infinity)
      case 'qty':        return (b._folder_qty ?? b.qty ?? 0) - (a._folder_qty ?? a.qty ?? 0)
      case 'set':        return (a.set_code || '').localeCompare(b.set_code || '')
      case 'added':      return new Date(b.added_at || 0) - new Date(a.added_at || 0)
      case 'rarity':     return (RARITY_ORDER2[sfB?.rarity] ?? 0) - (RARITY_ORDER2[sfA?.rarity] ?? 0)
      case 'cmc_asc':    return (sfA?.cmc ?? 99) - (sfB?.cmc ?? 99)
      case 'cmc_desc':   return (sfB?.cmc ?? 0)  - (sfA?.cmc ?? 0)
      default:           return 0
    }
  })

  return r
}
