import { useState, useEffect, useMemo } from 'react'
import { Select } from '../UI'
import { BASIC_LANDS } from '../../lib/deckBuilderConstants'
import { isGroupFolder, normalizeCardName } from '../../lib/deckBuilderHelpers'
import { buildChosenAllocations, buildChosenPrintingSelections } from '../../lib/deckSyncDecisions'
import { planDeckAllocations } from '../../lib/deckAllocationPlanner'
import { loadLocalPlacementSnapshot, refreshRemotePlacementSnapshot } from '../../lib/deckPlacementData'
import PrintingPickerModal from './PrintingPickerModal'

// ── Make Deck row ─────────────────────────────────────────────────────────────
function MakeDeckRow({ item }) {
  const { dc, neededQty, addExact, addOther, totalAdd, missingQty } = item
  const img = dc.image_uri
  let statusColor, statusIcon, statusDetail
  if (totalAdd === 0) {
    statusColor = '#e07070'; statusIcon = 'x'; statusDetail = 'not owned'
  } else if (missingQty === 0 && addOther === 0) {
    statusColor = 'var(--green, #4a9a5a)'; statusIcon = 'OK'; statusDetail = `${totalAdd}x exact`
  } else {
    statusColor = '#c9a84c'; statusIcon = 'Alt'
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
    <div style={{ display:'flex', alignItems:'center', padding:'5px 20px', borderBottom:'1px solid var(--s-border)', gap:10, minHeight:36 }}>
      {img
        ? <img src={img} alt="" style={{ width:26, height:18, objectFit:'cover', borderRadius:2, flexShrink:0 }} />
        : <div style={{ width:26, height:18, background:'var(--s3)', borderRadius:2, flexShrink:0 }} />
      }
      <div style={{ flex:1, minWidth:0 }}>
        <span style={{ fontSize:'0.84rem', color:'var(--text)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', display:'block' }}>
          {neededQty > 1 ? `${neededQty}x ` : ''}{dc.name}
        </span>
        {allocationDetail && (
          <span style={{ fontSize:'0.72rem', color:'var(--text-faint)', display:'block', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
            Uses: {allocationDetail}
          </span>
        )}
      </div>
      <div style={{ fontSize:'0.79rem', color:statusColor, flexShrink:0, display:'flex', alignItems:'center', gap:4 }}>
        <span>{statusIcon}</span><span>{statusDetail}</span>
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
  const [missingAction, setMissingAction] = useState('skip') // 'skip' | 'add' | 'wishlist'
  const [selectedWishlistId, setSelectedWishlistId] = useState('')
  const [newWishlistName, setNewWishlistName] = useState('')
  const [chosenOtherCardIds, setChosenOtherCardIds] = useState({})
  const [pickerItem, setPickerItem] = useState(null)

  // Intentional: modal mounts fresh on each open - one-shot load from current props snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false
    const deckNameSet = new Set((deckCards || []).map(card => normalizeCardName(card.name)).filter(Boolean))
    const deckScryfallIds = new Set((deckCards || []).map(card => card.scryfall_id).filter(Boolean))
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
          names: [...deckNameSet],
          scryfallIds: [...deckScryfallIds],
        })
        if (cancelled) return
        applySnapshot(localSnapshot)
        setLoading(false)

        try {
          const remoteSnapshot = await refreshRemotePlacementSnapshot(userId, {
            names: [...deckNameSet],
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

  const planningOwnedCards = useMemo(() => {
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
  }, [ownedCardsForPlanning, binderQtyByCardId, deckAllocatedQtyByCardId, pullFromOtherDecks])

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
    || (selectedWishlistId ? (selectedWishlistId === 'new' ? !!newWishlistName.trim() : true) : true)
  const canConfirm    = remoteReady && (addItems.length > 0 || missingAction === 'add') && wishlistReady

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:700, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:560, maxWidth:'95vw', maxHeight:'90vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>Make Collection Deck</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:'pointer' }}>x</button>
        </div>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'var(--text-faint)', fontSize:'0.85rem' }}>Checking your collection...</div>
        ) : (
          <>
            <div style={{ padding:'10px 20px', borderBottom:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:8 }}>
              {[
                [skipBasicLands,    setSkipBasicLands,    'Skip basic lands',                          'Island, Plains, Forest, Mountain, Swamp'],
                [exactVersionOnly,  setExactVersionOnly,  'Use specified version only',                'Won\'t substitute a different printing'],
                [!pullFromOtherDecks, v => setPullFromOtherDecks(!v), 'Skip cards already in another deck', 'Avoids pulling the same copy into two decks'],
              ].map(([val, set, label, sub]) => (
                <label key={label} style={{ display:'flex', alignItems:'flex-start', gap:8, cursor:'pointer' }}>
                  <input type="checkbox" checked={val} onChange={e => set(e.target.checked)} style={{ accentColor:'var(--gold)', marginTop:2, flexShrink:0 }} />
                  <span>
                    <div style={{ fontSize:'0.84rem', color:'var(--text-dim)' }}>{label}</div>
                    <div style={{ fontSize:'0.75rem', color:'var(--text-faint)' }}>{sub}</div>
                  </span>
                </label>
              ))}
            </div>
            <div style={{ padding:'8px 20px', background:'var(--s1)', borderBottom:'1px solid var(--border)', display:'flex', gap:16, fontSize:'0.81rem', flexWrap:'wrap' }}>
              <span style={{ color:'var(--green, #4a9a5a)' }}>OK {exactCount} exact</span>
              {fallbackCount > 0 && <span style={{ color:'#c9a84c' }}>Alt {fallbackCount} different printing</span>}
              {missingCount > 0 && <span style={{ color:'#e07070' }}>x {missingCount} missing</span>}
            </div>
            <div style={{ flex:1, overflowY:'auto', minHeight:0 }}>
              {filtered.length === 0
                ? <div style={{ padding:40, textAlign:'center', color:'var(--text-faint)', fontSize:'0.85rem' }}>No cards to add.</div>
                : filtered.map(item => (
                  <div key={item.dc.id}>
                    <MakeDeckRow item={item} />
                    {!exactVersionOnly && (item.otherCandidates?.length || 0) > 1 && item.totalAdd > 0 && (
                      <div style={{ padding:'0 20px 8px' }}>
                        <button
                          onClick={() => setPickerItem(item)}
                          style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'5px 10px', color:'var(--text-dim)', fontSize:'0.76rem', cursor:'pointer' }}>
                          Choose owned printing
                        </button>
                      </div>
                    )}
                  </div>
                ))
              }
            </div>
            {missingCount > 0 && (
              <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)' }}>
                <div style={{ fontSize:'0.82rem', color:'var(--text-dim)', marginBottom:10 }}>
                  {missingItems.reduce((s, i) => s + i.missingQty, 0)} missing card{missingCount !== 1 ? 's' : ''}:
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {[
                    ['skip', 'Skip missing cards',     'They will not be added to the deck'],
                    ['add',  'Add to collection',      'Creates owned copies placed directly in this deck'],
                    ['wishlist', 'Add to wishlist',    'Save to a wishlist for future tracking'],
                  ].map(([value, label, sub]) => (
                    <label key={value} style={{ display:'flex', alignItems:'flex-start', gap:8, cursor:'pointer' }}>
                      <input type="radio" name="missingAction" value={value} checked={missingAction === value}
                        onChange={() => setMissingAction(value)}
                        style={{ accentColor:'var(--gold)', marginTop:2, flexShrink:0 }} />
                      <span>
                        <div style={{ fontSize:'0.84rem', color:'var(--text-dim)' }}>{label}</div>
                        <div style={{ fontSize:'0.75rem', color:'var(--text-faint)' }}>{sub}</div>
                      </span>
                    </label>
                  ))}
                  {missingAction === 'wishlist' && (
                    <div style={{ display:'flex', gap:8, alignItems:'center', paddingLeft:24 }}>
                      <Select value={selectedWishlistId} onChange={e => setSelectedWishlistId(e.target.value)}
                        menuDirection="up"
                        style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'6px 10px', color:'var(--text)', fontSize:'0.84rem', flex:1, minWidth:0 }}
                        title="Select wishlist">
                        <option value="">Choose wishlist</option>
                        {wishlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
                        <option value="new">+ Create new wishlist...</option>
                      </Select>
                      {selectedWishlistId === 'new' && (
                        <input autoFocus placeholder="Wishlist name..." value={newWishlistName} onChange={e => setNewWishlistName(e.target.value)}
                          maxLength={100}
                          style={{ background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'6px 10px', color:'var(--text)', fontSize:'0.84rem', flex:1 }} />
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
            <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', display:'flex', gap:8, justifyContent:'flex-end' }}>
              <div style={{ flex:1, color:refreshError ? '#e07070' : 'var(--text-faint)', fontSize:'0.76rem', alignSelf:'center' }}>
                {!remoteReady ? (refreshError || 'Refreshing collection placements...') : ''}
              </div>
              <button onClick={onClose} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:'pointer' }}>Cancel</button>
              <button
                onClick={() => onConfirm({
                  addItems,
                  missingItems,
                  printingSelections: buildChosenPrintingSelections(filtered, chosenOtherCardIds),
                  addMissing: missingAction === 'add',
                  wishlistId: missingAction === 'wishlist' && selectedWishlistId !== 'new' ? (selectedWishlistId || null) : null,
                  wishlistName: missingAction === 'wishlist' && selectedWishlistId === 'new' ? newWishlistName.trim() : null,
                })}
                disabled={!canConfirm}
                style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green, #4a9a5a)', fontSize:'0.83rem', cursor:'pointer', opacity:canConfirm ? 1 : 0.45 }}>
                Create Deck ({addItems.reduce((s, i) => s + i.totalAdd, 0) + (missingAction === 'add' ? missingItems.reduce((s, i) => s + i.missingQty, 0) : 0)} cards)
              </button>
            </div>
          </>
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
    </div>
  )
}
