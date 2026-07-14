import { useState, useEffect, useMemo, useCallback } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { parseDeckMeta, serializeDeckMeta, FORMATS, classifyCardType, groupDeckCards, TYPE_GROUPS } from '../lib/deckBuilderApi'
import { toDeckCardRow } from '../lib/deckBuilderWrites'
import { cardNameMatchKeys } from '../lib/deckBuilderHelpers'
import DeckStats, { CAT_ORDER, getCardCategory, normalizeDeckBuilderCards } from '../components/DeckStats'
import styles from './DeckView.module.css'
import uiStyles from '../components/UI.module.css'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { getPrice, formatPrice, getScryfallKey } from '../lib/scryfall'
import { ResponsiveMenu } from '../components/UI'
import { CardBrowserContent } from '../components/CardBrowserViews'
import { CloseIcon, CheckIcon, ChevronDownIcon, GridViewIcon, SearchIcon, SortIcon, StacksViewIcon, TextViewIcon, TableViewIcon } from '../icons'
import BRAND_MARK from '../icons/DeckLoom_logo.png'
import Markdown, { extractHeadings } from '../lib/miniMarkdown.jsx'
import { DeckLikeButton, DeckComments } from '../components/community/DeckSocial'
import { deckBracketBadge } from '../lib/commanderBracket'
import { scryfallCardDetailUrls } from '../lib/cardDetailUrls'
import { useComboCardImage } from '../hooks/useComboCardImage'

const RARITY_ORDER = ['mythic', 'rare', 'uncommon', 'common']
const RARITY_GROUP_ORDER = ['Mythic', 'Rare', 'Uncommon', 'Common', 'Unknown']
const BOARD_LABELS = { main: 'Mainboard', attraction: 'Attraction Deck', side: 'Sideboard', maybe: 'Maybeboard' }
const COLOR_GROUP_ORDER = ['W', 'U', 'B', 'R', 'G', 'Multicolor', 'Colorless']
// Deck-context order: Type/Color lead because grouping by them is the most
// useful deck-building view. Name pair next, then numeric sorts paired
// asc/desc, then Set and Quantity.
const SORT_OPTIONS = [
  { id: 'type', label: 'Type' },
  { id: 'color', label: 'Color' },
  { id: 'name', label: 'Name A→Z' },
  { id: 'name_desc', label: 'Name Z→A' },
  { id: 'cmc_asc', label: 'Mana Value ↑' },
  { id: 'cmc_desc', label: 'Mana Value ↓' },
  { id: 'rarity_desc', label: 'Rarity ↓' },
  { id: 'rarity_asc', label: 'Rarity ↑' },
  { id: 'price_desc', label: 'Price ↓' },
  { id: 'price_asc', label: 'Price ↑' },
  { id: 'set', label: 'Set' },
  { id: 'qty', label: 'Quantity' },
]
const GROUP_OPTIONS = [
  { id: 'type', label: 'Type' },
  { id: 'category', label: 'Category' },
  { id: 'rarity', label: 'Rarity' },
  { id: 'set', label: 'Set' },
  { id: 'board', label: 'Board' },
  { id: 'color', label: 'Color' },
  { id: 'none', label: 'None' },
]
const CARD_SIZE_OPTIONS = [
  { id: 'compact', label: 'Small' },
  { id: 'comfortable', label: 'Medium' },
  { id: 'cozy', label: 'Large' },
]

function normalizeBoard(board) {
  return board === 'attraction' || board === 'side' || board === 'maybe' ? board : 'main'
}

function rarityLabel(rarity) {
  if (!rarity) return 'Unknown'
  return rarity.charAt(0).toUpperCase() + rarity.slice(1)
}

function colorGroup(colors = []) {
  const list = Array.isArray(colors) ? colors.filter(Boolean) : []
  if (list.length === 0) return 'Colorless'
  if (list.length > 1) return 'Multicolor'
  return list[0]
}

function getSfCard(sfMap, card) {
  return sfMap[getScryfallKey(card)] || null
}

// ── Mana / symbol renderer ────────────────────────────────────────────────────
// Converts Scryfall notation like {W}, {T}, {2/U}, {X} → inline SVG images.
// Newlines in oracle text are preserved via the parent's white-space: pre-line.
function ManaText({ text, imgStyle }) {
  if (!text) return null
  const parts = text.split(/(\{[^}]+\})/g)
  const symStyle = { width: '1em', height: '1em', verticalAlign: '-0.15em', display: 'inline-block', margin: '0 1.5px', ...imgStyle }
  return (
    <>
      {parts.map((part, i) => {
        if (/^\{[^}]+\}$/.test(part)) {
          // Strip braces, upper-case, replace / with - for hybrid (e.g. W/U → W-U)
          const sym = part.slice(1, -1).toUpperCase().replace(/\//g, '-')
          return (
            <img
              key={i}
              src={`https://svgs.scryfall.io/card-symbols/${sym}.svg`}
              alt={part}
              title={part}
              style={symStyle}
            />
          )
        }
        return <span key={i}>{part}</span>
      })}
    </>
  )
}

// ── Lightweight card detail modal (fetches from Scryfall) ────────────────────
// `card` is either a deck-card row (shows the deck's exact printing) or a bare
// card name string (combo suggestions — Scryfall's default printing is fine).
function CardDetailModal({ card, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!card) return
    let cancelled = false
    setLoading(true)
    setData(null)
    ;(async () => {
      for (const url of scryfallCardDetailUrls(card)) {
        try {
          const r = await fetch(url)
          if (!r.ok) continue // e.g. stale scryfall_id — try the next lookup
          const d = await r.json()
          if (!cancelled) { setData(d); setLoading(false) }
          return
        } catch { /* network hiccup — try the next lookup */ }
      }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [card])

  const face  = data?.card_faces?.[0] || data
  const face2 = data?.card_faces?.[1] || null
  const imgUrl  = face?.image_uris?.normal  || data?.image_uris?.normal
  const imgUrl2 = face2?.image_uris?.normal || null

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modalBox} onClick={e => e.stopPropagation()}>

        {loading && <div className={styles.modalLoading}>Loading…</div>}

        {!loading && data && (
          <>
            <div className={styles.modalHeader}>
              <div>
                <div className={styles.modalCardName}>{data.name}</div>
                <div className={styles.modalTypeLine}>{face?.type_line || data.type_line}</div>
              </div>
              <div className={styles.modalHeaderRight}>
                {(face?.mana_cost || data.mana_cost) && (
                  <span className={styles.modalManaCost}>
                    <ManaText
                      text={face?.mana_cost || data.mana_cost}
                      imgStyle={{ width: '1.1em', height: '1.1em' }}
                    />
                  </span>
                )}
                <button className={styles.modalClose} onClick={onClose}><CloseIcon size={13} /></button>
              </div>
            </div>

            <div className={styles.modalBody}>
              <div className={styles.modalImages}>
                {imgUrl  && <img src={imgUrl}  alt={data.name} />}
                {imgUrl2 && <img src={imgUrl2} alt={data.name} />}
              </div>
              <div className={styles.modalDetails}>
                {(face?.oracle_text || data.oracle_text) && (
                  <div className={styles.modalOracleText}>
                    <ManaText text={face?.oracle_text || data.oracle_text} />
                  </div>
                )}
                {face2?.oracle_text && (
                  <div className={styles.modalOracleText2}>
                    <ManaText text={face2.oracle_text} />
                  </div>
                )}
                <div className={styles.modalTags}>
                  {data.set_name     && <span className={styles.modalTag}>{data.set_name}</span>}
                  {data.rarity       && <span className={styles.modalTag}>{data.rarity}</span>}
                  {data.attraction_lights?.length > 0 && <span className={styles.modalTag}>Lights {data.attraction_lights.join(', ')}</span>}
                  {face?.power != null && <span className={styles.modalTag}>{face.power}/{face.toughness}</span>}
                  {data.loyalty      && <span className={styles.modalTag}>Loyalty {data.loyalty}</span>}
                </div>
                {data.flavor_text && (
                  <div className={styles.modalFlavor}>{data.flavor_text}</div>
                )}
              </div>
            </div>
          </>
        )}

        {!loading && !data && (
          <div className={styles.modalError}>Could not load card data.</div>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
function ComboThumb({ name, inDeck, imageUri, onOpenDetail }) {
  const img = useComboCardImage(name, imageUri)
  return (
    <button
      type="button"
      className={`${styles.comboThumb}${inDeck ? '' : ' ' + styles.comboThumbMissing}`}
      onClick={() => onOpenDetail?.(name)}
      title={name}
    >
      {img ? <img src={img} alt={name} loading="lazy" /> : <span>{name}</span>}
      <span className={styles.comboThumbName}>{name}</span>
    </button>
  )
}

function ComboCard({ combo, deckNames, deckImages, dim, onOpenDetail }) {
  const uses = (combo.uses || []).map(u => u.card?.name || u.template?.name || '').filter(Boolean)
  const requires = (combo.requires || []).map(r => ({
    name: r.template?.name || r.card?.name || '',
    quantity: r.quantity ?? 1,
    zone: (r.zoneLocations || []).join(''),
  })).filter(r => r.name)
  const results = (combo.produces || []).map(p => p.feature?.name || '').filter(Boolean)
  const prereqs = [combo.easyPrerequisites, combo.notablePrerequisites].filter(Boolean).join(' ')
  const steps = combo.description || ''
  // Full + front-face keys: Spellbook may name a DFC by front face while the
  // deck row carries the full "Front // Back" name (and vice versa).
  const deckSet = new Set([...deckNames].flatMap(name => cardNameMatchKeys(name)))

  return (
    <div className={`${styles.comboCard}${dim ? ' ' + styles.comboCardDim : ''}`}>
      <div className={styles.comboThumbs}>
        {uses.map((name, index) => (
          <ComboThumb
            key={`${name}-${index}`}
            name={name}
            inDeck={cardNameMatchKeys(name).some(k => deckSet.has(k))}
            imageUri={deckImages[name]}
            onOpenDetail={onOpenDetail}
          />
        ))}
      </div>
      {requires.length > 0 && (
        <div className={styles.comboResults}>
          {requires.map((r, index) => (
            <span key={`${r.name}-${index}`} className={styles.comboResult}>
              {r.quantity > 1 ? `${r.quantity}x ` : ''}{r.name}{r.zone ? ` (${r.zone})` : ''}
            </span>
          ))}
        </div>
      )}
      {results.length > 0 && (
        <div className={styles.comboResults}>
          {results.slice(0, 6).map((result, index) => (
            <span key={`${result}-${index}`} className={styles.comboResult}>{result}</span>
          ))}
        </div>
      )}
      {prereqs && <div className={styles.comboText}><span>Prerequisites: </span>{prereqs}</div>}
      {steps && <div className={styles.comboText}>{steps}</div>}
    </div>
  )
}

export default function DeckViewPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const { price_source } = useSettings()
  const navigate = useNavigate()

  // ── All state up top (before any conditional returns) ─────────────────────
  const [deck, setDeck]             = useState(null)
  const [deckMeta, setDeckMeta]     = useState({})
  const [cards, setCards]           = useState([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState(null)
  const [creatorNick, setCreatorNick] = useState(null)

  const [detailCard, setDetailCard] = useState(null)
  const [viewMode, setViewMode]     = useState('grid')
  const [hoverImg, setHoverImg]     = useState(null)
  const [hoverPos, setHoverPos]     = useState({ x: 0, y: 0 })
  useEffect(() => {
    const handler = e => setHoverPos({ x: e.clientX, y: e.clientY })
    window.addEventListener('mousemove', handler)
    return () => window.removeEventListener('mousemove', handler)
  }, [])
  const [copying, setCopying]       = useState(false)
  const [copyDone, setCopyDone]     = useState(false)

  const [search,    setSearch]    = useState('')
  const [sortBy,    setSortBy]    = useState('price_desc')
  const [groupBy,   setGroupBy]   = useState('type')
  const [cardSize,  setCardSize]  = useState('comfortable')
  const [showDecklist, setShowDecklist] = useState(false)
  const [decklistCopied, setDecklistCopied] = useState(false)
  const [sfMap,     setSfMap]     = useState({})
  const [combosIncluded, setCombosIncluded] = useState([])
  const [combosLoading, setCombosLoading] = useState(false)
  const [combosFetched, setCombosFetched] = useState(false)
  const [combosCollapsed, setCombosCollapsed] = useState(false)

  const [statsBracketOverride, setStatsBracketOverride] = useState(null)

  // ── Load deck data ──────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      const { data: folder, error: ferr } = await sb.from('folders').select('*').eq('id', id).maybeSingle()
      if (ferr || !folder) {
        setError('Deck not found')
        setLoading(false)
        return
      }
      const meta = parseDeckMeta(folder.description)
      if (!meta.is_public && folder.user_id !== user?.id) {
        setError('Deck not found')
        setLoading(false)
        return
      }
      setDeck(folder)
      setDeckMeta(meta)
      setStatsBracketOverride(meta.bracketManual ? (meta.bracket ?? null) : null)

      // Fetch creator nickname via security-definer RPC (bypasses user_settings RLS)
      sb.rpc('get_user_nickname', { p_user_id: folder.user_id })
        .then(({ data }) => { if (data) setCreatorNick(data) })
        .catch(() => {})

      // Use security-definer RPC: bypasses cards RLS for collection decks
      // so visitors who are not the owner still see the full card list.
      const { data: rpcCards } = await sb.rpc('get_deck_cards_for_view', { p_deck_id: id })
      const deckCards = Array.isArray(rpcCards) ? rpcCards : (rpcCards || [])
      setCards(deckCards)
      setLoading(false)
      if (deckCards.length) {
        loadCardMapWithSharedPrices(deckCards).then(setSfMap).catch(() => {})
      }
    })()
  }, [id, user])

  const fetchCombos = useCallback(async () => {
    if (combosLoading || !cards.length) return
    setCombosLoading(true)
    setCombosCollapsed(false)
    try {
      const combosUrl = import.meta.env.DEV
        ? '/api/combos/find-my-combos/'
        : `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/combo-proxy`
      const body = {
        commanders: cards.filter(c => c.is_commander).map(c => ({ card: c.name })),
        main: cards
          .filter(c => !c.is_commander && normalizeBoard(c.board) === 'main')
          .map(c => ({ card: c.name })),
      }
      const res = await fetch(combosUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(import.meta.env.DEV ? {} : {
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          }),
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`API ${res.status}`)
      const data = await res.json()
      const results = data.results || {}
      setCombosIncluded(results.included || [])
    } catch (e) {
      console.warn('[DeckView combos]', e)
    } finally {
      setCombosFetched(true)
      setCombosLoading(false)
    }
  }, [cards, combosLoading, id])

  // ── Copy deck to own builder ────────────────────────────────────────────────
  async function copyDeck() {
    if (!user || copying) return
    setCopying(true)
    try {
      const newMeta = serializeDeckMeta({ ...deckMeta, copiedFrom: id })
      const { data: existingDecks, error: namesErr } = await sb
        .from('folders')
        .select('name')
        .eq('user_id', user.id)
        .eq('type', 'builder_deck')
      if (namesErr) throw namesErr

      const existingNames = new Set((existingDecks || []).map(row => row.name))
      const baseName = deck.name?.trim() || 'Copied Deck'
      let nextName = baseName
      if (existingNames.has(nextName)) {
        let copyIndex = 2
        nextName = `${baseName} (Copy)`
        while (existingNames.has(nextName)) {
          nextName = `${baseName} (Copy ${copyIndex})`
          copyIndex += 1
        }
      }

      const { data: newFolder, error: folderErr } = await sb
        .from('folders')
        .insert({ name: nextName, type: 'builder_deck', user_id: user.id, description: newMeta })
        .select()
        .single()
      if (folderErr) throw folderErr

      if (cards.length > 0) {
        const categoryRows = [...new Map(
          cards
            .filter(c => c.category_name)
            .map(c => [c.category_id || c.category_name.toLowerCase(), {
              sourceId: c.category_id || null,
              name: c.category_name,
              sort_order: c.category_sort_order ?? 0,
            }])
        ).values()]
        const categoryIdMap = new Map()
        if (categoryRows.length) {
          const { data: createdCategories, error: catErr } = await sb
            .from('deck_categories')
            .insert(categoryRows.map(category => ({
              deck_id: newFolder.id,
              user_id: user.id,
              name: category.name,
              sort_order: category.sort_order,
            })))
            .select('id,name')
          if (catErr) throw catErr
          categoryRows.forEach((category, index) => {
            const created = createdCategories?.[index]
            if (!created) return
            if (category.sourceId) categoryIdMap.set(category.sourceId, created.id)
            categoryIdMap.set(category.name.toLowerCase(), created.id)
          })
        }
        const rows = cards.map(c => ({
          deck_id:          newFolder.id,
          user_id:          user.id,
          card_print_id:    c.card_print_id || null,
          scryfall_id:      c.scryfall_id || null,
          name:             c.name,
          set_code:         c.set_code || null,
          collector_number: c.collector_number || null,
          mana_cost:        c.mana_cost || null,
          cmc:              c.cmc ?? null,
          color_identity:   c.color_identity || [],
          image_uri:        c.image_uri || null,
          qty:              c.qty,
          foil:             c.foil || false,
          is_commander:     c.is_commander || false,
          board:            c.board || 'main',
          type_line:        c.type_line || null,
          category_id:      c.category_id ? (categoryIdMap.get(c.category_id) || null) : (c.category_name ? (categoryIdMap.get(c.category_name.toLowerCase()) || null) : null),
        }))
        const { error: cardsErr } = await sb.from('deck_cards').insert(rows.map(toDeckCardRow))
        if (cardsErr) throw cardsErr
      }

      setCopyDone(true)
      setTimeout(() => navigate(`/builder/${newFolder.id}`), 900)
    } catch (e) {
      console.error('[DeckView] copyDeck error:', e)
      setCopying(false)
    }
  }

  // ── Derived values ─────────────────────────────────────────────────────────
  const isOwner    = user && deck?.user_id === user.id
  const isViewer   = user && deck?.user_id !== user.id
  const builderEditId = deck?.type === 'deck' && deckMeta?.linked_builder_id ? deckMeta.linked_builder_id : id
  const format     = FORMATS.find(f => f.id === deckMeta.format)
  const bracketBadge = deckBracketBadge(deckMeta.format, deckMeta.bracket)
  const totalCards = useMemo(() => cards.filter(c => normalizeBoard(c.board) === 'main').reduce((s, c) => s + c.qty, 0), [cards])
  const allCardsTotal = useMemo(() => cards.reduce((s, c) => s + c.qty, 0), [cards])
  const attractionCount = useMemo(() => cards.filter(c => normalizeBoard(c.board) === 'attraction').reduce((s, c) => s + c.qty, 0), [cards])
  const visibleCards = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return cards
    return cards.filter(card => {
      const sf = getSfCard(sfMap, card)
      return [
        card.name,
        card.type_line,
        card.mana_cost,
        card.set_code,
        card.collector_number,
        card.category_name,
        sf?.type_line,
        sf?.oracle_text,
        sf?.set_name,
        sf?.rarity,
      ].join(' ').toLowerCase().includes(q)
    })
  }, [cards, search, sfMap])
  const categoryOrder = useMemo(() => {
    const custom = [...new Map(
      cards
        .filter(card => card.category_name)
        .sort((a, b) => (a.category_sort_order ?? 999) - (b.category_sort_order ?? 999) || a.category_name.localeCompare(b.category_name))
        .map(card => [card.category_name.toLowerCase(), card.category_name])
    ).values()]
    const inferred = CAT_ORDER.filter(name => !custom.some(category => category.toLowerCase() === name.toLowerCase()))
    return [...custom, ...inferred, 'Uncategorized']
  }, [cards])
  const groupOrder = useMemo(() => {
    if (groupBy === 'category') return categoryOrder
    if (groupBy === 'type') return TYPE_GROUPS
    if (groupBy === 'rarity') return RARITY_GROUP_ORDER
    if (groupBy === 'board') return ['Mainboard', 'Attraction Deck', 'Sideboard', 'Maybeboard']
    if (groupBy === 'color') return COLOR_GROUP_ORDER
    if (groupBy === 'set') {
      return [...new Set(visibleCards.map(card => getSfCard(sfMap, card)?.set_name || card.set_code?.toUpperCase() || 'Unknown'))]
        .sort((a, b) => a.localeCompare(b))
    }
    return []
  }, [categoryOrder, groupBy, sfMap, visibleCards])
  const groupResolver = useCallback((card, sf, mode) => {
    if (mode === 'type') return card.is_commander ? 'Commander' : classifyCardType(sf?.type_line || card.type_line || '')
    if (mode === 'category') {
      if (card.category_name) return card.category_name
      const oracle = [sf?.oracle_text, ...(sf?.card_faces || []).map(face => face.oracle_text)].filter(Boolean).join('\n')
      return getCardCategory(oracle, sf?.type_line || card.type_line || '', sf?.keywords || []) || 'Uncategorized'
    }
    if (mode === 'rarity') return rarityLabel(sf?.rarity)
    if (mode === 'set') return sf?.set_name || card.set_code?.toUpperCase() || 'Unknown'
    if (mode === 'board') return BOARD_LABELS[normalizeBoard(card.board)]
    if (mode === 'color') return colorGroup(sf?.color_identity || card.color_identity)
    return null
  }, [])

  // Sort cards according to sortBy
  const sortCards = useCallback((list) => {
    const copy = [...list]
    if (sortBy === 'name')      return copy.sort((a, b) => a.name.localeCompare(b.name))
    if (sortBy === 'name_desc') return copy.sort((a, b) => b.name.localeCompare(a.name))
    if (sortBy === 'qty') return copy.sort((a, b) => (b.qty ?? 1) - (a.qty ?? 1) || a.name.localeCompare(b.name))
    if (sortBy === 'cmc_asc')  return copy.sort((a, b) => (a.cmc ?? 0) - (b.cmc ?? 0) || a.name.localeCompare(b.name))
    if (sortBy === 'cmc_desc') return copy.sort((a, b) => (b.cmc ?? 0) - (a.cmc ?? 0) || a.name.localeCompare(b.name))
    if (sortBy === 'color') return copy.sort((a, b) => {
      const ca = (a.color_identity || []).join('') || 'Z'
      const cb = (b.color_identity || []).join('') || 'Z'
      return ca.localeCompare(cb) || a.name.localeCompare(b.name)
    })
    if (sortBy === 'rarity_desc' || sortBy === 'rarity') return copy.sort((a, b) => {
      const rA = RARITY_ORDER.indexOf(getSfCard(sfMap, a)?.rarity || 'common')
      const rB = RARITY_ORDER.indexOf(getSfCard(sfMap, b)?.rarity || 'common')
      return rA - rB || a.name.localeCompare(b.name)
    })
    if (sortBy === 'rarity_asc') return copy.sort((a, b) => {
      const rA = RARITY_ORDER.indexOf(getSfCard(sfMap, a)?.rarity || 'common')
      const rB = RARITY_ORDER.indexOf(getSfCard(sfMap, b)?.rarity || 'common')
      return rB - rA || a.name.localeCompare(b.name)
    })
    if (sortBy === 'set') return copy.sort((a, b) => {
      const sA = getSfCard(sfMap, a)?.set_name || a.set_code || ''
      const sB = getSfCard(sfMap, b)?.set_name || b.set_code || ''
      return sA.localeCompare(sB) || a.name.localeCompare(b.name)
    })
    if (sortBy === 'price_desc' || sortBy === 'price') return copy.sort((a, b) => {
      const pA = getPrice(getSfCard(sfMap, a), a.foil, { price_source }) ?? -1
      const pB = getPrice(getSfCard(sfMap, b), b.foil, { price_source }) ?? -1
      return pB - pA || a.name.localeCompare(b.name)
    })
    if (sortBy === 'price_asc') return copy.sort((a, b) => {
      const pA = getPrice(getSfCard(sfMap, a), a.foil, { price_source }) ?? Infinity
      const pB = getPrice(getSfCard(sfMap, b), b.foil, { price_source }) ?? Infinity
      return pA - pB || a.name.localeCompare(b.name)
    })
    return copy // 'type' — groupDeckCards handles ordering
  }, [price_source, sfMap, sortBy])

  const groupedCards  = useMemo(() => groupDeckCards(cards), [cards])
  const sortedFlat    = useMemo(() => sortCards(visibleCards), [sortCards, visibleCards])
  const effectiveViewMode = viewMode === 'list' ? 'table' : viewMode

  // Total deck value
  const totalValueFmt = useMemo(() => {
    const v = cards.reduce((sum, c) => {
      const sfCard = sfMap[getScryfallKey(c)]
      const p = getPrice(sfCard, c.foil, { price_source })
      return p != null ? sum + p * c.qty : sum
    }, 0)
    return v > 0 ? formatPrice(v, price_source) : null
  }, [cards, sfMap, price_source])

  // Build plain-text decklist for copy
  const cardLine = (c) => {
    let line = `${c.qty} ${c.name}`
    if (c.set_code && c.collector_number) line += ` (${c.set_code.toUpperCase()}) ${c.collector_number}`
    if (c.foil) line += ' *F*'
    return line
  }
  const buildDecklist = useCallback(() => {
    const commander = cards.filter(c => c.is_commander)
    const main      = cards.filter(c => !c.is_commander && normalizeBoard(c.board) === 'main')
    const attractions = cards.filter(c => normalizeBoard(c.board) === 'attraction')
    const side      = cards.filter(c => c.board === 'side')
    const lines = []
    if (commander.length) {
      lines.push('// Commander')
      commander.forEach(c => lines.push(cardLine(c)))
      lines.push('')
    }
    if (groupBy === 'type') {
      TYPE_GROUPS.forEach(group => {
        const gc = groupedCards.get(group)?.filter(c => !c.is_commander && normalizeBoard(c.board) === 'main')
        if (!gc?.length) return
        lines.push(`// ${group}`)
        sortCards(gc).forEach(c => lines.push(cardLine(c)))
        lines.push('')
      })
    } else {
      if (main.length) {
        lines.push('// Main')
        sortCards(main).forEach(c => lines.push(cardLine(c)))
        lines.push('')
      }
    }
    if (attractions.length) {
      lines.push('// Attractions')
      sortCards(attractions).forEach(c => lines.push(cardLine(c)))
      lines.push('')
    }
    if (side.length) {
      lines.push('// Sideboard')
      sortCards(side).forEach(c => lines.push(cardLine(c)))
    }
    return lines.join('\n').trim()
  }, [cards, groupBy, groupedCards, sortCards])

  // ── Loading / error states ─────────────────────────────────────────────────
  if (loading) return (
    <div className={styles.signinPage}>
      <div className={styles.signinLogo}>
        <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
        <span className={styles.logoText}>Deck<span>Loom</span></span>
      </div>
      <div className={styles.signinMsg} style={{ fontStyle: 'italic' }}>Loading deck…</div>
    </div>
  )

  if (error) return (
    <div className={styles.signinPage}>
      <div className={styles.signinMsg}>{error}</div>
      <Link to="/" className={styles.signinLink}>Go to DeckLoom</Link>
    </div>
  )

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={styles.page}>

      {/* Card detail modal */}
      {detailCard && <CardDetailModal card={detailCard} onClose={() => setDetailCard(null)} />}

      {/* ── Top bar ── */}
      <div className={styles.topBar}>
        <Link to="/" className={styles.logo}>
          <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
          <span className={styles.logoText}>Deck<span>Loom</span></span>
        </Link>

        <div className={styles.topActions}>
          {!user ? (
            <>
              <Link to="/login" className={styles.signInBtn}>Sign In</Link>
              <Link to="/login" className={styles.actionLink}>Create Account</Link>
            </>
          ) : (
            <>
              <button
                type="button"
                className={styles.backBtn}
                onClick={() => {
                  if (window.history.length > 1) navigate(-1)
                  else navigate(deck?.type === 'builder_deck' ? '/builder' : '/decks')
                }}
              >
                <span aria-hidden="true" className={styles.backArrow}>←</span>
                <span>Back</span>
              </button>
              {isOwner && (
                <Link to={`/builder/${builderEditId}`} className={styles.actionLink}>⚔ Edit in Builder</Link>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Guest banner ── */}
      {!user && (
        <div className={styles.guestBanner}>
          Want to try DeckLoom?{' '}
          <Link to="/login" className={styles.guestBannerLink}>Sign up.</Link>
        </div>
      )}

      {/* ── Deck header ── */}
      <div className={styles.deckHeader}>
        <div className={styles.deckHeaderInner}>
          <div className={styles.deckInfo}>
            <div className={styles.deckTitleRow}>
              <h1 className={styles.deckTitle}>{deck.name}</h1>
              {deckMeta.is_public && <DeckLikeButton deckId={id} user={user} />}
            </div>
            {creatorNick && (
              <div className={styles.deckCreator}>
                by{' '}
                <Link to={`/profile/${encodeURIComponent(creatorNick)}`} className={styles.deckCreatorLink}>
                  {creatorNick}
                </Link>
              </div>
            )}
            <div className={styles.deckMeta}>
              {format && <span className={styles.metaPill}>{format.label}</span>}
              {bracketBadge && (
                <span
                  className={styles.metaPill}
                  style={{ borderColor: `${bracketBadge.color}55`, color: bracketBadge.color }}
                  title={bracketBadge.desc}
                >
                  B{deckMeta.bracket} · {bracketBadge.label}
                </span>
              )}
              <span className={styles.metaPill}>{totalCards} cards</span>
              {attractionCount > 0 && <span className={styles.metaPill}>{attractionCount} attractions</span>}
              {totalValueFmt && <span className={`${styles.metaPill} ${styles.deckValue}`}>{totalValueFmt}</span>}
              {deckMeta.commanders?.length > 0 && (
                <span className={styles.commanderBadge}>⚔ {deckMeta.commanders.map(c => c.name).join(' + ')}</span>
              )}
              {!deckMeta.commanders?.length && deckMeta.commanderName && (
                <span className={styles.commanderBadge}>⚔ {deckMeta.commanderName}</span>
              )}
            </div>
          </div>

          {isViewer ? (
            <div className={styles.viewerBanner}>
              <div className={styles.viewerCopy}>
                <div className={styles.viewerEyebrow}>Shared Deck</div>
                <div className={styles.viewerText}>Copy this list straight into your deckbuilder.</div>
              </div>
              <div className={styles.viewerActions}>
                <button
                  onClick={copyDeck}
                  disabled={copying || copyDone}
                  className={`${styles.actionBtn}${copyDone ? ' ' + styles.actionBtnDone : ''}`}
                >
                  {copyDone ? 'Added to Deckbuilder' : copying ? 'Copying...' : '+ Copy to My Deckbuilder'}
                </button>
                <button
                  className={`${styles.actionBtn}${showDecklist ? ' ' + styles.actionBtnActive : ''}`}
                  onClick={() => setShowDecklist(v => !v)}
                >
                  Copy Decklist
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.deckHeaderActions}>
              <button
                className={`${styles.actionBtn}${showDecklist ? ' ' + styles.actionBtnActive : ''}`}
                onClick={() => setShowDecklist(v => !v)}
              >
                Copy Decklist
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Deck primer (Markdown description) ── */}
      {deckMeta.description?.trim() && (() => {
        const headings = extractHeadings(deckMeta.description)
        return (
          <div className={styles.primer}>
            <div className={styles.primerLabel}>Primer</div>
            {headings.length >= 2 && (
              <nav className={styles.primerToc} aria-label="Primer contents">
                {headings.map(h => (
                  <button
                    key={h.slug}
                    className={styles.primerTocItem}
                    style={{ paddingLeft: `${(h.level - 1) * 12}px` }}
                    onClick={() => document.getElementById(h.slug)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  >
                    {h.text}
                  </button>
                ))}
              </nav>
            )}
            <Markdown source={deckMeta.description} headingSlugs className={styles.primerBody} />
          </div>
        )
      })()}

      {/* ── Inline decklist panel ── */}
      {showDecklist && (() => {
        const text = buildDecklist()
        return (
          <div className={styles.decklistInline}>
            <div className={styles.decklistInlineHeader}>
              <span className={styles.decklistTitle}>Decklist</span>
              <button
                className={`${styles.actionBtn}${decklistCopied ? ' ' + styles.actionBtnDone : ''}`}
                onClick={() => {
                  navigator.clipboard.writeText(text)
                  setDecklistCopied(true)
                  setTimeout(() => setDecklistCopied(false), 2000)
                }}
              >
                {decklistCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className={styles.decklistText}>{text}</pre>
          </div>
        )
      })()}

      {/* ── Body: deck list (dominant) + right sidebar ── */}
      <div className={styles.body}>

        {/* ── Left: deck list — the star of the page ── */}
        <div className={styles.deckListPanel}>

          {/* Header: label + controls */}
          <div className={styles.listHeader}>
            <div className={styles.listHeading}>
              <span className={styles.listLabel}>Decklist</span>
              <span className={styles.listCount}>
                {visibleCards.reduce((sum, card) => sum + (card.qty || 0), 0)} / {allCardsTotal}
              </span>
            </div>
            <div className={styles.listToolbar}>
              <label className={styles.searchBox}>
                <SearchIcon size={14} />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search deck..."
                  aria-label="Search deck"
                />
              </label>
              {/* Sort menu */}
              <ResponsiveMenu
                title="Sort"
                trigger={({ open, toggle }) => (
                  <button
                    className={`${styles.controlBtn} ${open ? styles.controlBtnActive : ''}`}
                    onClick={toggle}
                    aria-label={`Sort deck by ${SORT_OPTIONS.find(option => option.id === sortBy)?.label || 'Type'}`}
                  >
                    <SortIcon size={14} />
                    <span>Sort</span>
                    <ChevronDownIcon size={12} className={`${styles.controlChevron}${open ? ' ' + styles.controlChevronOpen : ''}`} />
                  </button>
                )}
              >
                {({ close }) => (
                  <div className={uiStyles.responsiveMenuList}>
                    {SORT_OPTIONS.map(opt => (
                      <button
                        key={opt.id}
                        className={`${uiStyles.responsiveMenuAction}${sortBy === opt.id ? ' ' + uiStyles.responsiveMenuActionActive : ''}`}
                        onClick={() => { setSortBy(opt.id); close() }}
                      >
                        {opt.label}
                        <span className={uiStyles.responsiveMenuCheck}>{sortBy === opt.id ? <CheckIcon size={11} /> : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </ResponsiveMenu>
              <ResponsiveMenu
                title="Group"
                trigger={({ open, toggle }) => (
                  <button
                    className={`${styles.controlBtn} ${open ? styles.controlBtnActive : ''}`}
                    onClick={toggle}
                    aria-label={`Group deck by ${GROUP_OPTIONS.find(option => option.id === groupBy)?.label || 'None'}`}
                  >
                    <StacksViewIcon size={14} />
                    <span>Group</span>
                    <ChevronDownIcon size={12} className={`${styles.controlChevron}${open ? ' ' + styles.controlChevronOpen : ''}`} />
                  </button>
                )}
              >
                {({ close }) => (
                  <div className={uiStyles.responsiveMenuList}>
                    {GROUP_OPTIONS.map(opt => (
                      <button
                        key={opt.id}
                        className={`${uiStyles.responsiveMenuAction}${groupBy === opt.id ? ' ' + uiStyles.responsiveMenuActionActive : ''}`}
                        onClick={() => { setGroupBy(opt.id); close() }}
                      >
                        {opt.label}
                        <span className={uiStyles.responsiveMenuCheck}>{groupBy === opt.id ? <CheckIcon size={11} /> : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </ResponsiveMenu>
              <ResponsiveMenu
                title="Card Size"
                trigger={({ open, toggle }) => (
                  <button
                    className={`${styles.controlBtn} ${open ? styles.controlBtnActive : ''}`}
                    onClick={toggle}
                    aria-label={`Card size ${CARD_SIZE_OPTIONS.find(option => option.id === cardSize)?.label || 'Medium'}`}
                  >
                    <GridViewIcon size={14} />
                    <span>Size</span>
                    <ChevronDownIcon size={12} className={`${styles.controlChevron}${open ? ' ' + styles.controlChevronOpen : ''}`} />
                  </button>
                )}
              >
                {({ close }) => (
                  <div className={uiStyles.responsiveMenuList}>
                    {CARD_SIZE_OPTIONS.map(opt => (
                      <button
                        key={opt.id}
                        className={`${uiStyles.responsiveMenuAction}${cardSize === opt.id ? ' ' + uiStyles.responsiveMenuActionActive : ''}`}
                        onClick={() => { setCardSize(opt.id); close() }}
                      >
                        {opt.label}
                        <span className={uiStyles.responsiveMenuCheck}>{cardSize === opt.id ? <CheckIcon size={11} /> : ''}</span>
                      </button>
                    ))}
                  </div>
                )}
              </ResponsiveMenu>
              {/* View toggle — all 5 modes */}
              <div className={styles.viewToggles}>
                {[
                  { id: 'stacks', Icon: StacksViewIcon, label: 'Stacks' },
                  { id: 'text',   Icon: TextViewIcon,   label: 'Text' },
                  { id: 'grid',   Icon: GridViewIcon,   label: 'Grid' },
                  { id: 'table',  Icon: TableViewIcon,  label: 'Table' },
                ].map(m => (
                  <button
                    key={m.id}
                    className={`${styles.vBtn}${effectiveViewMode === m.id ? ' ' + styles.vBtnActive : ''}`}
                    title={m.label}
                    onClick={() => setViewMode(m.id)}
                  ><m.Icon size={13} /></button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Card browser content ── */}
          <div className={styles.browserContent}>
            <CardBrowserContent
              cards={sortedFlat}
              sfMap={sfMap}
              priceSource={price_source}
              viewMode={effectiveViewMode}
              groupBy={groupBy}
              groupResolver={groupResolver}
              groupOrder={groupOrder}
              density={cardSize}
              onSelect={card => setDetailCard(card)}
              onHover={effectiveViewMode !== 'grid' ? img => setHoverImg(img) : undefined}
              onHoverEnd={effectiveViewMode !== 'grid' ? () => setHoverImg(null) : undefined}
            />
          </div>

          {cards.length === 0 && (
            <div className={styles.emptyDeck}>This deck has no cards yet.</div>
          )}
          {cards.length > 0 && visibleCards.length === 0 && (
            <div className={styles.emptyDeck}>No cards match this search.</div>
          )}
        </div>

        {/* Floating hover preview */}
        {hoverImg && (
          <img
            src={hoverImg}
            alt=""
            className={styles.hoverPreview}
            style={{
              left: hoverPos.x + 18,
              top: Math.min(hoverPos.y - 60, window.innerHeight - 320),
            }}
          />
        )}

        {/* ── Right sidebar ── */}
        <div className={styles.sidebar}>
          {cards.length > 0 && (
            <div className={styles.combosPanel}>
              <div className={styles.combosHeader}>
                <div>
                  <div className={styles.combosEyebrow}>Commander Spellbook</div>
                  <div className={styles.combosTitle}>Combos</div>
                </div>
                <div className={styles.combosActions}>
                  {!combosLoading && combosFetched && (
                    <button className={styles.comboRefreshBtn} onClick={() => setCombosCollapsed(v => !v)}>
                      <ChevronDownIcon size={12} className={`${styles.comboCollapseIcon}${combosCollapsed ? ' ' + styles.comboCollapseIconClosed : ''}`} />
                      {combosCollapsed ? 'Expand' : 'Collapse'}
                    </button>
                  )}
                  {!combosLoading && (
                    <button className={styles.comboRefreshBtn} onClick={fetchCombos}>
                      {combosFetched ? 'Refresh' : 'Find Combos'}
                    </button>
                  )}
                </div>
              </div>
              {!combosFetched && !combosLoading && (
                <div className={styles.combosPrompt}>Check this deck for complete combo lines already included in the list.</div>
              )}
              {combosLoading && <div className={styles.combosLoading}>Checking Commander Spellbook...</div>}
              {!combosLoading && combosFetched && combosIncluded.length === 0 && (
                <div className={styles.combosEmpty}>No combos found for this deck.</div>
              )}
              {!combosLoading && combosFetched && combosIncluded.length > 0 && combosCollapsed && (
                <div className={styles.combosSummary}>
                  {combosIncluded.length} complete combo{combosIncluded.length === 1 ? '' : 's'} found.
                </div>
              )}
              {!combosLoading && combosFetched && combosIncluded.length > 0 && !combosCollapsed && (
                <>
                  <div className={styles.comboSubLabel}>
                    Complete <span className={styles.comboCount}>{combosIncluded.length}</span>
                  </div>
                  {combosIncluded.map((combo, index) => (
                    <ComboCard
                      key={`included-${index}`}
                      combo={combo}
                      deckNames={cards.map(card => card.name)}
                      deckImages={Object.fromEntries(cards.map(card => [card.name, card.image_uri]).filter(([, uri]) => uri))}
                      onOpenDetail={setDetailCard}
                    />
                  ))}
                </>
              )}
            </div>
          )}
          {cards.length > 0 && (
            <div>
              <div className={styles.sectionLabel}>Stats</div>
              <DeckStats
                cards={normalizeDeckBuilderCards(cards.filter(card => normalizeBoard(card.board) === 'main'), sfMap)}
                bracketOverride={statsBracketOverride}
                onBracketOverride={isOwner ? setStatsBracketOverride : undefined}
              />
            </div>
          )}
        </div>
      </div>

      {deckMeta.is_public && <DeckComments deckId={id} user={user} />}
    </div>
  )
}
