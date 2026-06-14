import { useState, useMemo } from 'react'
import { CheckIcon, CloseIcon, CopyIcon, TableViewIcon, TextViewIcon, CartIcon } from '../icons'
import { cardsToCSV, cardsToText, cardsToArena, cardsToMtgoDek, cardsToBuylist, downloadFile, copyToClipboard, canNativeShare, shareOrCopy } from '../lib/exportUtils'
import styles from './ExportModal.module.css'

// ── ExportModal ───────────────────────────────────────────────────────────────
// Props:
//   cards         — array of card / wishlist-item objects
//   sfMap         — Scryfall map keyed by `${set_code}-${collector_number}`
//   title         — display title  (e.g. "My Deck", "Collection")
//   folderType    — 'collection' | 'binder' | 'deck' | 'list'
//   loading       — show a spinner while data is being fetched
//   unownedCards  — (optional, decks) cards the user does NOT own, for the "Buylist" tab
//   onClose       — called to dismiss

export default function ExportModal({
  cards = [],
  sfMap = {},
  title = 'Export',
  folderType = 'collection',
  loading = false,
  includeFoilIndicator = true,
  unownedCards = null,
  onClose,
}) {
  const isWishlist   = folderType === 'list'
  const isCollection = folderType === 'collection'
  const isDeck       = folderType === 'deck'
  const noun         = isWishlist ? 'wants' : 'cards'
  const safeTitle    = title.replace(/[^a-z0-9]/gi, '_').toLowerCase()

  // Available formats. Arena/MTGO only make sense for actual decks; the buylist
  // tab only appears when the caller computed un-owned cards.
  const formats = useMemo(() => {
    const list = [
      { id: 'text', label: 'Text', icon: TextViewIcon,  ext: 'txt', mime: 'text/plain;charset=utf-8',
        hint: 'Plain decklist — paste anywhere',
        build: () => cardsToText(cards, sfMap, { includeFoilIndicator }) },
      { id: 'csv',  label: 'CSV',  icon: TableViewIcon, ext: 'csv', mime: 'text/csv;charset=utf-8',
        hint: 'Manabox-compatible — re-importable',
        build: () => cardsToCSV(cards, sfMap, isCollection ? '' : title, folderType) },
    ]
    if (!isWishlist && !isCollection) {
      list.push(
        { id: 'arena', label: 'Arena', icon: TextViewIcon, ext: 'txt', mime: 'text/plain;charset=utf-8',
          hint: 'MTG Arena import — 1 Name (SET) 123',
          build: () => cardsToArena(cards, sfMap) },
        { id: 'mtgo',  label: 'MTGO',  icon: TextViewIcon, ext: 'dek', mime: 'application/xml;charset=utf-8',
          hint: 'Magic Online .dek file',
          build: () => cardsToMtgoDek(cards, sfMap) },
      )
    }
    if (isDeck && Array.isArray(unownedCards)) {
      list.push({ id: 'buylist', label: 'Buylist', icon: CartIcon, ext: 'txt', mime: 'text/plain;charset=utf-8',
        hint: unownedCards.length
          ? `${unownedCards.length} card${unownedCards.length !== 1 ? 's' : ''} you don't own — paste into TCGplayer / Cardmarket`
          : 'You already own every card in this deck',
        build: () => cardsToBuylist(unownedCards, sfMap) })
    }
    return list
  }, [cards, sfMap, title, folderType, isCollection, isWishlist, isDeck, includeFoilIndicator, unownedCards])

  const [fmt, setFmt]           = useState('text')
  const [copied, setCopied]     = useState(false)
  const [shareMsg, setShareMsg] = useState(null)

  const active   = formats.find(f => f.id === fmt) || formats[0]
  const content  = useMemo(() => active.build(), [active])
  const filename = `${safeTitle}.${active.ext}`

  const allLines = content.split('\n')
  const preview  = allLines.slice(0, 12).join('\n')
  const overflow = allLines.length - 12

  const handleCopy = async () => {
    const ok = await copyToClipboard(content)
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 2000) }
  }

  const handleShare = async () => {
    const res = await shareOrCopy(title, content, filename)
    setShareMsg(res)
    setTimeout(() => setShareMsg(null), 2500)
  }

  return (
    <div className={styles.overlay} onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        <button className={styles.closeBtn} onClick={onClose} aria-label="Close"><CloseIcon size={13} /></button>

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
              {formats.map(f => {
                const Icon = f.icon
                return (
                  <button
                    key={f.id}
                    className={`${styles.tab} ${fmt === f.id ? styles.tabActive : ''}`}
                    onClick={() => setFmt(f.id)}
                  >
                    <Icon size={12} /> {f.label}
                  </button>
                )
              })}
            </div>
            <div className={styles.tabHintRow}>{active.hint}</div>

            {/* ── Preview ── */}
            <div className={styles.previewWrap}>
              <pre className={styles.preview}>{preview || '(nothing to export)'}</pre>
              {overflow > 0 && (
                <div className={styles.overflow}>… {overflow} more line{overflow !== 1 ? 's' : ''}</div>
              )}
            </div>

            {/* ── Primary actions ── */}
            <div className={styles.actions}>
              <button
                className={`${styles.btn} ${styles.btnCopy} ${copied ? styles.btnCopied : ''}`}
                onClick={handleCopy}
                disabled={!content}
              >
                {copied ? <><CheckIcon size={12} /> Copied</> : <><CopyIcon size={12} /> Copy</>}
              </button>
              <button
                className={`${styles.btn} ${styles.btnDownload}`}
                onClick={() => downloadFile(content, filename, active.mime)}
                disabled={!content}
              >
                ↓ .{active.ext}
              </button>
              <button
                className={`${styles.btn} ${styles.btnShare}`}
                onClick={handleShare}
                disabled={!content}
                title={canNativeShare() ? 'Open share sheet' : 'Copy to clipboard'}
              >
                ↗ {canNativeShare() ? 'Share' : 'Copy link'}
              </button>
            </div>

            {/* ── Share status / phone hint ── */}
            {shareMsg && (
              <div className={styles.shareMsg}>
                {shareMsg === 'shared'    && <><CheckIcon size={12} /> Shared successfully</>}
                {shareMsg === 'copied'    && <><CheckIcon size={12} /> Copied to clipboard</>}
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
