import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { getInstantCache, getPrice, formatPrice, getImageUri, sfGet } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { getLocalCards, getLocalFolders, getAllLocalFolderCards, getAllDeckAllocationsForUser, putCards } from '../lib/db'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { Select } from '../components/UI'
import styles from './Home.module.css'
import { TypeLineFilter } from '../components/CardComponents'
import { CloseIcon, CheckIcon, WarningIcon, BannedIcon, ChevronDownIcon, ChevronUpIcon, ChevronRightIcon, DiceIcon, ImageIcon } from '../icons'

// ── Recently Viewed (localStorage + custom event for live update) ─────────────
const VIEWED_KEY = 'arcanevault_recently_viewed'
function getRecentlyViewed() {
  try { return JSON.parse(localStorage.getItem(VIEWED_KEY) || '[]') } catch { return [] }
}
function addRecentlyViewed(card) {
  if (!card?.id) return
  const entry = {
    id:       card.id,
    name:     card.name,
    set_name: card.set_name || '',
    image:    card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || card.image_uri || null,
    eur:      card.prices?.eur  || null,
    usd:      card.prices?.usd  || null,
  }
  const prev = getRecentlyViewed().filter(c => c.id !== card.id)
  localStorage.setItem(VIEWED_KEY, JSON.stringify([entry, ...prev].slice(0, 24)))
  window.dispatchEvent(new CustomEvent('av:viewed'))
}

// ── Collection data loader ────────────────────────────────────────────────────
// Uses IDB (same store Collection.jsx syncs into) — no Supabase RLS issues.
// Falls back to a fresh Supabase pull if IDB is empty (first visit on device).
async function loadCollectionData(userId) {
  // IDB reads + price cache in parallel — fast
  const [idbCards, idbFolders, sfMap] = await Promise.all([
    getLocalCards(userId),
    getLocalFolders(userId),
    getInstantCache(),
  ])

  let safeSfMap = sfMap || {}

  // Prefer IDB folders; if IDB is cold, pull from Supabase
  let allFolders = idbFolders?.length ? idbFolders : []
  if (!allFolders.length) {
    const { data } = await sb.from('folders').select('id, name, type').eq('user_id', userId)
    allFolders = data || []
  }

  // Same for cards
  let allCards = idbCards?.length ? idbCards : []
  if (!allCards.length) {
    const { data, error } = await sb.from('cards')
      .select('*').eq('user_id', userId).order('name')
    if (error) console.warn('[Home] cards fallback error:', error.message)
    allCards = data || []
  }

  const folderIds = allFolders.map(f => f.id)

  const deckIds = allFolders.filter(f => f.type === 'deck').map(f => f.id)
  const placementFolderIds = allFolders.filter(f => f.type !== 'deck').map(f => f.id)

  // Get folder_cards and deck_allocations from IDB; fall back to Supabase if IDB is cold
  let allFc = placementFolderIds.length ? await getAllLocalFolderCards(placementFolderIds) : []
  if (!allFc.length && placementFolderIds.length) {
    let from = 0
    while (true) {
      const { data: page, error } = await sb.from('folder_cards')
        .select('id, folder_id, card_id, qty')
        .in('folder_id', placementFolderIds)
        .range(from, from + 999)
      if (error) { console.warn('[Home] folder_cards fallback error:', error.message); break }
      if (page?.length) allFc = [...allFc, ...page]
      if (!page || page.length < 1000) break
      from += 1000
    }
  }

  let allDa = deckIds.length ? await getAllDeckAllocationsForUser(userId) : []
  if (!allDa.length && deckIds.length) {
    let from = 0
    while (true) {
      const { data: page, error } = await sb.from('deck_allocations')
        .select('id, deck_id, card_id, qty, user_id')
        .eq('user_id', userId)
        .in('deck_id', deckIds)
        .range(from, from + 999)
      if (error) { console.warn('[Home] deck_allocations fallback error:', error.message); break }
      if (page?.length) allDa = [...allDa, ...page]
      if (!page || page.length < 1000) break
      from += 1000
    }
  }

  // Join in memory
  const cardById  = Object.fromEntries(allCards.map(c => [c.id, c]))
  const cardRows  = allFc.map(r => ({ ...r, cards: cardById[r.card_id] || null }))
  const deckRows = allDa.map(r => ({ ...r, cards: cardById[r.card_id] || null }))

  // Recently added — unique cards newest first
  const seen = new Set()
  const recentCards = [...allCards]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .filter(c => seen.has(c.id) ? false : (seen.add(c.id), true))
    .slice(0, 14)

  if (allCards.length) {
    safeSfMap = await loadCardMapWithSharedPrices(allCards)
  }

  return { folders: allFolders, cards: allCards, cardRows, deckRows, sfMap: safeSfMap, recentCards }
}

// Syncs cards from Supabase into IDB and returns updated cards array if anything changed.
// Returns null when offline or when the data matches what we already have.
async function syncCardsFromSupabase(userId, currentCards) {
  if (!navigator.onLine) return null
  try {
    let fresh = [], from = 0
    while (true) {
      const { data, error } = await sb.from('cards')
        .select('*').eq('user_id', userId).order('name')
        .range(from, from + 999)
      if (error) { console.warn('[Home] sync error:', error.message); return null }
      if (data?.length) fresh = [...fresh, ...data]
      if (!data || data.length < 1000) break
      from += 1000
    }
    // Compare total qty to decide if a re-render is needed
    const currentQty = currentCards.reduce((s, c) => s + (c.qty || 1), 0)
    const freshQty   = fresh.reduce((s, c) => s + (c.qty || 1), 0)
    if (fresh.length === currentCards.length && freshQty === currentQty) return null
    await putCards(fresh)
    return fresh
  } catch (e) {
    console.warn('[Home] sync exception:', e)
    return null
  }
}

// ── Scryfall sets cache (used by SetCompletionSection) ────────────────────────
const SETS_CACHE_KEY = 'av_scryfall_sets'
const SETS_CACHE_TTL = 24 * 60 * 60 * 1000
async function fetchScryfallSetsMap() {
  try {
    const raw = localStorage.getItem(SETS_CACHE_KEY)
    if (raw) {
      const { ts, data } = JSON.parse(raw)
      if (Date.now() - ts < SETS_CACHE_TTL) return data
    }
    const r = await fetch('https://api.scryfall.com/sets')
    const json = await r.json()
    const data = {}
    for (const s of (json.data || [])) data[s.code] = { name: s.name, count: s.card_count }
    localStorage.setItem(SETS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }))
    return data
  } catch { return {} }
}

// ── Scryfall API helpers ──────────────────────────────────────────────────────
async function fetchRandom() {
  return sfGet('https://api.scryfall.com/cards/random')
}
// Returns card objects (with images) for the autocomplete dropdown
async function fetchAutocomplete(q) {
  const data = await sfGet(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=names&order=name`)
  return (data?.data || []).slice(0, 9)
}
async function fetchByName(name) {
  return sfGet(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`)
}
async function fetchPrintings(cardName) {
  const q = `!"${cardName}"`
  const data = await sfGet(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`)
  return data?.data || []
}
async function fetchSearchResults(q, nextPageUrl = null) {
  const url = nextPageUrl || `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=name&unique=cards`
  const json = await sfGet(url)
  if (!json) return { data: [], nextPage: null, total: 0 }
  return { data: json.data || [], nextPage: json.next_page || null, total: json.total_cards || 0 }
}
async function fetchRulings(card) {
  const url = card.rulings_uri || `https://api.scryfall.com/cards/${card.set}/${card.collector_number}/rulings`
  const data = await sfGet(url)
  return data?.data || []
}
// Verified working feeds (2026-03-18):
//   MTGGoldfish → Atom format  (entries, link[href] attribute)
//   EDHREC      → RSS 2.0      (items, link text content)
//   MTGArenaZone→ RSS 2.0      (items, link text content)
// Proxy: api.codetabs.com/v1/proxy — returns raw feed text, no JSON wrapper
const NEWS_FEEDS = [
  { url: 'https://www.mtggoldfish.com/feed',     label: 'MTGGoldfish',    color: '#5a9a6a' },
  { url: 'https://edhrec.com/articles/feed',     label: 'EDHREC',         color: '#9a7acc' },
  { url: 'https://mtgazone.com/feed',            label: 'MTG Arena Zone', color: '#5aafcc' },
]

function parseRssFeed(xmlText, label, color) {
  try {
    const doc    = new DOMParser().parseFromString(xmlText, 'text/xml')
    if (doc.querySelector('parsererror')) return []

    // Atom uses <feed>/<entry>; RSS 2.0 uses <rss>/<channel>/<item>
    const isAtom = !!doc.querySelector('feed')
    const nodes  = isAtom
      ? [...doc.querySelectorAll('entry')]
      : [...doc.querySelectorAll('item')]

    return nodes.slice(0, 8).map(node => {
      const text = (...tags) => {
        for (const tag of tags) {
          const v = node.querySelector(tag)?.textContent?.trim()
          if (v) return v
        }
        return ''
      }

      // Atom <link> has href attribute; RSS <link> has text content or <guid>
      let link = ''
      if (isAtom) {
        const el = node.querySelector('link[rel="alternate"], link[type="text/html"], link')
        link = el?.getAttribute('href') || el?.textContent?.trim() || ''
      } else {
        link = text('link', 'guid')
      }

      const desc   = isAtom ? text('content', 'summary') : text('description', 'summary')
      const pubDate = isAtom ? text('published', 'updated') : text('pubDate', 'updated')
      const author  = isAtom
        ? node.querySelector('author > name')?.textContent?.trim() || text('author')
        : node.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator')[0]
            ?.textContent?.trim() || text('author', 'creator')

      // Thumbnail: enclosure → any [url] attr (media:*) → first <img> in description
      let thumbnail = null
      const enc = node.querySelector('enclosure[url]')
      if (enc?.getAttribute('type')?.startsWith('image')) thumbnail = enc.getAttribute('url')
      if (!thumbnail) thumbnail = node.querySelector('[url]')?.getAttribute('url') || null
      if (!thumbnail && desc) thumbnail = desc.match(/<img[^>]+src=["']([^"']+)["']/)?.[1] ?? null

      return {
        title:       text('title'),
        link:        link.startsWith('http') ? link : '',
        pubDate,
        description: desc,
        thumbnail:   thumbnail?.startsWith('http') ? thumbnail : null,
        author,
        _source:     label,
        _sourceColor: color,
      }
    }).filter(a => a.title && a.link)
  } catch { return [] }
}

async function fetchMTGNews() {
  const PROXY = 'https://api.codetabs.com/v1/proxy?quest='
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async feed => {
      const res = await fetch(PROXY + encodeURIComponent(feed.url))
      if (!res.ok) return []
      const text = await res.text()    // codetabs returns raw feed text, not JSON
      return parseRssFeed(text, feed.label, feed.color)
    })
  )
  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 12)
}

async function fetchUpcomingSets() {
  const json = await sfGet('https://api.scryfall.com/sets')
  if (!json) return []
  const today = new Date().toISOString().slice(0, 10)
  const interesting = new Set(['expansion', 'core', 'masters', 'draft_innovation', 'commander', 'starter_deck'])
  return (json.data || [])
    .filter(s => s.released_at > today && interesting.has(s.set_type))
    .sort((a, b) => a.released_at.localeCompare(b.released_at))
    .slice(0, 8)
}

// ── Advanced search helpers ───────────────────────────────────────────────────
const ADV_COLORS = [
  { id: 'W', label: 'W', title: 'White',    img: 'W' },
  { id: 'U', label: 'U', title: 'Blue',     img: 'U' },
  { id: 'B', label: 'B', title: 'Black',    img: 'B' },
  { id: 'R', label: 'R', title: 'Red',      img: 'R' },
  { id: 'G', label: 'G', title: 'Green',    img: 'G' },
  { id: 'C', label: 'C', title: 'Colorless',img: 'C' },
]
const ADV_RARITIES = [
  { id: 'common',   label: 'Common' },
  { id: 'uncommon', label: 'Uncommon' },
  { id: 'rare',     label: 'Rare' },
  { id: 'mythic',   label: 'Mythic' },
]
const ADV_FORMATS = [
  'commander','standard','pioneer','modern','legacy','vintage','pauper','oathbreaker'
]
const EMPTY_ADV = {
  colors: [], colorMode: 'includes',
  types: [],
  cmcOp: '', cmcVal: '',
  rarity: '',
  oracle: '',
  format: '',
}

function buildScryfallQuery(name, adv) {
  const tokens = []
  if (name?.trim()) tokens.push(name.trim())
  if (adv.colors.length) {
    const c = adv.colors.join('')
    if (adv.colorMode === 'exactly')  tokens.push(`c=${c}`)
    else if (adv.colorMode === 'at_least') tokens.push(`c>=${c}`)
    else tokens.push(`c:${c}`)
  }
  adv.types?.forEach(t => tokens.push(`t:${t}`))
  if (adv.cmcOp && adv.cmcVal !== '') tokens.push(`cmc${adv.cmcOp}${adv.cmcVal}`)
  if (adv.rarity)          tokens.push(`r:${adv.rarity}`)
  if (adv.oracle?.trim())  tokens.push(`o:"${adv.oracle.trim()}"`)
  if (adv.format)          tokens.push(`f:${adv.format}`)
  return tokens.join(' ')
}

function hasAdvFilters(adv) {
  return adv.colors.length > 0 || adv.types?.length > 0 || adv.cmcVal !== '' || adv.rarity || adv.oracle || adv.format
}

// ── Advanced Search Panel ─────────────────────────────────────────────────────
function AdvancedSearchPanel({ adv, set }) {
  const toggle = (key, val) => set(prev => ({
    ...prev,
    [key]: prev[key].includes(val) ? prev[key].filter(x => x !== val) : [...prev[key], val]
  }))

  const inp = (key) => ({
    value: adv[key],
    onChange: e => set(prev => ({ ...prev, [key]: e.target.value }))
  })

  return (
    <div className={styles.advPanel}>
      {/* Colors */}
      <div className={styles.advRow}>
        <span className={styles.advLabel}>Color</span>
        <div className={styles.advColorWrap}>
          {ADV_COLORS.map(c => (
            <button key={c.id}
              className={`${styles.advColorBtn} ${adv.colors.includes(c.id) ? styles.advColorBtnActive : ''}`}
              onClick={() => toggle('colors', c.id)}
              title={c.title}>
              <img src={`https://svgs.scryfall.io/card-symbols/${c.img}.svg`} alt={c.title}
                style={{ width: 18, height: 18, pointerEvents: 'none' }} />
            </button>
          ))}
          {adv.colors.length > 0 && (
            <Select className={styles.advSelect} style={{ marginLeft: 6 }}
              value={adv.colorMode}
              onChange={e => set(prev => ({ ...prev, colorMode: e.target.value }))}
              title="Select color mode">
              <option value="includes">Includes</option>
              <option value="exactly">Exactly</option>
              <option value="at_least">At least</option>
            </Select>
          )}
        </div>
      </div>

      {/* Type & CMC row */}
      <div className={styles.advRow} style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className={styles.advLabel}>Type</span>
        <div style={{ flex: 1, minWidth: 180 }}>
          <TypeLineFilter
            selected={adv.types}
            onChange={types => set(prev => ({ ...prev, types }))}
          />
        </div>
        <span className={styles.advLabel} style={{ marginLeft: 4 }}>CMC</span>
        <Select className={styles.advSelect}
          value={adv.cmcOp}
          onChange={e => set(prev => ({ ...prev, cmcOp: e.target.value }))}
          title="Select CMC filter">
          <option value="">Any</option>
          <option value="=">= (equal)</option>
          <option value="<">{'< (less)'}</option>
          <option value="<=">{'≤ (max)'}</option>
          <option value=">">{'> (more)'}</option>
          <option value=">=">{'>= (min)'}</option>
        </Select>
        {adv.cmcOp && (
          <input className={styles.advInput} style={{ width: 54 }}
            id="card-search-cmc"
            name="cmc"
            type="number" min="0" step="1" placeholder="0"
            value={adv.cmcVal}
            onChange={e => set(prev => ({ ...prev, cmcVal: e.target.value }))} />
        )}
      </div>

      {/* Rarity & Format row */}
      <div className={styles.advRow}>
        <span className={styles.advLabel}>Rarity</span>
        <div className={styles.advChips}>
          {ADV_RARITIES.map(r => (
            <button key={r.id}
              className={`${styles.advChip} ${adv.rarity === r.id ? styles.advChipActive : ''}`}
              onClick={() => set(prev => ({ ...prev, rarity: prev.rarity === r.id ? '' : r.id }))}>
              {r.label}
            </button>
          ))}
        </div>
        <span className={styles.advLabel} style={{ marginLeft: 10 }}>Format</span>
        <Select className={styles.advSelect}
          value={adv.format}
          onChange={e => set(prev => ({ ...prev, format: e.target.value }))}
          title="Select format">
          <option value="">Any</option>
          {ADV_FORMATS.map(f => <option key={f} value={f}>{f.charAt(0).toUpperCase() + f.slice(1)}</option>)}
        </Select>
      </div>

      {/* Oracle text */}
      <div className={styles.advRow}>
        <span className={styles.advLabel}>Text</span>
        <input className={styles.advInput} style={{ flex: 1 }}
          id="card-search-oracle"
          name="oracle"
          placeholder='Oracle text contains… (e.g. "draw a card")' {...inp('oracle')} />
      </div>
    </div>
  )
}

// ── Mana symbol renderer ──────────────────────────────────────────────────────
function ManaSymbol({ sym, size = 18 }) {
  const key = sym.replace(/\//g, '').toUpperCase()
  return (
    <img src={`https://svgs.scryfall.io/card-symbols/${key}.svg`} alt={`{${sym}}`}
      style={{ width: size, height: size, verticalAlign: 'middle', display: 'inline-block', flexShrink: 0 }} />
  )
}
function ManaCost({ cost, size = 18 }) {
  if (!cost) return null
  const syms = [...cost.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
  return <span className={styles.manaCostRow}>{syms.map((s, i) => <ManaSymbol key={i} sym={s} size={size} />)}</span>
}
function renderWithSymbols(text, symSize = 16) {
  if (!text) return null
  return text.split(/(\{[^}]+\})/g).map((part, i) => {
    const m = part.match(/^\{([^}]+)\}$/)
    if (m) {
      const key = m[1].replace(/\//g, '').toUpperCase()
      return <img key={i} src={`https://svgs.scryfall.io/card-symbols/${key}.svg`} alt={part}
        style={{ width: symSize, height: symSize, verticalAlign: 'middle', display: 'inline-block', margin: '0 1px' }} />
    }
    return part
  })
}
function OracleText({ text }) {
  if (!text) return <p className={styles.oracleEmpty}>No oracle text.</p>
  return (
    <>
      {text.split('\n').map((line, i) => (
        <p key={i} className={styles.oracleLine}>{renderWithSymbols(line)}</p>
      ))}
    </>
  )
}
function getCardImage(card, size = 'normal', face = 0) {
  if (!card) return null
  if (card.card_faces?.[face]?.image_uris) return card.card_faces[face].image_uris[size] || card.card_faces[face].image_uris.normal
  return card.image_uris?.[size] || card.image_uris?.normal || null
}
function rarityColor(r) {
  return r === 'mythic' ? '#e8942a' : r === 'rare' ? '#c0a060' : r === 'uncommon' ? '#9ab4cc' : 'var(--text-faint)'
}

// ── Card Detail View ──────────────────────────────────────────────────────────
function CardView({ card: initialCard, onClose, badge }) {
  const [card, setCard]   = useState(initialCard)
  const [tab, setTab]     = useState('rules')
  const [face, setFace]   = useState(0)
  const [rulings, setRulings]   = useState(null)
  const [printings, setPrintings] = useState([])

  // Reset when the initial card changes (new search result)
  useEffect(() => { setCard(initialCard); setTab('rules'); setFace(0); setRulings(null); setPrintings([]) }, [initialCard.id])

  // Fetch all printings for this card
  useEffect(() => {
    let cancelled = false
    fetchPrintings(initialCard.name).then(list => { if (!cancelled) setPrintings(list) })
    return () => { cancelled = true }
  }, [initialCard.name])

  useEffect(() => {
    if (tab === 'rulings' && rulings === null) fetchRulings(card).then(setRulings)
  }, [tab, card, rulings])

  const hasFaces    = card.card_faces?.length > 1
  const img         = getCardImage(card, 'normal', face)
  const displayFace = hasFaces ? (card.card_faces[face] || card) : card
  const oracle      = displayFace.oracle_text || card.oracle_text || ''
  const flavor      = displayFace.flavor_text  || card.flavor_text  || ''
  const typeLine    = displayFace.type_line    || card.type_line    || ''
  const manaCost    = displayFace.mana_cost    || card.mana_cost    || ''
  const power       = displayFace.power        ?? card.power
  const toughness   = displayFace.toughness    ?? card.toughness
  const loyalty     = displayFace.loyalty      ?? card.loyalty
  const prices      = card.prices || {}

  return (
    <div className={styles.cardView}>
      {onClose && <button className={styles.cvClose} onClick={onClose}><CloseIcon size={14} /></button>}
      {badge && <div className={styles.cvBadge}>{badge}</div>}
      <div className={styles.cvLayout}>
        <div className={styles.cvArtCol}>
          <div className={styles.cvArtWrap}>
            {img
              ? <img src={img} alt={card.name} className={styles.cvImg} />
              : <div className={styles.cvImgPlaceholder}>{card.name}</div>}
          </div>
          {hasFaces && <button className={styles.cvFlipBtn} onClick={() => setFace(f => 1 - f)}>Flip</button>}
          <div className={styles.cvArtCaption}>
            <span style={{ color: rarityColor(card.rarity) }}>
              {card.rarity ? card.rarity.charAt(0).toUpperCase() + card.rarity.slice(1) : ''}
            </span>
            <span>{card.set_name}</span>
            <span style={{ color: 'var(--text-faint)' }}>#{card.collector_number}</span>
          </div>
          {/* Printings strip */}
          {printings.length > 1 && (
            <div className={styles.printingsLabel}>
              {printings.length} printings
            </div>
          )}
          {printings.length > 1 && (
            <div className={styles.printingsStrip}>
              {printings.map(p => {
                const thumb = getCardImage(p, 'small')
                const active = p.id === card.id
                return (
                  <button key={p.id}
                    className={`${styles.printingThumb} ${active ? styles.printingThumbActive : ''}`}
                    onClick={() => { setCard(p); setFace(0); setRulings(null) }}
                    title={`${p.set_name} #${p.collector_number}`}>
                    {thumb
                      ? <img src={thumb} alt={p.set_name} />
                      : <span>{p.set?.toUpperCase()}</span>}
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className={styles.cvBody}>
          <div className={styles.cvHeader}>
            <div className={styles.cvName}>{displayFace.name || card.name}</div>
            <ManaCost cost={manaCost} size={18} />
          </div>
          <div className={styles.cvType}>{typeLine}</div>
          {(power != null || loyalty != null) && (
            <div className={styles.cvStats}>
              {power   != null && <span className={styles.cvStatBadge}>{power}/{toughness}</span>}
              {loyalty != null && <span className={styles.cvStatBadge}>{loyalty}</span>}
            </div>
          )}
          <div className={styles.tabBar}>
            {['rules', 'prices', 'legality', 'rulings'].map(t => (
              <button key={t} className={`${styles.tabBtn} ${tab === t ? styles.tabActive : ''}`} onClick={() => setTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          {tab === 'rules' && (
            <div className={styles.tabContent}>
              <div className={styles.oracleBox}><OracleText text={oracle} /></div>
              {flavor && <div className={styles.flavorText}>{renderWithSymbols(flavor)}</div>}
              {card.artist && <div className={styles.artistLine}>Illustrated by <em>{card.artist}</em></div>}
              <a href={card.scryfall_uri} target="_blank" rel="noopener noreferrer" className={styles.scryfallLink}>
                View on Scryfall ↗
              </a>
            </div>
          )}
          {tab === 'prices' && (
            <div className={styles.tabContent}>
              <div className={styles.pricesGrid}>
                {[
                  { label: 'EUR (Non-foil)', val: prices.eur },
                  { label: 'EUR (Foil)',     val: prices.eur_foil },
                  { label: 'USD (Non-foil)', val: prices.usd },
                  { label: 'USD (Foil)',     val: prices.usd_foil },
                  { label: 'USD (Etched)',   val: prices.usd_etched },
                  { label: 'MTGO (tix)',     val: prices.tix, tix: true },
                ].filter(p => p.val && parseFloat(p.val) > 0).map(p => (
                  <div key={p.label} className={styles.priceBlock}>
                    <div className={styles.priceLabel}>{p.label}</div>
                    <div className={styles.priceVal} style={{ color: p.tix ? 'var(--text-dim)' : 'var(--green)' }}>
                      {p.tix ? `${parseFloat(p.val).toFixed(2)} tix` : p.label.includes('EUR') ? `€${parseFloat(p.val).toFixed(2)}` : `$${parseFloat(p.val).toFixed(2)}`}
                    </div>
                  </div>
                ))}
              </div>
              {card.purchase_uris?.tcgplayer && (
                <a href={card.purchase_uris.tcgplayer} target="_blank" rel="noopener noreferrer" className={styles.scryfallLink} style={{ marginTop: 12 }}>Buy on TCGPlayer ↗</a>
              )}
              {card.purchase_uris?.cardmarket && (
                <a href={card.purchase_uris.cardmarket} target="_blank" rel="noopener noreferrer" className={styles.scryfallLink} style={{ marginTop: 8 }}>Buy on Cardmarket ↗</a>
              )}
            </div>
          )}
          {tab === 'legality' && (
            <div className={styles.tabContent}>
              <div className={styles.legalGrid}>
                {[
                  ['standard','Standard'],['pioneer','Pioneer'],['explorer','Explorer'],
                  ['modern','Modern'],['legacy','Legacy'],['vintage','Vintage'],
                  ['commander','Commander'],['oathbreaker','Oathbreaker'],
                  ['pauper','Pauper'],['penny','Penny Dreadful'],['historic','Historic'],
                  ['alchemy','Alchemy'],
                ].map(([fmt, label]) => {
                  const status = card.legalities?.[fmt]
                  if (!status || status === 'not_legal') return null
                  const color = status === 'legal' ? '#4a9a5a' : status === 'restricted' ? '#c9a84c' : '#7a4a4a'
                  const bg    = status === 'legal' ? 'rgba(74,154,90,0.1)' : status === 'restricted' ? 'rgba(201,168,76,0.1)' : 'rgba(200,80,80,0.08)'
                  return (
                    <div key={fmt} className={styles.legalRow} style={{ background: bg, borderColor: color + '55' }}>
                      <span>{label}</span>
                      <span style={{ color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {status === 'legal'
                          ? <><CheckIcon size={12} /> Legal</>
                          : status === 'restricted'
                            ? <><WarningIcon size={12} /> Restricted</>
                            : <><BannedIcon size={12} /> Banned</>}
                      </span>
                    </div>
                  )
                }).filter(Boolean)}
              </div>
            </div>
          )}
          {tab === 'rulings' && (
            <div className={styles.tabContent}>
              {rulings === null
                ? <p className={styles.oracleEmpty}>Loading rulings…</p>
                : rulings.length === 0
                  ? <p className={styles.oracleEmpty}>No rulings on record.</p>
                  : <div className={styles.rulingsList}>
                      {rulings.map((r, i) => (
                        <div key={i} className={styles.rulingItem}>
                          <span className={styles.rulingDate}>{r.published_at}</span>
                          <span className={styles.rulingText}>{r.comment}</span>
                        </div>
                      ))}
                    </div>
              }
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Search Results Grid ───────────────────────────────────────────────────────
function SearchResultGrid({ results, onSelect }) {
  return (
    <div className={styles.resultsGrid}>
      {results.map(card => (
        <div key={card.id} className={styles.resultCard} onClick={() => onSelect(card)}>
          {getCardImage(card, 'small')
            ? <img src={getCardImage(card, 'small')} alt={card.name} className={styles.resultImg} loading="lazy" />
            : <div className={styles.resultImgPlaceholder}>{card.name}</div>}
          <div className={styles.resultName}>{card.name}</div>
          <div className={styles.resultSet}>{card.set_name}</div>
          {card.prices?.eur && <div className={styles.resultPrice}>€{parseFloat(card.prices.eur).toFixed(2)}</div>}
        </div>
      ))}
    </div>
  )
}

// ── Card Lookup Section ───────────────────────────────────────────────────────
function CardLookupSection() {
  const [query, setQuery]         = useState('')
  const [suggestions, setSuggs]   = useState([])
  const [showSuggs, setShowSuggs] = useState(false)
  const [card, setCard]           = useState(null)
  const [results, setResults]     = useState([])
  const [nextPage, setNextPage]   = useState(null)
  const [totalCards, setTotalCards] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [currentQuery, setCurrentQuery] = useState('')
  const [mode, setMode]           = useState('idle')
  const [loading, setLoading]     = useState(false)
  const [showAdv, setShowAdv]     = useState(false)
  const [advFilters, setAdvFilters] = useState({ ...EMPTY_ADV })
  const debounce = useRef(null)

  const handleInput = e => {
    const v = e.target.value
    setQuery(v)
    clearTimeout(debounce.current)
    if (v.length < 2) { setSuggs([]); setShowSuggs(false); return }
    debounce.current = setTimeout(async () => {
      const r = await fetchAutocomplete(v)
      setSuggs(r); setShowSuggs(r.length > 0)
    }, 250)
  }

  // suggestions are now card objects — pick directly, no extra fetch needed
  const pickSuggestion = cardObj => {
    setQuery(cardObj.name); setShowSuggs(false); setSuggs([])
    setCard(cardObj); setResults([]); setMode('card')
    addRecentlyViewed(cardObj)
  }

  const handleSearch = async e => {
    e.preventDefault()
    const hasAdv = hasAdvFilters(advFilters)
    // Always use search endpoint when advanced filters are active
    if (hasAdv || (showAdv && hasAdv)) {
      const q = buildScryfallQuery(query, advFilters)
      if (!q.trim()) return
      setShowSuggs(false); setCard(null); setLoading(true); setMode('idle')
      setCurrentQuery(q)
      const { data, nextPage: np, total } = await fetchSearchResults(q)
      setResults(data); setNextPage(np); setTotalCards(total)
      setMode('results'); setLoading(false)
      return
    }
    if (!query.trim()) return
    setShowSuggs(false); setCard(null); setLoading(true); setMode('idle')
    const exact = await fetchByName(query.trim())
    if (exact) { setCard(exact); setMode('card'); addRecentlyViewed(exact); setLoading(false); return }
    setCurrentQuery(query.trim())
    const { data, nextPage: np, total } = await fetchSearchResults(query.trim())
    setResults(data); setNextPage(np); setTotalCards(total)
    setMode('results'); setLoading(false)
  }

  const handleLoadMore = async () => {
    if (!nextPage || loadingMore) return
    setLoadingMore(true)
    const { data, nextPage: np } = await fetchSearchResults(null, nextPage)
    setResults(prev => [...prev, ...data]); setNextPage(np)
    setLoadingMore(false)
  }

  const handleClear = () => {
    setCard(null); setResults([]); setNextPage(null); setTotalCards(0)
    setMode('idle'); setQuery(''); setCurrentQuery('')
    setAdvFilters({ ...EMPTY_ADV })
  }

  const activeAdvCount = [
    advFilters.colors.length > 0,
    (advFilters.types?.length ?? 0) > 0,
    !!advFilters.cmcVal,
    !!advFilters.rarity,
    !!advFilters.oracle,
    !!advFilters.format,
  ].filter(Boolean).length

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Card Lookup</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className={`${styles.advToggleBtn} ${showAdv ? styles.advToggleBtnActive : ''}`}
            onClick={() => setShowAdv(v => !v)}>
            {showAdv ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />} Filters{activeAdvCount > 0 ? ` (${activeAdvCount})` : ''}
          </button>
          {mode !== 'idle' && (
            <button className={styles.clearBtn} onClick={handleClear}>Clear</button>
          )}
        </div>
      </div>
      <p className={styles.sectionDesc}>Search any Magic card — browse art, oracle text, prices and rulings.</p>

      {showAdv && (
        <AdvancedSearchPanel adv={advFilters} set={setAdvFilters} />
      )}

      <form className={styles.searchForm} onSubmit={handleSearch}>
        <div className={styles.searchWrap}>
          <input className={styles.searchInput}
            id="card-search-query"
            name="query"
            placeholder="Card name or search query…"
            value={query} onChange={handleInput}
            onFocus={() => suggestions.length && setShowSuggs(true)}
            onBlur={() => setTimeout(() => setShowSuggs(false), 160)}
            autoComplete="off"
          />
          {showSuggs && (
            <ul className={styles.suggList}>
              {suggestions.map(c => (
                <li key={c.id} className={styles.suggItem} onMouseDown={() => pickSuggestion(c)}>
                  <img
                    src={getCardImage(c, 'small')}
                    alt=""
                    className={styles.suggThumb}
                  />
                  <span className={styles.suggName}>{c.name}</span>
                  <span className={styles.suggSet}>{c.set_name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button className={styles.searchBtn} type="submit"
          disabled={loading || (!query.trim() && !hasAdvFilters(advFilters))}>
          {loading ? '…' : 'Search'}
        </button>
      </form>
      {loading && <div className={styles.loadingMsg}>Searching Scryfall…</div>}
      {!loading && mode === 'card' && card && (
        <CardView card={card} onClose={() => { setCard(null); setMode('idle') }} />
      )}
      {!loading && mode === 'results' && (
        results.length === 0
          ? <div className={styles.emptyMsg}>No cards found for "{currentQuery}".</div>
          : <>
              <div className={styles.resultsHeader}>
                {totalCards > 0 ? `${totalCards.toLocaleString()} total` : `${results.length}`} result{results.length !== 1 ? 's' : ''}
                {results.length < totalCards ? ` — showing ${results.length}` : ''} — click a card for details
              </div>
              <SearchResultGrid results={results} onSelect={c => { setCard(c); setMode('card'); addRecentlyViewed(c) }} />
              {nextPage && (
                <div style={{ textAlign: 'center', marginTop: 16 }}>
                  <button className={styles.loadMoreBtn} onClick={handleLoadMore} disabled={loadingMore}>
                    {loadingMore ? 'Loading…' : `Load more (${results.length} / ${totalCards.toLocaleString()})`}
                  </button>
                </div>
              )}
            </>
      )}
    </section>
  )
}

// ── Random Card Section ───────────────────────────────────────────────────────
function RandomCardSection() {
  const [card, setCard]       = useState(null)
  const [loading, setLoading] = useState(true)

  const roll = useCallback(async () => {
    setLoading(true); setCard(null)
    const c = await fetchRandom()
    setCard(c); setLoading(false)
  }, [])

  useEffect(() => { roll() }, [roll])

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}><DiceIcon size={14} style={{ marginRight: 5, verticalAlign: 'middle' }} /> Random Card</h2>
        <button className={styles.rerollBtn} onClick={roll} disabled={loading}>
          {loading ? 'Rolling…' : 'Reroll'}
        </button>
      </div>
      {loading ? (
        <div className={styles.skeletonLayout}>
          <div className={styles.skeletonImg} />
          <div className={styles.skeletonBody} />
        </div>
      ) : card ? (
        <CardView card={card} />
      ) : (
        <div className={styles.emptyMsg}>Failed to load card.</div>
      )}
    </section>
  )
}

// ── Horizontal scroll strip skeleton ─────────────────────────────────────────
function LoadingStrip({ count = 9 }) {
  return (
    <div className={styles.hScroll}>
      {Array.from({ length: count }).map((_, i) => <div key={i} className={styles.hScrollSkeleton} />)}
    </div>
  )
}

// ── Set Completion ────────────────────────────────────────────────────────────
function SetRow({ row }) {
  const pct = row.pct ?? 0
  return (
    <div className={styles.setRow}>
      <div className={styles.setRowMeta}>
        <span className={styles.setRowName}>{row.name}</span>
        <span className={styles.setRowCount}>
          {row.owned}{row.total ? `/${row.total}` : ''}{row.pct != null ? ` · ${row.pct}%` : ''}
        </span>
      </div>
      <div className={styles.setRowTrack}>
        <div className={styles.setRowFill} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  )
}

function SetCompletionSection({ data, loading }) {
  const [setsMap,  setSetsMap]  = useState(null)
  const [expanded, setExpanded] = useState(false)

  // Group owned cards by set — unique collector_numbers only
  const ownedBySet = useMemo(() => {
    if (!data) return []
    const { cardRows, sfMap } = data
    const map = {}
    for (const row of cardRows) {
      const card = row.cards
      if (!card?.set_code || !card?.collector_number) continue
      const sf = sfMap[`${card.set_code}-${card.collector_number}`]
      if (!map[card.set_code])
        map[card.set_code] = { code: card.set_code, name: sf?.set_name || card.set_code.toUpperCase(), nums: new Set() }
      map[card.set_code].nums.add(card.collector_number)
    }
    return Object.values(map)
  }, [data])

  useEffect(() => {
    if (ownedBySet.length) fetchScryfallSetsMap().then(setSetsMap)
  }, [ownedBySet.length])

  // Build rows: sort by completion % desc, fallback to owned count
  const rows = useMemo(() => {
    return ownedBySet.map(s => {
      const total = setsMap?.[s.code]?.count || null
      const pct   = total ? Math.min(100, Math.round(s.nums.size / total * 100)) : null
      return { code: s.code, name: setsMap?.[s.code]?.name || s.name, owned: s.nums.size, total, pct }
    }).sort((a, b) => {
      if (a.pct != null && b.pct != null) return b.pct - a.pct
      if (a.pct != null) return -1
      if (b.pct != null) return 1
      return b.owned - a.owned
    })
  }, [ownedBySet, setsMap])

  if (!loading && rows.length === 0) return null

  const top  = rows.slice(0, 5)
  const rest = rows.slice(5)

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Set Completion</h2>
        <span className={styles.sectionCount}>{rows.length} sets</span>
      </div>
      {loading
        ? <div className={styles.setSkeletons}>{[0,1,2].map(i => <div key={i} className={styles.setSkeleton} />)}</div>
        : (
          <>
            <div className={styles.setList}>
              {top.map(r => <SetRow key={r.code} row={r} />)}
            </div>
            {rest.length > 0 && (
              <div className={styles.setDropdown}>
                <button className={styles.setDropdownToggle} onClick={() => setExpanded(v => !v)}>
                  {expanded ? <><ChevronUpIcon size={12} /> Show less</> : <><ChevronDownIcon size={12} /> Show all {rows.length} sets</>}
                </button>
                {expanded && (
                  <div className={styles.setDropdownList}>
                    {rest.map(r => <SetRow key={r.code} row={r} />)}
                  </div>
                )}
              </div>
            )}
          </>
        )
      }
    </section>
  )
}

// ── Collection Snapshot ───────────────────────────────────────────────────────
function CollectionSnapshot({ data, loading, priceSource }) {
  const stats = useMemo(() => {
    if (!data) return null
    const { folders, cards, sfMap } = data
    const binderCount = folders.filter(f => f.type === 'binder').length
    const deckCount   = folders.filter(f => f.type === 'deck').length
    const uniquePrints = new Set()
    const sets = new Set()
    let totalQty = 0
    let totalValue = 0
    let foilQty = 0

    for (const card of cards || []) {
      const qty = card.qty || 1
      totalQty += qty
      if (card.foil) foilQty += qty
      if (card.set_code && card.collector_number) uniquePrints.add(`${card.set_code}-${card.collector_number}`)
      if (card.set_code) sets.add(card.set_code)
      const sf = sfMap[`${card.set_code}-${card.collector_number}`]
      const p  = getPrice(sf, card.foil, { price_source: priceSource })
      if (p != null) totalValue += p * qty
    }

    return {
      binderCount,
      deckCount,
      totalQty,
      totalValue,
      uniqueEntries: cards?.length || 0,
      uniquePrintCount: uniquePrints.size,
      uniqueSetCount: sets.size,
      foilQty,
      foilPct: totalQty ? Math.round((foilQty / totalQty) * 100) : 0,
      avgCopiesPerEntry: cards?.length ? totalQty / cards.length : 0,
    }
  }, [data, priceSource])

  const tiles = stats ? [
    {
      label: 'Total Copies',
      val: stats.totalQty.toLocaleString(),
      meta: `${stats.uniqueEntries.toLocaleString()} entries`,
      color: 'var(--text)',
    },
    {
      label: 'Unique Prints',
      val: stats.uniquePrintCount.toLocaleString(),
      meta: `${stats.uniqueSetCount.toLocaleString()} sets`,
      color: 'var(--text)',
    },
    {
      label: 'Collection Value',
      val: formatPrice(stats.totalValue, priceSource),
      meta: '',
      color: 'var(--green)',
    },
    {
      label: 'Binders',
      val: stats.binderCount.toString(),
      meta: 'Collection folders',
      color: 'var(--text)',
    },
    {
      label: 'Decks',
      val: stats.deckCount.toString(),
      meta: 'Built decks',
      color: 'var(--text)',
    },
  ] : []

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Collection</h2>
      </div>
      <div className={styles.snapshotGrid}>
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <div key={i} className={styles.snapshotSkeleton} />)
          : tiles.map(t => (
              <div key={t.label} className={styles.snapshotTile}>
                <div className={styles.snapshotVal} style={{ color: t.color }}>{t.val}</div>
                <div className={styles.snapshotLabel}>{t.label}</div>
                {t.meta ? <div className={styles.snapshotMeta}>{t.meta}</div> : null}
              </div>
            ))
        }
      </div>
    </section>
  )
}

// ── Top Valued Cards ──────────────────────────────────────────────────────────
function TopValuedCards({ data, loading, priceSource, onCardClick }) {
  const topCards = useMemo(() => {
    if (!data) return []
    const { cardRows, sfMap } = data
    const seen = {}
    for (const row of cardRows) {
      const card = row.cards
      if (!card || seen[card.id]) continue
      const sf = sfMap[`${card.set_code}-${card.collector_number}`]
      const p  = getPrice(sf, card.foil, { price_source: priceSource })
      if (p != null) seen[card.id] = { card, sf, price: p }
    }
    return Object.values(seen).sort((a, b) => b.price - a.price).slice(0, 14)
  }, [data, priceSource])

  if (!loading && topCards.length === 0) return null

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Most Valuable Cards</h2>
      </div>
      {loading ? <LoadingStrip /> : (
        <div className={styles.hScroll}>
          {topCards.map(({ card, sf, price }) => {
            const img = getImageUri(sf, 'normal') || card.image_uri || null
            return (
              <div key={card.id} className={styles.hScrollCard}
                style={{ cursor: 'pointer' }}
                onClick={() => onCardClick(card.scryfall_id, card.name)}>
                {img
                  ? <img src={img} alt={card.name} className={styles.hScrollImg} loading="lazy" />
                  : <div className={styles.hScrollImgPlaceholder}>{card.name}</div>}
                <div className={styles.hScrollName}>{card.name}</div>
                <div className={styles.hScrollPrice}>{formatPrice(price, priceSource)}</div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ── Recently Added ────────────────────────────────────────────────────────────
function RecentlyAdded({ data, loading, onCardClick }) {
  if (!loading && !data?.recentCards?.length) return null

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Recently Added</h2>
      </div>
      {loading ? <LoadingStrip /> : (
        <div className={styles.hScroll}>
          {data.recentCards.map(card => {
            const sf  = data.sfMap[`${card.set_code}-${card.collector_number}`]
            const img = getImageUri(sf, 'normal') || card.image_uri || null
            return (
              <div key={card.id} className={styles.hScrollCard}
                style={{ cursor: 'pointer' }}
                onClick={() => onCardClick(card.scryfall_id, card.name)}>
                {img
                  ? <img src={img} alt={card.name} className={styles.hScrollImg} loading="lazy" />
                  : <div className={styles.hScrollImgPlaceholder}>{card.name}</div>}
                <div className={styles.hScrollName}>{card.name}</div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

// ── Most Valuable Decks ───────────────────────────────────────────────────────
function TopValuedDecks({ data, loading, priceSource }) {
  const navigate = useNavigate()

  const topDecks = useMemo(() => {
    if (!data) return []
    const { folders, deckRows = [], sfMap } = data
    const deckVal = {}
    for (const f of folders.filter(f => f.type === 'deck')) deckVal[f.id] = { folder: f, value: 0, qty: 0 }
    for (const row of deckRows) {
      if (!deckVal[row.deck_id]) continue
      const card = row.cards
      if (!card) continue
      const sf = sfMap[`${card.set_code}-${card.collector_number}`]
      const p  = getPrice(sf, card.foil, { price_source: priceSource })
      if (p != null) deckVal[row.deck_id].value += p * (row.qty || 1)
      deckVal[row.deck_id].qty += row.qty || 1
    }
    return Object.values(deckVal).sort((a, b) => b.value - a.value).slice(0, 6)
  }, [data, priceSource])

  if (!loading && topDecks.length === 0) return null

  const maxVal = topDecks[0]?.value || 1

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Most Valuable Decks</h2>
      </div>
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className={styles.deckRowSkeleton} />)}
        </div>
      ) : (
        <div className={styles.deckList}>
          {topDecks.map(({ folder, value, qty }, i) => (
            <div key={folder.id} className={styles.deckRow}
              onClick={() => navigate(`/decks?folder=${folder.id}`)}>
              <span className={styles.deckRank}>#{i + 1}</span>
              <div className={styles.deckInfo}>
                <div className={styles.deckName}>{folder.name}</div>
                <div className={styles.deckBarWrap}>
                  <div className={styles.deckBarFill} style={{ width: `${(value / maxVal) * 100}%` }} />
                </div>
                <div className={styles.deckQty}>{qty} cards</div>
              </div>
              <div className={styles.deckValue}>{formatPrice(value, priceSource)}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── MTG News ──────────────────────────────────────────────────────────────────
function MTGNewsSection() {
  const [articles, setArticles] = useState([])
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    fetchMTGNews().then(a => { setArticles(a); setLoading(false) })
  }, [])

  const fmtDate = d => {
    if (!d) return ''
    const date = new Date(d)
    return date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  // Strip HTML tags from RSS description to get plain-text excerpt
  const stripHtml = html => {
    if (!html) return ''
    return html.replace(/<[^>]*>/g, '').replace(/&#?\w+;/g, ' ').trim().slice(0, 140)
  }

  if (!loading && articles.length === 0) return null

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>MTG News</h2>
        <div className={styles.newsSources}>
          {NEWS_FEEDS.map(f => (
            <span key={f.label} className={styles.newsSourceBadge}
              style={{ color: f.color, borderColor: f.color + '44' }}>
              {f.label}
            </span>
          ))}
        </div>
      </div>

      {loading ? (
        <div className={styles.newsGrid}>
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className={styles.newsCardSkeleton} />)}
        </div>
      ) : (
        <div className={styles.newsGrid}>
          {articles.map((article, i) => (
            <a key={article.guid || article.link || i}
              href={article.link} target="_blank" rel="noopener noreferrer"
              className={styles.newsCard}>
              <div className={styles.newsCardImg}>
                {article.thumbnail && article.thumbnail.startsWith('http')
                  ? <img src={article.thumbnail} alt="" loading="lazy" />
                  : <div className={styles.newsCardImgPlaceholder}><ImageIcon size={24} /></div>
                }
                <span className={styles.newsCardBadge}
                  style={{ background: article._sourceColor + '22', color: article._sourceColor, borderColor: article._sourceColor + '55' }}>
                  {article._source}
                </span>
              </div>
              <div className={styles.newsCardBody}>
                <div className={styles.newsCardTitle}>{article.title}</div>
                {article.description && (
                  <div className={styles.newsCardExcerpt}>{stripHtml(article.description)}</div>
                )}
                <div className={styles.newsCardMeta}>
                  {article.author && <span>{article.author}</span>}
                  <span>{fmtDate(article.pubDate)}</span>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Upcoming Sets ─────────────────────────────────────────────────────────────
function UpcomingSetsSection() {
  const [sets, setSets]       = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchUpcomingSets().then(s => { setSets(s); setLoading(false) })
  }, [])

  if (!loading && sets.length === 0) return null

  const fmtDate = d => {
    const [y, m, day] = d.split('-')
    return new Date(+y, +m - 1, +day).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
  }
  const setTypeLabel = t => ({
    expansion: 'Expansion', core: 'Core Set', masters: 'Masters',
    draft_innovation: 'Draft Innovation', commander: 'Commander', starter_deck: 'Starter Deck',
  }[t] || t)

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Upcoming Sets</h2>
      </div>
      {loading ? (
        <div className={styles.setsGrid}>
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className={styles.setTileSkeleton} />)}
        </div>
      ) : (
        <div className={styles.setsGrid}>
          {sets.map(s => (
            <a key={s.code} href={`https://scryfall.com/sets/${s.code}`}
              target="_blank" rel="noopener noreferrer" className={styles.setTile}>
              <img src={s.icon_svg_uri} alt={s.name} className={styles.setIcon} />
              <div className={styles.setName}>{s.name}</div>
              <div className={styles.setDate}>{fmtDate(s.released_at)}</div>
              <div className={styles.setType}>{setTypeLabel(s.set_type)}</div>
            </a>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Recently Viewed ───────────────────────────────────────────────────────────
function RecentlyViewedSection({ onCardClick }) {
  const [viewed, setViewed] = useState(() => getRecentlyViewed())

  useEffect(() => {
    const refresh = () => setViewed(getRecentlyViewed())
    window.addEventListener('av:viewed', refresh)
    return () => window.removeEventListener('av:viewed', refresh)
  }, [])

  if (viewed.length === 0) return null

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Recently Viewed</h2>
        <button className={styles.clearBtn} onClick={() => { localStorage.removeItem(VIEWED_KEY); setViewed([]) }}>
          Clear
        </button>
      </div>
      <div className={styles.hScroll}>
        {viewed.map(card => (
          <div key={card.id} className={styles.hScrollCard}
            style={{ cursor: 'pointer' }}
            onClick={() => onCardClick(card.id, card.name)}>
            {card.image
              ? <img src={card.image} alt={card.name} className={styles.hScrollImg} loading="lazy" />
              : <div className={styles.hScrollImgPlaceholder}>{card.name}</div>}
            <div className={styles.hScrollName}>{card.name}</div>
            {(card.eur || card.usd) && (
              <div className={styles.hScrollPrice}>
                {card.eur ? `€${parseFloat(card.eur).toFixed(2)}` : `$${parseFloat(card.usd).toFixed(2)}`}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

// ── Changelog panel ──────────────────────────────────────────────────────────
const CL_CACHE_KEY = 'av_changelog_data'
const CL_CACHE_TTL = 60 * 60 * 1000 // 1 hour

const CHANGELOG_DEFAULT = [
  {
    version: 'Apr 2, 2026',
    label: 'Latest',
    updates: [
      'Collection decks are more reliable — adding, removing, and moving cards between decks works correctly',
      'When building a deck, you can now pick which printing or foil version of a card to use from your collection',
      'Deck Builder got a cleaner layout on mobile with better card images and improved tabs',
    ],
  },
]

async function fetchChangelog() {
  try {
    const raw = localStorage.getItem(CL_CACHE_KEY)
    if (raw) {
      const { ts, data } = JSON.parse(raw)
      if (Date.now() - ts < CL_CACHE_TTL) return data
    }
    const { data, error } = await sb.from('app_config').select('value').eq('key', 'changelog').maybeSingle()
    if (error || !data?.value?.length) return CHANGELOG_DEFAULT
    localStorage.setItem(CL_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: data.value }))
    return data.value
  } catch {
    return CHANGELOG_DEFAULT
  }
}

function ChangelogPanel({ entries }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('av_changelog_open') !== 'false' } catch { return true }
  })

  const toggle = () => {
    setOpen(v => {
      try { localStorage.setItem('av_changelog_open', String(!v)) } catch {}
      return !v
    })
  }

  const list = entries?.length ? entries : CHANGELOG_DEFAULT

  return (
    <div className={styles.changelog}>
      <button className={styles.changelogHeader} onClick={toggle}>
        <span className={styles.changelogTitle}>What's New</span>
        <span className={styles.changelogChevron}>{open ? <ChevronUpIcon size={10} /> : <ChevronDownIcon size={10} />}</span>
      </button>
      {open && (
        <div className={styles.changelogBody}>
          {list.map((section, idx) => (
            <div key={`${section.version}-${idx}`} className={styles.changelogSection}>
              <div className={styles.changelogSectionHead}>
                <span className={styles.changelogBadge}>
                  {section.label}
                </span>
                <span className={styles.changelogDate}>{section.version}</span>
              </div>
              <ul className={styles.changelogList}>
                {(section.updates || []).map((item, i) => (
                  <li key={i} className={styles.changelogItem} dangerouslySetInnerHTML={{ __html: item }} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function HomePage() {
  const { user }               = useAuth()
  const { price_source }       = useSettings()
  const [collData, setCollData]   = useState(null)
  const [collLoading, setCollLoading] = useState(false)
  const [changelog, setChangelog] = useState(CHANGELOG_DEFAULT)
  // Shared card-detail modal for hScroll sections
  const [modalCard, setModalCard] = useState(null)
  const [modalLoading, setModalLoading] = useState(false)

  useEffect(() => { fetchChangelog().then(setChangelog) }, [])

  useEffect(() => {
    if (!user) return
    setCollLoading(true)
    loadCollectionData(user.id).then(async data => {
      setCollData(data)
      setCollLoading(false)
      // Background sync: if Supabase has fresher card data than IDB, update the snapshot
      const freshCards = await syncCardsFromSupabase(user.id, data.cards)
      if (freshCards) {
        const sfMap = await loadCardMapWithSharedPrices(freshCards)
        const seen = new Set()
        const recentCards = [...freshCards]
          .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
          .filter(c => seen.has(c.id) ? false : (seen.add(c.id), true))
          .slice(0, 14)
        setCollData(prev => ({ ...prev, cards: freshCards, sfMap, recentCards }))
      }
    })
  }, [user?.id])

  // Open a Scryfall card in the shared CardView modal
  const openCard = useCallback(async (scryfallId, fallbackName) => {
    setModalLoading(true)
    setModalCard(null)
    try {
      let card = null
      if (scryfallId) {
        card = await sfGet(`https://api.scryfall.com/cards/${scryfallId}`)
      }
      if (!card && fallbackName) card = await fetchByName(fallbackName)
      if (card) { setModalCard(card); addRecentlyViewed(card) }
    } catch (e) {
      console.warn('[Home] openCard error:', e)
    } finally {
      setModalLoading(false)
    }
  }, [])

  return (
    <div className={styles.home}>
      <div className={styles.hero}>
        <div className={styles.heroTitle}>UNTAP<span className={styles.heroAccent}>HUB</span></div>
        <div className={styles.heroSub}>Your Magic: The Gathering collection manager</div>
      </div>

      <ChangelogPanel entries={changelog} />
      <CardLookupSection />
      {user && <CollectionSnapshot data={collData} loading={collLoading} priceSource={price_source} />}
      <RecentlyViewedSection onCardClick={openCard} />
      <RandomCardSection />
      {user && <TopValuedCards    data={collData} loading={collLoading} priceSource={price_source} onCardClick={openCard} />}
      {user && <RecentlyAdded     data={collData} loading={collLoading} onCardClick={openCard} />}
      {user && <TopValuedDecks    data={collData} loading={collLoading} priceSource={price_source} />}
      <MTGNewsSection />
      <UpcomingSetsSection />

      {/* ── Shared card detail modal ───────────────────────────────────── */}
      {(modalLoading || modalCard) && (
        <div className={styles.modalOverlay}
          onClick={e => { if (e.target === e.currentTarget) { setModalCard(null); setModalLoading(false) } }}>
          <div className={styles.modalInner}>
            {modalLoading
              ? <div className={styles.modalSpinner}>Loading…</div>
              : <CardView card={modalCard} onClose={() => setModalCard(null)} />
            }
          </div>
        </div>
      )}
    </div>
  )
}
