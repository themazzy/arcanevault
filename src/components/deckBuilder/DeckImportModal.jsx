import { useState, useEffect, useRef, useMemo } from 'react'
import { sb } from '../../lib/supabase'
import {
  normalizeImportedDeckCards,
  parseImportText,
  resolveImportEntries,
  summarizeImportRows,
} from '../../lib/importFlow'
import { getDeckBuilderCardMeta, importDeckFromUrl } from '../../lib/deckBuilderApi'
import { BOARD_ORDER, BOARD_LABELS } from '../../lib/deckBuilderConstants'
import { normalizeBoard } from '../../lib/deckBuilderHelpers'
import { boardForCard } from '../../lib/attractions'
import { toDeckCardRow, requireCardPrintIds } from '../../lib/deckBuilderWrites'
import { putDeckCards } from '../../lib/db'
import { CheckIcon } from '../../icons'
import { Modal, ConfirmModal } from '../UI'
import { getImportDiscardModel } from '../../lib/importDiscard'
import { describeReviewRows, reviewHeadline, uniformValue } from '../../lib/importReview'
import ImportReviewList from '../import/ImportReviewList'
import ImportSourceStep from '../import/ImportSourceStep'
import styles from './DeckImportModal.module.css'
import uiStyles from '../UI.module.css'

// Shared button primitive (DESIGN.md §3) — variants only remap --btn-*.
const BTN = `${uiStyles.btn} ${uiStyles.sm}`
const BTN_PRIMARY = `${BTN} ${uiStyles.primary}`
const BTN_SECONDARY = `${BTN} ${uiStyles.secondary}`

const REVIEW_PAGE_SIZE = 100

// Section headers (Commander:, Sideboard:, Maybeboard:, Attractions:) are still
// parsed — they just don't need explaining. Anyone pasting an export already has
// them, and everyone else is pasting a plain list.
const TEXT_PLACEHOLDER = `1 Myra the Magnificent
1 Sol Ring
4 Lightning Bolt (M10) 155
1 Storybook Ride`

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
  const [discardPrompt, setDiscardPrompt] = useState(null)

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

  // Escape is `Modal`'s job (DESIGN.md §6). It keeps a stack so only the
  // topmost dialog reacts; a second document-level listener here bypassed that
  // and fired alongside it.

  const importSummary = importRows.length ? summarizeImportRows(importRows) : null
  const importMatchedRows = useMemo(
    () => importRows.filter(row => row.status === 'matched' && row.sfCard),
    [importRows],
  )

  const reviewStatus = useMemo(() => reviewHeadline(describeReviewRows(importRows)), [importRows])
  // A column whose value is identical on every row tells you nothing and was
  // costing the card name ~40% of the width. Demote both to a footnote and only
  // chip the rows that break the pattern.
  const uniformBoard = useMemo(
    () => uniformValue(importMatchedRows, row => normalizeBoard(row.board)),
    [importMatchedRows],
  )
  const allExactPrints = useMemo(
    () => importMatchedRows.length > 0 && importMatchedRows.every(row => row.exactPrinting && !row.matchNote),
    [importMatchedRows],
  )

  const canReview = importTab === 'url' ? !!importUrl.trim() : !!importText.trim()
  // Only the write phase is unsafe to abandon. Bailing out of a long Scryfall
  // resolve is fine and should stay possible.
  const committing = importing && importStep === 'review'

  // Overlay clicks, Escape and Cancel all land here. A pasted decklist is
  // expensive input, so an accidental click outside must not silently bin it.
  function requestClose() {
    if (committing) return
    if (importDone) { onClose(); return }
    const model = getImportDiscardModel({
      reviewing: importStep === 'review',
      rowCount: importRows.length,
      hasText: !!(importText.trim() || importUrl.trim()),
    })
    if (!model.needsConfirm) { onClose(); return }
    setDiscardPrompt(model)
  }

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
          board:            isCmd ? 'main' : boardForCard({ type_line: meta.type_line }, sf, normalizeBoard(entry.board)),
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
    <>
    <Modal
      onClose={requestClose}
      // Content-driven height means the dialog resizes on every step, status
      // line and expanded row. Fixed from CSS; the body scrolls instead.
      autoHeight={false}
      className={styles.modal}
      // The gap that spaces header / tabs / pane / footer has to live on the
      // CONTENT element. On `className` it lands on Modal's outer box, whose
      // only in-flow child is .modalContent (the close button is absolute), so
      // it silently did nothing and the footer sat flush against the pane.
      contentClassName={styles.modalBody}
      showClose={!committing}
      closeOnEscape={!committing}
      closeOnOverlay={!committing}
    >
      <>
        <div className={styles.header}>
          <span className={styles.title}>Import Deck</span>
        </div>

        {importStep === 'input' && (
          <ImportSourceStep
            sources={['text', 'file', 'url']}
            tab={importTab}
            onTabChange={id => { setImportTab(id); setImportError(null); setImportDone(null) }}
            text={importText}
            onTextChange={value => { setImportText(value); setImportError(null); setImportDone(null) }}
            url={importUrl}
            onUrlChange={value => { setImportUrl(value); setImportError(null); setImportDone(null) }}
            onUrlSubmit={prepareImportReview}
            busy={importing}
            textPlaceholder={TEXT_PLACEHOLDER}
            textHint={
              <p className={styles.hint}>
                One card per line. Quantity, set code and collector number are all optional.<br />
                <span className={styles.hintFormats}>
                  <code>Sol Ring</code> / <code>4 Lightning Bolt</code> / <code>1 Sol Ring (LTC) 273</code> / <code>4 *F* Sol Ring</code>
                </span>
              </p>
            }
            urlPlaceholder="https://archidekt.com/decks/123456/my-deck"
            urlHint={
              <p className={styles.hint}>
                Paste a public deck link from <code>Archidekt</code> or <code>Moxfield</code>.
                MTGGoldfish blocks automated imports — paste its decklist text instead.
              </p>
            }
          />
        )}

        {importStep === 'review' && (
          <div className={styles.pane}>
            <ImportReviewList
              rows={importRows}
              status={reviewStatus}
              pageSize={REVIEW_PAGE_SIZE}
              footnoteParts={[
                uniformBoard ? BOARD_LABELS[uniformBoard] : null,
                allExactPrints ? 'exact prints' : null,
              ]}
              renderRowTags={row => <>
                {row.isCommander && <span className={styles.rowTagCommander}>Commander</span>}
                {!uniformBoard && <span className={styles.rowTagBoard}>{BOARD_LABELS[normalizeBoard(row.board)]}</span>}
                {!allExactPrints && !row.exactPrinting && !row.matchNote && (
                  <span className={styles.rowTagBoard}>Name match</span>
                )}
              </>}
              onRowChange={(index, nextRow) =>
                setImportRows(prev => prev.map((row, i) => (i === index ? nextRow : row)))}
              editDisabled={importing}
              editDisabledTitle="Available once matching finishes"
            />
          </div>
        )}

        {importError && <p className={styles.errorText}>{importError}</p>}
        {importDone && (
          <p className={styles.doneText}><CheckIcon size={14} /> {importDone}</p>
        )}

        <div className={styles.footer}>
          {(importDone || importStep === 'input') && (
            <button
              type="button"
              className={BTN_SECONDARY}
              disabled={committing}
              onClick={requestClose}
            >
              {importDone ? 'Close' : 'Cancel'}
            </button>
          )}
          {!importDone && importStep === 'review' && (
            <button
              type="button"
              className={BTN_SECONDARY}
              disabled={importing}
              onClick={() => { setImportStep('input'); setImportError(null); setImportDone(null) }}
            >
              Back
            </button>
          )}
          {!importDone && (
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={importStep === 'review' ? confirmImportReview : prepareImportReview}
              disabled={importing || (importStep === 'review' ? importMatchedRows.length === 0 : !canReview)}
            >
              {importing
                ? (importStep === 'review' ? 'Importing…' : importTab === 'url' ? 'Fetching…' : 'Resolving…')
                : (importStep === 'review'
                    ? `Import ${importSummary?.matchedCopies || 0} card${importSummary?.matchedCopies === 1 ? '' : 's'}`
                    : 'Review Import')}
            </button>
          )}
        </div>
      </>
    </Modal>

    {/* Sits on top of this component's own <Modal>. Modal keeps a stack so
        Escape only reaches the topmost one — see UI.jsx. */}
    {discardPrompt && (
      <ConfirmModal
        title={null}
        message={discardPrompt.message}
        cancelLabel={discardPrompt.keepLabel}
        confirmLabel={discardPrompt.discardLabel}
        variant={discardPrompt.discardVariant}
        onConfirm={() => { setDiscardPrompt(null); onClose(); setImportStep('input'); setImportRows([]) }}
        onClose={() => setDiscardPrompt(null)}
      />
    )}
    </>
  )
}
