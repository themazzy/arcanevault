import { useState, useMemo } from 'react'
import { cardsToCSV, cardsToText, downloadFile, copyToClipboard, canNativeShare, shareOrCopy } from '../lib/exportUtils'
import styles from './ExportModal.module.css'

// ── ExportModal ───────────────────────────────────────────────────────────────
// Props:
//   cards      — array of card / wishlist-item objects
//   sfMap      — Scryfall map keyed by `${set_code}-${collector_number}`
//   title      — display title  (e.g. "My Deck", "Collection")
//   folderType — 'collection' | 'binder' | 'deck' | 'list'
//   loading    — show a spinner while data is being fetched
//   onClose    — called to dismiss

export default function ExportModal({
  cards = [],
  sfMap = {},
  title = 'Export',
  folderType = 'collection',
  loading = false,
  includeFoilIndicator = true,
  onClose,
}) {
  const [fmt, setFmt]         = useState('text')   // 'text' | 'csv'
  const [copied, setCopied]   = useState(false)
  const [shareMsg, setShareMsg] = useState(null)

  const isWishlist   = folderType === 'list'
  const isCollection = folderType === 'collection'
  const noun         = isWishlist ? 'wants' : 'cards'
  const safeTitle    = title.replace(/[^a-z0-9]/gi, '_').toLowerCase()

  const textContent = useMemo(
    () => cardsToText(cards, sfMap, { includeFoilIndicator }),
    [cards, sfMap, includeFoilIndicator]
  )
  const csvContent  = useMemo(
    () => cardsToCSV(cards, sfMap, isCollection ? '' : title, folderType),
    [cards, sfMap, title, folderType, isCollection]
  )

  const content  = fmt === 'csv' ? csvContent : textContent
  const ext      = fmt === 'csv' ? 'csv' : 'txt'
  const mime     = fmt === 'csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8'
  const filename = `${safeTitle}.${ext}`

  const allLines = content.split('\n')
  const preview  = allLines.slice(0, 12).join('\n')
  const overflow = allLines.length - 12

  const handleCopy = async () => {
    const ok = await copyToClipboard(content)
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000) }
  }

  const handleShare = async (overrideContent, overrideFmt) => {
    const c  = overrideContent ?? content
    const f  = overrideFmt ?? fmt
    const fn = `${safeTitle}.${f === 'csv' ? 'csv' : 'txt'}`
    const res = await shareOrCopy(title, c, fn)
    setShareMsg(res)
    setTimeout(() => setShareMsg(null), 2500)
  }

  return (
    <div className={styles.overlay} onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>

        {/* ── Header ── */}
        <div className={styles.head}>
          <div className={styles.headIcon}>↓</div>
          <div>
            <div className={styles.headTitle}>Export</div>
            <div className={styles.headSub}>
              {title}
              {!loading && <> · <span className={styles.cardCount}>{cards.length} {noun}</span></>}
            </div>
          </div>
        </div>

        {loading ? (
          <div className={styles.loadingWrap}>
            <div className={styles.spinner} />
            <span>Loading cards…</span>
          </div>
        ) : (
          <>
            {/* ── Format tabs ── */}
            <div className={styles.tabs}>
              <button
                className={`${styles.tab} ${fmt === 'text' ? styles.tabActive : ''}`}
                onClick={() => setFmt('text')}
              >
                ≡ Text
              </button>
              <button
                className={`${styles.tab} ${fmt === 'csv' ? styles.tabActive : ''}`}
                onClick={() => setFmt('csv')}
              >
                ⊟ CSV
              </button>
              <span className={styles.tabHint}>
                {fmt === 'text' ? 'Plain decklist — paste anywhere' : 'Manabox-compatible — re-importable'}
              </span>
            </div>

            {/* ── Preview ── */}
            <div className={styles.previewWrap}>
              <pre className={styles.preview}>{preview}</pre>
              {overflow > 0 && (
                <div className={styles.overflow}>… {overflow} more line{overflow !== 1 ? 's' : ''}</div>
              )}
            </div>

            {/* ── Primary actions ── */}
            <div className={styles.actions}>
              <button
                className={`${styles.btn} ${styles.btnCopy} ${copied ? styles.btnCopied : ''}`}
                onClick={handleCopy}
              >
                {copied ? '✓ Copied' : '⎘ Copy'}
              </button>
              <button
                className={`${styles.btn} ${styles.btnDownload}`}
                onClick={() => downloadFile(content, filename, mime)}
              >
                ↓ .{ext}
              </button>
              <button
                className={`${styles.btn} ${styles.btnShare}`}
                onClick={() => handleShare()}
                title={canNativeShare() ? 'Open share sheet' : 'Copy to clipboard'}
              >
                ↗ {canNativeShare() ? 'Share' : 'Copy link'}
              </button>
            </div>

            {/* ── Also export the other format ── */}
            <div className={styles.altRow}>
              <span className={styles.altLabel}>Also:</span>
              {fmt === 'text' ? (
                <>
                  <button className={styles.altBtn} onClick={() => downloadFile(csvContent, `${safeTitle}.csv`, 'text/csv;charset=utf-8')}>↓ .csv</button>
                  <button className={styles.altBtn} onClick={() => handleShare(csvContent, 'csv')}>↗ Share CSV</button>
                </>
              ) : (
                <>
                  <button className={styles.altBtn} onClick={() => downloadFile(textContent, `${safeTitle}.txt`, 'text/plain;charset=utf-8')}>↓ .txt</button>
                  <button className={styles.altBtn} onClick={() => handleShare(textContent, 'text')}>↗ Share Text</button>
                </>
              )}
            </div>

            {/* ── Share status / phone hint ── */}
            {shareMsg && (
              <div className={styles.shareMsg}>
                {shareMsg === 'shared'    && '✓ Shared successfully'}
                {shareMsg === 'copied'    && '✓ Copied to clipboard'}
                {shareMsg === 'cancelled' && 'Share cancelled'}
                {shareMsg === 'failed'    && 'Could not share — try Copy'}
              </div>
            )}

            {!canNativeShare() && (
              <div className={styles.phoneHint}>
                📱 Open on a phone to use the native share sheet (messages, email, WhatsApp…)
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
