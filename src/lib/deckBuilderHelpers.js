/**
 * Pure deck-builder helpers — no React, no IO. Safe to import anywhere.
 *
 * Anything async/stateful belongs in deckBuilderWrites.js (Supabase) or in
 * the DeckBuilder component itself.
 */

import { BOARD_ORDER } from './deckBuilderConstants'
import { getPrice } from './scryfall'

// ── Board / name normalization ───────────────────────────────────────────────

export function normalizeBoard(board) {
  return BOARD_ORDER.includes(board) ? board : 'main'
}

// Main-board rows only — what "the deck" means for counters and the Build
// Assistant. The commander stays included (it always lives on the main board);
// side/maybe rows are excluded, and unknown boards normalize to main.
export function mainBoardCards(rows) {
  return (rows || []).filter(dc => normalizeBoard(dc?.board) === 'main')
}

// Split ids for PostgREST .in() filters — the ids ride in the request URL, so
// unbounded lists overflow URL-length limits somewhere past ~200 uuids. 100
// matches the batch size used by the app's other bulk writes.
export function chunkIds(ids, size = 100) {
  const out = []
  for (let i = 0; i < (ids?.length || 0); i += size) out.push(ids.slice(i, i + size))
  return out
}

export function normalizeCardName(name) {
  return String(name || '').trim().toLowerCase()
}

// Name filters for deckPlacementData's snapshot loaders. The remote fetch
// matches `name` case-sensitively in SQL, so these must keep the cards'
// original casing — normalizeCardName output silently matches nothing there.
export function placementFilterNames(cards) {
  return [...new Set((cards || []).map(c => String(c?.name || '').trim()).filter(Boolean))]
}

// Total COPIES across deck rows — a row holds `qty` copies (basics especially:
// one row, qty 8+). Any slot math against the deck size must use this, never
// rows.length, or multi-copy rows undercount the deck and overfill it.
export function countDeckCards(rows) {
  let n = 0
  for (const dc of rows || []) n += dc?.qty || 1
  return n
}

// Recommendation feeds (EDHREC, Recommander, Commander Spellbook) identify
// double-faced cards by their front-face name, while deck/collection rows
// store the full Scryfall "Front // Back" name. Whenever names from the two
// sides are matched against each other, key sets/maps with every key this
// name can appear under so a lookup from either side hits.
export function cardNameMatchKeys(name) {
  const full = normalizeCardName(name)
  if (!full) return []
  const front = full.split('//')[0].trim()
  return front && front !== full ? [full, front] : [full]
}

export function isGroupFolder(folder) {
  try { return JSON.parse(folder?.description || '{}').isGroup === true } catch { return false }
}

// ── Image helpers ────────────────────────────────────────────────────────────

// Upgrade a Scryfall CDN image to large quality regardless of stored size variant.
export function toLargeImg(uri) {
  if (!uri) return uri
  return uri.replace(/\/(small|art_crop|normal|png)\//, '/large/')
}

// Convert any Scryfall image URI to art_crop format (used for background panels).
export function toArtCropImg(uri) {
  if (!uri) return uri
  return uri.replace(/\/(small|normal|large|png|border_crop)\//, '/art_crop/')
}

// ── Mana symbol URL ─────────────────────────────────────────────────────────

export function manaSymbolUrl(sym) {
  return `https://svgs.scryfall.io/card-symbols/${String(sym || '').replace(/[{}]/g, '').replace(/\//g, '').toUpperCase()}.svg`
}

// ── Allocation key helpers ──────────────────────────────────────────────────

export function deckAllocationKeys(cardLike) {
  if (!cardLike) return []
  const foilKey = cardLike.foil ? '1' : '0'
  // Allocation rows contribute only their strongest available identity. If a
  // fully identified row also contributed its name, every printing with the
  // same name would look allocated and changing a version could never update
  // the ownership badge. Foil is part of the exact owned-card identity too.
  if (cardLike.card_print_id) return [`print:${cardLike.card_print_id}|${foilKey}`]
  if (cardLike.scryfall_id) return [`sf:${cardLike.scryfall_id}|${foilKey}`]
  const nameKey = (cardLike.name || '').trim().toLowerCase()
  return nameKey ? [`name:${nameKey}|${foilKey}`] : []
}

export function allocationSetHas(set, cardLike) {
  if (!cardLike || !set) return false
  const foilKey = cardLike.foil ? '1' : '0'
  const candidateKeys = []
  if (cardLike.card_print_id) candidateKeys.push(`print:${cardLike.card_print_id}|${foilKey}`)
  if (cardLike.scryfall_id) candidateKeys.push(`sf:${cardLike.scryfall_id}|${foilKey}`)
  const nameKey = (cardLike.name || '').trim().toLowerCase()
  if (nameKey) candidateKeys.push(`name:${nameKey}|${foilKey}`)
  return candidateKeys.some(key => set.has(key))
}

// Merge allocation rows fetched for cards added after the initial deck load
// into the existing other-deck key set. The load-time fetch is scoped to the
// deck's card list at load, so late additions (search, recs, assistant,
// import) need their allocations folded in or the ownership badge reports an
// owned-but-committed copy as available. Rows belonging to the current deck
// pair (the builder deck itself and its linked collection deck) are excluded.
export function mergeOtherDeckAllocationKeys(prevSet, allocationRows, excludedDeckIds = []) {
  const excluded = new Set((excludedDeckIds || []).filter(Boolean))
  const keys = (allocationRows || [])
    .filter(row => !excluded.has(row.deck_id))
    .flatMap(row => deckAllocationKeys(row))
  if (!keys.length) return prevSet
  const next = new Set(prevSet)
  for (const key of keys) next.add(key)
  return next
}

// Collects the identifying fields (print id, scryfall id, name) present across
// a list of cards, for scoping an allocation lookup to just "could this match
// one of these cards" instead of fetching a user's entire collection. The name
// tier also preloads alternate print allocations so a later version change can
// recalculate immediately without another full allocation fetch.
export function collectCardIdentities(cards) {
  const cardPrintIds = []
  const scryfallIds = []
  const names = []
  for (const c of cards || []) {
    if (c?.card_print_id) cardPrintIds.push(c.card_print_id)
    if (c?.scryfall_id) scryfallIds.push(c.scryfall_id)
    if (c?.name) names.push(c.name)
  }
  return { cardPrintIds, scryfallIds, names }
}

export function normalizePrintKey(cardLike) {
  const setCode = String(cardLike?.set_code || cardLike?.set || '').trim().toLowerCase()
  const collectorNumber = String(cardLike?.collector_number || '').trim()
  return setCode && collectorNumber ? `${setCode}-${collectorNumber}` : null
}

// Identity of a deck row for the DB's unique (deck_id, card_print_id, foil,
// board) index. card_print_id is NOT NULL on deck_cards, so it drives the key;
// the scryfall_id / print-key fallbacks only matter for optimistic rows that
// haven't been hydrated yet.
export function deckRowPrintKey(row) {
  const foil = row?.foil ? 1 : 0
  const board = normalizeBoard(row?.board)
  const ident = row?.card_print_id || row?.scryfall_id || normalizePrintKey(row) || ''
  return `${ident}|${foil}|${board}`
}

// Drop rows that would collide with the deck's unique index — either an existing
// deck card or an earlier row in the same batch. A plain bulk .insert() of one
// duplicate 409s and rolls back the WHOLE batch, so callers (auto-fill) must
// pre-dedupe. Returns the rows safe to insert plus how many were dropped.
export function dedupeDeckRowsForInsert(newRows, existingRows = []) {
  const seen = new Set((existingRows || []).map(deckRowPrintKey))
  const rows = []
  let skipped = 0
  for (const row of newRows || []) {
    const key = deckRowPrintKey(row)
    if (seen.has(key)) { skipped++; continue }
    seen.add(key)
    rows.push(row)
  }
  return { rows, skipped }
}

// ── Foil / printing helpers ─────────────────────────────────────────────────

export function printingSupportsFoil(sfCard) {
  return (sfCard?.finishes || []).includes('foil') || sfCard?.foil === true
}

export function printingSupportsNonfoil(sfCard) {
  const finishes = sfCard?.finishes || []
  return finishes.includes('nonfoil') || (!finishes.length && sfCard?.nonfoil !== false)
}

export function defaultFoilForPrinting(sfCard) {
  return !printingSupportsNonfoil(sfCard) && printingSupportsFoil(sfCard)
}

// ── Commander helpers ───────────────────────────────────────────────────────

export function getCommanderOracle(sf = null) {
  return [
    sf?.oracle_text || '',
    ...(sf?.card_faces || []).map(f => f?.oracle_text || ''),
  ].filter(Boolean).join('\n')
}

export function normalizePartnerName(name = '') {
  return String(name)
    .toLowerCase()
    .split('//')[0]
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[^a-z0-9\s,'-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function getCommanderProfile(dc, sf = null) {
  const typeLine = String(sf?.type_line || dc?.type_line || '').toLowerCase()
  const oracle = getCommanderOracle(sf)
  const keywords = new Set((sf?.keywords || []).map(k => String(k).toLowerCase()))
  const partnerWithMatch = oracle.match(/partner with ([^\n.(]+)/i)
  const profile = {
    canLead: false,
    isLegendaryCreature: typeLine.includes('legendary') && typeLine.includes('creature'),
    // CR 903.3a (2025): legendary Vehicles and Spacecraft can be commanders.
    isLegendaryVehicle: typeLine.includes('legendary') && (typeLine.includes('vehicle') || typeLine.includes('spacecraft')),
    hasCanBeCommanderText: /\bcan be your commander\b/i.test(oracle),
    hasPartner: keywords.has('partner') || /(^|\n)\s*partner(\s*\(|\.|\n|$)/i.test(oracle),
    partnerWith: partnerWithMatch ? normalizePartnerName(partnerWithMatch[1]) : '',
    hasFriendsForever: keywords.has('friends forever') || /(^|\n)\s*friends forever(\s*\(|\.|\n|$)/i.test(oracle),
    hasChooseBackground: /\bchoose a background\b/i.test(oracle),
    hasDoctorsCompanion: keywords.has("doctor's companion") || /\bdoctor's companion\b/i.test(oracle),
    isBackground: typeLine.includes('enchantment') && typeLine.includes('background'),
    isDoctor: typeLine.includes('time lord') && typeLine.includes('doctor'),
  }

  profile.canLead = profile.isLegendaryCreature
    || profile.isLegendaryVehicle
    || profile.hasCanBeCommanderText
    || profile.hasPartner
    || !!profile.partnerWith
    || profile.hasFriendsForever
    || profile.hasChooseBackground
    || profile.hasDoctorsCompanion
    || profile.isBackground

  return profile
}

export function canBeCommander(dc, sf = null) {
  if (!dc?.type_line) return true // unknown type — allow the option
  return getCommanderProfile(dc, sf).canLead
}

export function getNonCommanderDeckCoverArt(cards, sfMap = {}, priceSourceId) {
  let best = null
  for (const dc of cards || []) {
    if (dc.is_commander || normalizeBoard(dc.board) !== 'main') continue
    const sf = dc.set_code && dc.collector_number ? sfMap[`${dc.set_code}-${dc.collector_number}`] : null
    const typeLine = String(sf?.type_line || dc.type_line || '').toLowerCase()
    if (typeLine.includes('land')) continue
    const art = sf?.image_uris?.art_crop
      || sf?.card_faces?.[0]?.image_uris?.art_crop
      || (dc.image_uri ? toArtCropImg(dc.image_uri) : null)
    if (!art) continue
    const price = getPrice(sf, dc.foil, { price_source: priceSourceId })
    const score = price ?? -1
    if (!best || score > best.score) best = { score, art }
  }
  return best?.art || null
}

export function getCommanderPairIssue(cards, sfMap = {}) {
  if (!cards?.length) return null
  if (cards.length === 1) {
    const [card] = cards
    const sf = card?.set_code && card?.collector_number ? sfMap[`${card.set_code}-${card.collector_number}`] : null
    const profile = getCommanderProfile(card, sf)
    if (profile.isBackground && !profile.isLegendaryCreature && !profile.hasCanBeCommanderText) {
      return `${card?.name || 'Background'} needs a commander with Choose a Background.`
    }
    return null
  }
  if (cards.length > 2) return 'Commander format allows at most two commanders, and only when the pair is valid together.'

  const [a, b] = cards
  const sfA = a?.set_code && a?.collector_number ? sfMap[`${a.set_code}-${a.collector_number}`] : null
  const sfB = b?.set_code && b?.collector_number ? sfMap[`${b.set_code}-${b.collector_number}`] : null
  const pa = getCommanderProfile(a, sfA)
  const pb = getCommanderProfile(b, sfB)
  const nameA = normalizePartnerName(a?.name)
  const nameB = normalizePartnerName(b?.name)

  if (pa.hasPartner && pb.hasPartner) return null
  if (pa.hasFriendsForever && pb.hasFriendsForever) return null
  if ((pa.hasChooseBackground && pb.isBackground) || (pb.hasChooseBackground && pa.isBackground)) return null
  if ((pa.hasDoctorsCompanion && pb.isDoctor) || (pb.hasDoctorsCompanion && pa.isDoctor)) return null
  if ((pa.partnerWith && pa.partnerWith === nameB) || (pb.partnerWith && pb.partnerWith === nameA)) return null

  return `${a?.name || 'Commander'} and ${b?.name || 'the second commander'} are not a valid commander pair.`
}

// ── Sync helpers ────────────────────────────────────────────────────────────

export function findCommanderTransferHint(row, currentDeckCards) {
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
