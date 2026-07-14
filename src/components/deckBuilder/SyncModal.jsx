import { useState, useEffect } from 'react'
import { CloseIcon } from '../../icons'
import { sb } from '../../lib/supabase'
import { getLocalCards } from '../../lib/db'
import { buildDeckAllocationViewRows, loadLocalPlacementSnapshot } from '../../lib/deckPlacementData'
import { Select } from '../UI'
import { isGroupFolder, normalizeBoard } from '../../lib/deckBuilderHelpers'
import { getSyncState, buildSyncDiff, getLogicalKey } from '../../lib/deckSync'
import { planDeckAllocations } from '../../lib/deckAllocationPlanner'
import {
  buildChosenAllocations,
  buildChosenPrintingSelections,
  formatOwnedPrinting,
  formatQtyLabel,
  formatPlacementLabel,
  summarizePlacementParts,
  getDecisionCategory,
  getDecisionPreview,
  getDecisionOptionLabels,
} from '../../lib/deckSyncDecisions'
import PrintingPickerModal from './PrintingPickerModal'

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

  const overlay = { position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:700, display:'flex', alignItems:'center', justifyContent:'center' }
  const s = { background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'5px 8px', color:'var(--text)', fontSize:'0.83rem' }
  const secLabel = { fontSize:'0.74rem', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em', color:'var(--text-faint)', marginBottom:6 }

  if (loading) return (
    <div style={overlay}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, padding:32, color:'var(--text-faint)', fontSize:'0.9rem' }}>
        Comparing deck with collection...
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
        qty: i.oldQty - i.newQty,
      })),
    ...removedSelected.map(r => ({
      key: `removed:${r.allocRow.id}`,
      name: r.name,
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
  const moveOutDestinationLabel = selectedMoveTarget ? formatPlacementLabel(selectedMoveTarget) : 'Select destination'
  const moveInCopyCount = ownedAdded.reduce((sum, item) => sum + (item.totalAdd || 0), 0)
    + increaseRows.reduce((sum, item) => sum + Math.max(0, (item.newQty || 0) - (item.oldQty || 0)), 0)
  const moveOutCopyCount = movedOwnedRows.reduce((sum, row) => sum + (row.qty || 0), 0)
  const missingCopyCount = unownedAdded.reduce((sum, item) => sum + (item.missingQty || 0), 0)

  if (!hasChanges && !remoteReady) return (
    <div style={overlay}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, padding:32, color:'var(--text-faint)', fontSize:'0.9rem' }}>
        Refreshing collection placements...
      </div>
    </div>
  )

  if (!hasChanges) return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, padding:32, width:380, display:'flex', flexDirection:'column', gap:16 }}>
        <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)' }}>Update Collection Deck</span>
        <p style={{ color:'var(--text-dim)', fontSize:'0.85rem', margin:0 }}>No sync differences found.</p>
        <div style={{ display:'flex', justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:'pointer' }}>Close</button>
        </div>
      </div>
    </div>
  )

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:760, maxWidth:'96vw', maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>Update Collection Deck</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:'pointer' }}><CloseIcon size={13} /></button>
        </div>
        <div style={{ flex:1, overflowY:'auto', minHeight:0, padding:'16px 20px', display:'flex', flexDirection:'column', gap:16 }}>
          <div style={{ padding:'12px 14px', border:'1px solid var(--border)', borderRadius:8, background:'var(--s1)', display:'flex', flexDirection:'column', gap:6 }}>
            <div style={{ color:'var(--text)', fontSize:'0.86rem' }}>
              Sync compares Deck Builder with {collectionDeckLabel}.
            </div>
            <div style={{ color:'var(--text-faint)', fontSize:'0.76rem', lineHeight:1.5 }}>
              Use Deck Builder to move owned cards into or out of the Collection Deck. Use Collection Deck only when the builder list should change and owned cards should stay where they are.
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(150px, 1fr))', gap:10 }}>
            <div style={{ padding:'12px', border:'1px solid rgba(74,154,90,0.38)', borderRadius:8, background:'rgba(74,154,90,0.08)' }}>
              <div style={{ color:'var(--text-faint)', fontSize:'0.72rem', textTransform:'uppercase', letterSpacing:'0.06em' }}>Move Into Deck</div>
              <div style={{ color:'var(--text)', fontSize:'1.1rem', marginTop:4 }}>{moveInCopyCount}</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginTop:4 }}>
                from binders/decks to Collection Deck
              </div>
            </div>
            <div style={{ padding:'12px', border:'1px solid rgba(224,112,32,0.38)', borderRadius:8, background:'rgba(224,112,32,0.08)' }}>
              <div style={{ color:'var(--text-faint)', fontSize:'0.72rem', textTransform:'uppercase', letterSpacing:'0.06em' }}>Too Many In Deck</div>
              <div style={{ color:'var(--text)', fontSize:'1.1rem', marginTop:4 }}>{moveOutCopyCount}</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginTop:4 }}>
                from Collection Deck to chosen place
              </div>
            </div>
            <div style={{ padding:'12px', border:'1px solid rgba(224,92,92,0.38)', borderRadius:8, background:'rgba(224,92,92,0.08)' }}>
              <div style={{ color:'var(--text-faint)', fontSize:'0.72rem', textTransform:'uppercase', letterSpacing:'0.06em' }}>Missing Cards</div>
              <div style={{ color:'var(--text)', fontSize:'1.1rem', marginTop:4 }}>{missingCopyCount}</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginTop:4 }}>
                not owned, optional wishlist
              </div>
            </div>
            <div style={{ padding:'12px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)' }}>
              <div style={{ color:'var(--text-faint)', fontSize:'0.72rem', textTransform:'uppercase', letterSpacing:'0.06em' }}>Deck List Only</div>
              <div style={{ color:'var(--text)', fontSize:'1.1rem', marginTop:4 }}>{builderImpactCount}</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginTop:4 }}>collection cards stay put</div>
            </div>
          </div>

          <div>
            <div style={secLabel}>Card Decisions</div>
            <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
              {decisionRows.map(row => {
                const name = row.builder?.name || row.collection?.name || 'Card'
                const label = row.category === 'builderOnly'
                  ? 'Needed by Deck Builder'
                  : row.category === 'collectionOnly'
                    ? 'Only in Collection Deck'
                    : 'Different quantities'
                const optionLabels = getDecisionOptionLabels(row, { addedByKey })
                return (
                  <div key={row.key} style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) 220px', gap:12, alignItems:'center', padding:'10px 12px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)' }}>
                    <div style={{ minWidth:0, display:'flex', flexDirection:'column', gap:4 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
                        <span style={{ color:'var(--text)', fontSize:'0.85rem', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{name}</span>
                        {row.builder?.is_commander && (
                          <span style={{ color:'var(--gold)', fontSize:'0.7rem', border:'1px solid rgba(201,168,76,0.35)', borderRadius:999, padding:'2px 8px', flexShrink:0 }}>Commander</span>
                        )}
                        <span style={{ color:'var(--text-faint)', fontSize:'0.72rem', border:'1px solid var(--border)', borderRadius:999, padding:'2px 8px', flexShrink:0 }}>{label}</span>
                      </div>
                      <div style={{ color:'var(--text-faint)', fontSize:'0.74rem' }}>
                        {row.printing} · Deck Builder {row.builderQty ?? 0} · Collection Deck {row.collectionQty ?? 0}
                      </div>
                      <div style={{ color: row.resolution === 'keep' ? 'var(--text-faint)' : 'var(--text-dim)', fontSize:'0.76rem', lineHeight:1.45 }}>
                        {row.summary}
                      </div>
                    </div>
                    <Select
                      value={row.resolution}
                      onChange={e => setResolutions(prev => ({ ...prev, [row.key]: e.target.value }))}
                      style={{ ...s, width:'100%' }}
                      title="Action for this card"
                    >
                      <option value="builder">{optionLabels.builder}</option>
                      <option value="collection">{optionLabels.collection}</option>
                      <option value="keep">{optionLabels.keep}</option>
                    </Select>
                  </div>
                )
              })}
            </div>
          </div>

          <div>
            <label style={{ display:'flex', alignItems:'flex-start', gap:8, cursor:'pointer' }}>
              <input type="checkbox" checked={exactVersionOnly} onChange={e => setExactVersionOnly(e.target.checked)} style={{ accentColor:'var(--gold)', marginTop:2, flexShrink:0 }} />
              <span>
                <div style={{ fontSize:'0.84rem', color:'var(--text-dim)' }}>Use specified version only</div>
                <div style={{ fontSize:'0.75rem', color:'var(--text-faint)' }}>Exact version first. If off, another owned printing can be used, like ManaBox.</div>
              </span>
            </label>
          </div>

          {commanderRiskRows.length > 0 && (
            <div>
              <div style={secLabel}>Commander Attention</div>
              <div style={{ padding:'10px 12px', border:'1px solid rgba(201,168,76,0.28)', borderRadius:8, background:'rgba(201,168,76,0.08)', display:'flex', flexDirection:'column', gap:6 }}>
                {commanderRiskRows.map(row => (
                  <div key={`commander-${row.key}`} style={{ color:'var(--text-dim)', fontSize:'0.8rem' }}>
                    {(row.builder?.name || row.collection?.name || 'Card')}: collection choices may remove or leave unresolved commander status in Deck Builder.
                  </div>
                ))}
              </div>
            </div>
          )}

          {(ownedAdded.length > 0 || increaseRows.length > 0) && (
            <div style={{ border:'1px solid rgba(74,154,90,0.28)', borderRadius:8, background:'rgba(74,154,90,0.05)', padding:12 }}>
              <div style={secLabel}>Move Into Collection Deck</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginBottom:10 }}>
                Source: owned cards in binders or other decks. Destination: {collectionDeckLabel}.
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {ownedAdded.map(i => (
                  <div key={i.dc.id} style={{ padding:'10px 12px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)', display:'flex', flexDirection:'column', gap:5 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', gap:8, fontSize:'0.84rem', color:'var(--text)' }}>
                      <span>{i.dc.name}</span>
                      <span style={{ color:'var(--green, #4a9a5a)' }}>{formatQtyLabel(i.totalAdd)}</span>
                    </div>
                    {!!i.allocations?.length && (
                      <>
                        <div style={{ color:'var(--text-faint)', fontSize:'0.74rem' }}>
                          From: {summarizePlacementParts(i.allocations.flatMap(row => row.sourceParts || []))}
                        </div>
                        <div style={{ color:'var(--text-faint)', fontSize:'0.74rem' }}>
                          Printing: {i.allocations.map(row => `${row.qty}x ${formatOwnedPrinting(row)}`).join(', ')}
                        </div>
                      </>
                    )}
                    {!exactVersionOnly && (i.otherCandidates?.length || 0) > 1 && (
                      <div>
                        <button
                          onClick={() => setPickerItem(i)}
                          style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'5px 10px', color:'var(--text-dim)', fontSize:'0.76rem', cursor:'pointer' }}>
                          Choose owned printing
                        </button>
                      </div>
                    )}
                  </div>
                ))}
                {increaseRows.map(i => (
                  <div key={`inc-${i.cardId}:${i.dc.id}`} style={{ display:'flex', flexDirection:'column', gap:4, padding:'8px 10px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)', fontSize:'0.84rem', color:'var(--text)' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', gap:8 }}>
                      <span>{i.dc.name}</span>
                      <span style={{ color:'var(--green, #4a9a5a)', fontSize:'0.78rem' }}>{`add ${i.newQty - i.oldQty}`}</span>
                    </div>
                    <div style={{ color:'var(--text-faint)', fontSize:'0.74rem' }}>
                      From: matching owned copies elsewhere in collection. To: {collectionDeckLabel}.
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {movedOwnedRows.length > 0 && (
            <div style={{ border:'1px solid rgba(224,112,32,0.28)', borderRadius:8, background:'rgba(224,112,32,0.05)', padding:12 }}>
              <div style={secLabel}>Too Many In Collection Deck</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginBottom:8 }}>
                Source: {collectionDeckLabel}. Destination: {moveOutDestinationLabel}.
              </div>
              <Select value={globalDest} onChange={e => setGlobalDest(e.target.value)} style={{ ...s, width:'100%' }} title="Select destination" portal searchable>
                <option value="">Select binder or deck</option>
                {folders.map(folder => (
                  <option key={folder.id} value={folder.id}>
                    {folder.type === 'binder' ? 'Binder' : 'Deck'}: {folder.name}
                  </option>
                ))}
              </Select>
              {selectedMoveTarget && (
                <div style={{ color:'var(--text-dim)', fontSize:'0.76rem', marginTop:8 }}>
                  These copies will move from {collectionDeckLabel} to {formatPlacementLabel(selectedMoveTarget)}.
                </div>
              )}
              <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:10 }}>
                {movedOwnedRows.map(row => (
                  <div key={row.key} style={{ display:'flex', flexDirection:'column', gap:3, padding:'8px 10px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)' }}>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:'0.82rem', color:'var(--text)' }}>
                      <span>{row.name}</span>
                      <span style={{ color:'var(--text-faint)' }}>{row.qty}x</span>
                    </div>
                    <div style={{ color:'var(--text-faint)', fontSize:'0.73rem' }}>
                      {collectionDeckLabel} to {moveOutDestinationLabel}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unownedAdded.length > 0 && (
            <div style={{ border:'1px solid rgba(224,92,92,0.28)', borderRadius:8, background:'rgba(224,92,92,0.05)', padding:12 }}>
              <div style={secLabel}>Missing Cards</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginBottom:8 }}>
                These are in Deck Builder but no owned copy is available to move into {collectionDeckLabel}.
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:10 }}>
                {unownedAdded.map(item => (
                  <div key={item.dc.id} style={{ display:'flex', justifyContent:'space-between', fontSize:'0.84rem', color:'var(--text)' }}>
                    <span>{item.dc.name}</span>
                    <span style={{ color:'var(--text-faint)', fontSize:'0.78rem' }}>
                      {item.missingQty || item.dc.qty || 1}x
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginBottom:8 }}>
                These cards are not owned, so they will not be placed into the Collection Deck.
              </div>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <Select value={wishlistId} onChange={e => setWishlistId(e.target.value)} style={{ ...s, flex:1 }} title="Select wishlist">
                  <option value="">Skip</option>
                  {wishlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
                  <option value="new">+ Create new wishlist...</option>
                </Select>
                {wishlistId === 'new' && (
                  <input
                    autoFocus
                    value={newWishlistName}
                    onChange={e => setNewWishlistName(e.target.value)}
                    placeholder="Wishlist name..."
                    maxLength={100}
                    style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'5px 8px', color:'var(--text)', fontSize:'0.83rem', flex:1 }}
                  />
                )}
              </div>
            </div>
          )}

          {builderUpdateRows.length > 0 && (
            <div>
              <div style={secLabel}>Deck List Changes Only</div>
              <div style={{ color:'var(--text-faint)', fontSize:'0.74rem', marginBottom:8 }}>
                These decisions change the Deck Builder list to match the current Collection Deck. No collection cards will move.
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {builderUpdateRows.map(row => (
                  <div key={`builder-${row.key}`} style={{ display:'flex', justifyContent:'space-between', gap:8, padding:'8px 10px', border:'1px solid var(--border)', borderRadius:8, background:'var(--bg3)', fontSize:'0.84rem', color:'var(--text)' }}>
                    <span>{row.collection?.name || row.builder?.name || 'Card'}</span>
                    <span style={{ color:'var(--text-dim)', fontSize:'0.78rem' }}>{`Deck Builder ${row.builderQty ?? 0} to ${row.collectionQty ?? 0}`}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unresolvedRows.length > 0 && (
            <div>
              <div style={secLabel}>Keep Separate For Now</div>
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {unresolvedRows.map(row => (
                  <div key={`keep-${row.key}`} style={{ display:'flex', justifyContent:'space-between', fontSize:'0.8rem', color:'var(--text-dim)' }}>
                    <span>{row.builder?.name || row.collection?.name || 'Card'}</span>
                    <span>no change</span>
                  </div>
                ))}
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
        <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', display:'flex', gap:8, justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:'0.79rem', color:'var(--text-faint)' }}>
            {!remoteReady
              ? 'Refreshing collection placements before decisions can be applied.'
              : movedOwnedRows.length > 0
              ? (selectedMoveTarget ? `Moving excess cards to ${formatPlacementLabel(selectedMoveTarget)}.` : 'Choose a destination for cards leaving the Collection Deck.')
              : ''}
          </span>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={onClose} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:'pointer' }}>Cancel</button>
            <button
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
              style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green, #4a9a5a)', fontSize:'0.83rem', cursor:canConfirm ? 'pointer' : 'not-allowed', opacity:canConfirm ? 1 : 0.45 }}>
              {`Apply ${actionCount} Decision${actionCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
