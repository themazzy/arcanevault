// ── exportUtils.js ────────────────────────────────────────────────────────────
// Utilities for exporting collection / deck / binder / wishlist data.

const escCsv = v => {
  const s = v == null ? '' : String(v)
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s
}

/**
 * Manabox-compatible CSV.
 * If cards have a `_folderName` property, a per-card "binder name" column is added.
 * Otherwise pass folderName/folderType for a uniform folder column.
 */
export function cardsToCSV(cards, sfMap = {}, folderName = '', folderType = '') {
  const perCard = cards.some(c => c._folderName != null)
  const hasFolder = perCard || Boolean(folderName)

  const headers = [
    'name', 'set code', 'collector number', 'foil', 'quantity',
    'condition', 'language', 'purchase price', 'purchase price currency',
    ...(hasFolder ? ['binder name', 'binder type'] : []),
  ]

  const rows = cards.map(c => {
    const sf = sfMap[`${c.set_code}-${c.collector_number}`] || {}
    const name = c.name || sf.name || ''
    const qty  = c._folder_qty ?? c.qty ?? 1
    const fn   = perCard ? (c._folderName || '') : folderName
    const ft   = perCard ? (c._folderType || 'binder') : (folderType || 'binder')

    return [
      escCsv(name),
      c.set_code || '',
      c.collector_number || '',
      c.foil ? 'foil' : '',
      qty,
      c.condition || 'near_mint',
      c.language || 'en',
      c.purchase_price != null ? c.purchase_price : '',
      'EUR',
      ...(hasFolder ? [escCsv(fn), ft] : []),
    ].join(',')
  })

  return [headers.join(','), ...rows].join('\n')
}

/**
 * Plain-text decklist  ( "4 Lightning Bolt" / "1 Sol Ring *F*" )
 */
export function cardsToText(cards, sfMap = {}, { includeFoilIndicator = true } = {}) {
  return cards.map(c => {
    const sf   = sfMap[`${c.set_code}-${c.collector_number}`] || {}
    const name = c.name || sf.name || 'Unknown'
    const qty  = c._folder_qty ?? c.qty ?? 1
    return `${qty} ${name}${includeFoilIndicator && c.foil ? ' *F*' : ''}`
  }).join('\n')
}

// Board helpers (deck cards carry board: main/attraction/side/maybe and is_commander).
const cardName = (c, sfMap) =>
  c.name || (sfMap[`${c.set_code}-${c.collector_number}`] || {}).name || 'Unknown'
const cardQty = c => c._folder_qty ?? c.qty ?? 1
const boardOf = c => {
  const b = (c.board || 'main').toLowerCase()
  return b === 'sideboard' ? 'side' : b
}

/**
 * MTG Arena import format:  "1 Lightning Bolt (M10) 146"
 * Sections: Commander / Deck / Attractions / Sideboard. The "maybe" board is excluded.
 * Falls back to "<qty> <name>" when a card has no set/collector number.
 */
export function cardsToArena(cards, sfMap = {}) {
  const line = c => {
    const set = c.set_code ? `(${String(c.set_code).toUpperCase()}) ${c.collector_number || ''}`.trim() : ''
    return `${cardQty(c)} ${cardName(c, sfMap)}${set ? ` ${set}` : ''}`
  }
  const commander = cards.filter(c => c.is_commander)
  const main = cards.filter(c => !c.is_commander && boardOf(c) === 'main')
  const attractions = cards.filter(c => !c.is_commander && boardOf(c) === 'attraction')
  const side = cards.filter(c => !c.is_commander && boardOf(c) === 'side')

  const blocks = []
  if (commander.length) blocks.push(['Commander', commander])
  blocks.push(['Deck', main])
  if (attractions.length) blocks.push(['Attractions', attractions])
  if (side.length) blocks.push(['Sideboard', side])

  return blocks
    .filter(([, list]) => list.length)
    .map(([label, list]) => `${label}\n${list.map(line).join('\n')}`)
    .join('\n\n')
}

const escXml = s => String(s ?? '').replace(/[<>&"']/g, ch =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]))

/**
 * Magic Online ".dek" XML. Commander + main go in the deck; the "side" board
 * becomes Sideboard="true". Maybeboard and Attractions are excluded because
 * Magic Online has no Attraction-deck zone.
 */
export function cardsToMtgoDek(cards, sfMap = {}) {
  const playable = cards.filter(c => c.is_commander || !['maybe', 'attraction'].includes(boardOf(c)))
  const row = c =>
    `  <Cards CatID="0" Quantity="${cardQty(c)}" Sideboard="${!c.is_commander && boardOf(c) === 'side' ? 'true' : 'false'}" Name="${escXml(cardName(c, sfMap))}" />`
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Deck xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '  <NetDeckID>0</NetDeckID>',
    '  <PreconstructedDeckID>0</PreconstructedDeckID>',
    ...playable.map(row),
    '</Deck>',
  ].join('\n')
}

/** Trigger a browser file download. */
export function downloadFile(content, filename, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  requestAnimationFrame(() => { document.body.removeChild(a); URL.revokeObjectURL(url) })
}

/** Copy text to clipboard. Returns true on success. */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = Object.assign(document.createElement('textarea'), {
        value: text,
        style: 'position:fixed;opacity:0;top:-9999px',
      })
      document.body.appendChild(ta)
      ta.focus(); ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch { return false }
  }
}

/** True if the Web Share API is available (phones, modern browsers). */
export function canNativeShare() {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function'
}

/**
 * Share via Web Share API, falling back to clipboard copy.
 * Returns: 'shared' | 'copied' | 'cancelled' | 'failed'
 */
export async function shareOrCopy(title, text, filename) {
  if (canNativeShare()) {
    try {
      if (navigator.canShare) {
        const file = new File([text], filename, { type: 'text/plain' })
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ title, files: [file] })
          return 'shared'
        }
      }
      await navigator.share({ title, text })
      return 'shared'
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled'
    }
  }
  return (await copyToClipboard(text)) ? 'copied' : 'failed'
}
