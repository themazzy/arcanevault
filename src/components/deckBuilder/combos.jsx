import { useEffect, useState } from 'react'
import { cardNameMatchKeys } from '../../lib/deckBuilderHelpers'

// Lazy-fetches a card image from Scryfall for combo-card thumbnails. Requests
// are shared by name so multiple thumbs of the same card don't refetch.
const comboImageRequests = new Map()

function useComboCardImage(name, existingUri) {
  const [images, setImages] = useState(() => existingUri ? { [name]: existingUri } : {})
  useEffect(() => {
    if (existingUri || !name) return
    let cancelled = false
    let request = comboImageRequests.get(name)
    if (!request) {
      request = fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=json`)
        .then(r => r.ok ? r.json() : null)
        .then(d => (
          d?.image_uris?.large ||
          d?.card_faces?.[0]?.image_uris?.large ||
          d?.image_uris?.normal ||
          d?.card_faces?.[0]?.image_uris?.normal ||
          null
        ))
        .catch(() => null)
      comboImageRequests.set(name, request)
    }
    request.then(url => {
      if (!url) {
        if (comboImageRequests.get(name) === request) comboImageRequests.delete(name)
        return
      }
      if (cancelled || !url) return
      setImages(current => current[name] === url ? current : { ...current, [name]: url })
    })
    return () => { cancelled = true }
  }, [name, existingUri])
  return existingUri || images[name] || null
}

// Thumbnail tile for a single card inside a combo result. Shows an "+ Add"
// button when the card isn't in the deck and an onAdd callback is provided.
export function ComboCardThumb({ name, inDeck, existingUri, onAdd, onOpenDetail }) {
  const img = useComboCardImage(name, existingUri)
  const [adding, setAdding] = useState(false)
  const handleAdd = async e => {
    e.stopPropagation()
    if (adding) return
    setAdding(true)
    try { await onAdd(name) } finally { setAdding(false) }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: inDeck ? 1 : 0.6, cursor: 'pointer' }} onClick={() => onOpenDetail?.(name)}>
      <div style={{ position: 'relative', width: 120, height: 168, borderRadius: 7, overflow: 'hidden', flexShrink: 0,
        border: `1px solid ${inDeck ? 'rgba(201,168,76,0.5)' : 'var(--s-border2)'}`,
        background: 'var(--s2)',
      }}>
        {img
          ? <img src={img} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
          : <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.73rem', color: 'var(--text-faint)', padding: 8, textAlign: 'center', lineHeight: 1.3 }}>{name}</div>}
        {!inDeck && onAdd && (
          <button
            onClick={handleAdd}
            disabled={adding}
            style={{
              position: 'absolute', bottom: 6, left: '50%', transform: 'translateX(-50%)',
              background: adding ? 'rgba(201,168,76,0.25)' : 'rgba(20,20,30,0.85)',
              border: '1px solid rgba(201,168,76,0.6)', borderRadius: 4,
              color: 'var(--gold)', fontSize: '0.7rem', padding: '3px 10px',
              cursor: adding ? 'default' : 'pointer', whiteSpace: 'nowrap',
              backdropFilter: 'blur(4px)',
            }}
          >
            {adding ? '...' : '+ Add'}
          </button>
        )}
        </div>
      <div style={{ fontSize: '0.64rem', color: inDeck ? 'var(--text-faint)' : '#e08878', textAlign: 'center', maxWidth: 110, lineHeight: 1.2, wordBreak: 'break-word' }}>
        {inDeck ? name : `Add ${name}`}
      </div>
    </div>
  )
}

// Card for a single combo result from the EDHRec / Commander Spellbook
// recommendation API. Renders the participating cards as thumbs plus any
// requires/produces/mana/prereqs/notes metadata the API returned.
export function ComboResultCard({ combo, highlight, deckCardNames, deckImages, onAddCard, onOpenDetail }) {
  const uses    = (combo.uses    || []).map(u => u.card?.name || u.template?.name || '').filter(Boolean)
  const requires = (combo.requires || []).map(r => ({
    name: r.template?.name || r.card?.name || '',
    quantity: r.quantity ?? 1,
    zone: (r.zoneLocations || []).join(''),
  })).filter(r => r.name)
  const results = (combo.produces || []).map(p => p.feature?.name || '').filter(Boolean)
  // Full + front-face keys: Spellbook may name a DFC by front face while the
  // deck row carries the full "Front // Back" name (and vice versa).
  const deckSet = new Set((deckCardNames || []).flatMap(n => cardNameMatchKeys(n)))
  const inDeck = name => !deckCardNames || cardNameMatchKeys(name).some(k => deckSet.has(k))
  const steps   = combo.description || ''
  const prereqs = [combo.easyPrerequisites, combo.notablePrerequisites].filter(Boolean).join(' ')
  const manaNeeded = combo.manaNeeded || ''
  const manaValueNeeded = combo.manaValueNeeded || 0
  const notes = combo.notes || ''
  const hasExtras = requires.length > 0 || prereqs || manaNeeded || manaValueNeeded > 0 || notes
  const bottomGap = results.length || steps || hasExtras
  return (
    <div style={{
      background: highlight ? 'rgba(201,168,76,0.07)' : 'var(--s1)',
      border: `1px solid ${highlight ? 'rgba(201,168,76,0.28)' : 'var(--s-border)'}`,
      borderRadius: 6, padding: '14px',
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: bottomGap ? 12 : 0 }}>
        {uses.map((name, i) => (
          <ComboCardThumb key={i} name={name} inDeck={inDeck(name)} existingUri={deckImages?.[name]} onAdd={inDeck(name) ? undefined : onAddCard} onOpenDetail={onOpenDetail} />
        ))}
      </div>
      {requires.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-faint)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Requires</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {requires.map((r, i) => (
              <span key={i} style={{ fontSize: '0.72rem', background: 'rgba(180,120,60,0.15)', border: '1px solid rgba(180,120,60,0.3)', borderRadius: 3, padding: '2px 7px', color: 'var(--text-dim)' }}>
                {r.quantity > 1 ? `${r.quantity}× ` : ''}{r.name}{r.zone ? ` (${r.zone})` : ''}
              </span>
            ))}
          </div>
        </div>
      )}
      {(manaNeeded || manaValueNeeded > 0) && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: 6 }}>
          <span style={{ color: 'var(--text-faint)' }}>Mana: </span>
          {manaValueNeeded > 0 && <span>{manaValueNeeded} total</span>}
          {manaValueNeeded > 0 && manaNeeded && <span> — </span>}
          {manaNeeded && <span>{manaNeeded}</span>}
        </div>
      )}
      {prereqs && (
        <div style={{ fontSize: '0.77rem', color: 'var(--text-dim)', marginBottom: 6, lineHeight: 1.5 }}>
          <span style={{ color: 'var(--text-faint)' }}>Prerequisites: </span>{prereqs}
        </div>
      )}
      {results.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: (steps || hasExtras) ? 8 : 0 }}>
          {results.slice(0, 6).map((r, i) => (
            <span key={i} style={{ fontSize: '0.68rem', background: 'rgba(100,100,160,0.2)', border: '1px solid rgba(100,100,160,0.3)', borderRadius: 3, padding: '2px 7px', color: 'var(--text-faint)' }}>{r}</span>
          ))}
        </div>
      )}
      {steps && (
        <div style={{ fontSize: '0.79rem', color: 'var(--text-dim)', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{steps}</div>
      )}
      {notes && (
        <div style={{ fontSize: '0.74rem', color: 'var(--text-faint)', marginTop: 6, fontStyle: 'italic', lineHeight: 1.5 }}>{notes}</div>
      )}
    </div>
  )
}
