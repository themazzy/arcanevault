import { useState, useRef, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { Modal, ResponsiveMenu } from './UI'
import { parseTextDecklist, importDeckFromUrl } from '../lib/deckBuilderApi'
import { parseManaboxCSV } from '../lib/csvParser'
import { sfUrl } from '../lib/scryfall'
import styles from './ImportModal.module.css'
import uiStyles from './UI.module.css'

const NOUN = { binder: 'Binder', deck: 'Deck', list: 'Wishlist' }
const SF = 'https://api.scryfall.com'

/**
 * Resolve cards using the Scryfall /cards/collection endpoint.
 * Entries with setCode + collectorNumber use exact-printing identifiers;
 * name-only entries fall back to { name }.
 * Returns a map of lookupKey → sf card.
 */
async function resolveCards(parsed) {
  const identifiers = parsed.map(c =>
    c.setCode && c.collectorNumber
      ? { set: c.setCode, collector_number: c.collectorNumber }
      : { name: c.name }
  )

  const results = new Map() // lookupKey → sfCard

  for (let i = 0; i < identifiers.length; i += 75) {
    const batch = identifiers.slice(i, i + 75)
    try {
      const res = await fetch(sfUrl(`${SF}/cards/collection`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ identifiers: batch }),
      })
      if (res.ok) {
        const data = await res.json()
        for (const sf of (data.data || [])) {
          // Key by full name
          results.set(sf.name.toLowerCase(), sf)
          // Also key by front-face name for DFCs ("Brazen Borrower // Petty Theft" → "brazen borrower")
          const frontFace = sf.name.split(' // ')[0].toLowerCase()
          if (frontFace !== sf.name.toLowerCase()) results.set(frontFace, sf)
          // Key by set+collector for exact-printing lookup
          if (sf.set && sf.collector_number) {
            results.set(`${sf.set}-${sf.collector_number}`, sf)
          }
        }
      }
    } catch {}
    if (i + 75 < identifiers.length) await new Promise(r => setTimeout(r, 150))
  }
  return results
}

// Detect format and return [{ name, qty, foil, setCode?, collectorNumber? }]
function parseInput(text) {
  const firstLine = text.trim().split('\n')[0] || ''
  if (firstLine.includes(',') && /\bname\b/i.test(firstLine)) {
    // Manabox / generic CSV
    const { cards } = parseManaboxCSV(text)
    const map = new Map()
    for (const c of cards) {
      const key = c.name.toLowerCase() + (c.foil ? '|foil' : '')
      const ex = map.get(key)
      map.set(key, ex
        ? { ...ex, qty: ex.qty + c.qty }
        : { name: c.name, qty: c.qty, foil: c.foil,
            setCode: c.set_code || null, collectorNumber: c.collector_number || null })
    }
    return [...map.values()]
  }
  // Plain decklist — now returns setCode, collectorNumber, foil too
  return parseTextDecklist(text).map(c => ({
    name: c.name, qty: c.qty, foil: c.foil ?? false,
    setCode: c.setCode || null, collectorNumber: c.collectorNumber || null,
  }))
}

export default function ImportModal({
  userId, folderType, folders: initialFolders, defaultFolderId,
  onClose, onSaved,
  /** Optional initial text (e.g. from a dropped .txt file) */
  initialText,
}) {
  const noun = NOUN[folderType] || folderType
  const [step, setStep]         = useState(initialText ? 'preview' : 'input')
  const [inputTab, setInputTab] = useState('text') // 'text' | 'url'
  const [text, setText]         = useState(initialText || '')
  const [importUrl, setImportUrl]   = useState('')
  const [urlLoading, setUrlLoading] = useState(false)
  const [urlError, setUrlError]     = useState('')
  const [parsed, setParsed]     = useState(() => initialText ? parseInput(initialText) : [])
  const [folders, setFolders]           = useState(initialFolders || [])
  const [folderId, setFolderId]         = useState(defaultFolderId || '')
  const [folderSearch, setFolderSearch] = useState('')
  const [newName, setNewName]           = useState('')
  const [creating, setCreating]         = useState(false)
  const [progress, setProgress]         = useState(0)
  const [total, setTotal]               = useState(0)
  const [missed, setMissed]             = useState([])
  const [imported, setImported]         = useState(0)
  const fileRef = useRef(null)

  const selectedFolderName = folders.find(f => f.id === folderId)?.name || ''
  const filteredFolders = folders.filter(f =>
    !folderSearch.trim() || f.name.toLowerCase().includes(folderSearch.toLowerCase())
  )

  // When defaultFolderId is provided and we have only one folder, the destination
  // is pre-determined — skip the picker UI.
  const destinationFixed = !!defaultFolderId && folders.length <= 1

  const handleFile = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setText(ev.target.result)
    reader.readAsText(file)
    // Reset input so the same file can be re-selected
    e.target.value = ''
  }

  const handleParse = () => {
    const result = parseInput(text)
    if (!result.length) return
    setParsed(result)
    setStep('preview')
  }

  const handleUrlFetch = async () => {
    if (!importUrl.trim()) return
    setUrlLoading(true)
    setUrlError('')
    try {
      const result = await importDeckFromUrl(importUrl.trim())
      const converted = result.cards.map(c => ({
        name: c.name, qty: c.qty, foil: c.foil ?? false,
        setCode: c.setCode || null, collectorNumber: c.collectorNumber || null,
      }))
      if (!converted.length) throw new Error('No cards found in the deck.')
      setParsed(converted)
      setStep('preview')
    } catch (e) {
      setUrlError(e.message)
    }
    setUrlLoading(false)
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
      // Resolve all cards via Scryfall collection endpoint (supports exact-printing lookup)
      const sfMap = await resolveCards(parsed)

      // Helper: find the best Scryfall match for a parsed entry
      const resolveSf = (c) => {
        if (c.setCode && c.collectorNumber) {
          const byPrint = sfMap.get(`${c.setCode}-${c.collectorNumber}`)
          if (byPrint) return byPrint
        }
        return sfMap.get(c.name.toLowerCase()) || null
      }

      if (folderType === 'list') {
        const items = []
        for (const c of parsed) {
          const sf = resolveSf(c)
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
          const sf = resolveSf(c)
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
            .upsert(cardRows, { onConflict: 'user_id,set_code,collector_number,foil,language,condition', ignoreDuplicates: false })
            .select('id, set_code, collector_number, foil, language, condition')
          if (upserted) {
            const cardKeyToId = {}
            for (const r of upserted) {
              cardKeyToId[`${r.set_code}-${r.collector_number}-${r.foil}-${r.language}-${r.condition}`] = r.id
            }
            for (const row of cardRows) {
              const cardKey = `${row.set_code}-${row.collector_number}-${row.foil}-${row.language}-${row.condition}`
              const cid = cardKeyToId[cardKey]
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
            {/*
              URL IMPORT TAB — disabled until server-side proxy is available.
              These APIs (Archidekt, Moxfield, MTGGoldfish) all require a server-side
              proxy to bypass CORS / spoof Origin headers. The Vite dev proxy in
              vite.config.js handles this locally, but on static hosting (GitHub Pages
              or any plain file server) there is no server component to proxy through.
              To re-enable: migrate to hosting with serverless functions (Netlify, Vercel,
              Cloudflare Workers) and port the vite.config.js proxy routes to edge functions,
              then uncomment the tab switcher and URL tab below.

              State needed: inputTab, setInputTab, importUrl, setImportUrl,
                            urlLoading, setUrlLoading, urlError, setUrlError
              Handler needed: handleUrlFetch (already implemented above, just not wired up)
              CSS needed: .inputTabs, .inputTab, .inputTabActive, .urlInput, .urlError
                          (already in ImportModal.module.css, just not visible)

            <div className={styles.inputTabs}>
              {[['text', '📋 Paste / Upload'], ['url', '🔗 URL']].map(([id, label]) => (
                <button key={id} className={`${styles.inputTab} ${inputTab === id ? styles.inputTabActive : ''}`}
                  onClick={() => { setInputTab(id); setUrlError('') }}>
                  {label}
                </button>
              ))}
            </div>
            */}

            <p className={styles.hint}>
              Paste a decklist or Manabox CSV, or upload a <em>.csv</em> / <em>.txt</em> file.<br />
              <span className={styles.hintFormats}>
                Supported: <code>4 Lightning Bolt</code> · <code>4 Lightning Bolt (M10) 155</code> · <code>4 *F* Sol Ring</code>
              </span>
            </p>
            <textarea
              className={styles.textarea}
              placeholder={'4 Forest\n1 Sol Ring\n4 Lightning Bolt (M10) 155\n// comments are ignored'}
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

            {/* URL tab content — also disabled, keep for when proxy is available:
            {inputTab === 'url' && (
              <>
                <p className={styles.hint}>
                  Paste a deck link from Archidekt, Moxfield, or MTGGoldfish.
                </p>
                <input autoFocus className={styles.urlInput}
                  value={importUrl}
                  onChange={e => { setImportUrl(e.target.value); setUrlError('') }}
                  onKeyDown={async e => { if (e.key === 'Enter') await handleUrlFetch() }}
                  placeholder="https://archidekt.com/decks/12345/…"
                />
                {urlError && <p className={styles.urlError}>{urlError}</p>}
                <div className={styles.inputRow}>
                  <button className={styles.parseBtn} onClick={handleUrlFetch}
                    disabled={urlLoading || !importUrl.trim()}>
                    {urlLoading ? 'Fetching…' : 'Fetch →'}
                  </button>
                </div>
              </>
            )}
            */}
          </>
        )}

        {/* ── Step: Preview ── */}
        {step === 'preview' && (
          <>
            <p className={styles.hint}>{parsed.length} cards found. {destinationFixed ? `Importing into: ${folders[0]?.name || noun}` : `Choose a destination:`}</p>

            {/* Folder picker — only shown when destination is not pre-fixed */}
            {!destinationFixed && (
              !creating ? (
                <div className={styles.pickerRow}>
                  <ResponsiveMenu
                    title={`Select ${noun}`}
                    align="left"
                    wrapClassName={styles.folderCombo}
                    onOpenChange={(open) => { if (!open) setFolderSearch('') }}
                    trigger={({ open, toggle }) => (
                      <button type="button" className={styles.folderComboBtn} onClick={toggle}>
                        <span className={!folderId ? styles.folderComboBtnPlaceholder : ''}>
                          {selectedFolderName || `Choose ${noun.toLowerCase()}…`}
                        </span>
                        <span className={styles.folderComboArrow}>{open ? '▲' : '▼'}</span>
                      </button>
                    )}
                  >
                    {({ close }) => (
                      <>
                        <input
                          autoFocus
                          className={styles.folderDropSearch}
                          value={folderSearch}
                          onChange={e => setFolderSearch(e.target.value)}
                          placeholder={`Search ${noun.toLowerCase()}s…`}
                          onMouseDown={e => e.stopPropagation()}
                        />
                        <div className={uiStyles.responsiveMenuList}>
                          {filteredFolders.length > 0
                            ? filteredFolders.map(f => (
                                <button
                                  key={f.id}
                                  className={`${uiStyles.responsiveMenuAction} ${folderId === f.id ? uiStyles.responsiveMenuActionActive : ''}`}
                                  onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
                                  onClick={e => { e.preventDefault(); e.stopPropagation(); setFolderId(f.id); setFolderSearch(''); close() }}
                                >{f.name}</button>
                              ))
                            : <div className={styles.folderDropEmpty}>
                                {folderSearch
                                  ? `No ${noun.toLowerCase()}s match "${folderSearch}"`
                                  : `No ${noun.toLowerCase()}s yet`}
                              </div>
                          }
                        </div>
                      </>
                    )}
                  </ResponsiveMenu>
                  <button className={styles.createBtn} onClick={() => setCreating(true)}>
                    + New
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
              )
            )}

            {/* Card list preview */}
            <div className={styles.previewList}>
              {parsed.slice(0, 50).map((c, i) => (
                <div key={i} className={styles.previewRow}>
                  <span className={styles.previewQty}>×{c.qty}</span>
                  <span className={styles.previewName}>{c.name}</span>
                  {c.setCode && (
                    <span className={styles.previewSet}>
                      {c.setCode.toUpperCase()}{c.collectorNumber ? ` ${c.collectorNumber}` : ''}
                    </span>
                  )}
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
