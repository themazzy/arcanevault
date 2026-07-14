// Pure helpers for keeping card_prints in sync from Scryfall's all_cards bulk
// export, shared by sync-card-prices.mjs (daily insert-missing + metadata
// backfill) and unit-tested in src/lib/printSyncCore.test.js.

export const ORACLE_TEXT_CAP = 600

function pickImage(card, size) {
  if (card?.image_uris?.[size]) return card.image_uris[size]
  if (card?.card_faces?.[0]?.image_uris?.[size]) return card.card_faces[0].image_uris[size]
  return null
}

function oracleTextOf(card) {
  if (card?.oracle_text) return card.oracle_text.slice(0, ORACLE_TEXT_CAP)
  const faces = Array.isArray(card?.card_faces)
    ? card.card_faces.map(face => face.oracle_text).filter(Boolean)
    : []
  return faces.length ? faces.join('\n//\n').slice(0, ORACLE_TEXT_CAP) : ''
}

function slimFaces(faces) {
  if (!Array.isArray(faces) || !faces.length) return null
  return faces.map(f => ({
    name: f.name || null,
    mana_cost: f.mana_cost || null,
    type_line: f.type_line || null,
    oracle_text: f.oracle_text || null,
    power: f.power ?? null,
    toughness: f.toughness ?? null,
    image_uris: f.image_uris ? {
      small: f.image_uris.small || null,
      normal: f.image_uris.normal || null,
      large: f.image_uris.large || null,
    } : null,
  }))
}

const EXCLUDED_LAYOUTS = new Set([
  'token',
  'double_faced_token',
  'emblem',
  'art_series',
  'vanguard',
  'scheme',
  'planar',
])

const EXCLUDED_SET_TYPES = new Set([
  'token',
  'memorabilia',
  'minigame',
  'treasure_chest',
  'alchemy',
])

// Insert gate for prints newly discovered in the bulk stream. English paper
// cards only — non-English rows still enter card_prints through app usage
// (requireCardPrintIds) when a user actually owns one. Mirrors the price
// sync's shouldKeepCard minus the has-a-price requirement, so brand-new set
// previews are searchable before they have market prices.
export function shouldInsertPrint(card) {
  if (!card?.id || !card?.set || !card?.collector_number || !card?.name) return false
  if (card.object !== 'card') return false
  if (card.digital) return false
  if (card.lang !== 'en') return false
  if (Array.isArray(card.games) && card.games.length && !card.games.includes('paper')) return false
  if (EXCLUDED_LAYOUTS.has(card.layout)) return false
  if (EXCLUDED_SET_TYPES.has(card.set_type)) return false
  return true
}

// Full card_prints row from a Scryfall bulk card object. Must stay aligned
// with buildCardPrintPayload in src/lib/cardPrints.js (the app-side writer).
export function buildPrintRow(card) {
  return {
    scryfall_id: card.id,
    oracle_id: card.oracle_id || null,
    name: card.name,
    set_code: card.set,
    collector_number: card.collector_number,
    lang: card.lang || null,
    type_line: card.type_line || null,
    mana_cost: card.mana_cost || card.card_faces?.[0]?.mana_cost || null,
    cmc: card.cmc ?? null,
    color_identity: card.color_identity || [],
    image_uri: pickImage(card, 'normal'),
    art_crop_uri: pickImage(card, 'art_crop'),
    oracle_text: oracleTextOf(card),
    rarity: card.rarity || null,
    set_name: card.set_name || null,
    artist: card.artist || null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    produced_mana: card.produced_mana || [],
    keywords: card.keywords || [],
    colors: card.colors || [],
    card_faces: slimFaces(card.card_faces),
    attraction_lights: Array.isArray(card.attraction_lights) ? card.attraction_lights : null,
    released_at: card.released_at || null,
    edhrec_rank: Number.isFinite(card.edhrec_rank) ? card.edhrec_rank : null,
    illustration_id: card.illustration_id || card.card_faces?.[0]?.illustration_id || null,
    finishes: Array.isArray(card.finishes) ? card.finishes : [],
  }
}
