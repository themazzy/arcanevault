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

export function normalizeCardName(name) {
  return String(name || '').trim().toLowerCase()
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
  const keys = []
  const foilKey = cardLike.foil ? '1' : '0'
  if (cardLike.card_print_id) keys.push(`print:${cardLike.card_print_id}`)
  if (cardLike.scryfall_id) keys.push(`sf:${cardLike.scryfall_id}|${foilKey}`)
  const nameKey = (cardLike.name || '').trim().toLowerCase()
  if (nameKey) keys.push(`name:${nameKey}|${foilKey}`)
  return [...new Set(keys)]
}

export function allocationSetHas(set, cardLike) {
  return deckAllocationKeys(cardLike).some(key => set.has(key))
}

export function normalizePrintKey(cardLike) {
  const setCode = String(cardLike?.set_code || cardLike?.set || '').trim().toLowerCase()
  const collectorNumber = String(cardLike?.collector_number || '').trim()
  return setCode && collectorNumber ? `${setCode}-${collectorNumber}` : null
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
