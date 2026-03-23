import { useState, useEffect, useRef } from 'react'
import { sb } from '../lib/supabase'
import { Modal, Button, ErrorBox } from './UI'
import { useSettings } from './SettingsContext'
import { getPrice, formatPrice, getPriceSource, sfGet } from '../lib/scryfall'
import { initScanner, ocrCardName, getFrameArtHash, filterPrintingsByArt } from '../lib/scanner'
import styles from './AddCardModal.module.css'

const CONDITIONS = [
  ['near_mint', 'Near Mint'],
  ['lightly_played', 'Lightly Played'],
  ['moderately_played', 'Moderately Played'],
  ['heavily_played', 'Heavily Played'],
  ['damaged', 'Damaged'],
]

const LANGUAGES = [
  ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['it', 'Italian'],
  ['es', 'Spanish'], ['pt', 'Portuguese'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['ru', 'Russian'], ['cs', 'Trad. Chinese'], ['ct', 'Simp. Chinese'],
  ['he', 'Hebrew'], ['ar', 'Arabic'], ['la', 'Latin'], ['ph', 'Phyrexian'],
]

function getCardImage(printing, size = 'normal') {
  if (!printing) return null
  if (printing.image_uris?.[size]) return printing.image_uris[size]
  if (printing.card_faces?.[0]?.image_uris?.[size]) return printing.card_faces[0].image_uris[size]
  return null
}

// Returns market price in the native price_source currency as a string for the purchase price input.
function getMarketPrice(printing, isFoil, price_source = 'cardmarket_trend') {
  const v = getPrice(printing, isFoil, { price_source })
  return v ? v.toFixed(2) : ''
}

// ── Camera / scan view ────────────────────────────────────────────────────────

function ScanView({ onScanned, onManual }) {
  const videoRef    = useRef(null)
  const activeRef   = useRef(true)   // set to false on unmount to stop loop
  const ocrBufRef   = useRef([])     // stability buffer — need 2 consecutive matches
  const [camReady, setCamReady]     = useState(false)
  const [camError, setCamError]     = useState(false)
  const [statusText, setStatusText] = useState('Starting camera…')
  const [showDebug, setShowDebug]   = useState(false)
  const [debugInfo, setDebugInfo]   = useState({})

  // Start camera + Tesseract in parallel
  useEffect(() => {
    let stream = null
    activeRef.current = true

    const start = async () => {
      setStatusText('Initializing scanner…')
      try {
        const [, s] = await Promise.all([
          initScanner(),
          navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          }),
        ])
        if (!activeRef.current) { s.getTracks().forEach(t => t.stop()); return }
        stream = s
        videoRef.current.srcObject = s
        await videoRef.current.play()
        setCamReady(true)
        setStatusText('Hold card still…')
      } catch {
        setCamError(true)
        setStatusText('Camera unavailable — use manual search')
      }
    }

    start()
    return () => {
      activeRef.current = false
      stream?.getTracks().forEach(t => t.stop())
    }
  }, [])

  // Scanning loop — runs after camera is ready
  useEffect(() => {
    if (!camReady) return
    let timeout

    const scan = async () => {
      if (!activeRef.current) return

      const result = await ocrCardName(videoRef.current)
      if (!activeRef.current) return

      setDebugInfo(d => ({ ...d,
        ocrText: result?.text || '—',
        ocrConf: result ? `${result.confidence.toFixed(0)}%` : '—',
        step: 'OCR',
      }))

      if (!result || result.confidence < 52 || result.text.length < 3) {
        ocrBufRef.current = []  // reset stability buffer on failed read
        setStatusText(`Hold card still inside the frame${result?.text ? ` — "${result.text}" (${result.confidence.toFixed(0)}%)` : ''}`)
        if (activeRef.current) timeout = setTimeout(scan, 700)
        return
      }

      // Stability buffer: require the same text twice in a row to avoid misreads
      const buf = ocrBufRef.current
      buf.push(result.text)
      if (buf.length > 2) buf.shift()

      setStatusText(`Scanning… "${result.text}" (${result.confidence.toFixed(0)}%)`)
      setDebugInfo(d => ({ ...d, step: 'Stabilising' }))

      if (buf.length < 2 || buf[0] !== buf[1]) {
        if (activeRef.current) timeout = setTimeout(scan, 700)
        return
      }

      // Got a stable read — proceed
      ocrBufRef.current = []
      setDebugInfo(d => ({ ...d, step: 'Name lookup' }))

      try {
        // Fuzzy name match
        const card = await sfGet(
          `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(result.text)}`
        )
        if (!card) throw new Error('no match')

        setStatusText(`Found "${card.name}" — matching set from art…`)
        setDebugInfo(d => ({ ...d, matchedName: card.name, step: 'Printings' }))

        // Fetch all printings
        const printsData = await sfGet(
          `https://api.scryfall.com/cards/search?q=!"${encodeURIComponent(card.name)}"&unique=prints&order=released&dir=desc`
        )
        const allPrintings = printsData?.data || []

        setDebugInfo(d => ({ ...d, printingCount: allPrintings.length, step: 'Art hash' }))

        // Art hash comparison
        const frameHash = getFrameArtHash(videoRef.current)
        const matchedPrintings = await filterPrintingsByArt(allPrintings, frameHash, scores => {
          setDebugInfo(d => ({ ...d,
            artScores: scores.slice(0, 5).map(s => `${s.p.set?.toUpperCase()} ${s.score}`).join('  '),
          }))
        })

        if (!activeRef.current) return
        activeRef.current = false  // stop loop — success

        setDebugInfo(d => ({ ...d, step: 'Done', artMatches: matchedPrintings.length }))
        setStatusText(`Matched! ${matchedPrintings.length} set(s)`)
        onScanned(card.name, matchedPrintings, allPrintings)
      } catch (e) {
        setDebugInfo(d => ({ ...d, step: 'Error', error: e.message }))
        setStatusText('Not recognized — try repositioning the card')
        ocrBufRef.current = []
        if (activeRef.current) timeout = setTimeout(scan, 700)
      }
    }

    timeout = setTimeout(scan, 1000)  // brief delay before first attempt
    return () => clearTimeout(timeout)
  }, [camReady])

  return (
    <div className={styles.scanView}>
      <div className={styles.cameraWrap}>
        <video
          ref={videoRef}
          autoPlay playsInline muted
          className={styles.videoEl}
        />

        {/* Targeting overlay — dark mask with card-shaped cutout */}
        <div className={styles.scanMask}>
          <div className={styles.cardTarget}>
            {/* Name strip indicator */}
            <div className={styles.nameZone} />
            {/* Art area indicator */}
            <div className={styles.artZone} />
          </div>
        </div>

        {/* Scan status */}
        <div className={`${styles.scanStatusBar} ${camError ? styles.scanStatusError : ''}`}>
          <span className={!camError && camReady ? styles.scanDot : ''} />
          {statusText}
        </div>
      </div>

      <div className={styles.scanFooter}>
        <span className={styles.scanHint}>
          {camError
            ? 'Grant camera permission and reload to scan'
            : 'Hold the card in the frame, name side up'}
        </span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className={styles.debugToggle} onClick={() => setShowDebug(v => !v)}>
            {showDebug ? 'Hide debug' : 'Debug'}
          </button>
          <button className={styles.manualLink} onClick={onManual}>
            Type instead →
          </button>
        </div>
      </div>

      {showDebug && (
        <div className={styles.debugPanel}>
          <div className={styles.debugRow}><span>Step</span><span>{debugInfo.step || '—'}</span></div>
          <div className={styles.debugRow}><span>OCR text</span><span>{debugInfo.ocrText || '—'}</span></div>
          <div className={styles.debugRow}><span>OCR conf</span><span>{debugInfo.ocrConf || '—'}</span></div>
          {debugInfo.matchedName && <div className={styles.debugRow}><span>Card name</span><span>{debugInfo.matchedName}</span></div>}
          {debugInfo.printingCount != null && <div className={styles.debugRow}><span>Printings</span><span>{debugInfo.printingCount}</span></div>}
          {debugInfo.artScores && <div className={styles.debugRow}><span>Art scores</span><span className={styles.debugSmall}>{debugInfo.artScores}</span></div>}
          {debugInfo.artMatches != null && <div className={styles.debugRow}><span>Art matches</span><span>{debugInfo.artMatches}</span></div>}
          {debugInfo.error && <div className={styles.debugRow} style={{ color: 'var(--red)' }}><span>Error</span><span>{debugInfo.error}</span></div>}
        </div>
      )}
    </div>
  )
}

// ── Edit mode (simple form) ────────────────────────────────────────────────────
function EditForm({ card, onClose, onSaved }) {
  const [qty, setQty]                   = useState(card.qty || 1)
  const [condition, setCondition]       = useState(card.condition || 'near_mint')
  const [language, setLanguage]         = useState(card.language || 'en')
  const [purchasePrice, setPurchasePrice] = useState(card.purchase_price ?? 0)
  const [foil, setFoil]                 = useState(card.foil || false)
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState('')

  const save = async () => {
    setSaving(true); setError('')
    const { error: err } = await sb.from('cards').update({
      qty: parseInt(qty) || 1, condition, language, foil,
      purchase_price: parseFloat(purchasePrice) || 0,
    }).eq('id', card.id)
    if (err) setError(err.message)
    else onSaved()
    setSaving(false)
  }

  return (
    <>
      <h2 className={styles.title}>Edit Card</h2>
      <div className={styles.editName}>{card.name}</div>
      <div className={styles.editMeta}>{card.set_code?.toUpperCase()} · #{card.collector_number}</div>
      <div className={styles.formGrid} style={{ marginTop: 16 }}>
        <div className={styles.field}>
          <label className={styles.label}>Quantity</label>
          <input className={styles.input} type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Condition</label>
          <select className={styles.input} value={condition} onChange={e => setCondition(e.target.value)}>
            {CONDITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Language</label>
          <select className={styles.input} value={language} onChange={e => setLanguage(e.target.value)}>
            {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Purchase Price (€)</label>
          <input className={styles.input} type="number" min="0" step="0.01"
            value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} />
        </div>
      </div>
      <label className={styles.foilToggle}>
        <input type="checkbox" checked={foil} onChange={e => setFoil(e.target.checked)} />
        Foil
      </label>
      <ErrorBox>{error}</ErrorBox>
      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </>
  )
}

// ── Main modal ─────────────────────────────────────────────────────────────────
export default function AddCardModal({
  userId, onClose, onSaved, prefillCard = null,
  folderMode = false, defaultFolderType = 'binder', defaultFolderId = null,
}) {
  return (
    <Modal onClose={onClose}>
      {prefillCard?.id
        ? <EditForm card={prefillCard} onClose={onClose} onSaved={onSaved} />
        : <AddFlow userId={userId} onClose={onClose} onSaved={onSaved}
            folderMode={folderMode} defaultFolderType={defaultFolderType} defaultFolderId={defaultFolderId} />
      }
    </Modal>
  )
}

// ── Add flow ──────────────────────────────────────────────────────────────────
function AddFlow({ userId, onClose, onSaved, folderMode = false, defaultFolderType = 'binder', defaultFolderId = null }) {
  const { price_source } = useSettings()

  // Format a printing's non-foil price using the user's price source
  const fmtPrintingPrice = (printing) => {
    if (!printing) return '—'
    const v = getPrice(printing, false, { price_source })
    return v != null ? formatPrice(v, price_source) : '—'
  }

  // View state: 'scan' | 'search' | 'configure'
  const [view, setView] = useState('scan')

  // Search
  const [query, setQuery]               = useState('')
  const [suggestions, setSuggestions]   = useState([])
  const [suggestOpen, setSuggestOpen]   = useState(false)
  const searchDebounce                  = useRef(null)
  const suggestRef                      = useRef(null)

  // Selected card
  const [selectedName, setSelectedName]         = useState(null)
  const [printings, setPrintings]               = useState([])   // filtered (matched sets)
  const [allPrintings, setAllPrintings]         = useState([])   // full list
  const [showAllPrintings, setShowAllPrintings] = useState(false)
  const [loadingPrintings, setLoadingPrintings] = useState(false)
  const [selectedPrinting, setSelectedPrinting] = useState(null)

  // Form
  const [qty, setQty]                   = useState(1)
  const [foil, setFoil]                 = useState(false)
  const [condition, setCondition]       = useState('near_mint')
  const [language, setLanguage]         = useState('en')
  const [purchasePrice, setPurchasePrice] = useState('')

  // Queue
  const [queue, setQueue] = useState([])

  // Destination
  const [destTab, setDestTab]           = useState(folderMode ? (defaultFolderType || 'binder') : 'binder')
  const [folders, setFolders]           = useState([])
  const [selectedFolder, setSelectedFolder] = useState(defaultFolderId || null)

  // Folder mode — searchable dropdown
  const [folderSearch, setFolderSearch]   = useState('')
  const [folderDropOpen, setFolderDropOpen] = useState(false)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName]   = useState('')
  const folderDropRef = useRef(null)

  // Save
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')

  useEffect(() => {
    sb.from('folders').select('id,name,type,description').eq('user_id', userId).then(({ data }) => {
      if (data) setFolders(data)
    })
  }, [userId])

  // Pre-populate folder search label when folders load
  useEffect(() => {
    if (!folderMode || !defaultFolderId || !folders.length) return
    const f = folders.find(fl => fl.id === defaultFolderId)
    if (f) setFolderSearch(f.name)
  }, [folderMode, defaultFolderId, folders])

  // Close folder dropdown on outside click
  useEffect(() => {
    if (!folderDropOpen) return
    const close = (e) => { if (folderDropRef.current && !folderDropRef.current.contains(e.target)) setFolderDropOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [folderDropOpen])

  // Close suggestions on outside click
  useEffect(() => {
    const handler = e => {
      if (suggestRef.current && !suggestRef.current.contains(e.target)) setSuggestOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Autocomplete — uses search API to get full card objects (for images)
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    if (!query.trim() || query.length < 2 || selectedName) {
      setSuggestions([]); setSuggestOpen(false); return
    }
    searchDebounce.current = setTimeout(async () => {
      try {
        const data = await sfGet(
          `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=cards&order=name&limit=8`
        )
        const cards = data?.data?.slice(0, 8) || []
        setSuggestions(cards)
        setSuggestOpen(cards.length > 0)
      } catch {}
    }, 320)
    return () => clearTimeout(searchDebounce.current)
  }, [query, selectedName])

  // ── Callbacks ────────────────────────────────────────────────────────────────

  // Called by ScanView when scan succeeds: matchedPrintings = art-filtered, allPrints = full list
  const handleScanned = (name, matchedPrintings, allPrints) => {
    setSelectedName(name)
    setQuery(name)
    setPrintings(matchedPrintings)
    setAllPrintings(allPrints)
    setShowAllPrintings(false)
    if (matchedPrintings.length > 0) {
      setSelectedPrinting(matchedPrintings[0])
      setFoil(false)
      setPurchasePrice(getMarketPrice(matchedPrintings[0], false, price_source))
    }
    setView('configure')
  }

  // Called when user manually types and picks a card name
  const selectCard = async (name) => {
    setSelectedName(name)
    setQuery(name)
    setSuggestions([]); setSuggestOpen(false)
    setLoadingPrintings(true)
    setSelectedPrinting(null)
    setPrintings([]); setAllPrintings([]); setShowAllPrintings(false)
    setView('configure')
    try {
      const data = await sfGet(
        `https://api.scryfall.com/cards/search?q=!"${encodeURIComponent(name)}"&unique=prints&order=released&dir=desc`
      )
      const prints = data?.data || []
      setPrintings(prints)     // manual: show all (no art filtering)
      setAllPrintings(prints)
      if (prints.length > 0) {
        setSelectedPrinting(prints[0])
        setFoil(false)
        setPurchasePrice(getMarketPrice(prints[0], false, price_source))
      }
    } catch {}
    setLoadingPrintings(false)
  }

  const choosePrinting = (p) => {
    setSelectedPrinting(p)
    setPurchasePrice(getMarketPrice(p, foil, price_source))
  }

  const handleFoilChange = (checked) => {
    setFoil(checked)
    if (selectedPrinting) setPurchasePrice(getMarketPrice(selectedPrinting, checked, price_source))
  }

  const resetSearch = () => {
    setQuery(''); setSelectedName(null)
    setSelectedPrinting(null); setPrintings([]); setAllPrintings([])
    setQty(1); setFoil(false); setCondition('near_mint')
    setLanguage('en'); setPurchasePrice('')
  }

  const addToQueue = () => {
    if (!selectedPrinting) return
    setQueue(q => [...q, {
      id: Date.now(),
      printing: selectedPrinting,
      qty: parseInt(qty) || 1,
      foil, condition, language,
      purchasePrice: parseFloat(purchasePrice) || 0,
    }])
    resetSearch()
    setView('scan')
  }

  const removeFromQueue = (id) => setQueue(q => q.filter(item => item.id !== id))
  const updateQueueQty = (id, delta) => setQueue(q => q.map(item =>
    item.id === id ? { ...item, qty: Math.max(1, item.qty + delta) } : item
  ))

  const destFolders = folders.filter(f => f.type === destTab)

  // Folder mode: filtered folders by selected type + search text, excluding groups
  const filteredFoldersByType = (() => {
    const byType = folders.filter(f => {
      if (f.type !== destTab) return false
      try { if (JSON.parse(f.description || '{}').isGroup) return false } catch {}
      return true
    })
    if (!folderSearch.trim()) return byType
    const q = folderSearch.toLowerCase()
    return byType.filter(f => f.name.toLowerCase().includes(q))
  })()

  const createNewFolder = async () => {
    if (!newFolderName.trim() || !userId) return
    const { data } = await sb.from('folders').insert({
      user_id: userId, type: destTab, name: newFolderName.trim(),
    }).select().single()
    if (data) {
      setFolders(prev => [...prev, data])
      setSelectedFolder(data.id)
      setFolderSearch(data.name)
      setCreatingFolder(false)
      setNewFolderName('')
    }
  }

  const canSave = queue.length > 0 && selectedFolder != null

  const saveAll = async () => {
    if (!queue.length) return
    setSaving(true); setError('')
    try {
      // Wishlist (list_items) save — only in folder mode
      if (folderMode && destTab === 'list' && selectedFolder) {
        const items = queue.map(item => ({
          folder_id: selectedFolder,
          name: item.printing.name,
          set_code: item.printing.set,
          collector_number: item.printing.collector_number,
          scryfall_id: item.printing.id || null,
          foil: item.foil,
          qty: item.qty,
        }))
        const { error: err } = await sb.from('list_items')
          .upsert(items, { onConflict: 'folder_id,set_code,collector_number,foil' })
        if (err) { setError(err.message); setSaving(false); return }
        onSaved()
        setSaving(false)
        return
      }

      // Binder / Deck / Collection save
      const cards = queue.map(item => ({
        user_id: userId,
        name: item.printing.name,
        set_code: item.printing.set,
        collector_number: item.printing.collector_number,
        scryfall_id: item.printing.id || null,
        foil: item.foil, qty: item.qty,
        condition: item.condition, language: item.language,
        purchase_price: item.purchasePrice,
        currency: 'EUR',
      }))
      const { error: err } = await sb.from('cards')
        .upsert(cards, { onConflict: 'user_id,set_code,collector_number,foil,language,condition' })
      if (err) { setError(err.message); setSaving(false); return }

      const folderTarget = folderMode ? selectedFolder : (destTab !== 'collection' ? selectedFolder : null)
      if (folderTarget) {
        const setCodes = [...new Set(cards.map(c => c.set_code))]
        const { data: saved } = await sb.from('cards')
          .select('id,set_code,collector_number,foil,language,condition')
          .eq('user_id', userId).in('set_code', setCodes)
        if (saved?.length) {
          const links = saved
            .filter(c => cards.some(qc =>
              qc.set_code === c.set_code && qc.collector_number === c.collector_number &&
              qc.foil === c.foil && qc.language === c.language && qc.condition === c.condition
            ))
            .map(c => ({ folder_id: folderTarget, card_id: c.id }))
          if (links.length) {
            await sb.from('folder_cards').upsert(links, { onConflict: 'folder_id,card_id' })
          }
        }
      }
      onSaved()
    } catch (e) { setError(e.message) }
    setSaving(false)
  }

  const displayedPrintings = showAllPrintings ? allPrintings : printings
  const imageUri   = getCardImage(selectedPrinting)
  // Card has a foil version if Scryfall says so in finishes[], OR if there's a foil price
  const hasFoil = !!(
    selectedPrinting?.finishes?.includes('foil') ||
    selectedPrinting?.finishes?.includes('etched') ||
    selectedPrinting?.prices?.eur_foil ||
    selectedPrinting?.prices?.usd_foil
  )
  const totalQty   = queue.reduce((s, i) => s + i.qty, 0)

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <div className={styles.modalHeader}>
        <h2 className={styles.title}>Add Cards</h2>
        {/* Tab row: Scan | Type */}
        <div className={styles.modeTabs}>
          <button
            className={`${styles.modeTab} ${view === 'scan' ? styles.modeTabActive : ''}`}
            onClick={() => { resetSearch(); setView('scan') }}
          >
            ⌖ Scan
          </button>
          <button
            className={`${styles.modeTab} ${view !== 'scan' ? styles.modeTabActive : ''}`}
            onClick={() => setView(selectedName ? 'configure' : 'search')}
          >
            ⌨ Type
          </button>
        </div>
      </div>

      {/* ── Scan view ── */}
      {view === 'scan' && (
        <ScanView
          onScanned={handleScanned}
          onManual={() => { resetSearch(); setView('search') }}
        />
      )}

      {/* ── Manual search ── */}
      {view === 'search' && (
        <div className={styles.searchWrap} ref={suggestRef}>
          <div className={styles.searchRow}>
            <input
              className={styles.searchInput}
              value={query}
              onChange={e => { setQuery(e.target.value); setSelectedName(null) }}
              placeholder="Search for a card…"
              autoFocus
              onFocus={() => suggestions.length > 0 && setSuggestOpen(true)}
            />
            {query && (
              <button className={styles.clearBtn} onClick={resetSearch}>×</button>
            )}
          </div>
          {suggestOpen && (
            <div className={styles.suggestions}>
              {suggestions.map(card => {
                const artUri = card.image_uris?.art_crop || card.card_faces?.[0]?.image_uris?.art_crop
                return (
                  <button key={card.id} className={styles.suggestion} onMouseDown={() => selectCard(card.name)}>
                    {artUri && <img src={artUri} alt="" className={styles.suggestionArt} />}
                    <div className={styles.suggestionInfo}>
                      <span className={styles.suggestionName}>{card.name}</span>
                      <span className={styles.suggestionMeta}>{card.type_line}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Configure panel ── */}
      {view === 'configure' && (
        <>
          {/* Back to search */}
          <div className={styles.configTopBar}>
            <button className={styles.backLink} onClick={() => setView('search')}>
              ← Search again
            </button>
            {selectedName && (
              <span className={styles.configCardName}>{selectedName}</span>
            )}
          </div>

          <div className={styles.configPanel}>
            {/* Left: image */}
            <div className={styles.imagePanel}>
              {imageUri
                ? <img src={imageUri} alt={selectedPrinting?.name} className={styles.cardImage} />
                : <div className={styles.imagePlaceholder}>
                    {loadingPrintings ? 'Loading…' : 'No image'}
                  </div>
              }
              {selectedPrinting && (
                <div className={styles.imageCaption}>
                  <span className={styles.captionName}>{selectedPrinting.name}</span>
                  <span className={styles.captionSet}>{selectedPrinting.set_name}</span>
                </div>
              )}
            </div>

            {/* Right: printing + form */}
            <div className={styles.configRight}>
              <div className={styles.fieldGroup}>
                <div className={styles.printingsHeader}>
                  <label className={styles.label}>Printing</label>
                  {/* Show "X matches" and toggle to all */}
                  {!showAllPrintings && allPrintings.length > printings.length && (
                    <button className={styles.showAllBtn}
                      onClick={() => setShowAllPrintings(true)}>
                      {printings.length} set{printings.length !== 1 ? 's' : ''} matched · show all {allPrintings.length}
                    </button>
                  )}
                  {showAllPrintings && allPrintings.length > 0 && (
                    <button className={styles.showAllBtn}
                      onClick={() => setShowAllPrintings(false)}>
                      Show matched only
                    </button>
                  )}
                </div>

                {loadingPrintings
                  ? <div className={styles.loadingText}>Loading printings…</div>
                  : (
                    <div className={styles.printingsGrid}>
                      {displayedPrintings.map(p => {
                        const thumbUri = p.image_uris?.small || p.card_faces?.[0]?.image_uris?.small
                        return (
                          <button
                            key={p.id}
                            className={`${styles.printingGridItem} ${selectedPrinting?.id === p.id ? styles.printingSelected : ''}`}
                            onClick={() => choosePrinting(p)}
                            title={`${p.set_name} (${p.released_at?.slice(0,4)}) · ${p.rarity} · ${fmtPrintingPrice(p)}`}
                          >
                            {thumbUri
                              ? <img src={thumbUri} alt={p.set_name} className={styles.printingGridImg} />
                              : <div className={styles.printingGridImgEmpty} />
                            }
                            <span className={styles.printingGridSet}>{p.set?.toUpperCase()}</span>
                            <span className={styles.printingGridNum}>#{p.collector_number}</span>
                            <span className={styles.printingGridPrice}>{fmtPrintingPrice(p)}</span>
                          </button>
                        )
                      })}
                    </div>
                  )
                }
              </div>

              <div className={styles.formGrid}>
                <div className={styles.field}>
                  <label className={styles.label}>Qty</label>
                  <input className={styles.input} type="number" min="1" value={qty}
                    onChange={e => setQty(e.target.value)} />
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Condition</label>
                  <select className={styles.input} value={condition} onChange={e => setCondition(e.target.value)}>
                    {CONDITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Language</label>
                  <select className={styles.input} value={language} onChange={e => setLanguage(e.target.value)}>
                    {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Purchase Price ({getPriceSource(price_source).symbol})</label>
                  <div className={styles.priceInputRow}>
                    <input className={styles.input} type="number" min="0" step="0.01"
                      value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} />
                    <button className={styles.marketBtn}
                      onClick={() => setPurchasePrice(getMarketPrice(selectedPrinting, foil, price_source))}
                      title="Use current market price">↺</button>
                  </div>
                </div>
              </div>

              <div className={styles.bottomRow}>
                <label className={styles.foilToggle}>
                  <input type="checkbox" checked={foil}
                    onChange={e => handleFoilChange(e.target.checked)}
                    disabled={!hasFoil} />
                  <span style={{ opacity: hasFoil ? 1 : 0.4 }}>Foil</span>
                  {selectedPrinting && !hasFoil && (
                    <span className={styles.noFoilNote}>No foil version</span>
                  )}
                </label>
                <Button onClick={addToQueue} disabled={!selectedPrinting}>+ Add to Queue</Button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Queue ── */}
      {queue.length > 0 && (
        <div className={styles.queueSection}>
          <div className={styles.queueHeader}>
            Queue
            <span className={styles.queueCount}>{queue.length} card{queue.length !== 1 ? 's' : ''} · {totalQty} total</span>
          </div>
          <div className={styles.queueList}>
            {queue.map(item => (
              <div key={item.id} className={styles.queueItem}>
                <img src={getCardImage(item.printing, 'small')}
                  alt={item.printing.name} className={styles.queueThumb} />
                <div className={styles.queueInfo}>
                  <span className={styles.queueName}>{item.printing.name}</span>
                  <span className={styles.queueMeta}>
                    {item.printing.set?.toUpperCase()} ·{' '}
                    {item.foil ? '✦ Foil' : 'Non-foil'} ·{' '}
                    {CONDITIONS.find(([v]) => v === item.condition)?.[1] || item.condition} ·{' '}
                    {LANGUAGES.find(([v]) => v === item.language)?.[1] || item.language}
                    {item.purchasePrice > 0 && ` · €${item.purchasePrice.toFixed(2)}`}
                  </span>
                </div>
                <div className={styles.queueQtyRow}>
                  <button className={styles.queueQtyBtn} onClick={() => updateQueueQty(item.id, -1)}>−</button>
                  <span className={styles.queueQty}>{item.qty}</span>
                  <button className={styles.queueQtyBtn} onClick={() => updateQueueQty(item.id, +1)}>+</button>
                </div>
                <button className={styles.queueRemove} onClick={() => removeFromQueue(item.id)}>×</button>
              </div>
            ))}
          </div>

          {/* Destination */}
          <div className={styles.destination}>
            <div className={styles.destLabel}>Save to</div>

            {folderMode ? (
              /* ── Folder mode: type tabs + searchable dropdown ── */
              <>
                <div className={styles.destTabs}>
                  {[['deck','Deck'],['binder','Binder'],['list','Wishlist']].map(([key,label]) => (
                    <button key={key}
                      className={`${styles.destTab} ${destTab===key ? styles.destTabActive : ''}`}
                      onClick={() => { setDestTab(key); setSelectedFolder(null); setFolderSearch(''); setCreatingFolder(false) }}>
                      {label}
                    </button>
                  ))}
                </div>
                <div ref={folderDropRef} className={styles.folderSearchWrap}>
                  <input
                    className={styles.folderSearchInput}
                    value={selectedFolder ? (folders.find(f => f.id === selectedFolder)?.name || folderSearch) : folderSearch}
                    onChange={e => { setFolderSearch(e.target.value); setSelectedFolder(null); setFolderDropOpen(true) }}
                    onFocus={() => setFolderDropOpen(true)}
                    placeholder={`Search ${destTab === 'list' ? 'wishlists' : destTab + 's'}…`}
                  />
                  {folderDropOpen && (
                    <div className={styles.folderDropdown}>
                      {filteredFoldersByType.map(f => (
                        <button key={f.id}
                          className={`${styles.folderDropItem} ${selectedFolder === f.id ? styles.folderDropItemActive : ''}`}
                          onMouseDown={() => { setSelectedFolder(f.id); setFolderSearch(f.name); setFolderDropOpen(false) }}>
                          {f.name}
                        </button>
                      ))}
                      {filteredFoldersByType.length === 0 && folderSearch && (
                        <div className={styles.folderDropEmpty}>No {destTab === 'list' ? 'wishlists' : destTab + 's'} found</div>
                      )}
                      <button className={styles.folderDropCreate}
                        onMouseDown={() => { setCreatingFolder(true); setFolderDropOpen(false) }}>
                        + Create new {destTab === 'list' ? 'wishlist' : destTab}
                      </button>
                    </div>
                  )}
                </div>
                {creatingFolder && (
                  <div className={styles.newFolderRow}>
                    <input
                      className={`${styles.input} ${styles.newFolderInput}`}
                      value={newFolderName}
                      onChange={e => setNewFolderName(e.target.value)}
                      placeholder={`New ${destTab === 'list' ? 'wishlist' : destTab} name…`}
                      autoFocus
                      onKeyDown={e => {
                        if (e.key === 'Enter') createNewFolder()
                        if (e.key === 'Escape') setCreatingFolder(false)
                      }}
                    />
                    <button className={styles.marketBtn} onClick={createNewFolder} title="Create">✓</button>
                    <button className={styles.clearBtn} onClick={() => { setCreatingFolder(false); setNewFolderName('') }}>×</button>
                  </div>
                )}
              </>
            ) : (
              /* ── Collection mode: tabs + button grid ── */
              <>
                <div className={styles.destTabs}>
                  {[['deck','Deck'],['binder','Binder'],['list','Wishlist']].map(([key,label]) => (
                    <button key={key}
                      className={`${styles.destTab} ${destTab===key ? styles.destTabActive : ''}`}
                      onClick={() => { setDestTab(key); setSelectedFolder(null) }}>
                      {label}
                    </button>
                  ))}
                </div>
                {destFolders.length > 0
                  ? (
                    <div className={styles.folderGrid}>
                      {destFolders.map(f => (
                        <button key={f.id}
                          className={`${styles.folderBtn} ${selectedFolder === f.id ? styles.folderBtnActive : ''}`}
                          onClick={() => setSelectedFolder(f.id)}>
                          {f.name}
                        </button>
                      ))}
                    </div>
                  )
                  : <div className={styles.noFolders}>No {destTab === 'list' ? 'wishlists' : `${destTab}s`} yet — create one first</div>
                }
              </>
            )}
          </div>
        </div>
      )}

      <ErrorBox>{error}</ErrorBox>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {queue.length > 0 && (
          <Button onClick={saveAll} disabled={saving || !canSave}>
            {saving ? 'Saving…' : `Save ${queue.length} Card${queue.length !== 1 ? 's' : ''}`}
          </Button>
        )}
      </div>
    </>
  )
}
