import { useState, useEffect, useRef, useCallback, useMemo, startTransition } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sb } from '../lib/supabase'
import { getInstantCache, getPriceSource, formatPrice, getImageUri, sfGet } from '../lib/scryfall'
import { sortByNameRelevance } from '../lib/scryfallSearch'
import { fetchAutocomplete, buildLookupQuery, hasLookupFilters } from '../lib/cardLookup'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { getLocalCards, getLocalFolders, getAllLocalFolderCards, getAllDeckAllocationsForUser } from '../lib/db'
import { syncOwnedCards } from '../lib/collectionFetchers'
import { cardsContentHash } from '../lib/cardsHash'
import { getProdAppUrl } from '../lib/publicUrl'
import { CAN_HOVER } from '../lib/deckBuilderConstants'
import { lastInputWasTouch } from '../lib/inputType'
import { useAuth } from '../components/Auth'
import { useSettings } from '../components/SettingsContext'
import { FloatingPreview } from '../components/deckBuilder/FloatingPreview'
import BRAND_MARK from '../icons/DeckLoom_logo.png'
import styles from './Home.module.css'
import { EMPTY_FILTERS, FilterBar } from '../components/CardComponents'
import { CloseIcon, CheckIcon, WarningIcon, BannedIcon, ChevronDownIcon, ChevronUpIcon, ChevronRightIcon, DiceIcon, ImageIcon, SearchIcon } from '../icons'

// ── Recently Viewed (localStorage + custom event for live update) ─────────────
const VIEWED_KEY = 'arcanevault_recently_viewed'
function getRecentlyViewed() {
  try { return JSON.parse(localStorage.getItem(VIEWED_KEY) || '[]') } catch { return [] }
}
function toSmallScryfallImage(url) {
  return typeof url === 'string'
    ? url.replace('/normal/', '/small/').replace('/large/', '/small/')
    : url
}
function addRecentlyViewed(card) {
  if (!card?.id) return
  const entry = {
    id:       card.id,
    name:     card.name,
    set_name: card.set_name || '',
    image:    card.image_uris?.small || card.card_faces?.[0]?.image_uris?.small || toSmallScryfallImage(card.image_uri) || null,
    eur:      card.prices?.eur  || null,
    usd:      card.prices?.usd  || null,
  }
  const prev = getRecentlyViewed().filter(c => c.id !== card.id)
  localStorage.setItem(VIEWED_KEY, JSON.stringify([entry, ...prev].slice(0, 24)))
  window.dispatchEvent(new CustomEvent('av:viewed'))
}

// O(N) partial top-K: pick the `n` newest unique cards by `created_at` without a full sort.
function pickRecentCards(cards, n = 14) {
  if (!cards?.length) return []
  const seen = new Set()
  const top = []
  for (const c of cards) {
    if (!c?.id || seen.has(c.id)) continue
    const ts = c.created_at || ''
    if (top.length < n) {
      seen.add(c.id)
      top.push(c)
      if (top.length === n) top.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    } else if (ts.localeCompare(top[n - 1].created_at || '') > 0) {
      seen.add(c.id)
      let i = n - 1
      top[i] = c
      while (i > 0 && (top[i].created_at || '').localeCompare(top[i - 1].created_at || '') > 0) {
        const t = top[i]; top[i] = top[i - 1]; top[i - 1] = t
        i--
      }
    }
  }
  if (top.length < n) top.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  return top
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
    const { data, error } = await sb.from('owned_cards_view')
      .select('*').eq('user_id', userId).order('id')
    if (error) console.warn('[Home] cards fallback error:', error.message)
    allCards = data || []
  }

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

  const recentCards = pickRecentCards(allCards, 14)

  if (allCards.length) {
    safeSfMap = await loadCardMapWithSharedPrices(allCards, { priceLookup: 'set' })
  }

  return { folders: allFolders, cards: allCards, cardRows, deckRows, sfMap: safeSfMap, recentCards }
}

// Syncs cards from Supabase into IDB and returns updated cards array if anything changed.
// Returns null when offline or when the data matches what we already have.
// Delegates to syncOwnedCards, which only pulls what changed since the last
// sync (a full re-fetch of a large collection previously took 10s+).
async function syncCardsFromSupabase(userId, currentCards) {
  if (!navigator.onLine) return null
  try {
    const fresh = await syncOwnedCards(userId)
    if (cardsContentHash(fresh) === cardsContentHash(currentCards)) return null
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
async function fetchByName(name) {
  return sfGet(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`)
}
async function fetchPrintings(cardName) {
  const q = `!"${cardName}"`
  const data = await sfGet(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`)
  return data?.data || []
}
function getScryfallSort(sort) {
  switch (sort) {
    case 'released': return { order: 'released', dir: 'desc' }
    case 'set': return { order: 'set', dir: 'auto' }
    case 'rarity': return { order: 'rarity', dir: 'auto' }
    case 'cmc_asc': return { order: 'cmc', dir: 'asc' }
    case 'cmc_desc': return { order: 'cmc', dir: 'desc' }
    case 'price_desc': return { order: 'eur', dir: 'desc' }
    case 'price_asc': return { order: 'eur', dir: 'asc' }
    default: return { order: 'name', dir: 'auto' }
  }
}
async function fetchSearchResults(q, nextPageUrl = null, sort = 'name') {
  const { order, dir } = getScryfallSort(sort)
  const url = nextPageUrl || `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=${order}&dir=${dir}&unique=cards`
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
// Feeds are proxied through our own Cloudflare Worker (deckloom.app/api/rss,
// allow-listed + edge-cached 15 min) — the free public CORS proxies this used
// before (codetabs, corsproxy.io) kept breaking. Adding a feed here requires
// adding its URL to RSS_ALLOWED_FEEDS in cloudflare/og-worker/worker.js too.
const NEWS_FEEDS = [
  { url: 'https://www.mtggoldfish.com/feed', label: 'MTGGoldfish',    color: '#5a9a6a' },
  { url: 'https://edhrec.com/articles/feed', label: 'EDHREC',         color: '#9a7acc' },
  { url: 'https://mtgazone.com/feed',        label: 'MTG Arena Zone', color: '#5aafcc' },
]

// WordPress serves the RSS "featured image" at its generated crop size
// (e.g. "...-150x150.jpg", visibly blurry at card size) — stripping the size
// suffix recovers the full-resolution original at the same URL.
function upgradeWpThumbnail(url) {
  return url.replace(/-\d{2,4}x\d{2,4}(?=\.\w+(?:[?#]|$))/, '')
}

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
      let link
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
        thumbnail:   thumbnail?.startsWith('http') ? upgradeWpThumbnail(thumbnail) : null,
        author,
        _source:     label,
        _sourceColor: color,
      }
    }).filter(a => a.title && a.link)
  } catch { return [] }
}

const NEWS_CACHE_KEY = 'av_mtg_news_v2'
const NEWS_CACHE_TTL_MS = 15 * 60 * 1000

// MTGGoldfish and MTG Arena Zone's feeds carry no image data at all — backfill
// their thumbnails by asking the worker to scrape og:image off the article
// page itself (edge-cached 24h there, so repeat articles are near-instant).
async function backfillThumbnails(articles) {
  const missing = articles.filter(a => !a.thumbnail && a.link)
  if (!missing.length) return articles
  await Promise.allSettled(missing.map(async a => {
    try {
      const res = await fetch(`${getProdAppUrl('/api/og-image')}?url=${encodeURIComponent(a.link)}`, {
        signal: AbortSignal.timeout?.(6000),
      })
      if (!res.ok) return
      const { image } = await res.json()
      if (image?.startsWith('http')) a.thumbnail = image
    } catch { /* leave thumbnail null — placeholder icon shown */ }
  }))
  return articles
}

async function fetchMTGNews() {
  // Session cache: repeat Home visits within 15 min skip the network entirely
  // (the worker edge-caches feeds for the same window).
  try {
    const cached = JSON.parse(sessionStorage.getItem(NEWS_CACHE_KEY) || 'null')
    if (cached?.articles?.length && Date.now() - cached.at < NEWS_CACHE_TTL_MS) {
      return cached.articles
    }
  } catch { /* corrupt cache — refetch */ }

  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async feed => {
      const res = await fetch(`${getProdAppUrl('/api/rss')}?feed=${encodeURIComponent(feed.url)}`)
      if (!res.ok) return []
      const text = await res.text()    // worker returns the raw feed XML
      return parseRssFeed(text, feed.label, feed.color)
    })
  )
  const articles = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 12)

  await backfillThumbnails(articles)

  if (articles.length) {
    try { sessionStorage.setItem(NEWS_CACHE_KEY, JSON.stringify({ at: Date.now(), articles })) } catch { /* storage full */ }
  }
  return articles
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
  const [activeSuggIndex, setActiveSuggIndex] = useState(-1)
  const [card, setCard]           = useState(null)
  // Where to land when the card detail view is closed — 'idle' (opened from a
  // suggestion / exact-name match) or 'results' (opened from the results grid,
  // so closing should restore the grid instead of discarding the search).
  const [cardOrigin, setCardOrigin] = useState('idle')
  const [results, setResults]     = useState([])
  const [nextPage, setNextPage]   = useState(null)
  const [totalCards, setTotalCards] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [currentQuery, setCurrentQuery] = useState('')
  const [mode, setMode]           = useState('idle')
  const [loading, setLoading]     = useState(false)
  const [sort, setSort]           = useState('name')
  const [filters, setFilters]     = useState({ ...EMPTY_FILTERS })
  const [lookupSets, setLookupSets] = useState([])
  const debounce = useRef(null)
  const wrapRef = useRef(null)
  const floatingPreviewRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    fetchScryfallSetsMap().then(map => {
      if (cancelled) return
      const sets = Object.entries(map || {})
        .map(([code, meta]) => ({ code, name: meta?.name || code.toUpperCase() }))
        .sort((a, b) => a.name.localeCompare(b.name))
      setLookupSets(sets)
    })
    return () => { cancelled = true }
  }, [])

  // Dismiss the suggestion dropdown on an outside click — without this it
  // stays open (and stale) once you click anywhere else on the page.
  useEffect(() => {
    if (!showSuggs) return
    const onDocMouseDown = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setShowSuggs(false); setActiveSuggIndex(-1)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [showSuggs])

  const handleInput = e => {
    const v = e.target.value
    setQuery(v)
    setActiveSuggIndex(-1)
    clearTimeout(debounce.current)
    if (v.length < 2) { setSuggs([]); setShowSuggs(false); return }
    debounce.current = setTimeout(async () => {
      const r = await fetchAutocomplete(v)
      setSuggs(r); setShowSuggs(r.length > 0); setActiveSuggIndex(-1)
    }, 250)
  }

  // suggestions are now card objects — pick directly, no extra fetch needed
  const pickSuggestion = cardObj => {
    setQuery(cardObj.name); setShowSuggs(false); setSuggs([]); setActiveSuggIndex(-1)
    setCardOrigin('idle')
    setCard(cardObj); setResults([]); setMode('card')
    addRecentlyViewed(cardObj)
  }

  // Arrow keys / Enter / Escape while the suggestion dropdown is open.
  // FilterBar calls this before its own Enter→submit handling and respects
  // e.preventDefault() to skip it, so this only changes behavior here.
  const handleSearchKeyDown = e => {
    if (!showSuggs || suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveSuggIndex(i => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveSuggIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && activeSuggIndex >= 0) {
      e.preventDefault()
      pickSuggestion(suggestions[activeSuggIndex])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setShowSuggs(false); setActiveSuggIndex(-1)
    }
  }

  const handleSearch = async e => {
    e?.preventDefault?.()
    const hasFilters = hasLookupFilters(filters)
    if (!query.trim() && !hasFilters) return
    setShowSuggs(false); setCard(null); setLoading(true); setMode('idle')
    const exact = !hasFilters ? await fetchByName(query.trim()) : null
    if (exact) { setCardOrigin('idle'); setCard(exact); setMode('card'); addRecentlyViewed(exact); setLoading(false); return }
    const scryfallQuery = buildLookupQuery(query, filters)
    setCurrentQuery(scryfallQuery)
    const { data, nextPage: np, total } = await fetchSearchResults(scryfallQuery, null, sort)
    setResults(sortByNameRelevance(data, query)); setNextPage(np); setTotalCards(total)
    setMode('results'); setLoading(false)
  }

  const handleLoadMore = async () => {
    if (!nextPage || loadingMore) return
    setLoadingMore(true)
    const { data, nextPage: np } = await fetchSearchResults(null, nextPage, sort)
    setResults(prev => [...prev, ...sortByNameRelevance(data, query)]); setNextPage(np)
    setLoadingMore(false)
  }

  const handleClear = () => {
    setCard(null); setResults([]); setNextPage(null); setTotalCards(0)
    setMode('idle'); setQuery(''); setCurrentQuery('')
    setFilters({ ...EMPTY_FILTERS })
  }

  const handleSuggHoverEnter = useCallback((uri, e) => {
    floatingPreviewRef.current?.setPos(e.clientX, e.clientY)
    floatingPreviewRef.current?.setImages(uri ? [uri] : [])
  }, [])
  const handleSuggHoverMove = useCallback((e) => {
    floatingPreviewRef.current?.setPos(e.clientX, e.clientY)
  }, [])
  const handleSuggHoverLeave = useCallback(() => {
    floatingPreviewRef.current?.setImages([])
  }, [])

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Card Lookup</h2>
        <div className={styles.sectionHeaderActions}>
          {mode !== 'idle' && (
            <button className={styles.clearBtn} onClick={handleClear}>Clear</button>
          )}
        </div>
      </div>
      <p className={styles.sectionDesc}>Search any Magic card — browse art, oracle text, prices and rulings.</p>

      <div className={styles.lookupFilterWrap} ref={wrapRef}>
        <FilterBar
          mode="lookup"
          search={query}
          setSearch={value => handleInput({ target: { value } })}
          sort={sort}
          setSort={setSort}
          filters={filters}
          setFilters={setFilters}
          sets={lookupSets}
          onSearchSubmit={handleSearch}
          onSearchKeyDown={handleSearchKeyDown}
          extra={(
            <button className={styles.searchBtn} type="button"
              onClick={handleSearch}
              disabled={loading || (!query.trim() && !hasLookupFilters(filters))}>
              {loading ? '...' : 'Search'}
            </button>
          )}
        />
        {showSuggs && (
          <ul className={styles.suggList} role="listbox">
            {suggestions.map((c, i) => {
              const img = getCardImage(c, 'small')
              const hoverableProps = CAN_HOVER && !lastInputWasTouch && img
                ? {
                    onMouseEnter: e => handleSuggHoverEnter(img, e),
                    onMouseMove: handleSuggHoverMove,
                    onMouseLeave: handleSuggHoverLeave,
                  }
                : {}
              return (
                <li
                  key={c.id}
                  role="option"
                  aria-selected={i === activeSuggIndex}
                  className={`${styles.suggItem}${i === activeSuggIndex ? ' ' + styles.suggItemActive : ''}`}
                  onMouseDown={() => pickSuggestion(c)}
                  onMouseEnter={() => setActiveSuggIndex(i)}
                >
                  <img src={img} alt="" className={styles.suggThumb} {...hoverableProps} />
                  <span className={styles.suggName}>{c.name}</span>
                  <span className={styles.suggSet}>{c.set_name}</span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {loading && <div className={styles.loadingMsg}>Searching Scryfall…</div>}
      {!loading && mode === 'card' && card && (
        <CardView card={card} onClose={() => { setCard(null); setMode(cardOrigin) }} />
      )}
      {!loading && mode === 'results' && (
        results.length === 0
          ? <div className={styles.emptyMsg}>No cards found for "{currentQuery}".</div>
          : <>
              <div className={styles.resultsHeader}>
                {totalCards > 0 ? `${totalCards.toLocaleString()} total` : `${results.length}`} result{results.length !== 1 ? 's' : ''}
                {results.length < totalCards ? ` — showing ${results.length}` : ''} — click a card for details
              </div>
              <SearchResultGrid results={results} onSelect={c => { setCardOrigin('results'); setCard(c); setMode('card'); addRecentlyViewed(c) }} />
              {nextPage && (
                <div className={styles.loadMoreWrap}>
                  <button className={styles.loadMoreBtn} onClick={handleLoadMore} disabled={loadingMore}>
                    {loadingMore ? 'Loading…' : `Load more (${results.length} / ${totalCards.toLocaleString()})`}
                  </button>
                </div>
              )}
            </>
      )}
      <FloatingPreview ref={floatingPreviewRef} />
    </section>
  )
}

// ── Random Card Section ───────────────────────────────────────────────────────
function RulebookSection() {
  const navigate = useNavigate()
  return (
    <section className={`${styles.section} ${styles.rulebookSection}`}>
      <div className={styles.rulebookBody}>
        <div className={styles.rulebookIcon}><SearchIcon size={18} /></div>
        <div className={styles.rulebookCopy}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Rulebook</h2>
          </div>
          <p className={styles.sectionDesc}>Comprehensive Magic the Gathering rules, last updated on April 17, 2026.</p>
        </div>
        <button type="button" className={styles.rulebookButton} onClick={() => navigate('/rules')}>
          Open <ChevronRightIcon size={13} />
        </button>
      </div>
    </section>
  )
}

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

const _SetCompletionSection = function SetCompletionSection({ data, loading }) {
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
    const source = getPriceSource(priceSource)
    const field = source.field
    const foilField = source.foilField
    let binderCount = 0, deckCount = 0
    for (const f of folders) {
      if (f.type === 'binder') binderCount++
      else if (f.type === 'deck') deckCount++
    }
    const uniquePrints = new Set()
    const sets = new Set()
    let totalQty = 0
    let totalValue = 0
    let foilQty = 0

    for (const card of cards || []) {
      const qty = card.qty || 1
      totalQty += qty
      if (card.foil) foilQty += qty
      const sc = card.set_code, cn = card.collector_number
      if (sc) {
        sets.add(sc)
        if (cn) {
          uniquePrints.add(sc + '-' + cn)
          const sf = sfMap[sc + '-' + cn]
          const raw = sf?.prices?.[card.foil ? foilField : field]
          if (raw) {
            const p = +raw
            if (p) totalValue += p * qty
          }
        }
      }
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
    const source = getPriceSource(priceSource)
    const field = source.field
    const foilField = source.foilField
    const K = 14
    const seen = new Set()
    const top = [] // sorted desc, length <= K

    for (const row of cardRows) {
      const card = row.cards
      if (!card || seen.has(card.id)) continue
      const sf = sfMap[`${card.set_code}-${card.collector_number}`]
      const raw = sf?.prices?.[card.foil ? foilField : field]
      if (!raw) continue
      const price = +raw
      if (!price) continue

      if (top.length < K) {
        seen.add(card.id)
        top.push({ card, sf, price })
        if (top.length === K) top.sort((a, b) => b.price - a.price)
      } else if (price > top[K - 1].price) {
        seen.add(card.id)
        let i = K - 1
        top[i] = { card, sf, price }
        while (i > 0 && top[i].price > top[i - 1].price) {
          const t = top[i]; top[i] = top[i - 1]; top[i - 1] = t
          i--
        }
      }
    }
    if (top.length < K) top.sort((a, b) => b.price - a.price)
    return top
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
            const img = getImageUri(sf, 'small') || toSmallScryfallImage(card.image_uri) || null
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
            const img = getImageUri(sf, 'small') || toSmallScryfallImage(card.image_uri) || null
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
    const source = getPriceSource(priceSource)
    const field = source.field
    const foilField = source.foilField
    const deckVal = new Map()
    for (const f of folders) {
      if (f.type === 'deck') deckVal.set(f.id, { folder: f, value: 0, qty: 0 })
    }
    for (const row of deckRows) {
      const entry = deckVal.get(row.deck_id)
      if (!entry) continue
      const card = row.cards
      if (!card) continue
      const qty = row.qty || 1
      entry.qty += qty
      const sf = sfMap[`${card.set_code}-${card.collector_number}`]
      const raw = sf?.prices?.[card.foil ? foilField : field]
      if (raw) {
        const p = +raw
        if (p) entry.value += p * qty
      }
    }
    const arr = Array.from(deckVal.values())
    arr.sort((a, b) => b.value - a.value)
    return arr.slice(0, 6)
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
                  style={{ color: article._sourceColor, borderColor: article._sourceColor }}>
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
              ? <img src={toSmallScryfallImage(card.image)} alt={card.name} className={styles.hScrollImg} loading="lazy" />
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
    version: 'July 11, 2026',
    label: 'New',
    updates: [
      'Build Assist got a major glow-up — one <strong>Auto build deck</strong> button now fills your Commander deck all the way to 100, pulling the best cards straight from your binders (or the top picks for your commander if you prefer to buy in).',
      'Shape the deck as it builds: choose a <strong>theme</strong>, target a <strong>power bracket</strong>, and set a <strong>per-card budget</strong> right from the build screen.',
      'The new summary shows your mana curve, combos you are one card away from, and a buy list for anything missing — with hover-to-preview card art and a one-click trim-to-100.',
      'Take it for a spin: open the <a href="/builder">Deck Builder</a>, start a new deck, and pick <strong>Build Assist</strong>. ✨',
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
function HomeSupportSection() {
  const navigate = useNavigate()

  return (
    <section className={`${styles.section} ${styles.homeSupportSection}`}>
      <div className={styles.homeSupportCopy}>
        <div className={styles.homeSupportEyebrow}>Support DeckLoom</div>
        <h2 className={styles.homeSupportTitle}>Unlock premium themes and keep the app growing</h2>
        <p className={styles.homeSupportText}>
          One-time support unlocks Obsidian Night, Crimson Court, and Verdant Realm across your account.
        </p>
      </div>
      <button type="button" className={styles.homeSupportButton} onClick={() => navigate('/settings#support')}>
        Support <ChevronRightIcon size={13} />
      </button>
    </section>
  )
}

export default function HomePage() {
  const { user }               = useAuth()
  const { price_source, premium } = useSettings()
  const queryClient = useQueryClient()
  const [changelog, setChangelog] = useState(CHANGELOG_DEFAULT)
  // Shared card-detail modal for hScroll sections
  const [modalCard, setModalCard] = useState(null)
  const [modalLoading, setModalLoading] = useState(false)
  // Defer below-the-fold sections so they don't block the first paint.
  const [showBelowFold, setShowBelowFold] = useState(false)

  useEffect(() => { fetchChangelog().then(setChangelog) }, [])

  useEffect(() => {
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(() => setShowBelowFold(true), { timeout: 800 })
      : setTimeout(() => setShowBelowFold(true), 250)
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle)
      else clearTimeout(idle)
    }
  }, [])

  // Cross-mount cached collection load. staleTime defaults to 5 min via queryClient defaults,
  // so Home → Collection → Home returns instantly from cache.
  const { data: collData, isLoading } = useQuery({
    queryKey: ['home-snapshot', user?.id],
    queryFn: () => loadCollectionData(user.id),
    enabled: !!user?.id,
  })
  const collLoading = isLoading && !collData

  // Trigger Home resync whenever the shared ['cards', userId] cache updates
  // (e.g. from Collection mutations, Scanner adds, Trading). Without this,
  // Home would only sync once per session and go stale.
  const [cardsCacheTick, setCardsCacheTick] = useState(0)
  useEffect(() => {
    if (!user?.id) return
    const unsub = queryClient.getQueryCache().subscribe(event => {
      if (event?.type !== 'updated') return
      const key = event.query?.queryKey
      if (Array.isArray(key) && key[0] === 'cards' && key[1] === user.id) {
        setCardsCacheTick(t => t + 1)
      }
    })
    return unsub
  }, [user?.id, queryClient])

  // Background sync after initial render. Only patches the parts that actually changed,
  // keeping sfMap reference stable when only qty drifted — avoids invalidating every memo.
  // Re-runs whenever the cards cache ticks; syncCardsFromSupabase hashes contents
  // and returns null when nothing changed, so repeat ticks are cheap.
  const lastSyncedHashRef = useRef(null)
  useEffect(() => {
    if (!user?.id || !collData) return
    let cancelled = false
    ;(async () => {
      const freshCards = await syncCardsFromSupabase(user.id, collData.cards)
      if (cancelled || !freshCards) return
      const freshHash = cardsContentHash(freshCards)
      if (freshHash === lastSyncedHashRef.current) return
      lastSyncedHashRef.current = freshHash

      // Check if the set of scryfall prints changed. If not, reuse sfMap reference.
      const prevKeys = new Set()
      for (const c of collData.cards) prevKeys.add(`${c.set_code}-${c.collector_number}`)
      let keysChanged = false
      const newKeys = new Set()
      for (const c of freshCards) {
        const k = `${c.set_code}-${c.collector_number}`
        newKeys.add(k)
        if (!prevKeys.has(k)) keysChanged = true
      }
      if (!keysChanged && newKeys.size !== prevKeys.size) keysChanged = true

      const sfMap = keysChanged
        ? await loadCardMapWithSharedPrices(freshCards, { priceLookup: 'set' })
        : collData.sfMap
      const recentCards = pickRecentCards(freshCards, 14)

      // Background sync is non-urgent — let React interrupt it for user input.
      startTransition(() => {
        queryClient.setQueryData(['home-snapshot', user.id], prev =>
          prev ? { ...prev, cards: freshCards, sfMap, recentCards } : prev
        )
      })
    })()
    return () => { cancelled = true }
  }, [user?.id, collData, queryClient, cardsCacheTick])

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
        <div className={styles.heroTitle}>
          <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
          <span className={styles.logoText}>Deck<span className={styles.heroAccent}>Loom</span></span>
        </div>
        <div className={styles.heroSub}>Your Magic: The Gathering collection manager</div>
      </div>

      <ChangelogPanel entries={changelog} />
      <CardLookupSection />
      <RulebookSection />
      {user && !premium && <HomeSupportSection />}
      {user && <CollectionSnapshot data={collData} loading={collLoading} priceSource={price_source} />}
      <RecentlyViewedSection onCardClick={openCard} />
      <RandomCardSection />
      {user && <TopValuedCards    data={collData} loading={collLoading} priceSource={price_source} onCardClick={openCard} />}
      {user && <RecentlyAdded     data={collData} loading={collLoading} onCardClick={openCard} />}
      {user && <TopValuedDecks    data={collData} loading={collLoading} priceSource={price_source} />}
      {showBelowFold && <MTGNewsSection />}
      {showBelowFold && <UpcomingSetsSection />}

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
