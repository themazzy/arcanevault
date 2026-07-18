import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { CheckIcon, InfoIcon, WarningIcon, AddIcon } from '../../icons'
import { Modal, Select } from '../UI'
import { BASIC_LANDS, CAN_HOVER } from '../../lib/deckBuilderConstants'
import { lastInputWasTouch } from '../../lib/inputType'
import { isGroupFolder, normalizeCardName, placementFilterNames } from '../../lib/deckBuilderHelpers'
import { buildChosenAllocations, buildChosenPrintingSelections } from '../../lib/deckSyncDecisions'
import { planDeckAllocations } from '../../lib/deckAllocationPlanner'
import { loadLocalPlacementSnapshot, refreshRemotePlacementSnapshot } from '../../lib/deckPlacementData'
import PrintingPickerModal from './PrintingPickerModal'
import { FloatingPreview } from './FloatingPreview'
import styles from './MakeDeckModal.module.css'

const MISSING_ACTIONS = [
  ['skip',     'Skip missing cards',       'Cards not found in your collection won\'t be added'],
  ['add',      'Add missing to collection', 'Creates new owned copies for cards you don\'t have, placed directly in this deck'],
  ['wishlist', 'Add missing to wishlist',   'Save missing cards to a wishlist for future tracking'],
  ['new',      'Add all as new copies',     'Skip cards you already own — build this deck entirely from freshly added copies'],
]

// ── Make Deck row ─────────────────────────────────────────────────────────────
function MakeDeckRow({ item, addAllAsNew, onHoverEnter, onHoverMove, onHoverLeave }) {
  const { dc, neededQty, addExact, addOther, totalAdd, missingQty } = item
  const img = dc.image_uri
  const hoverableProps = CAN_HOVER && !lastInputWasTouch && img
    ? {
        onMouseEnter: e => onHoverEnter?.(img, e),
        onMouseMove: e => onHoverMove?.(e),
        onMouseLeave: () => onHoverLeave?.(),
      }
    : {}
  let statusClass, statusGlyph, statusDetail
  if (addAllAsNew) {
    statusClass = styles.statusNew; statusGlyph = <AddIcon size={13} />; statusDetail = `${neededQty}x new`
  } else if (totalAdd === 0) {
    statusClass = styles.statusMiss; statusGlyph = <WarningIcon size={13} />; statusDetail = 'not owned'
  } else if (missingQty === 0 && addOther === 0) {
    statusClass = styles.statusOk; statusGlyph = <CheckIcon size={13} />; statusDetail = `${totalAdd}x exact`
  } else {
    statusClass = styles.statusAlt; statusGlyph = <InfoIcon size={13} />
    const parts = []
    if (addExact > 0) parts.push(`${addExact}x exact`)
    if (addOther > 0) parts.push(`${addOther}x other print`)
    if (missingQty > 0) parts.push(`${missingQty}x missing`)
    statusDetail = parts.join(', ')
  }
  const allocationDetail = (item.allocations || [])
    .map(row => {
      const print = row.set_code && row.collector_number ? `${String(row.set_code).toUpperCase()} #${row.collector_number}` : 'owned print'
      return `${row.qty}x ${print}${row.foil ? ' foil' : ''}`
    })
    .join(', ')
  return (
    <div className={styles.row}>
      {img
        ? <img src={img} alt="" className={styles.rowThumb} {...hoverableProps} />
        : <div className={styles.rowThumbPlaceholder} />
      }
      <div className={styles.rowInfo}>
        <span className={styles.rowName}>
          {neededQty > 1 ? `${neededQty}x ` : ''}{dc.name}
        </span>
        {allocationDetail && (
          <span className={styles.rowSub}>Uses: {allocationDetail}</span>
        )}
      </div>
      <div className={`${styles.rowStatus} ${statusClass}`}>
        {statusGlyph}<span>{statusDetail}</span>
      </div>
    </div>
  )
}

export default function MakeDeckModal({ deckCards, userId, onConfirm, onClose }) {
  const [loading, setLoading] = useState(true)
  const [remoteReady, setRemoteReady] = useState(false)
  const [refreshError, setRefreshError] = useState(null)
  const [ownedCardsForPlanning, setOwnedCardsForPlanning] = useState([])
  const [binderQtyByCardId, setBinderQtyByCardId] = useState(new Map())
  const [deckAllocatedQtyByCardId, setDeckAllocatedQtyByCardId] = useState(new Map())
  const [skipBasicLands, setSkipBasicLands] = useState(true)
  const [exactVersionOnly, setExactVersionOnly] = useState(true)
  const [pullFromOtherDecks, setPullFromOtherDecks] = useState(false)
  const [wishlists, setWishlists] = useState([])
  const [missingAction, setMissingAction] = useState('skip') // 'skip' | 'add' | 'wishlist' | 'new'
  const [selectedWishlistId, setSelectedWishlistId] = useState('')
  const [newWishlistName, setNewWishlistName] = useState('')
  const [chosenOtherCardIds, setChosenOtherCardIds] = useState({})
  const [pickerItem, setPickerItem] = useState(null)

  // 'new' bypasses ownership matching entirely (see planningOwnedCards below) —
  // it's one of the missing-card strategies, just one that makes every card missing.
  const addAllAsNew = missingAction === 'new'

  const floatingPreviewRef = useRef(null)
  const handleRowHoverEnter = useCallback((uri, e) => {
    floatingPreviewRef.current?.setPos(e.clientX, e.clientY)
    floatingPreviewRef.current?.setImages(uri ? [uri] : [])
  }, [])
  const handleRowHoverMove = useCallback((e) => {
    floatingPreviewRef.current?.setPos(e.clientX, e.clientY)
  }, [])
  const handleRowHoverLeave = useCallback(() => {
    floatingPreviewRef.current?.setImages([])
  }, [])

  // Intentional: modal mounts fresh on each open - one-shot load from current props snapshot.
  useEffect(() => {
    let cancelled = false
    const deckNameSet = new Set((deckCards || []).map(card => normalizeCardName(card.name)).filter(Boolean))
    const deckScryfallIds = new Set((deckCards || []).map(card => card.scryfall_id).filter(Boolean))
    // Loader filters need raw casing — the remote fetch matches names
    // case-sensitively, so lowercased names would mark every card whose exact
    // printing isn't in the deck as "not owned".
    const filterNames = placementFilterNames(deckCards)
    const applySnapshot = (snapshot) => {
      const planningCards = (snapshot.cards || []).filter(card =>
        deckNameSet.has(normalizeCardName(card.name)) ||
        (card.scryfall_id && deckScryfallIds.has(card.scryfall_id))
      )
      setOwnedCardsForPlanning(planningCards)
      setBinderQtyByCardId(snapshot.binderQtyByCardId)
      setDeckAllocatedQtyByCardId(snapshot.deckQtyByCardId)
      setWishlists((snapshot.wishlistFolders || []).filter(folder => !isGroupFolder(folder)))
    }

    async function load() {
      try {
        const localSnapshot = await loadLocalPlacementSnapshot(userId, {
          names: filterNames,
          scryfallIds: [...deckScryfallIds],
        })
        if (cancelled) return
        applySnapshot(localSnapshot)
        setLoading(false)

        try {
          const remoteSnapshot = await refreshRemotePlacementSnapshot(userId, {
            names: filterNames,
            scryfallIds: [...deckScryfallIds],
          })
          if (cancelled) return
          applySnapshot(remoteSnapshot)
          setRemoteReady(true)
        } catch (err) {
          if (cancelled) return
          console.warn('[MakeDeckModal] placement refresh failed:', err)
          setRefreshError('Could not refresh collection placements.')
        }
      } catch (err) {
        if (cancelled) return
        console.warn('[MakeDeckModal] local placement load failed:', err)
        setLoading(false)
        setRefreshError('Could not load collection placements.')
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // "All New Copies" bypasses ownership matching entirely — planDeckAllocations
  // then sees no owned cards, so every deck card comes back as missingQty and
  // goes through the same skip/add/wishlist choice as an ordinary missing card.
  const planningOwnedCards = useMemo(() => {
    if (addAllAsNew) return []
    return ownedCardsForPlanning
      .map(card => {
        const binderQty = binderQtyByCardId.get(card.id) || 0
        const deckQty = deckAllocatedQtyByCardId.get(card.id) || 0
        const placementQty = binderQty + (pullFromOtherDecks ? deckQty : 0)
        return {
          ...card,
          qty: Math.min(card.qty || 0, placementQty),
        }
      })
      .filter(card => (card.qty || 0) > 0)
  }, [addAllAsNew, ownedCardsForPlanning, binderQtyByCardId, deckAllocatedQtyByCardId, pullFromOtherDecks])

  const previewItems = useMemo(
    () => planDeckAllocations(deckCards, planningOwnedCards),
    [deckCards, planningOwnedCards]
  )

  const filtered = previewItems
    .filter(i => !skipBasicLands || !BASIC_LANDS.has(i.dc.name))
    .map(i => {
      const chosen = buildChosenAllocations(i, exactVersionOnly, chosenOtherCardIds[i.dc.id])
      return {
        ...i,
        ...chosen,
      }
    })
  const addItems      = filtered.filter(i => i.totalAdd > 0)
  const missingItems  = filtered.filter(i => i.missingQty > 0)
  const exactCount    = filtered.filter(i => i.missingQty === 0 && i.addOther === 0 && i.totalAdd > 0).length
  const fallbackCount = filtered.filter(i => i.addOther > 0).length
  const missingCount  = missingItems.length
  const wishlistReady = missingCount === 0
    || missingAction === 'skip'
    || missingAction === 'add'
    || missingAction === 'new'
    || (selectedWishlistId ? (selectedWishlistId === 'new' ? !!newWishlistName.trim() : true) : true)
  const canConfirm    = remoteReady && (addItems.length > 0 || missingAction === 'add' || missingAction === 'new') && wishlistReady

  return (
    <>
      <Modal onClose={onClose} className={styles.modal} contentClassName={styles.modalContent}>
        <div className={styles.header}>
          <span className={styles.title}>Make Collection Deck</span>
        </div>
        {loading ? (
          <div className={styles.loading}>Checking your collection...</div>
        ) : (
          <>
            <div className={styles.body}>
              <div className={styles.sidebar}>
                <div className={styles.options}>
                  {[
                    [skipBasicLands,    setSkipBasicLands,    'Skip basic lands',                          'Island, Plains, Forest, Mountain, Swamp', false],
                    [exactVersionOnly,  setExactVersionOnly,  'Use specified version only',                'Won\'t substitute a different printing', addAllAsNew],
                    [!pullFromOtherDecks, v => setPullFromOtherDecks(!v), 'Skip cards already in another deck', 'Avoids pulling the same copy into two decks', addAllAsNew],
                  ].map(([val, set, label, sub, disabled]) => (
                    <label key={label} className={`${styles.optionRow}${disabled ? ' ' + styles.optionRowDisabled : ''}`}>
                      <input type="checkbox" className={styles.optionCheckbox} checked={val} disabled={disabled} onChange={e => set(e.target.checked)} />
                      <span>
                        <div className={styles.optionLabel}>{label}</div>
                        <div className={styles.optionSub}>{sub}</div>
                      </span>
                    </label>
                  ))}
                </div>

                {addAllAsNew ? (
                  <div className={styles.statusLine}>
                    <AddIcon size={13} /> {missingCount} card{missingCount !== 1 ? 's' : ''} not yet in your collection
                  </div>
                ) : (
                  <div className={styles.statGrid}>
                    <div className={styles.statCard}>
                      <div className={`${styles.statValue} ${styles.statValueOk}`}>{exactCount}</div>
                      <div className={styles.statLabel}>Exact</div>
                    </div>
                    <div className={styles.statCard}>
                      <div className={styles.statValue}>{fallbackCount}</div>
                      <div className={styles.statLabel}>Alt Print</div>
                    </div>
                    <div className={styles.statCard}>
                      <div className={`${styles.statValue}${missingCount > 0 ? ' ' + styles.statValueBad : ''}`}>{missingCount}</div>
                      <div className={styles.statLabel}>Missing</div>
                    </div>
                  </div>
                )}

                <div className={styles.missingSection}>
                  <div className={styles.missingIntro}>
                    {missingCount > 0
                      ? `${missingItems.reduce((s, i) => s + i.missingQty, 0)} card${missingCount !== 1 ? 's' : ''} not matched from your collection:`
                      : 'All cards matched from your collection.'}
                  </div>
                  <div className={styles.choices}>
                    {MISSING_ACTIONS.map(([value, label, sub]) => (
                      <label key={value} className={`${styles.choiceRow}${missingAction === value ? ' ' + styles.choiceRowActive : ''}`}>
                        <input type="radio" name="missingAction" className={styles.choiceInput} value={value} checked={missingAction === value}
                          onChange={() => setMissingAction(value)} />
                        <span>
                          <div className={styles.choiceLabel}>{label}</div>
                          <div className={styles.choiceSub}>{sub}</div>
                        </span>
                      </label>
                    ))}
                    {missingAction === 'wishlist' && (
                      <div className={styles.wishlistRow}>
                        {/* portal: this sits inside .sidebar (overflow-y:auto)
                            within .modal (overflow:hidden), so an inline panel
                            gets clipped. See DESIGN.md §6. */}
                        <Select value={selectedWishlistId} onChange={e => setSelectedWishlistId(e.target.value)}
                          portal
                          menuDirection="up"
                          className={styles.wishlistSelect}
                          title="Select wishlist">
                          <option value="">Choose wishlist</option>
                          {wishlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
                          <option value="new">+ Create new wishlist...</option>
                        </Select>
                        {selectedWishlistId === 'new' && (
                          <input autoFocus placeholder="Wishlist name..." className={styles.wishlistInput} value={newWishlistName} onChange={e => setNewWishlistName(e.target.value)}
                            maxLength={100} />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className={styles.main}>
                <div className={styles.rowsList}>
                  {filtered.length === 0
                    ? <div className={styles.empty}>No cards to add.</div>
                    : filtered.map(item => (
                      <div key={item.dc.id}>
                        <MakeDeckRow
                          item={item}
                          addAllAsNew={addAllAsNew}
                          onHoverEnter={handleRowHoverEnter}
                          onHoverMove={handleRowHoverMove}
                          onHoverLeave={handleRowHoverLeave}
                        />
                        {!exactVersionOnly && (item.otherCandidates?.length || 0) > 1 && item.totalAdd > 0 && (
                          <div className={styles.rowActionWrap}>
                            <button type="button" className={styles.rowActionBtn} onClick={() => setPickerItem(item)}>
                              Choose owned printing
                            </button>
                          </div>
                        )}
                      </div>
                    ))
                  }
                </div>
              </div>
            </div>

            <div className={styles.footer}>
              <div className={`${styles.footerNote}${refreshError ? ' ' + styles.footerNoteError : ''}`}>
                {!remoteReady ? (refreshError || 'Refreshing collection placements...') : ''}
              </div>
              <button type="button" className={styles.btn} onClick={onClose}>Cancel</button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={() => onConfirm({
                  addItems,
                  missingItems,
                  printingSelections: buildChosenPrintingSelections(filtered, chosenOtherCardIds),
                  addMissing: missingAction === 'add' || missingAction === 'new',
                  wishlistId: missingAction === 'wishlist' && selectedWishlistId !== 'new' ? (selectedWishlistId || null) : null,
                  wishlistName: missingAction === 'wishlist' && selectedWishlistId === 'new' ? newWishlistName.trim() : null,
                })}
                disabled={!canConfirm}
              >
                Create Deck ({addItems.reduce((s, i) => s + i.totalAdd, 0) + ((missingAction === 'add' || missingAction === 'new') ? missingItems.reduce((s, i) => s + i.missingQty, 0) : 0)} cards)
              </button>
            </div>
          </>
        )}
      </Modal>
      {pickerItem && (
        <PrintingPickerModal
          cardName={pickerItem.dc.name}
          options={pickerItem.otherCandidates || []}
          selectedCardId={chosenOtherCardIds[pickerItem.dc.id] || ''}
          onSelect={(cardId) => {
            setChosenOtherCardIds(prev => ({ ...prev, [pickerItem.dc.id]: cardId }))
            setPickerItem(null)
          }}
          onClose={() => setPickerItem(null)}
        />
      )}
      <FloatingPreview ref={floatingPreviewRef} />
    </>
  )
}
