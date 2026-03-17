import { useState, useEffect, useRef } from 'react'
import { sb } from '../lib/supabase'
import { Modal, Button, ErrorBox } from './UI'
import { useSettings } from './SettingsContext'
import { getPrice, formatPrice, convertCurrency, getPriceSource } from '../lib/scryfall'
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

// Returns market price in display_currency as a string for the purchase price input.
// Always prefers EUR source (most accurate for EUR-stored purchase prices), then converts.
function getMarketPrice(printing, isFoil, price_source = 'cardmarket_trend', display_currency = 'EUR') {
  if (!printing?.prices) return ''
  const p = printing.prices
  // Get raw EUR value first (canonical source for storage); fall back to USD
  let eurVal = isFoil
    ? (parseFloat(p.eur_foil) || parseFloat(p.usd_foil) || 0)
    : (parseFloat(p.eur)      || parseFloat(p.usd)      || 0)
  if (!eurVal) return ''
  // Convert EUR → display currency
  const converted = display_currency === 'EUR' ? eurVal : (convertCurrency(eurVal, 'EUR', display_currency) ?? eurVal)
  return converted ? converted.toFixed(2) : ''
}

// Convert a purchase price entered in display_currency back to EUR for DB storage
function purchasePriceToEur(value, display_currency) {
  const v = parseFloat(value) || 0
  if (!v) return 0
  if (display_currency === 'EUR') return v
  return convertCurrency(v, display_currency, 'EUR') ?? v
}

// ── Camera / scan view ────────────────────────────────────────────────────────

function ScanView({ onScanned, onManual }) {
  const videoRef   = useRef(null)
  const activeRef  = useRef(true)   // set to false on unmount to stop loop
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

      if (!result || result.confidence < 62 || result.text.length < 3) {
        setStatusText(`Hold card still… ${result ? `(OCR: "${result.text}" ${result.confidence.toFixed(0)}%)` : ''}`)
        if (activeRef.current) timeout = setTimeout(scan, 900)
        return
      }

      setStatusText(`Reading: "${result.text}" (${result.confidence.toFixed(0)}%)…`)
      setDebugInfo(d => ({ ...d, step: 'Name lookup' }))

      try {
        // Fuzzy name match
        const nameRes = await fetch(
          `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(result.text)}`
        )
        if (!nameRes.ok) throw new Error('no match')
        const card = await nameRes.json()

        setStatusText(`Found "${card.name}" — matching set from art…`)
        setDebugInfo(d => ({ ...d, matchedName: card.name, step: 'Printings' }))

        // Fetch all printings
        const printsRes = await fetch(
          `https://api.scryfall.com/cards/search?q=!"${encodeURIComponent(card.name)}"&unique=prints&order=released&dir=desc`
        )
        const printsData = await printsRes.json()
        const allPrintings = printsData.data || []

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
        setStatusText('Not recognized — hold card still…')
        if (activeRef.current) timeout = setTimeout(scan, 900)
      }
    }

    timeout = setTimeout(scan, 1200)  // brief delay before first attempt
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
export default function AddCardModal({ userId, onClose, onSaved, prefillCard = null }) {
  return (
    <Modal onClose={onClose}>
      {prefillCard?.id
        ? <EditForm card={prefillCard} onClose={onClose} onSaved={onSaved} />
        : <AddFlow userId={userId} onClose={onClose} onSaved={onSaved} />
      }
    </Modal>
  )
}

// ── Add flow ──────────────────────────────────────────────────────────────────
function AddFlow({ userId, onClose, onSaved }) {
  const { price_source, display_currency } = useSettings()

  // Format a printing's non-foil price using the user's currency settings
  const fmtPrintingPrice = (printing) => {
    if (!printing) return '—'
    const v = getPrice(printing, false, { price_source })
    return v != null ? formatPrice(v, price_source, display_currency) : '—'
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
  const [destTab, setDestTab]           = useState('collection')
  const [folders, setFolders]           = useState([])
  const [selectedFolder, setSelectedFolder] = useState(null)

  // Save
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')

  useEffect(() => {
    sb.from('folders').select('id,name,type').eq('user_id', userId).then(({ data }) => {
      if (data) setFolders(data)
    })
  }, [userId])

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
        const res = await fetch(
          `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=cards&order=name&limit=8`
        )
        const data = await res.json()
        const cards = data.data?.slice(0, 8) || []
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
      const res = await fetch(
        `https://api.scryfall.com/cards/search?q=!"${encodeURIComponent(name)}"&unique=prints&order=released&dir=desc`
      )
      const data = await res.json()
      const prints = data.data || []
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
    // Store purchase price in EUR regardless of display currency
    const purchasePriceEur = purchasePriceToEur(purchasePrice, display_currency)
    setQueue(q => [...q, {
      id: Date.now(),
      printing: selectedPrinting,
      qty: parseInt(qty) || 1,
      foil, condition, language,
      purchasePrice: purchasePriceEur,
    }])
    resetSearch()
    setView('scan')
  }

  const removeFromQueue = (id) => setQueue(q => q.filter(item => item.id !== id))

  const destFolders = folders.filter(f => f.type === destTab)
  const canSave = queue.length > 0 &&
    (destTab === 'collection' || !destFolders.length || selectedFolder)

  const saveAll = async () => {
    if (!queue.length) return
    setSaving(true); setError('')
    try {
      const cards = queue.map(item => ({
        user_id: userId,
        name: item.printing.name,
        set_code: item.printing.set,
        collector_number: item.printing.collector_number,
        scryfall_id: item.printing.id || null,
        foil: item.foil, qty: item.qty,
        condition: item.condition, language: item.language,
        purchase_price: item.purchasePrice,  // already in EUR
        currency: 'EUR',
      }))
      const { error: err } = await sb.from('cards')
        .upsert(cards, { onConflict: 'user_id,set_code,collector_number,foil,language,condition' })
      if (err) { setError(err.message); setSaving(false); return }

      if (destTab !== 'collection' && selectedFolder) {
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
            .map(c => ({ folder_id: selectedFolder, card_id: c.id }))
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
                  <label className={styles.label}>Purchase Price ({display_currency === 'USD' ? '$' : '€'})</label>
                  <div className={styles.priceInputRow}>
                    <input className={styles.input} type="number" min="0" step="0.01"
                      value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} />
                    <button className={styles.marketBtn}
                      onClick={() => setPurchasePrice(getMarketPrice(selectedPrinting, foil, price_source, display_currency))}
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
                    {item.printing.set?.toUpperCase()} · {item.qty}× ·{' '}
                    {item.foil ? '✦ Foil' : 'Non-foil'} ·{' '}
                    {CONDITIONS.find(([v]) => v === item.condition)?.[1] || item.condition} ·{' '}
                    {LANGUAGES.find(([v]) => v === item.language)?.[1] || item.language}
                    {item.purchasePrice > 0 && ` · €${item.purchasePrice.toFixed(2)}`}
                  </span>
                </div>
                <button className={styles.queueRemove} onClick={() => removeFromQueue(item.id)}>×</button>
              </div>
            ))}
          </div>

          {/* Destination */}
          <div className={styles.destination}>
            <div className={styles.destLabel}>Save to</div>
            <div className={styles.destTabs}>
              {[['collection', 'Collection'], ['deck', 'Deck'], ['binder', 'Binder'], ['list', 'Wishlist']].map(([key, label]) => (
                <button
                  key={key}
                  className={`${styles.destTab} ${destTab === key ? styles.destTabActive : ''}`}
                  onClick={() => { setDestTab(key); setSelectedFolder(null) }}
                >
                  {label}
                </button>
              ))}
            </div>
            {destTab !== 'collection' && (
              destFolders.length > 0
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
                : <div className={styles.noFolders}>
                    No {destTab}s yet — cards will be saved to collection only
                  </div>
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
