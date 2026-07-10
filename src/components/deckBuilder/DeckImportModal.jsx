import { useState, useEffect, useRef, useMemo } from 'react'
import { sb } from '../../lib/supabase'
import { normalizeImportedDeckCards, parseImportText, resolveImportEntries, summarizeImportRows } from '../../lib/importFlow'
import { getDeckBuilderCardMeta, importDeckFromUrl } from '../../lib/deckBuilderApi'
import { BOARD_ORDER, BOARD_LABELS } from '../../lib/deckBuilderConstants'
import { normalizeBoard } from '../../lib/deckBuilderHelpers'
import { toDeckCardRow, requireCardPrintIds } from '../../lib/deckBuilderWrites'
import { putDeckCards } from '../../lib/db'
import { CheckIcon, CloseIcon, WarningIcon } from '../../icons'
import styles from './DeckImportModal.module.css'

const TABS = [
  ['text', 'Paste List'],
  ['file', 'Upload File'],
  ['url',  'From URL'],
]

/**
 * Bulk deck import modal. Owns its own UI state — the parent only needs to
 * supply `open` / `onClose` and the deck context primitives.
 *
 * Sources: pasted decklist, .txt/.csv file, or a deck URL (Archidekt /
 * Moxfield via the Cloudflare Worker import proxy; Goldfish is blocked
 * upstream and errors with a paste hint).
 *
 * On a successful import the modal calls `setDeckCards()` directly with the
 * merged update + insert plan.
 */
export default function DeckImportModal({
  open,
  onClose,
  deckId,
  userId,
  deckCardsRef,
  setDeckCards,
  onImported,
}) {
  const [importText, setImportText] = useState('')
  const [importUrl,  setImportUrl]  = useState('')
  const [importTab,  setImportTab]  = useState('text') // 'text' | 'file' | 'url'
  const [importStep, setImportStep] = useState('input') // 'input' | 'review'
  const [importRows, setImportRows] = useState([])
  const [importing,  setImporting]  = useState(false)
  const [importError, setImportError] = useState(null)
  const [importDone,  setImportDone]  = useState(null) // summary string

  const importFileRef = useRef(null)
  const importingRef  = useRef(false)
  useEffect(() => () => { importingRef.current = false }, [])

  // Reset state every time the modal is reopened so it doesn't show a stale
  // review from a previous session.
  useEffect(() => {
    if (open) {
      setImportStep('input')
      setImportRows([])
      setImportError(null)
      setImportDone(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const importSummary = importRows.length ? summarizeImportRows(importRows) : null
  const importMatchedRows = useMemo(
    () => importRows.filter(row => row.status === 'matched' && row.sfCard),
    [importRows],
  )
  const importMissingRows = useMemo(
    () => importRows.filter(row => row.status !== 'matched'),
    [importRows],
  )

  const canReview = importTab === 'url' ? !!importUrl.trim() : !!importText.trim()

  async function prepareImportReview() {
    if (importingRef.current) return
    importingRef.current = true
    setImportError(null)
    setImportDone(null)
    setImportRows([])
    setImporting(true)

    try {
      let entries
      if (importTab === 'url') {
        const result = await importDeckFromUrl(importUrl.trim())
        entries = normalizeImportedDeckCards(result.cards)
      } else {
        entries = parseImportText(importText).entries
      }
      if (!entries.length) throw new Error('No cards found in the import.')

      const resolvedRows = await resolveImportEntries(entries)
      setImportRows(resolvedRows)
      setImportStep('review')
    } catch (err) {
      setImportError(err.message)
    }
    setImporting(false)
    importingRef.current = false
  }

  async function confirmImportReview() {
    if (importingRef.current) return
    importingRef.current = true
    setImportError(null)
    setImportDone(null)
    setImporting(true)

    try {
      const resolvedRows = importRows
      const matchedRows = resolvedRows.filter(row => row.status === 'matched' && row.sfCard)
      const missedRows  = resolvedRows.filter(row => row.status !== 'matched')
      if (!matchedRows.length) throw new Error('No cards could be matched in Scryfall.')

      const now = new Date().toISOString()
      const newRows = []
      let commanderSet = false

      for (const entry of matchedRows) {
        const sf = entry.sfCard
        const meta = getDeckBuilderCardMeta(sf)
        const isCmd = entry.isCommander && !commanderSet
        if (isCmd) commanderSet = true

        newRows.push({
          id:               crypto.randomUUID(),
          deck_id:          deckId,
          user_id:          userId,
          scryfall_id:      meta.scryfall_id,
          name:             entry.resolvedName || entry.name,
          set_code:         entry.resolvedSetCode ?? entry.setCode ?? meta.set_code,
          collector_number: entry.resolvedCollectorNumber ?? entry.collectorNumber ?? meta.collector_number,
          type_line:        meta.type_line,
          mana_cost:        meta.mana_cost,
          cmc:              meta.cmc,
          color_identity:   meta.color_identity ?? [],
          image_uri:        meta.image_uri,
          qty:              entry.qty,
          foil:             entry.foil ?? false,
          is_commander:     isCmd,
          board:            isCmd ? 'main' : normalizeBoard(entry.board),
          created_at:       now,
          updated_at:       now,
        })
      }

      const hydratedRows = await requireCardPrintIds(newRows, 'Imported deck card')

      const makeDeckCardMergeKey = row => [
        row.card_print_id,
        row.foil ? '1' : '0',
        normalizeBoard(row.board),
      ].join('|')

      const existingByKey = new Map(
        deckCardsRef.current
          .filter(row => row.card_print_id)
          .map(row => [makeDeckCardMergeKey(row), row])
      )
      const updatesById = new Map()
      const insertsByKey = new Map()

      for (const row of hydratedRows) {
        const key = makeDeckCardMergeKey(row)
        const existing = existingByKey.get(key)
        if (existing) {
          updatesById.set(existing.id, {
            ...existing,
            qty: (existing.qty || 0) + (row.qty || 0),
            is_commander: !!existing.is_commander || !!row.is_commander,
            updated_at: now,
          })
          continue
        }

        const pending = insertsByKey.get(key)
        if (pending) {
          insertsByKey.set(key, {
            ...pending,
            qty: (pending.qty || 0) + (row.qty || 0),
            is_commander: !!pending.is_commander || !!row.is_commander,
          })
        } else {
          insertsByKey.set(key, row)
        }
      }

      const updateRows = [...updatesById.values()]
      const insertRows = [...insertsByKey.values()]

      if (updateRows.length) {
        await Promise.all(updateRows.map(row =>
          sb.from('deck_cards')
            .update({ qty: row.qty, is_commander: row.is_commander, updated_at: row.updated_at })
            .eq('id', row.id)
        ))
        putDeckCards(updateRows).catch(() => {})
      }
      if (insertRows.length) {
        await sb.from('deck_cards')
          .upsert(insertRows.map(toDeckCardRow), { onConflict: 'deck_id,card_print_id,foil,board' })
        putDeckCards(insertRows).catch(() => {})
      }

      setDeckCards(prev => {
        const updatedById = new Map(updateRows.map(row => [row.id, row]))
        return [
          ...prev.map(row => updatedById.get(row.id) || row),
          ...insertRows,
        ]
      })

      const importedCopies = hydratedRows.reduce((sum, row) => sum + (row.qty || 0), 0)
      const boardSummary = BOARD_ORDER
        .map(board => {
          const qty = hydratedRows.filter(row => normalizeBoard(row.board) === board).reduce((sum, row) => sum + (row.qty || 0), 0)
          return qty ? `${qty} ${BOARD_LABELS[board].toLowerCase()}` : null
        })
        .filter(Boolean)
        .join(', ')
      const skipped = missedRows.length ? ` Skipped ${missedRows.length} unresolved row${missedRows.length !== 1 ? 's' : ''}.` : ''
      setImportDone(`Imported ${importedCopies} card${importedCopies !== 1 ? 's' : ''}${boardSummary ? ` (${boardSummary})` : ''}.${skipped}`)
      onImported?.(importedCopies, hydratedRows)
      setImportText('')
      setImportUrl('')
      setImportRows([])
      setImportStep('input')
    } catch (err) {
      setImportError(err.message)
    }
    setImporting(false)
    importingRef.current = false
  }

  if (!open) return null

  return (
    <div className={styles.overlay} onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={styles.modal} role="dialog" aria-label="Import deck">
        <div className={styles.header}>
          <span className={styles.title}>Import Deck</span>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>

        {importStep === 'input' && <>
          <div className={styles.tabs}>
            {TABS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`${styles.tab}${importTab === id ? ' ' + styles.tabActive : ''}`}
                onClick={() => { setImportTab(id); setImportError(null); setImportDone(null) }}
              >
                {label}
              </button>
            ))}
          </div>

          {importTab === 'text' && (
            <div className={styles.pane}>
              <p className={styles.hint}>
                Paste a decklist in standard format. Supports <code>Commander:</code>, <code>Sideboard:</code>, and <code>Maybeboard:</code> sections.
              </p>
              <textarea
                autoFocus
                className={styles.textarea}
                value={importText}
                onChange={e => setImportText(e.target.value)}
                placeholder={"Commander:\n1 Sheoldred, the Apocalypse\n\nDeck:\n1 Sol Ring\n1 Swamp\n\nSideboard:\n1 Duress\n\nMaybeboard:\n1 Bitterblossom"}
                rows={10}
              />
            </div>
          )}

          {importTab === 'file' && (
            <div className={styles.pane}>
              <p className={styles.hint}>
                Upload a <code>.txt</code> decklist or <code>.csv</code> Manabox export.
              </p>
              <input
                ref={importFileRef}
                type="file"
                accept=".csv,.txt"
                style={{ display: 'none' }}
                onChange={async e => {
                  const file = e.target.files[0]
                  if (!file) return
                  const text = await file.text()
                  setImportText(text)
                  setImportError(null)
                  setImportDone(null)
                  e.target.value = ''
                }}
              />
              <button type="button" className={styles.fileBtn} onClick={() => importFileRef.current?.click()}>
                {importText
                  ? <><span className={styles.fileLoadedIcon}><CheckIcon size={14} /></span> File loaded — {importText.split('\n').filter(Boolean).length} lines</>
                  : 'Choose file…'}
              </button>
              {importText && (
                <textarea readOnly className={styles.filePreview} value={importText} rows={6} />
              )}
            </div>
          )}

          {importTab === 'url' && (
            <div className={styles.pane}>
              <p className={styles.hint}>
                Paste a public deck link from <code>Archidekt</code> or <code>Moxfield</code>.
                MTGGoldfish blocks automated imports — paste its decklist text instead.
              </p>
              <input
                autoFocus
                type="url"
                className={styles.urlInput}
                value={importUrl}
                onChange={e => { setImportUrl(e.target.value); setImportError(null); setImportDone(null) }}
                onKeyDown={e => { if (e.key === 'Enter' && importUrl.trim() && !importing) prepareImportReview() }}
                placeholder="https://archidekt.com/decks/123456/my-deck"
              />
            </div>
          )}
        </>}

        {importStep === 'review' && (
          <div className={styles.pane}>
            <div className={styles.statGrid}>
              {[
                ['Unique Cards', importSummary?.totalRows || 0, false],
                ['Matched', importSummary?.matchedRows || 0, false],
                ['Cards', importSummary?.matchedCopies || 0, false],
                ['Unresolved', importSummary?.missingRows || 0, !!importSummary?.missingRows],
              ].map(([label, value, bad]) => (
                <div key={label} className={styles.statCard}>
                  <div className={`${styles.statValue}${bad ? ' ' + styles.statValueBad : ''}`}>{value}</div>
                  <div className={styles.statLabel}>{label}</div>
                </div>
              ))}
            </div>
            <div className={`${styles.statusLine}${importMissingRows.length ? ' ' + styles.statusLineWarn : ''}`}>
              {importMissingRows.length
                ? `${importMissingRows.length} row${importMissingRows.length === 1 ? '' : 's'} will be skipped unless corrected.`
                : 'All rows resolved and are ready to import.'}
            </div>
            <div className={styles.reviewList}>
              {importRows.map((row, index) => (
                <div
                  key={`${row.name}-${index}`}
                  className={`${styles.reviewRow}${row.status !== 'matched' ? ' ' + styles.reviewRowMiss : ''}`}
                >
                  <span className={row.status === 'matched' ? styles.statusOk : styles.statusMiss} aria-label={row.status === 'matched' ? 'Matched' : 'Unresolved'}>
                    {row.status === 'matched' ? <CheckIcon size={14} /> : <WarningIcon size={14} />}
                  </span>
                  <span className={styles.rowName}>
                    {row.qty}x {row.resolvedName || row.name}
                    {row.foil && <span className={styles.rowTag}>Foil</span>}
                    {row.isCommander && <span className={styles.rowTag}>Commander</span>}
                  </span>
                  <span className={styles.rowDim}>{row.board ? BOARD_LABELS[normalizeBoard(row.board)] : 'Mainboard'}</span>
                  <span className={styles.rowDim}>{row.resolvedSetCode ? `${String(row.resolvedSetCode).toUpperCase()} #${row.resolvedCollectorNumber || '–'}` : '–'}</span>
                  <span className={row.exactPrinting ? styles.rowMatchExact : styles.rowDim}>
                    {row.status === 'matched' ? (row.exactPrinting ? 'Exact print' : 'Name match') : row.reason || 'Missing'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {importError && <p className={styles.errorText}>{importError}</p>}
        {importDone && (
          <p className={styles.doneText}><CheckIcon size={14} /> {importDone}</p>
        )}

        <div className={styles.footer}>
          <button type="button" className={styles.btn} onClick={() => { onClose(); setImportStep('input'); setImportRows([]) }}>
            {importDone ? 'Close' : 'Cancel'}
          </button>
          {!importDone && importStep === 'review' && (
            <button
              type="button"
              className={styles.btn}
              disabled={importing}
              onClick={() => { setImportStep('input'); setImportError(null); setImportDone(null) }}
            >
              Back
            </button>
          )}
          {!importDone && (
            <button
              type="button"
              className={styles.btnPrimary}
              onClick={importStep === 'review' ? confirmImportReview : prepareImportReview}
              disabled={importing || (importStep === 'review' ? importMatchedRows.length === 0 : !canReview)}
            >
              {importing
                ? (importStep === 'review' ? 'Importing…' : importTab === 'url' ? 'Fetching…' : 'Resolving…')
                : (importStep === 'review' ? `Import ${importSummary?.matchedCopies || 0}` : 'Review Import')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
