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
