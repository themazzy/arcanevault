import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { getLocalCards } from '../../lib/db'
import { getCardImageUri } from '../../lib/deckBuilderApi'
import { CAN_HOVER, FOLDER_TAG_COLOR, FOLDER_TAG_BORDER } from '../../lib/deckBuilderConstants'
import { normalizeCardName } from '../../lib/deckBuilderHelpers'
import { FolderTypeIcon } from '../../icons'

function PrintingLocationTags({ locations }) {
  if (!locations?.length) return null
  const visible = locations.slice(0, 2)
  const extra = locations.length - visible.length
  return (
    <div style={{ display:'flex', flexWrap:'wrap', justifyContent:'center', gap:4, maxWidth:'100%' }}>
      {visible.map((loc, i) => (
        <span
          key={`${loc.type}-${loc.id || loc.name}-${i}`}
          title={`${loc.type}: ${loc.name}${loc.qty ? ` (${loc.qty}x)` : ''}`}
          style={{
            maxWidth:'100%',
            display:'inline-flex',
            alignItems:'center',
            gap:4,
            padding:'2px 6px',
            borderRadius:3,
            border:'1px solid',
            borderColor:FOLDER_TAG_BORDER[loc.type] || FOLDER_TAG_BORDER.binder,
            background:FOLDER_TAG_COLOR[loc.type] || FOLDER_TAG_COLOR.binder,
            color:'var(--text-dim)',
            fontSize:'0.64rem',
            lineHeight:1.15,
            fontFamily:'var(--font-serif)',
            whiteSpace:'nowrap',
            overflow:'hidden',
            textOverflow:'ellipsis',
          }}
        >
          <span style={{ display:'inline-flex', flexShrink:0 }}>
            <FolderTypeIcon type={loc.type} size={12} />
          </span>
          <span style={{ minWidth:0, overflow:'hidden', textOverflow:'ellipsis' }}>{loc.name}</span>
        </span>
      ))}
      {extra > 0 && <span style={{ fontSize:'0.64rem', color:'var(--text-faint)', padding:'2px 4px' }}>+{extra}</span>}
    </div>
  )
}

export default function VersionPickerModal({ dc, ownedMap, userId, onSelect, onClose }) {
  const [printings, setPrintings] = useState([])
  const [loading,   setLoading]   = useState(true)
  const [locationsByScryfallId, setLocationsByScryfallId] = useState(new Map())

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [res, ownedRows] = await Promise.all([
          fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(`!"${dc.name}"`)}&unique=prints&order=released`),
          userId ? getLocalCards(userId) : Promise.resolve([]),
        ])
        const d = await res.json()
        if (!cancelled) {
          const raw = d.data || []
          const sorted = [
            ...raw.filter(p => (ownedMap.get(p.id) ?? 0) > 0),
            ...raw.filter(p => (ownedMap.get(p.id) ?? 0) === 0),
          ]
          setPrintings(sorted)
        }

        const ownedForCard = (ownedRows || []).filter(row => normalizeCardName(row.name) === normalizeCardName(dc.name))
        const cardIds = [...new Set(ownedForCard.map(row => row.id).filter(Boolean))]
        if (!cardIds.length) {
          if (!cancelled) setLocationsByScryfallId(new Map())
          return
        }

        const [{ data: folderRows, error: folderErr }, { data: deckRows, error: deckErr }] = await Promise.all([
          sb.from('folder_cards').select('folder_id,card_id,qty').in('card_id', cardIds),
          sb.from('deck_allocations').select('deck_id,card_id,qty').eq('user_id', userId).in('card_id', cardIds),
        ])
        if (folderErr) throw folderErr
        if (deckErr) throw deckErr

        const folderIds = [
          ...new Set([
            ...(folderRows || []).map(row => row.folder_id),
            ...(deckRows || []).map(row => row.deck_id),
          ].filter(Boolean)),
        ]
        const { data: folders, error: foldersErr } = folderIds.length
          ? await sb.from('folders').select('id,name,type').in('id', folderIds)
          : { data: [], error: null }
        if (foldersErr) throw foldersErr

        const ownedById = new Map(ownedForCard.map(row => [row.id, row]))
        const folderById = new Map((folders || []).map(folder => [folder.id, folder]))
        const nextLocations = new Map()
        const addLocation = (scryfallId, folder, qty) => {
          if (!scryfallId || !folder) return
          const list = nextLocations.get(scryfallId) || []
          const existing = list.find(loc => loc.id === folder.id && loc.type === folder.type)
          if (existing) existing.qty += qty || 0
          else list.push({ id: folder.id, name: folder.name || 'Unknown', type: folder.type || 'binder', qty: qty || 0 })
          nextLocations.set(scryfallId, list)
        }
        for (const row of folderRows || []) {
          const owned = ownedById.get(row.card_id)
          addLocation(owned?.scryfall_id, folderById.get(row.folder_id), row.qty)
        }
        for (const row of deckRows || []) {
          const owned = ownedById.get(row.card_id)
          addLocation(owned?.scryfall_id, folderById.get(row.deck_id), row.qty)
        }
        if (!cancelled) setLocationsByScryfallId(nextLocations)
      } catch {
        if (!cancelled) setLocationsByScryfallId(new Map())
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [dc.name, userId, ownedMap])

  const desktopPicker = CAN_HOVER
  const modalWidth = desktopPicker ? 1120 : 560
  const tileWidth = desktopPicker ? 156 : 88
  const imageWidth = desktopPicker ? 140 : 76
  const imageHeight = desktopPicker ? 196 : 106

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', zIndex:700, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background:'var(--bg-card,#1e1e1e)', border:'1px solid var(--border)', borderRadius:8, padding:20, width:modalWidth, maxWidth:'96vw', maxHeight:'86vh', display:'flex', flexDirection:'column', gap:14 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'0.95rem' }}>
            Choose version - {dc.name}
          </span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.1rem', cursor:'pointer' }}>x</button>
        </div>
        {loading
          ? <div style={{ color:'var(--text-faint)', fontSize:'0.85rem', padding:'20px 0', textAlign:'center' }}>Loading printings...</div>
          : (
            <div style={{ overflowY:'auto', display:'flex', flexWrap:'wrap', gap:desktopPicker ? 14 : 10 }}>
              {printings.map(p => {
                const img = getCardImageUri(p, 'normal')
                const isActive  = p.id === dc.scryfall_id
                const locations = locationsByScryfallId.get(p.id) || []
                return (
                  <button key={p.id} onClick={() => onSelect(p)}
                    style={{
                      background: isActive ? 'rgba(201,168,76,0.12)' : 'var(--s2)',
                      border: `1px solid ${isActive ? 'rgba(201,168,76,0.5)' : 'var(--s-border2)'}`,
                      borderRadius:6, padding:desktopPicker ? 10 : 6, cursor:'pointer', display:'flex', flexDirection:'column',
                      alignItems:'center', gap:desktopPicker ? 8 : 6, width:tileWidth, flexShrink:0, transition:'all 0.13s',
                    }}>
                    {img
                      ? <img src={img} alt={p.set_name} style={{ width:imageWidth, height:imageHeight, objectFit:'cover', borderRadius:4 }} loading="lazy" />
                      : <div style={{ width:imageWidth, height:imageHeight, background:'var(--s3)', borderRadius:4 }} />
                    }
                    <div style={{ fontSize:desktopPicker ? '0.78rem' : '0.62rem', color: isActive ? 'var(--gold)' : 'var(--text-dim)', textAlign:'center', lineHeight:1.25, wordBreak:'break-word' }}>
                      {p.set_name}
                    </div>
                    <PrintingLocationTags locations={locations} />
                  </button>
                )
              })}
            </div>
          )
        }
      </div>
    </div>
  )
}
