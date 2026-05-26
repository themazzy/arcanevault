import { useState, useEffect, useRef, useMemo } from 'react'
import { sb } from '../../lib/supabase'
import { parseImportText, resolveImportEntries, summarizeImportRows } from '../../lib/importFlow'
import { getDeckBuilderCardMeta } from '../../lib/deckBuilderApi'
import { BOARD_ORDER, BOARD_LABELS } from '../../lib/deckBuilderConstants'
import { normalizeBoard } from '../../lib/deckBuilderHelpers'
import { toDeckCardRow, requireCardPrintIds } from '../../lib/deckBuilderWrites'
import { putDeckCards } from '../../lib/db'

/**
 * Bulk deck import modal. Owns its own UI state — the parent only needs to
 * supply `open` / `onClose` and the deck context primitives.
 *
 * On a successful import the modal calls `setDeckCards()` directly with the
 * merged update + insert plan. Keeping that callback raw (instead of going via
 * a callback prop) matches how the inline version worked before extraction —
 * one synchronous state update from the parent's perspective.
 */
export default function DeckImportModal({
  open,
  onClose,
  deckId,
  userId,
  deckCardsRef,
  setDeckCards,
}) {
  const [importText, setImportText] = useState('')
  const [importTab,  setImportTab]  = useState('text') // 'text' | 'file'
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

  const importSummary = importRows.length ? summarizeImportRows(importRows) : null
  const importMatchedRows = useMemo(
    () => importRows.filter(row => row.status === 'matched' && row.sfCard),
    [importRows],
  )
  const importMissingRows = useMemo(
    () => importRows.filter(row => row.status !== 'matched'),
    [importRows],
  )

  async function prepareImportReview() {
    if (importingRef.current) return
    importingRef.current = true
    setImportError(null)
    setImportDone(null)
    setImportRows([])
    setImporting(true)

    try {
      const parsed = parseImportText(importText).entries
      if (!parsed.length) throw new Error('No cards found in the import.')

      const resolvedRows = await resolveImportEntries(parsed)
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
      setImportText('')
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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'var(--bg-card, #1e1e1e)', border: '1px solid var(--border)', borderRadius: 8, padding: 24, width: 480, maxWidth: '95vw', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', fontSize: '1rem' }}>Import Deck</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: '1.1rem', cursor: 'pointer' }}>x</button>
        </div>

        {importStep === 'input' && <>
          {/* Tab switcher */}
          <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)' }}>
            {[['text', 'Paste List'], ['file', 'Upload File']].map(([id, label]) => (
              <button key={id} onClick={() => { setImportTab(id); setImportError(null); setImportDone(null) }}
                style={{ flex: 1, padding: '7px 0', background: 'none', border: 'none', borderBottom: importTab === id ? '2px solid var(--gold)' : '2px solid transparent', color: importTab === id ? 'var(--gold)' : 'var(--text-dim)', fontSize: '0.83rem', cursor: 'pointer', marginBottom: -1 }}>
                {label}
              </button>
            ))}
          </div>

          {importTab === 'text' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-faint)', margin: 0 }}>
                Paste a decklist in standard format. Supports <code style={{ color: 'var(--gold)' }}>Commander:</code>, <code style={{ color: 'var(--gold)' }}>Sideboard:</code>, and <code style={{ color: 'var(--gold)' }}>Maybeboard:</code> sections.
              </p>
              <textarea
                autoFocus
                value={importText}
                onChange={e => setImportText(e.target.value)}
                placeholder={"Commander:\n1 Sheoldred, the Apocalypse\n\nDeck:\n1 Sol Ring\n1 Swamp\n\nSideboard:\n1 Duress\n\nMaybeboard:\n1 Bitterblossom"}
                rows={10}
                style={{ background: 'var(--s3)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', color: 'var(--text)', fontSize: '0.83rem', outline: 'none', resize: 'vertical', fontFamily: 'monospace' }}
              />
            </div>
          )}
          {importTab === 'file' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-faint)', margin: 0 }}>
                Upload a <code style={{ color: 'var(--gold)' }}>.txt</code> decklist or <code style={{ color: 'var(--gold)' }}>.csv</code> Manabox export.
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
              <button
                onClick={() => importFileRef.current?.click()}
                style={{ background: 'var(--s3)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)', padding: '10px 16px', fontSize: '0.83rem', cursor: 'pointer', textAlign: 'left' }}>
                {importText ? `OK File loaded - ${importText.split('\n').filter(Boolean).length} lines` : 'Choose file...'}
              </button>
              {importText && (
                <textarea
                  readOnly
                  value={importText}
                  rows={6}
                  style={{ background: 'var(--s2)', border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', color: 'var(--text-faint)', fontSize: '0.78rem', outline: 'none', resize: 'vertical', fontFamily: 'monospace' }}
                />
              )}
            </div>
          )}
        </>}

        {importStep === 'review' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {[
                ['Rows', importSummary?.totalRows || 0],
                ['Matched', importSummary?.matchedRows || 0],
                ['Copies', importSummary?.matchedCopies || 0],
                ['Unresolved', importSummary?.missingRows || 0],
              ].map(([label, value]) => (
                <div key={label} style={{ background: 'var(--s2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>
                  <div style={{ color: label === 'Unresolved' && value ? '#e07070' : 'var(--gold)', fontFamily: 'var(--font-display)', fontSize: '1rem' }}>{value}</div>
                  <div style={{ color: 'var(--text-faint)', fontSize: '0.68rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
                </div>
              ))}
            </div>
            <div style={{ color: importMissingRows.length ? '#e0a852' : 'var(--green)', fontSize: '0.8rem' }}>
              {importMissingRows.length
                ? `${importMissingRows.length} row${importMissingRows.length === 1 ? '' : 's'} will be skipped unless corrected.`
                : 'All rows resolved and are ready to import.'}
            </div>
            <div style={{ maxHeight: '42vh', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
              {importRows.map((row, index) => (
                <div key={`${row.name}-${index}`} style={{
                  display: 'grid',
                  gridTemplateColumns: '52px minmax(0, 1fr) 82px 70px 86px',
                  gap: 8,
                  alignItems: 'center',
                  padding: '8px 10px',
                  borderBottom: index === importRows.length - 1 ? 'none' : '1px solid var(--s-border)',
                  background: row.status === 'matched' ? 'transparent' : 'rgba(196,96,96,0.08)',
                  fontSize: '0.78rem',
                }}>
                  <span style={{ color: row.status === 'matched' ? 'var(--green)' : '#e07070', fontFamily: 'var(--font-display)' }}>
                    {row.status === 'matched' ? 'OK' : 'MISS'}
                  </span>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                    {row.qty}x {row.resolvedName || row.name}
                    {row.foil && <span style={{ color: 'var(--gold)', marginLeft: 6 }}>Foil</span>}
                    {row.isCommander && <span style={{ color: 'var(--gold)', marginLeft: 6 }}>Commander</span>}
                  </span>
                  <span style={{ color: 'var(--text-faint)' }}>{row.board ? BOARD_LABELS[normalizeBoard(row.board)] : 'Mainboard'}</span>
                  <span style={{ color: 'var(--text-faint)' }}>{row.resolvedSetCode ? `${String(row.resolvedSetCode).toUpperCase()} #${row.resolvedCollectorNumber || '-'}` : '-'}</span>
                  <span style={{ color: row.exactPrinting ? 'var(--green)' : 'var(--text-faint)' }}>{row.status === 'matched' ? (row.exactPrinting ? 'Exact print' : 'Name match') : row.reason || 'Missing'}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {importError && <p style={{ color: '#e07070', fontSize: '0.82rem', margin: 0 }}>{importError}</p>}
        {importDone  && <p style={{ color: 'var(--green)', fontSize: '0.82rem', margin: 0 }}>OK {importDone}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => { onClose(); setImportStep('input'); setImportRows([]) }}
            style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)', padding: '7px 14px', fontSize: '0.83rem', cursor: 'pointer' }}>
            {importDone ? 'Close' : 'Cancel'}
          </button>
          {!importDone && importStep === 'review' && (
            <button onClick={() => { setImportStep('input'); setImportError(null); setImportDone(null) }}
              disabled={importing}
              style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-dim)', padding: '7px 14px', fontSize: '0.83rem', cursor: 'pointer', opacity: importing ? 0.6 : 1 }}>
              Back
            </button>
          )}
          {!importDone && (
            <button onClick={importStep === 'review' ? confirmImportReview : prepareImportReview}
              disabled={importing || (importStep === 'review' ? importMatchedRows.length === 0 : !importText.trim())}
              style={{ background: 'rgba(201,168,76,0.15)', border: '1px solid rgba(201,168,76,0.4)', borderRadius: 4, color: 'var(--gold)', padding: '7px 18px', fontSize: '0.83rem', cursor: 'pointer', opacity: importing ? 0.6 : 1 }}>
              {importing ? (importStep === 'review' ? 'Importing...' : 'Resolving...') : (importStep === 'review' ? `Import ${importSummary?.matchedCopies || 0}` : 'Review Import')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
