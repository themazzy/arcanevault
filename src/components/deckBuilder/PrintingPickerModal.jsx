import { useState, useEffect } from 'react'
import { fetchCardsByScryfallIds, getCardImageUri } from '../../lib/deckBuilderApi'

export default function PrintingPickerModal({ cardName, options, selectedCardId, onSelect, onClose }) {
  const [details, setDetails] = useState([])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const ids = [...new Set(options.map(option => option.scryfall_id).filter(Boolean))]
      const fetched = ids.length ? await fetchCardsByScryfallIds(ids) : []
      if (cancelled) return
      const byId = new Map(fetched.map(card => [card.id, card]))
      setDetails(options.map(option => {
        const sf = option.scryfall_id ? byId.get(option.scryfall_id) : null
        return {
          ...option,
          image_uri: getCardImageUri(sf, 'normal'),
          set_name: sf?.set_name || (option.set_code ? String(option.set_code).toUpperCase() : 'Unknown set'),
        }
      }))
    }
    load()
    return () => { cancelled = true }
  }, [options])

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:730, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:760, maxWidth:'95vw', maxHeight:'88vh', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>Choose owned printing</span>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:'pointer' }}>x</button>
        </div>
        <div style={{ padding:'12px 20px', color:'var(--text-dim)', fontSize:'0.84rem' }}>
          Select which owned printing to use for {cardName}.
        </div>
        <div style={{ padding:'0 20px 20px', overflowY:'auto', display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(160px, 1fr))', gap:12 }}>
          {details.map(option => (
            <button
              key={option.card_id}
              onClick={() => onSelect(option.card_id)}
              style={{
                background: selectedCardId === option.card_id ? 'rgba(201,168,76,0.12)' : 'var(--s1)',
                border: selectedCardId === option.card_id ? '1px solid rgba(201,168,76,0.45)' : '1px solid var(--border)',
                borderRadius:8,
                padding:10,
                display:'flex',
                flexDirection:'column',
                gap:8,
                cursor:'pointer',
                color:'var(--text)',
                textAlign:'left',
              }}>
              {option.image_uri
                ? <img src={option.image_uri} alt={option.name} style={{ width:'100%', aspectRatio:'63 / 88', objectFit:'cover', borderRadius:6 }} loading="lazy" />
                : <div style={{ width:'100%', aspectRatio:'63 / 88', background:'var(--s2)', borderRadius:6, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-faint)', fontSize:'0.75rem', textAlign:'center', padding:8 }}>{option.name}</div>}
              <div style={{ fontSize:'0.8rem', fontWeight:600 }}>{option.set_name}</div>
              <div style={{ fontSize:'0.73rem', color:'var(--text-faint)' }}>
                {option.set_code ? `${String(option.set_code).toUpperCase()} #${option.collector_number || '?'}` : 'Owned printing'}
              </div>
              <div style={{ fontSize:'0.73rem', color:'var(--text-faint)' }}>
                {`${option.available_qty}x available${option.foil ? ' / foil' : ''}`}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
