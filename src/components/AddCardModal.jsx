import { useState, useEffect, useRef } from 'react'
import { sb } from '../lib/supabase'
import { Modal, Button, ErrorBox, ResponsiveMenu } from './UI'
import { useSettings } from './SettingsContext'
import { getPrice, formatPrice, getPriceSource, sfGet } from '../lib/scryfall'
import styles from './AddCardModal.module.css'
import uiStyles from './UI.module.css'

function getMarketPrice(printing, isFoil, priceSource = 'cardmarket_trend') {
  const value = getPrice(printing, isFoil, { price_source: priceSource })
  return value != null ? value.toFixed(2) : ''
}

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

function getOwnedCardKey(card) {
  return [
    card.set_code,
    card.collector_number,
    card.foil ? 1 : 0,
    card.language || 'en',
    card.condition || 'near_mint',
  ].join('|')
}

function getOptionLabel(options, value) {
  return options.find(([optionValue]) => optionValue === value)?.[1] || value
}

function MenuField({ label, title, value, options, onChange }) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <ResponsiveMenu
        title={title}
        align="left"
        wrapClassName={styles.selectMenuWrap}
        panelClassName={styles.selectMenuPanel}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            className={`${styles.selectTrigger} ${open ? styles.selectTriggerOpen : ''}`}
            onClick={toggle}
          >
            <span className={styles.selectTriggerLabel}>{getOptionLabel(options, value)}</span>
            <span className={styles.selectTriggerChevron}>{open ? '▲' : '▼'}</span>
          </button>
        )}
      >
        {({ close }) => (
          <div className={uiStyles.responsiveMenuList}>
            {options.map(([optionValue, optionLabel]) => (
              <button
                key={optionValue}
                type="button"
                className={`${uiStyles.responsiveMenuAction} ${value === optionValue ? uiStyles.responsiveMenuActionActive : ''}`}
                onClick={() => { onChange(optionValue); close() }}
              >
                <span>{optionLabel}</span>
                <span className={uiStyles.responsiveMenuCheck}>{value === optionValue ? '✓' : ''}</span>
              </button>
            ))}
          </div>
        )}
      </ResponsiveMenu>
    </div>
  )
}

function FoilSwitch({ value, onChange, disabled = false, note = null }) {
  return (
    <div className={styles.foilToggleWrap}>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label="Foil"
        className={`${styles.foilToggle} ${value ? styles.foilToggleOn : ''}`}
        onClick={() => { if (!disabled) onChange(!value) }}
        disabled={disabled}
      >
        <span className={styles.foilToggleText}>Foil</span>
        <span className={styles.foilToggleTrack}>
          <span className={styles.foilToggleKnob} />
        </span>
      </button>
      {note}
    </div>
  )
}

// Edit mode (simple form) ────────────────────────────────────────────────────
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
        <MenuField label="Condition" title="Condition" value={condition} options={CONDITIONS} onChange={setCondition} />
        <MenuField label="Language" title="Language" value={language} options={LANGUAGES} onChange={setLanguage} />
        <div className={styles.field}>
          <label className={styles.label}>Purchase Price (€)</label>
          <input className={styles.input} type="number" min="0" step="0.01"
            value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} />
        </div>
      </div>
      <FoilSwitch value={foil} onChange={setFoil} />
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
  initialCardName = null,
}) {
  return (
    <Modal onClose={onClose}>
      {prefillCard?.id
        ? <EditForm card={prefillCard} onClose={onClose} onSaved={onSaved} />
        : <AddFlow userId={userId} onClose={onClose} onSaved={onSaved}
            folderMode={folderMode} defaultFolderType={defaultFolderType} defaultFolderId={defaultFolderId}
            initialCardName={initialCardName} />
      }
    </Modal>
  )
}

// ── Add flow ──────────────────────────────────────────────────────────────────
function AddFlow({ userId, onClose, onSaved, folderMode = false, defaultFolderType = 'binder', defaultFolderId = null, initialCardName = null }) {
  const { price_source } = useSettings()

  // Format a printing's non-foil price using the user's price source
  const fmtPrintingPrice = (printing) => {
    if (!printing) return '—'
    const v = getPrice(printing, false, { price_source })
    return v != null ? formatPrice(v, price_source) : '—'
  }

  // View state: 'search' | 'configure'
  const [view, setView] = useState(initialCardName ? 'configure' : 'search')

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
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName]   = useState('')

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

  // Pre-fill card from the standalone scanner: auto-search on mount
  useEffect(() => {
    if (initialCardName) selectCard(initialCardName)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  // Called when user types and picks a card name
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
    setView('search')
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
          user_id: userId,
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
      const aggregated = Array.from(
        queue.reduce((map, item) => {
          const card = {
            user_id: userId,
            name: item.printing.name,
            set_code: item.printing.set,
            collector_number: item.printing.collector_number,
            scryfall_id: item.printing.id || null,
            foil: item.foil,
            qty: item.qty,
            condition: item.condition,
            language: item.language,
            purchase_price: item.purchasePrice,
            currency: 'EUR',
          }
          const key = getOwnedCardKey(card)
          const prev = map.get(key)
          if (prev) {
            prev.qty += card.qty
            prev.purchase_price = card.purchase_price
            prev.name = card.name
            prev.scryfall_id = card.scryfall_id
          } else {
            map.set(key, { ...card })
          }
          return map
        }, new Map()).values()
      )

      const setCodes = [...new Set(aggregated.map(c => c.set_code))]
      const { data: existingCards, error: existingCardsErr } = await sb.from('cards')
        .select('id,user_id,name,set_code,collector_number,scryfall_id,foil,qty,condition,language,purchase_price,currency')
        .eq('user_id', userId)
        .in('set_code', setCodes)
      if (existingCardsErr) { setError(existingCardsErr.message); setSaving(false); return }

      const existingByKey = new Map((existingCards || []).map(card => [getOwnedCardKey(card), card]))
      const cards = aggregated.map(card => {
        const existing = existingByKey.get(getOwnedCardKey(card))
        return existing
          ? { ...existing, ...card, id: existing.id, qty: (existing.qty || 0) + card.qty }
          : card
      })

      const { error: err } = await sb.from('cards')
        .upsert(cards, { onConflict: 'user_id,set_code,collector_number,foil,language,condition' })
      if (err) { setError(err.message); setSaving(false); return }

      const folderTarget = folderMode ? selectedFolder : (destTab !== 'collection' ? selectedFolder : null)
      if (folderTarget) {
        const folderType = folders.find(f => f.id === folderTarget)?.type || destTab
        const { data: saved, error: savedErr } = await sb.from('cards')
          .select('id,set_code,collector_number,foil,language,condition')
          .eq('user_id', userId).in('set_code', setCodes)
        if (savedErr) { setError(savedErr.message); setSaving(false); return }
        if (saved?.length) {
          const savedByKey = new Map(saved.map(card => [getOwnedCardKey(card), card]))
          const placementTable = folderType === 'deck' ? 'deck_allocations' : 'folder_cards'
          const placementKey = folderType === 'deck' ? 'deck_id' : 'folder_id'
          const linkSelect = folderType === 'deck' ? 'card_id,qty' : 'card_id,qty'
          const { data: existingLinks, error: linksErr } = await sb.from(placementTable)
            .select(linkSelect)
            .eq(placementKey, folderTarget)
          if (linksErr) { setError(linksErr.message); setSaving(false); return }

          const existingLinkQty = new Map((existingLinks || []).map(link => [link.card_id, link.qty || 1]))
          const links = aggregated
            .map(card => {
              const savedCard = savedByKey.get(getOwnedCardKey(card))
              if (!savedCard) return null
              const base = {
                card_id: savedCard.id,
                qty: (existingLinkQty.get(savedCard.id) || 0) + card.qty,
              }
              return folderType === 'deck'
                ? { ...base, deck_id: folderTarget, user_id: userId }
                : { ...base, folder_id: folderTarget }
            })
            .filter(Boolean)
          if (links.length) {
            const { error: linkSaveErr } = await sb.from(placementTable)
              .upsert(links, { onConflict: `${placementKey},card_id` })
            if (linkSaveErr) { setError(linkSaveErr.message); setSaving(false); return }
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
      </div>

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
                <MenuField label="Condition" title="Condition" value={condition} options={CONDITIONS} onChange={setCondition} />
                <MenuField label="Language" title="Language" value={language} options={LANGUAGES} onChange={setLanguage} />
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
                <FoilSwitch
                  value={foil}
                  onChange={handleFoilChange}
                  disabled={!hasFoil}
                  note={selectedPrinting && !hasFoil ? <span className={styles.noFoilNote}>No foil version</span> : null}
                />
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

            {/* ── Destination: type tabs + searchable dropdown + create new ── */}
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
              <ResponsiveMenu
                title={destTab === 'list' ? 'Select Wishlist' : `Select ${destTab[0].toUpperCase()}${destTab.slice(1)}`}
                align="left"
                wrapClassName={styles.folderSearchWrap}
                panelClassName={styles.folderDropdown}
                trigger={({ open, toggle, setOpen }) => (
                  <div className={styles.folderSearchInner}>
                    <input
                      className={styles.folderSearchInput}
                      value={selectedFolder ? (folders.find(f => f.id === selectedFolder)?.name || folderSearch) : folderSearch}
                      onChange={e => { setFolderSearch(e.target.value); setSelectedFolder(null); setOpen(true) }}
                      onFocus={() => setOpen(true)}
                      placeholder={`Choose ${destTab === 'list' ? 'a wishlist' : `a ${destTab}`}…`}
                    />
                    <button className={styles.folderSearchChevron} tabIndex={-1}
                      onMouseDown={e => {
                        e.preventDefault()
                        toggle()
                      }}>
                      {open ? '▲' : '▼'}
                    </button>
                  </div>
                )}
              >
                {({ close }) => (
                  <div className={styles.folderDropdownInner}>
                    <div className={styles.folderDropdownHeader}>
                      <input
                        className={styles.folderDropdownSearch}
                        value={selectedFolder ? (folders.find(f => f.id === selectedFolder)?.name || folderSearch) : folderSearch}
                        onChange={e => { setFolderSearch(e.target.value); setSelectedFolder(null) }}
                        placeholder={`Search ${destTab === 'list' ? 'wishlists' : `${destTab}s`}…`}
                      />
                    </div>
                    <div className={styles.folderDropdownList}>
                      <button className={styles.folderDropCreate}
                        onMouseDown={() => { setCreatingFolder(true); close() }}>
                        + Create new {destTab === 'list' ? 'wishlist' : destTab}
                      </button>
                      <div className={styles.folderDropDivider} />
                      {filteredFoldersByType.length > 0
                        ? filteredFoldersByType.map(f => (
                            <button key={f.id}
                              className={`${styles.folderDropItem} ${selectedFolder === f.id ? styles.folderDropItemActive : ''}`}
                              onMouseDown={() => { setSelectedFolder(f.id); setFolderSearch(f.name); close() }}>
                              {f.name}
                            </button>
                          ))
                        : <div className={styles.folderDropEmpty}>
                            {folderSearch
                              ? `No ${destTab === 'list' ? 'wishlists' : destTab + 's'} match "${folderSearch}"`
                              : `No ${destTab === 'list' ? 'wishlists' : destTab + 's'} yet`}
                          </div>
                      }
                    </div>
                  </div>
                )}
              </ResponsiveMenu>
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
                      if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName('') }
                    }}
                  />
                  <button className={styles.marketBtn} onClick={createNewFolder} title="Create">✓</button>
                  <button className={styles.clearBtn} onClick={() => { setCreatingFolder(false); setNewFolderName('') }}>×</button>
                </div>
              )}
            </>
          </div>
        </div>
      )}

      <ErrorBox>{error}</ErrorBox>

      <div className={styles.actions}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {queue.length > 0 && (
          <Button onClick={saveAll} disabled={saving || !canSave}>
            {saving ? 'Saving…' : `Save ${totalQty} Card${totalQty !== 1 ? 's' : ''}`}
          </Button>
        )}
      </div>
    </>
  )
}

