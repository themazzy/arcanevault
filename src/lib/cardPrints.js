import { sb } from './supabase'

const CARD_PRINT_UPSERT_BATCH = 500
const CARD_PRINT_QUERY_BATCH = 500

function chunkRows(rows, size) {
  const chunks = []
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size))
  return chunks
}

function getCardImage(card, size = 'normal') {
  if (!card) return null
  if (card.image_uris?.[size]) return card.image_uris[size]
  if (card.card_faces?.[0]?.image_uris?.[size]) return card.card_faces[0].image_uris[size]
  return null
}

export function buildCardPrintPayload(card) {
  if (!card) return null
  const scryfallId = card.id || card.scryfall_id || null
  const setCode = card.set || card.set_code || card.setCode || null
  const collectorNumber = card.collector_number || card.collNum || null
  return {
    scryfall_id: scryfallId,
    oracle_id: card.oracle_id || null,
    name: card.name,
    set_code: setCode,
    collector_number: collectorNumber,
    type_line: card.type_line || null,
    mana_cost: card.mana_cost || card.card_faces?.[0]?.mana_cost || null,
    cmc: card.cmc ?? null,
    color_identity: card.color_identity || [],
    image_uri: card.image_uri || getCardImage(card, 'normal'),
    art_crop_uri: card.art_crop_uri || getCardImage(card, 'art_crop'),
  }
}

function printLookupKey(card) {
  const setCode = card?.set || card?.set_code || card?.setCode || null
  const collectorNumber = card?.collector_number || card?.collNum || null
  if (setCode && collectorNumber) return `set:${setCode}|${collectorNumber}`
  return card?.name ? `name:${card.name}` : null
}

export async function ensureCardPrints(cards) {
  const payloadByScryfallId = new Map()
  const fallbackPayloadByPrint = new Map()
  for (const card of cards || []) {
    const payload = buildCardPrintPayload(card)
    if (!payload) continue
    if (payload.scryfall_id) {
      payloadByScryfallId.set(payload.scryfall_id, payload)
    } else {
      const key = printLookupKey(payload)
      if (key) fallbackPayloadByPrint.set(key, payload)
    }
  }

  const result = new Map()
  const payloads = [...payloadByScryfallId.values()]
  if (payloads.length) {
    const data = []
    for (const batch of chunkRows(payloads, CARD_PRINT_UPSERT_BATCH)) {
      const { data: batchData, error } = await sb
        .from('card_prints')
        .upsert(batch, { onConflict: 'scryfall_id' })
        .select('id,scryfall_id,set_code,collector_number,name')

      if (error) throw error
      if (batchData?.length) data.push(...batchData)
    }
    for (const row of data || []) {
      if (row.scryfall_id) result.set(row.scryfall_id, row)
      const key = printLookupKey(row)
      if (key) result.set(key, row)
    }
  }

  const fallbackPayloads = [...fallbackPayloadByPrint.values()]
  if (fallbackPayloads.length) {
    const setCodes = [...new Set(fallbackPayloads.map(row => row.set_code).filter(Boolean))]
    const names = [...new Set(fallbackPayloads.map(row => row.name).filter(Boolean))]
    let existing = []
    if (setCodes.length) {
      for (const batch of chunkRows(setCodes, CARD_PRINT_QUERY_BATCH)) {
        const { data, error } = await sb
          .from('card_prints')
          .select('id,scryfall_id,set_code,collector_number,name')
          .in('set_code', batch)
        if (error) throw error
        if (data?.length) existing.push(...data)
      }
    }
    if (names.length) {
      for (const batch of chunkRows(names, CARD_PRINT_QUERY_BATCH)) {
        const { data, error } = await sb
          .from('card_prints')
          .select('id,scryfall_id,set_code,collector_number,name')
          .in('name', batch)
        if (error) throw error
        if (data?.length) existing.push(...data)
      }
    }

    const existingByPrint = new Map(existing.map(row => [printLookupKey(row), row]).filter(([key]) => key))
    const missing = fallbackPayloads.filter(row => !existingByPrint.has(printLookupKey(row)))
    if (missing.length) {
      for (const batch of chunkRows(missing, CARD_PRINT_UPSERT_BATCH)) {
        const { data, error } = await sb
          .from('card_prints')
          .insert(batch)
          .select('id,scryfall_id,set_code,collector_number,name')
        if (error) throw error
        for (const row of data || []) {
          const key = printLookupKey(row)
          if (key) existingByPrint.set(key, row)
        }
      }
    }

    for (const row of existingByPrint.values()) {
      const key = printLookupKey(row)
      if (key) result.set(key, row)
    }
  }

  return result
}

export function getCardPrint(printMap, card) {
  if (!printMap || !card) return null
  const scryfallId = card.id || card.scryfall_id || null
  return (scryfallId && printMap.get(scryfallId)) || printMap.get(printLookupKey(card)) || null
}

export function withCardPrint(row, print) {
  if (!print) return row
  return {
    ...row,
    card_print_id: print.id,
    name: print.name || row.name,
    set_code: print.set_code || row.set_code,
    collector_number: print.collector_number || row.collector_number,
  }
}
