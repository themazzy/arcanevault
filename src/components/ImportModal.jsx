import { useState, useRef, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { Modal, Select } from './UI'
import { parseTextDecklist, fetchCardsByNames } from '../lib/deckBuilderApi'
import { parseManaboxCSV } from '../lib/csvParser'
import styles from './ImportModal.module.css'

const NOUN = { binder: 'Binder', deck: 'Deck', list: 'Wishlist' }

// Detect format and return [{ name, qty, foil }]
function parseInput(text) {
  const firstLine = text.trim().split('\n')[0] || ''
  if (firstLine.includes(',') && /\bname\b/i.test(firstLine)) {
    // Manabox / generic CSV
    const { cards } = parseManaboxCSV(text)
    const map = new Map()
    for (const c of cards) {
      const key = c.name.toLowerCase() + (c.foil ? '|foil' : '')
      const ex = map.get(key)
      map.set(key, ex ? { ...ex, qty: ex.qty + c.qty } : { name: c.name, qty: c.qty, foil: c.foil })
    }
    return [...map.values()]
  }
  // Plain decklist (e.g. "4 Lightning Bolt")
  return parseTextDecklist(text).map(c => ({ name: c.name, qty: c.qty, foil: false }))
}

export default function ImportModal({ userId, folderType, folders: initialFolders, defaultFolderId, onClose, onSaved }) {
  const noun = NOUN[folderType] || folderType
  const [step, setStep]         = useState('input')   // input | preview | importing | done
  const [text, setText]         = useState('')
  const [parsed, setParsed]     = useState([])
  const [folders, setFolders]   = useState(initialFolders || [])
  const [folderId, setFolderId] = useState(defaultFolderId || '')
  const [newName, setNewName]   = useState('')
  const [creating, setCreating] = useState(false)
  const [progress, setProgress] = useState(0)
  const [total, setTotal]       = useState(0)
  const [missed, setMissed]     = useState([])
  const [imported, setImported] = useState(0)
  const fileRef = useRef(null)

  const handleFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setText(ev.target.result)
    reader.readAsText(file)
  }

  const handleParse = () => {
    const result = parseInput(text)
    if (!result.length) return
    setParsed(result)
    setStep('preview')
  }

  const handleCreateFolder = async () => {
    if (!newName.trim()) return
    const { data } = await sb.from('folders')
      .insert({ name: newName.trim(), type: folderType, user_id: userId })
      .select().single()
    if (data) {
      setFolders(prev => [...prev, data])
      setFolderId(data.id)
      setCreating(false)
      setNewName('')
    }
  }

  const handleImport = useCallback(async () => {
    if (!folderId || !parsed.length) return
    setStep('importing')
    setTotal(parsed.length)
    setProgress(0)

    const errs = []
    let count = 0

    try {
      const names = [...new Set(parsed.map(c => c.name))]
      const sfCards = await fetchCardsByNames(names)
      const sfByName = {}
      for (const c of sfCards) sfByName[c.name.toLowerCase()] = c

      if (folderType === 'list') {
        const items = []
        for (const c of parsed) {
          const sf = sfByName[c.name.toLowerCase()]
          if (!sf) { errs.push(c.name); setProgress(p => p + 1); continue }
          items.push({
            folder_id: folderId, user_id: userId, name: sf.name, set_code: sf.set,
            collector_number: sf.collector_number, scryfall_id: sf.id,
            foil: c.foil, qty: c.qty,
          })
          count++
          setProgress(p => p + 1)
        }
        if (items.length) {
          await sb.from('list_items').upsert(items, { onConflict: 'folder_id,set_code,collector_number,foil' })
        }
      } else {
        const cardRows = []
        const placementRows = []
        for (const c of parsed) {
          const sf = sfByName[c.name.toLowerCase()]
          if (!sf) { errs.push(c.name); setProgress(p => p + 1); continue }
          cardRows.push({
            user_id: userId, name: sf.name, set_code: sf.set,
            collector_number: sf.collector_number, scryfall_id: sf.id,
            foil: c.foil, qty: c.qty, condition: 'near_mint', language: 'en', purchase_price: 0,
          })
          setProgress(p => p + 1)
        }
        if (cardRows.length) {
          const { data: upserted } = await sb.from('cards')
            .upsert(cardRows, { onConflict: 'user_id,scryfall_id,foil', ignoreDuplicates: false })
            .select('id, scryfall_id, foil')
          if (upserted) {
            const sfToId = {}
            for (const r of upserted) sfToId[r.scryfall_id + (r.foil ? '|f' : '')] = r.id
            for (const row of cardRows) {
              const sfKey = row.scryfall_id + (row.foil ? '|f' : '')
              const cid = sfToId[sfKey]
              if (cid) {
                placementRows.push(
                  folderType === 'deck'
                    ? { deck_id: folderId, user_id: userId, card_id: cid, qty: row.qty }
                    : { folder_id: folderId, card_id: cid, qty: row.qty }
                )
                count++
              }
            }
            if (placementRows.length) {
              await sb.from(folderType === 'deck' ? 'deck_allocations' : 'folder_cards')
                .upsert(placementRows, { onConflict: `${folderType === 'deck' ? 'deck_id' : 'folder_id'},card_id`, ignoreDuplicates: true })
            }
          }
        }
      }
    } catch (e) {
      errs.push('Import error: ' + e.message)
    }

    setMissed(errs)
    setImported(count)
    setStep('done')
  }, [folderId, parsed, folderType, userId])

  return (
    <Modal onClose={onClose}>
      <div className={styles.wrap}>
        <h2 className={styles.title}>Import to {noun}</h2>

        {/* ── Step: Input ── */}
        {step === 'input' && (
          <>
            <p className={styles.hint}>
              Paste a decklist (<em>4 Lightning Bolt</em>), a Manabox CSV, or upload a .csv/.txt file.
            </p>
            <textarea
              className={styles.textarea}
              placeholder={'4 Forest\n1 Sol Ring\n// comments are ignored'}
              value={text}
              onChange={e => setText(e.target.value)}
              rows={10}
              autoFocus
            />
            <div className={styles.inputRow}>
              <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={handleFile} />
              <button className={styles.fileBtn} onClick={() => fileRef.current?.click()}>
                Upload file
              </button>
              <button className={styles.parseBtn} onClick={handleParse} disabled={!text.trim()}>
                Parse →
              </button>
            </div>
          </>
        )}

        {/* ── Step: Preview ── */}
        {step === 'preview' && (
          <>
            <p className={styles.hint}>{parsed.length} cards found. Choose a destination:</p>

            {/* Folder picker */}
            {!creating ? (
              <div className={styles.pickerRow}>
                <Select
                  className={styles.folderSelect}
                  value={folderId}
                  onChange={e => setFolderId(e.target.value)}
                  title={`Select ${noun}`}
                >
                  <option value="">— Select {noun} —</option>
                  {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </Select>
                <button className={styles.createBtn} onClick={() => setCreating(true)}>
                  + New {noun}
                </button>
              </div>
            ) : (
              <div className={styles.pickerRow}>
                <input
                  autoFocus
                  className={styles.newInput}
                  placeholder={`${noun} name…`}
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setCreating(false) }}
                />
                <button className={styles.parseBtn} onClick={handleCreateFolder} disabled={!newName.trim()}>Create</button>
                <button className={styles.fileBtn} onClick={() => setCreating(false)}>✕</button>
              </div>
            )}

            {/* Card list preview */}
            <div className={styles.previewList}>
              {parsed.slice(0, 50).map((c, i) => (
                <div key={i} className={styles.previewRow}>
                  <span className={styles.previewQty}>×{c.qty}</span>
                  <span className={styles.previewName}>{c.name}</span>
                  {c.foil && <span className={styles.previewFoil}>✦</span>}
                </div>
              ))}
              {parsed.length > 50 && (
                <div className={styles.previewMore}>…and {parsed.length - 50} more</div>
              )}
            </div>

            <div className={styles.actionRow}>
              <button className={styles.fileBtn} onClick={() => setStep('input')}>← Back</button>
              <button className={styles.parseBtn} onClick={handleImport} disabled={!folderId}>
                Import {parsed.length} cards
              </button>
            </div>
          </>
        )}

        {/* ── Step: Importing ── */}
        {step === 'importing' && (
          <div className={styles.progressWrap}>
            <div className={styles.progressLabel}>Importing… {progress} / {total}</div>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: total ? `${(progress / total) * 100}%` : '0%' }} />
            </div>
          </div>
        )}

        {/* ── Step: Done ── */}
        {step === 'done' && (
          <>
            <p className={styles.doneMsg}>
              {imported > 0
                ? <span className={styles.success}>✓ {imported} cards imported successfully.</span>
                : <span style={{ color: 'var(--text-dim)' }}>No cards were imported.</span>
              }
            </p>
            {missed.length > 0 && (
              <>
                <p className={styles.hint}>{missed.length} card{missed.length > 1 ? 's' : ''} not found in Scryfall:</p>
                <div className={styles.missedList}>
                  {missed.map((n, i) => <div key={i} className={styles.missedItem}>{n}</div>)}
                </div>
              </>
            )}
            <div className={styles.actionRow}>
              <button className={styles.parseBtn} onClick={() => { onSaved?.(folderId); onClose() }}>Done</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
