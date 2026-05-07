import { useEffect, useMemo, useState } from 'react'
import { sb } from './supabase'
import { parseDeckMeta, serializeDeckMeta } from './deckBuilderApi'

const artCache = {}

export function toArtCropImg(uri) {
  if (!uri) return uri
  return uri.replace(/\/(small|normal|large|png|border_crop)\//, '/art_crop/')
}

function firstString(...values) {
  return values.find(v => typeof v === 'string' && v.trim()) || null
}

function commanderId(commander) {
  return firstString(
    commander?.scryfall_id,
    commander?.scryfallId,
    commander?.scryfallID,
    commander?.id,
  )
}

function commanderArt(commander) {
  return toArtCropImg(firstString(
    commander?.art_crop_uri,
    commander?.artCropUri,
    commander?.cover_art_uri,
    commander?.coverArtUri,
    commander?.image_uri,
    commander?.imageUri,
  ))
}

function normalizeCommanderList(meta = {}) {
  const commanders = Array.isArray(meta.commanders)
    ? meta.commanders
        .map(c => ({
          id: commanderId(c),
          art: commanderArt(c),
        }))
        .filter(c => c.id || c.art)
    : []

  if (commanders.length) return commanders

  const legacy = []
  const commanderScryfallId = firstString(meta.commanderScryfallId, meta.commander_scryfall_id)
  const partnerScryfallId = firstString(meta.partnerScryfallId, meta.partner_scryfall_id)
  if (commanderScryfallId) legacy.push({ id: commanderScryfallId, art: null })
  if (partnerScryfallId && partnerScryfallId !== commanderScryfallId) legacy.push({ id: partnerScryfallId, art: null })
  return legacy
}

export function getDeckCoverArt(meta = {}) {
  return toArtCropImg(firstString(meta.coverArtUri, meta.cover_art_uri, meta.bg_url))
}

export function hasDeckArtSource(meta = {}) {
  if (getDeckCoverArt(meta)) return true
  return normalizeCommanderList(meta).some(c => c.id || c.art)
}

export function mergeDeckCommanderArt(meta = {}, rows = []) {
  const commanderRows = (rows || []).filter(row => row?.is_commander)
  if (!commanderRows.length || hasDeckArtSource(meta)) return meta

  const commanders = commanderRows.map(row => ({
    name: row.name,
    scryfall_id: row.scryfall_id,
    color_identity: row.color_identity ?? [],
    image_uri: row.art_crop_uri || row.image_uri || null,
  })).filter(c => c.scryfall_id || c.image_uri)

  if (!commanders.length) return meta

  return {
    ...meta,
    commanders,
    commanderName: meta.commanderName || commanders[0]?.name || null,
    commanderScryfallId: meta.commanderScryfallId || commanders[0]?.scryfall_id || null,
    commanderColorIdentity: meta.commanderColorIdentity || commanders[0]?.color_identity || [],
    coverArtUri: meta.coverArtUri || toArtCropImg(commanders[0]?.image_uri) || null,
  }
}

function getInitialDeckArts(meta = {}) {
  const cover = getDeckCoverArt(meta)
  const commanders = normalizeCommanderList(meta)

  if (!commanders.length) return cover ? [cover] : []
  if (commanders.length === 1) return [cover || commanders[0].art].filter(Boolean)

  const arts = commanders.map(c => c.art || null)
  return arts.some(Boolean) ? arts : (cover ? [cover] : [])
}

async function fetchCommanderArt(id) {
  if (!id) return null
  if (Object.prototype.hasOwnProperty.call(artCache, id)) return artCache[id]

  artCache[id] = null
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${id}?format=json`)
    const data = response.ok ? await response.json() : null
    const url = data?.image_uris?.art_crop || data?.card_faces?.[0]?.image_uris?.art_crop || null
    artCache[id] = url
    return url
  } catch {
    return null
  }
}

export function useDeckArts(meta = {}) {
  const key = useMemo(() => JSON.stringify({
    coverArtUri: meta.coverArtUri,
    cover_art_uri: meta.cover_art_uri,
    bg_url: meta.bg_url,
    commanderScryfallId: meta.commanderScryfallId,
    commander_scryfall_id: meta.commander_scryfall_id,
    partnerScryfallId: meta.partnerScryfallId,
    partner_scryfall_id: meta.partner_scryfall_id,
    commanders: meta.commanders,
  }), [
    meta.coverArtUri,
    meta.cover_art_uri,
    meta.bg_url,
    meta.commanderScryfallId,
    meta.commander_scryfall_id,
    meta.partnerScryfallId,
    meta.partner_scryfall_id,
    meta.commanders,
  ])

  const [arts, setArts] = useState(() => getInitialDeckArts(meta))

  useEffect(() => {
    let alive = true
    const commanders = normalizeCommanderList(meta)
    const cover = getDeckCoverArt(meta)
    const initial = getInitialDeckArts(meta)
    setArts(initial)

    if (!commanders.length) return () => { alive = false }

    const applyFetched = async () => {
      if (commanders.length === 1) {
        const current = cover || commanders[0].art || await fetchCommanderArt(commanders[0].id)
        if (alive) setArts(current ? [current] : [])
        return
      }

      const resolved = await Promise.all(commanders.map(async c => c.art || await fetchCommanderArt(c.id)))
      const visible = resolved.filter(Boolean)
      if (alive) setArts(visible.length ? resolved : (cover ? [cover] : []))
    }

    applyFetched()
    return () => { alive = false }
  }, [key])

  return arts.filter(Boolean)
}

export function useDeckArt(meta = {}) {
  return useDeckArts(meta)[0] || null
}

/**
 * Look up commander art for a list of decks, merge into folder meta, optionally
 * persist back to Supabase. Used by Builder.jsx to populate cover art for decks
 * that don't have it cached yet.
 *
 * Test seam: pass `client` to override the Supabase client (default: live `sb`).
 *
 * @param {Array} decks      Folder rows with `id`, `description`, `type`.
 * @param {Object} options
 * @param {boolean} options.persist  Write merged descriptions back to `folders` (default: false).
 * @param {Object}  options.client   Supabase client override (default: live).
 * @returns {Promise<Array>}  Decks with merged `__meta` and updated `description`.
 */
export async function enrichDecksWithCommanderArt(decks, { persist = false, client = sb } = {}) {
  const missingDecks = decks.filter(deck => !hasDeckArtSource(parseDeckMeta(deck.description)))
  const missingIds = missingDecks.map(deck => deck.id)
  if (!missingIds.length) return decks

  const { data, error } = await client.from('deck_cards_view')
    .select('deck_id,name,scryfall_id,color_identity,image_uri,art_crop_uri,is_commander')
    .in('deck_id', missingIds)
    .eq('is_commander', true)

  const byDeck = new Map()
  for (const row of error ? [] : (data || [])) {
    if (!byDeck.has(row.deck_id)) byDeck.set(row.deck_id, [])
    byDeck.get(row.deck_id).push(row)
  }

  const stillMissing = missingDecks.filter(deck => !byDeck.has(deck.id))
  const namedCollectionDecks = stillMissing.filter(deck => {
    const meta = parseDeckMeta(deck.description)
    return deck.type === 'deck' && (meta.commanderName || meta.commanders?.some(c => c.name))
  })
  if (namedCollectionDecks.length) {
    const { data: allocationRows } = await client.from('deck_allocations_view')
      .select('deck_id,name,scryfall_id,color_identity,image_uri,art_crop_uri')
      .in('deck_id', namedCollectionDecks.map(deck => deck.id))

    const wantedNames = new Map(namedCollectionDecks.map(deck => {
      const meta = parseDeckMeta(deck.description)
      const names = new Set([
        meta.commanderName,
        ...(Array.isArray(meta.commanders) ? meta.commanders.map(c => c.name) : []),
      ].filter(Boolean).map(name => String(name).toLowerCase()))
      return [deck.id, names]
    }))

    for (const row of allocationRows || []) {
      if (!wantedNames.get(row.deck_id)?.has(String(row.name || '').toLowerCase())) continue
      if (!byDeck.has(row.deck_id)) byDeck.set(row.deck_id, [])
      byDeck.get(row.deck_id).push({ ...row, is_commander: true })
    }
  }

  if (!byDeck.size) return decks

  const enriched = decks.map(deck => {
    const rows = byDeck.get(deck.id)
    if (!rows?.length) return deck
    const meta = mergeDeckCommanderArt(parseDeckMeta(deck.description), rows)
    return { ...deck, description: serializeDeckMeta(meta), __meta: meta, __artNeedsPersist: true }
  })
  const toPersist = persist ? enriched.filter(d => d.__artNeedsPersist && d.id) : []
  if (toPersist.length) {
    // Fire-and-forget; failure means we'll just re-enrich next time.
    Promise.all(toPersist.map(d =>
      client.from('folders').update({ description: d.description }).eq('id', d.id)
    )).catch(err => console.warn('[deckArt] persist failed:', err))
  }
  return enriched.map(({ __artNeedsPersist, ...rest }) => rest)
}
