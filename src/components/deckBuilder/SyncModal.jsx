import { useState, useEffect, useRef, useId } from 'react'
import { CloseIcon } from '../../icons'
import { sb } from '../../lib/supabase'
import { getLocalCards } from '../../lib/db'
import { buildDeckAllocationViewRows, loadLocalPlacementSnapshot } from '../../lib/deckPlacementData'
import { Select, Button, Input, useModalKeys } from '../UI'
import styles from './SyncModal.module.css'
import { isGroupFolder, normalizeBoard } from '../../lib/deckBuilderHelpers'
import { getSyncState, buildSyncDiff, getLogicalKey } from '../../lib/deckSync'
import { planDeckAllocations } from '../../lib/deckAllocationPlanner'
import {
  buildChosenAllocations,
  buildChosenPrintingSelections,
  formatOwnedPrinting,
  formatPlacementLabel,
  summarizePlacementParts,
  getDecisionCategory,
  getDecisionPreview,
  getDecisionOptionLabels,
} from '../../lib/deckSyncDecisions'
import PrintingPickerModal from './PrintingPickerModal'
import CardThumb from '../CardThumb'

export default function SyncModal({ deckId, deckCards, deckMeta, userId, isCollectionDeck, onConfirm, onClose }) {
  const [loading, setLoading] = useState(true)
  const [remoteReady, setRemoteReady] = useState(false)
  const [baseDiff, setBaseDiff] = useState(null)
  const [reviewDiff, setReviewDiff] = useState(null)
  const [resolutions, setResolutions] = useState({})
  const [folders, setFolders] = useState([])
  const [wishlists, setWishlists] = useState([])
  const [exactVersionOnly, setExactVersionOnly] = useState(true)
  const [globalDest, setGlobalDest] = useState('')
  const [wishlistId, setWishlistId] = useState('')
  const [newWishlistName, setNewWishlistName] = useState('')
  const [chosenOtherCardIds, setChosenOtherCardIds] = useState({})
  const [pickerItem, setPickerItem] = useState(null)

  const modalRef = useRef(null)
  const titleId = useId()
  // Escape to close, Tab trapped within the dialog, focus restored on close.
  useModalKeys(modalRef, { onClose })

  // Intentional: modal mounts fresh on each open - one-shot load from current props snapshot.
  useEffect(() => {
    let cancelled = false
    const applyInitialLocalDiff = async (targetDeckId, baseline) => {
      try {
        const snapshot = await loadLocalPlacementSnapshot(userId)
        if (cancelled) return
        const allocations = buildDeckAllocationViewRows(snapshot, targetDeckId)
        const builderCards = deckCards.filter(dc => normalizeBoard(dc.board) !== 'maybe')
        const allocationRowsByKey = new Map()
        for (const row of allocations || []) {
          const key = getLogicalKey(row)
          const list = allocationRowsByKey.get(key) || []
          list.push(row)
          allocationRowsByKey.set(key, list)
        }
        const localReviewDiff = buildSyncDiff({
          baseline,
          builderCards,
          collectionCards: allocations,
        })
        const withRows = list => list.map(row => ({
          ...row,
          allocationRows: allocationRowsByKey.get(row.key) || [],
        }))
        const normalizedReview = {
          builderOnly: withRows(localReviewDiff.builderOnly),
          collectionOnly: withRows(localReviewDiff.collectionOnly),
          conflicts: withRows(localReviewDiff.conflicts),
          targetDeckId,
          allocations,
        }
        setBaseDiff({ added: [], changed: [], removed: [], targetDeckId })
        setReviewDiff(normalizedReview)
        setResolutions(() => {
          const next = {}
          for (const row of normalizedReview.builderOnly) next[row.key] = 'builder'
          for (const row of normalizedReview.collectionOnly) next[row.key] = 'collection'
          for (const row of normalizedReview.conflicts) next[row.key] = 'keep'
          return next
        })
        const destinationFolders = (snapshot.folders || [])
          .filter(folder => (folder.type === 'deck' || folder.type === 'binder') && folder.id !== targetDeckId && !isGroupFolder(folder))
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
        setFolders(destinationFolders)
        setWishlists((snapshot.wishlistFolders || []).filter(folder => !isGroupFolder(folder)))
        if (destinationFolders.length === 1) setGlobalDest(destinationFolders[0].id)
        setLoading(false)
      } catch (err) {
        console.warn('[SyncModal] local diff load failed:', err)
      }
    }

    async function load() {
      const targetDeckId = isCollectionDeck ? deckId : deckMeta.linked_deck_id
      if (!targetDeckId) { setLoading(false); return }
      const baseline = getSyncState(deckMeta).last_sync_snapshot || { builder_cards: [], collection_cards: [] }
      applyInitialLocalDiff(targetDeckId, baseline)
      const [collCards, { data: allocations }, { data: foldersData }, { data: wls }] = await Promise.all([
        getLocalCards(userId),
        sb.from('deck_allocations_view').select('*').eq('deck_id', targetDeckId),
        sb.from('folders').select('id, name, type, description').eq('user_id', userId).in('type', ['deck', 'binder']).neq('id', targetDeckId).order('name'),
        sb.from('folders').select('id, name, description').eq('user_id', userId).eq('type', 'list').order('name'),
      ])
      const collMap = new Map()
      for (const row of allocations || []) collMap.set(row.card_id, row)
      const builderCards = deckCards.filter(dc => normalizeBoard(dc.board) !== 'maybe')
      const allocationMatchesDeckCard = (dc, row) => {
        if (dc.scryfall_id && row.scryfall_id) return dc.scryfall_id === row.scryfall_id && !!dc.foil === !!row.foil
        return (dc.name || '').trim().toLowerCase() === (row.name || '').trim().toLowerCase() && !!dc.foil === !!row.foil
      }

      const remainingCurrentByCardId = new Map((allocations || []).map(row => [row.card_id, row.qty || 0]))
      const preservedByCardId = new Map()
      const plannedBase = builderCards.map(dc => {
        let remainingQty = dc.qty || 0
        const preservedAllocations = []
        const matchingAllocations = (allocations || []).filter(row => allocationMatchesDeckCard(dc, row))

        for (const row of matchingAllocations) {
          if (remainingQty <= 0) break
          const available = remainingCurrentByCardId.get(row.card_id) || 0
          if (available <= 0) continue
          const usedQty = Math.min(available, remainingQty)
          preservedAllocations.push({ card_id: row.card_id, qty: usedQty })
          preservedByCardId.set(row.card_id, (preservedByCardId.get(row.card_id) || 0) + usedQty)
          remainingCurrentByCardId.set(row.card_id, available - usedQty)
          remainingQty -= usedQty
        }

        return {
          dc,
          neededQty: dc.qty || 0,
          preservedAllocations,
          remainingQty,
        }
      })

      const remainingOwnedCards = (collCards || []).map(card => ({
        ...card,
        qty: Math.max(0, (card.qty || 0) - (preservedByCardId.get(card.id) || 0)),
      }))
      const plannedRemainder = planDeckAllocations(
        plannedBase.map(item => ({ ...item.dc, qty: item.remainingQty })),
        remainingOwnedCards
      )
      const planned = plannedBase.map((base, index) => {
        const remainder = plannedRemainder[index]
        const exactAllocations = [
          ...base.preservedAllocations,
          ...(remainder?.exactAllocations || []),
        ]
        const otherAllocations = remainder?.otherAllocations || []
        const allocationsForDeck = [...exactAllocations, ...otherAllocations]
        const exactQty = exactAllocations.reduce((sum, row) => sum + row.qty, 0)
        const otherQty = otherAllocations.reduce((sum, row) => sum + row.qty, 0)
        const totalAdd = allocationsForDeck.reduce((sum, row) => sum + row.qty, 0)
        return {
          dc: base.dc,
          neededQty: base.neededQty,
          addExact: exactQty,
          addOther: otherQty,
          totalAdd,
          missingQty: Math.max(0, base.neededQty - totalAdd),
          exactAllocations,
          otherAllocations,
          exactCandidates: remainder?.exactCandidates || [],
          otherCandidates: remainder?.otherCandidates || [],
          allocations: allocationsForDeck,
        }
      })

      const folderById = new Map((foldersData || []).map(folder => [folder.id, folder]))
      const allocationCardIds = [...new Set(planned.flatMap(item => (item.allocations || []).map(row => row.card_id).filter(Boolean)))]
      const sourceRowsByCardId = new Map()
      if (allocationCardIds.length > 0) {
        const [{ data: folderPlacements, error: folderPlacementErr }, { data: deckPlacements, error: deckPlacementErr }] = await Promise.all([
          sb.from('folder_cards')
            .select('id, folder_id, card_id, qty')
            .in('card_id', allocationCardIds),
          sb.from('deck_allocations')
            .select('id, deck_id, card_id, qty')
            .in('card_id', allocationCardIds)
            .neq('deck_id', targetDeckId),
        ])
        if (folderPlacementErr) throw folderPlacementErr
        if (deckPlacementErr) throw deckPlacementErr

        for (const row of folderPlacements || []) {
          const folder = folderById.get(row.folder_id)
          const list = sourceRowsByCardId.get(row.card_id) || []
          list.push({
            id: row.id,
            rank: 0,
            qty: row.qty || 0,
            name: folder?.name || 'Unknown binder',
            type: folder?.type || 'binder',
          })
          sourceRowsByCardId.set(row.card_id, list)
        }
        for (const row of deckPlacements || []) {
          const folder = folderById.get(row.deck_id)
          const list = sourceRowsByCardId.get(row.card_id) || []
          list.push({
            id: row.id,
            rank: 1,
            qty: row.qty || 0,
            name: folder?.name || 'Unknown deck',
            type: folder?.type || 'deck',
          })
          sourceRowsByCardId.set(row.card_id, list)
        }
        for (const [cardId, rows] of sourceRowsByCardId) {
          sourceRowsByCardId.set(cardId, rows.sort((a, b) => a.rank - b.rank || (a.qty || 0) - (b.qty || 0)))
        }
      }

      const sourceCursorByCardId = new Map([...sourceRowsByCardId.entries()].map(([cardId, rows]) => [
        cardId,
        rows.map(row => ({ ...row })),
      ]))
      const takeSourceParts = (cardId, qty) => {
        const rows = sourceCursorByCardId.get(cardId) || []
        const parts = []
        let remaining = qty || 0
        for (const row of rows) {
          if (remaining <= 0) break
          if ((row.qty || 0) <= 0) continue
          const usedQty = Math.min(row.qty || 0, remaining)
          parts.push({ type: row.type, name: row.name, qty: usedQty })
          row.qty = (row.qty || 0) - usedQty
          remaining -= usedQty
        }
        return parts
      }
      for (const item of planned) {
        const annotate = row => ({
          ...row,
          sourceParts: takeSourceParts(row.card_id, row.qty),
        })
        item.exactAllocations = (item.exactAllocations || []).map(annotate)
        item.otherAllocations = (item.otherAllocations || []).map(annotate)
        item.allocations = [...item.exactAllocations, ...item.otherAllocations]
      }

      const desiredByCardId = new Map()
      for (const item of planned) {
        for (const row of item.allocations) {
          desiredByCardId.set(row.card_id, (desiredByCardId.get(row.card_id) || 0) + row.qty)
        }
      }
      const added = []
      const changed = []
      for (const item of planned) {
        const newExactAllocations = item.exactAllocations.filter(row => !collMap.has(row.card_id))
        const newOtherAllocations = item.otherAllocations.filter(row => !collMap.has(row.card_id))
        const newAllocations = [...newExactAllocations, ...newOtherAllocations]
        const addCandidate = {
          ...item,
          exactAllocations: newExactAllocations,
          otherAllocations: newOtherAllocations,
          otherCandidates: item.otherCandidates || [],
          allocations: newAllocations,
          addExact: newExactAllocations.reduce((sum, row) => sum + row.qty, 0),
          addOther: newOtherAllocations.reduce((sum, row) => sum + row.qty, 0),
          totalAdd: newAllocations.reduce((sum, row) => sum + row.qty, 0),
          owned: item.totalAdd > 0,
        }

        if (addCandidate.totalAdd > 0 || item.missingQty > 0) added.push({ ...addCandidate })
        for (const row of item.allocations) {
          const desiredQty = desiredByCardId.get(row.card_id)
          const existing = collMap.get(row.card_id)
          if (existing && existing.qty !== desiredQty && !changed.some(c => c.cardId === row.card_id)) {
            changed.push({ dc: item.dc, cardId: row.card_id, allocRow: existing, oldQty: existing.qty, newQty: desiredQty })
          }
        }
      }
      const removed = []
      for (const [cardId, fcRow] of collMap) {
        if (!desiredByCardId.has(cardId)) removed.push({ cardId, allocRow: fcRow, name: fcRow.name || '?' })
      }
      setBaseDiff({ added, changed, removed, targetDeckId })

      const allocationRowsByKey = new Map()
      for (const row of allocations || []) {
        const key = getLogicalKey(row)
        const list = allocationRowsByKey.get(key) || []
        list.push(row)
        allocationRowsByKey.set(key, list)
      }

      const nextReviewDiff = buildSyncDiff({
        baseline,
        builderCards: deckCards.filter(dc => normalizeBoard(dc.board) !== 'maybe'),
        collectionCards: allocations || [],
      })
      const withRows = list => list.map(row => ({
        ...row,
        allocationRows: allocationRowsByKey.get(row.key) || [],
      }))
      const normalizedReview = {
        builderOnly: withRows(nextReviewDiff.builderOnly),
        collectionOnly: withRows(nextReviewDiff.collectionOnly),
        conflicts: withRows(nextReviewDiff.conflicts),
        targetDeckId,
        allocations: allocations || [],
      }
      setReviewDiff(normalizedReview)
      setResolutions(() => {
        const next = {}
        for (const row of normalizedReview.builderOnly) next[row.key] = 'builder'
        for (const row of normalizedReview.collectionOnly) next[row.key] = 'collection'
        for (const row of normalizedReview.conflicts) next[row.key] = 'keep'
        return next
      })
      const destinationFolders = (foldersData || []).filter(folder => !isGroupFolder(folder))
      setFolders(destinationFolders)
      setWishlists((wls || []).filter(folder => !isGroupFolder(folder)))
      if (destinationFolders.length === 1) setGlobalDest(destinationFolders[0].id)
      setRemoteReady(true)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Token-based override passed to the portal Select primitive (className can't
  // reach its internals; DESIGN.md allows inline token values on primitives).
  const selectStyle = { background:'var(--bg3)', border:'1px solid var(--s-border2)', borderRadius:'var(--radius-xs)', padding:'6px 9px', color:'var(--text)', fontSize:'0.82rem', width:'100%' }

  if (loading) return (
    <div className={styles.overlay}>
      <div ref={modalRef} className={styles.panel} role="dialog" aria-modal="true" aria-label="Comparing deck with collection">
        Comparing deck with collection…
      </div>
    </div>
  )

  const diff = (() => {
    if (!baseDiff) return null
    const normalizedAdded = (baseDiff.added || []).map(item => {
      const chosen = buildChosenAllocations(item, exactVersionOnly, chosenOtherCardIds[item.dc.id])
      return { ...item, ...chosen }
    })
    return { ...baseDiff, added: normalizedAdded }
  })()

  const { added = [], changed = [], removed = [] } = diff || {}
  const builderOnly = reviewDiff?.builderOnly || []
  const collectionOnly = reviewDiff?.collectionOnly || []
  const conflicts = reviewDiff?.conflicts || []
  const reviewRows = [...builderOnly, ...collectionOnly, ...conflicts]
  const selectedBuilderKeys = new Set(reviewRows.filter(row => resolutions[row.key] === 'builder').map(row => row.key))
  const selectedCollectionRows = reviewRows.filter(row => resolutions[row.key] === 'collection')
  const unresolvedRows = reviewRows.filter(row => (resolutions[row.key] || 'keep') === 'keep')
  const ownedAdded = added.filter(i => selectedBuilderKeys.has(getLogicalKey(i.dc)) && i.totalAdd > 0)
  const unownedAdded = added.filter(i => selectedBuilderKeys.has(getLogicalKey(i.dc)) && i.missingQty > 0)
  const changedSelected = changed.filter(i => selectedBuilderKeys.has(getLogicalKey(i.dc)))
  const removedSelected = removed.filter(r => selectedBuilderKeys.has(getLogicalKey(r.allocRow)))
  const hasChanges = reviewRows.length > 0
  const movedOwnedRows = [
    ...changedSelected
      .filter(i => i.newQty < i.oldQty)
      .map(i => ({
        key: `changed:${i.allocRow.id}`,
        name: i.dc.name,
        scryfall_id: i.dc.scryfall_id || i.allocRow?.scryfall_id || null,
        qty: i.oldQty - i.newQty,
      })),
    ...removedSelected.map(r => ({
      key: `removed:${r.allocRow.id}`,
      name: r.name,
      scryfall_id: r.allocRow?.scryfall_id || null,
      qty: r.allocRow.qty || 0,
    })),
  ]
  const builderUpdateRows = selectedCollectionRows.filter(row => (row.collectionQty || 0) !== (row.builderQty || 0))
  const commanderRiskRows = [
    ...builderUpdateRows.filter(row => !!row.builder?.is_commander && !(row.collectionQty > 0)),
    ...unresolvedRows.filter(row => !!row.builder?.is_commander),
  ]
  const selectedMoveTarget = folders.find(folder => folder.id === globalDest) || null
  const canConfirm = remoteReady
    && (movedOwnedRows.length === 0 || !!globalDest)
    && (wishlistId !== 'new' || !!newWishlistName.trim())
  const addedByKey = new Map(added.map(item => [getLogicalKey(item.dc), item]))
  const changedByKey = new Map(changed.map(item => [getLogicalKey(item.dc), item]))
  const removedByKey = new Map(removed.map(item => [getLogicalKey(item.allocRow), item]))
  const increaseRows = changedSelected.filter(item => item.newQty > item.oldQty)
  const collectionImpactCount = ownedAdded.length + changedSelected.length + removedSelected.length
  const builderImpactCount = builderUpdateRows.length
  const wishlistCount = wishlistId ? unownedAdded.length : 0
  const actionCount = collectionImpactCount + builderImpactCount + unresolvedRows.length + wishlistCount
  const decisionRows = reviewRows.map(row => ({
    ...row,
    resolution: resolutions[row.key] || 'keep',
    category: getDecisionCategory(row, builderOnly, collectionOnly),
    summary: getDecisionPreview(row, resolutions[row.key] || 'keep', {
      addedByKey,
      changedByKey,
      removedByKey,
      selectedMoveTarget,
    }),
    printing: formatOwnedPrinting(row.builder || row.collection),
  }))
  const collectionDeckLabel = `Collection Deck${deckMeta?.name ? `: ${deckMeta.name}` : ''}`
  const moveInCopyCount = ownedAdded.reduce((sum, item) => sum + (item.totalAdd || 0), 0)
    + increaseRows.reduce((sum, item) => sum + Math.max(0, (item.newQty || 0) - (item.oldQty || 0)), 0)
  const moveOutCopyCount = movedOwnedRows.reduce((sum, row) => sum + (row.qty || 0), 0)
  const missingCopyCount = unownedAdded.reduce((sum, item) => sum + (item.missingQty || 0), 0)

  if (!hasChanges && !remoteReady) return (
    <div className={styles.overlay}>
      <div ref={modalRef} className={styles.panel} role="dialog" aria-modal="true" aria-label="Refreshing collection placements">
        Refreshing collection placements…
      </div>
    </div>
  )

  if (!hasChanges) return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div ref={modalRef} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <span id={titleId} className={styles.panelTitle}>Sync collection deck</span>
        <p className={styles.panelText}>Your builder list and the collection deck already match — nothing to sync.</p>
        <div className={styles.panelActions}>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div ref={modalRef} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className={styles.header}>
          <div style={{ minWidth: 0 }}>
            <div id={titleId} className={styles.title}>Sync collection deck</div>
            <div className={styles.subtitle}>Your Deck Builder list and {collectionDeckLabel} have drifted apart. For each card below, choose which side to update — move owned copies to match the builder, change the builder to match your collection, or leave it as-is.</div>
          </div>
          <button onClick={onClose} className={styles.closeBtn} aria-label="Close"><CloseIcon size={13} /></button>
        </div>

        <div className={styles.body}>
          {(moveInCopyCount > 0 || moveOutCopyCount > 0 || missingCopyCount > 0 || builderImpactCount > 0) ? (
            <div className={styles.summaryBar}>
              {moveInCopyCount > 0 && (
                <span className={`${styles.chip} ${styles.chipInto}`}><span className={styles.chipNum}>{moveInCopyCount}</span><span className={styles.chipLabel}>into deck</span></span>
              )}
              {moveOutCopyCount > 0 && (
                <span className={`${styles.chip} ${styles.chipOut}`}><span className={styles.chipNum}>{moveOutCopyCount}</span><span className={styles.chipLabel}>out of deck</span></span>
              )}
              {missingCopyCount > 0 && (
                <span className={`${styles.chip} ${styles.chipMissing}`}><span className={styles.chipNum}>{missingCopyCount}</span><span className={styles.chipLabel}>missing</span></span>
              )}
              {builderImpactCount > 0 && (
                <span className={styles.chip}><span className={styles.chipNum}>{builderImpactCount}</span><span className={styles.chipLabel}>list only</span></span>
              )}
            </div>
          ) : (
            <div className={styles.emptyNote}>No changes selected yet — pick an action for the cards below.</div>
          )}

          {commanderRiskRows.length > 0 && (
            <div className={styles.warn}>
              {commanderRiskRows.map(row => (
                <div key={`commander-${row.key}`} className={styles.warnItem}>
                  <b>{row.builder?.name || row.collection?.name || 'Card'}</b> — this choice may remove or leave unresolved commander status in the builder.
                </div>
              ))}
            </div>
          )}

          <div className={styles.section}>
            <div className={styles.sectionHead}>
              <div className={styles.sectionLabel}>Cards to resolve</div>
              <label className={styles.toggle}>
                <input type="checkbox" checked={exactVersionOnly} onChange={e => setExactVersionOnly(e.target.checked)} />
                Exact printing only
              </label>
            </div>
            {!exactVersionOnly && (
              <div className={styles.sectionHint}>Any owned printing can be pulled in when the exact one isn’t available (ManaBox-style).</div>
            )}
            <div className={styles.decisionList}>
              {decisionRows.map(row => {
                const name = row.builder?.name || row.collection?.name || 'Card'
                const tag = row.category === 'builderOnly'
                  ? 'In builder only'
                  : row.category === 'collectionOnly'
                    ? 'In deck only'
                    : 'Qty differs'
                const optionLabels = getDecisionOptionLabels(row, { addedByKey })
                const addItem = row.resolution === 'builder' ? addedByKey.get(row.key) : null
                const showMoveIn = addItem && addItem.totalAdd > 0 && !!addItem.allocations?.length
                const canPickPrinting = addItem && !exactVersionOnly && (addItem.otherCandidates?.length || 0) > 1
                return (
                  <div key={row.key} className={styles.decisionRow}>
                    <CardThumb scryfallId={row.builder?.scryfall_id || row.collection?.scryfall_id} name={name} size={44} />
                    <div className={styles.rowMain}>
                      <div className={styles.rowTitleLine}>
                        <span className={styles.rowName}>{name}</span>
                        {row.builder?.is_commander && <span className={styles.cmdPill}>Commander</span>}
                        <span className={styles.typeTag}>{tag}</span>
                      </div>
                      <div className={styles.counts}>
                        <span className={styles.countCell}><span className={styles.countLabel}>Builder</span><span className={styles.countVal}>{row.builderQty ?? 0}</span></span>
                        <span className={styles.countArrow} aria-hidden="true">⇄</span>
                        <span className={styles.countCell}><span className={styles.countLabel}>Deck</span><span className={styles.countVal}>{row.collectionQty ?? 0}</span></span>
                        {row.printing && <span className={styles.countLabel}>· {row.printing}</span>}
                      </div>
                      <div className={`${styles.consequence} ${row.resolution === 'keep' ? styles.consequenceKeep : ''}`}>{row.summary}</div>
                      {showMoveIn && (
                        <div className={styles.moveDetail}>
                          From <b>{summarizePlacementParts(addItem.allocations.flatMap(r => r.sourceParts || []))}</b> · {addItem.allocations.map(r => `${r.qty}× ${formatOwnedPrinting(r)}`).join(', ')}
                        </div>
                      )}
                    </div>
                    {/* Actions column (right). Wrapper controls the width — Select
                        is a portal component and doesn't forward className to its
                        box. portal: the modal body scrolls (overflow hidden), so
                        an inline panel clips. DESIGN.md §6. */}
                    <div className={styles.rowActions}>
                      <Select
                        value={row.resolution}
                        onChange={e => setResolutions(prev => ({ ...prev, [row.key]: e.target.value }))}
                        style={selectStyle}
                        title="Action for this card"
                        portal
                      >
                        <option value="builder">{optionLabels.builder}</option>
                        <option value="collection">{optionLabels.collection}</option>
                        <option value="keep">{optionLabels.keep}</option>
                      </Select>
                      {canPickPrinting && (
                        <Button variant="secondary" size="sm" block onClick={() => setPickerItem(addItem)}>
                          Choose printing
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {movedOwnedRows.length > 0 && (
            <div className={`${styles.inputBlock} ${styles.inputBlockRequired}`}>
              <div className={styles.inputHead}>
                <div className={styles.sectionLabel}>Where do cards leaving the deck go? <span className={styles.reqStar}>*</span></div>
                <div className={styles.sectionHint}>{moveOutCopyCount} {moveOutCopyCount === 1 ? 'copy moves' : 'copies move'} out of {collectionDeckLabel}. Pick a binder or deck to hold them.</div>
              </div>
              <div className={styles.inputRow}>
                <Select value={globalDest} onChange={e => setGlobalDest(e.target.value)} style={selectStyle} title="Select destination" portal searchable>
                  <option value="">Select binder or deck…</option>
                  {folders.map(folder => (
                    <option key={folder.id} value={folder.id}>
                      {folder.type === 'binder' ? 'Binder' : 'Deck'}: {folder.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className={styles.movingList}>
                {movedOwnedRows.map(row => (
                  <div key={row.key} className={styles.movingRow}>
                    <CardThumb scryfallId={row.scryfall_id} name={row.name} size={28} />
                    <span className={styles.movingName}>{row.name}</span>
                    <span className={styles.movingQty}>{row.qty}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unownedAdded.length > 0 && (
            <div className={styles.inputBlock}>
              <div className={styles.inputHead}>
                <div className={styles.sectionLabel}>Missing cards</div>
                <div className={styles.sectionHint}>{missingCopyCount} {missingCopyCount === 1 ? 'copy isn’t' : 'copies aren’t'} owned, so they stay out of the deck. Add them to a wishlist?</div>
              </div>
              <div className={styles.movingList}>
                {unownedAdded.map(item => (
                  <div key={item.dc.id} className={styles.movingRow}>
                    <CardThumb scryfallId={item.dc.scryfall_id} name={item.dc.name} size={28} />
                    <span className={styles.movingName}>{item.dc.name}</span>
                    <span className={styles.movingQty}>{item.missingQty || item.dc.qty || 1}×</span>
                  </div>
                ))}
              </div>
              <div className={styles.inputRow}>
                <Select value={wishlistId} onChange={e => setWishlistId(e.target.value)} style={selectStyle} title="Select wishlist" portal>
                  <option value="">Skip</option>
                  {wishlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
                  <option value="new">+ Create new wishlist…</option>
                </Select>
                {wishlistId === 'new' && (
                  <Input
                    autoFocus
                    value={newWishlistName}
                    onChange={e => setNewWishlistName(e.target.value)}
                    placeholder="Wishlist name…"
                    maxLength={100}
                  />
                )}
              </div>
            </div>
          )}
        </div>

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

        <div className={styles.footer}>
          <span className={`${styles.footerStatus} ${(remoteReady && movedOwnedRows.length > 0 && !selectedMoveTarget) ? styles.footerStatusWarn : ''}`}>
            {!remoteReady
              ? 'Refreshing collection placements before decisions can be applied.'
              : movedOwnedRows.length > 0
              ? (selectedMoveTarget ? `Excess copies move to ${formatPlacementLabel(selectedMoveTarget)}.` : 'Choose where cards leaving the deck should go.')
              : ''}
          </span>
          <div className={styles.footerActions}>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!canConfirm}
              onClick={() => canConfirm && onConfirm({
                diff: reviewDiff,
                resolutions,
                builderPlan: {
                  addItems: ownedAdded,
                  missingItems: unownedAdded,
                  changedItems: changedSelected,
                  removedItems: removedSelected,
                  printingSelections: buildChosenPrintingSelections(added.filter(i => selectedBuilderKeys.has(getLogicalKey(i.dc))), chosenOtherCardIds),
                  moveDestinationId: globalDest || null,
                  wishlistId: wishlistId === 'new' ? null : (wishlistId || null),
                  wishlistName: wishlistId === 'new' ? newWishlistName.trim() : null,
                },
                collectionSelections: selectedCollectionRows,
              })}
            >
              {`Apply ${actionCount} decision${actionCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
