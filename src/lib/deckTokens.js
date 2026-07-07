import { sfGet } from './scryfall'

const EXTRA_QUERIES = {
  Monarch: 't:conspiracy !"Monarch" game:paper',
  'The Initiative': '!"The Initiative" game:paper',
  'The Ring': 't:emblem !"The Ring"',
  Dungeon: 't:dungeon game:paper',
  Emblem: 't:emblem game:paper',
}

export function extractTokenNames(oracle) {
  if (!oracle) return []
  const names = new Set()

  const namedRe = /\b(Treasure|Food|Clue|Blood|Powerstone|Junk|Map|Shard|Incubator|Gold)\s+tokens?/gi
  let match
  while ((match = namedRe.exec(oracle)) !== null) names.add(match[1])

  const creatureRe = /create\s+(?:a\s+|an\s+|one\s+|two\s+|three\s+|four\s+|five\s+|six\s+|x\s+|\d+\s+)*(?:tapped\s+|attacking\s+)?(?:[+-]?\d+\/[+-]?\d+\s+)?(?:(?:white|blue|black|red|green|colorless|silver|gold)\s+)*(?:legendary\s+|snow\s+)?([A-Z][a-zA-Z]*(?:\s+[A-Z][a-zA-Z]*)*?)\s+(?:artifact\s+)?creature\s+tokens?/gi
  while ((match = creatureRe.exec(oracle)) !== null) {
    const raw = match[1]?.trim()
    if (!raw || /^(A|An|The|X|Your|Their|Each|All|Another|That|This|Copy|Token|Artifact)$/i.test(raw)) continue
    const words = raw.split(/\s+/)
    const name = words[words.length - 1]
    if (name && name.length > 1) names.add(name)
  }

  const roleRe = /\b(Blessed|Cursed|Wicked|Monster|Royal|Sorcerer|Young Hero)\s+Role\s+token/gi
  while ((match = roleRe.exec(oracle)) !== null) names.add(`${match[1]} Role`)

  return [...names]
}

export function extractTokenExtras(oracle) {
  if (!oracle) return []
  const extras = new Set()
  const text = oracle.toLowerCase()
  if (/\bmonarch\b/.test(text)) extras.add('Monarch')
  if (/\binitiative\b/.test(text)) extras.add('The Initiative')
  if (/the ring tempts you/.test(text)) extras.add('The Ring')
  if (/venture into the dungeon/.test(text)) extras.add('Dungeon')
  if (/you get an? emblem/.test(text)) extras.add('Emblem')
  return [...extras]
}

export function getDeckTokenItems(cards) {
  const oracle = (cards || []).map(card => card.oracle_text || '').join('\n')
  return [
    ...extractTokenNames(oracle).map(name => ({ name, kind: 'token' })),
    ...extractTokenExtras(oracle).map(name => ({ name, kind: 'extra' })),
  ]
}

export async function fetchDeckTokenCard(item, imageSize = 'normal') {
  const rawQuery = EXTRA_QUERIES[item.name] ?? `t:token !"${item.name}" game:paper`
  const query = encodeURIComponent(rawQuery)
  const data = await sfGet(`/cards/search?q=${query}&order=released&dir=desc&unique=prints`)
  const hit = data?.data?.[0]
  if (!hit) return { ...item, imageUri: null, card: null }
  const imageUri = hit.image_uris?.[imageSize]
    ?? hit.card_faces?.[0]?.image_uris?.[imageSize]
    ?? hit.image_uris?.small
    ?? hit.card_faces?.[0]?.image_uris?.small
    ?? null
  return { ...item, imageUri, card: hit }
}
