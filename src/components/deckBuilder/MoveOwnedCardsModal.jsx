import { useState } from 'react'
import { CloseIcon } from '../../icons'
import { Select } from '../UI'

export default function MoveOwnedCardsModal({ title, message, items, folders, onConfirm, onClose }) {
  const [targetId, setTargetId] = useState('')
  const [busy, setBusy] = useState(false)
  const canConfirm = !!targetId && !busy

  const overlay = { position:'fixed', inset:0, background:'rgba(0,0,0,0.75)', zIndex:720, display:'flex', alignItems:'center', justifyContent:'center' }
  const inputStyle = { background:'var(--bg3)', border:'1px solid var(--border)', borderRadius:4, padding:'8px 10px', color:'var(--text)', fontSize:'0.84rem', width:'100%' }

  async function handleConfirm() {
    const target = folders.find(folder => folder.id === targetId)
    if (!target) return
    setBusy(true)
    try {
      await onConfirm(target)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:8, width:520, maxWidth:'94vw', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <span style={{ fontFamily:'var(--font-display)', color:'var(--gold)', fontSize:'1rem' }}>{title}</span>
          <button onClick={onClose} disabled={busy} style={{ background:'none', border:'none', color:'var(--text-faint)', fontSize:'1.2rem', cursor:busy ? 'default' : 'pointer' }}><CloseIcon size={13} /></button>
        </div>
        <div style={{ padding:'16px 20px', display:'flex', flexDirection:'column', gap:14 }}>
          <p style={{ margin:0, color:'var(--text-dim)', fontSize:'0.84rem', lineHeight:1.6 }}>{message}</p>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {items.map(item => (
              <div key={item.key} style={{ display:'flex', justifyContent:'space-between', fontSize:'0.84rem', color:'var(--text)' }}>
                <span>{item.name}</span>
                <span style={{ color:'var(--text-faint)' }}>{item.qty}x</span>
              </div>
            ))}
          </div>
          <Select value={targetId} onChange={e => setTargetId(e.target.value)} style={inputStyle} title="Select destination" portal searchable>
            <option value="">Select binder or deck</option>
            {folders.map(folder => (
              <option key={folder.id} value={folder.id}>
                {folder.type === 'binder' ? 'Binder' : 'Deck'}: {folder.name}
              </option>
            ))}
          </Select>
          {folders.length === 0 && (
            <div style={{ color:'#d48d6a', fontSize:'0.8rem' }}>
              No other binders or decks are available. Create one first, then try again.
            </div>
          )}
        </div>
        <div style={{ padding:'12px 20px', borderTop:'1px solid var(--border)', display:'flex', justifyContent:'flex-end', gap:8 }}>
          <button onClick={onClose} disabled={busy} style={{ background:'none', border:'1px solid var(--border)', borderRadius:4, padding:'7px 16px', color:'var(--text-dim)', fontSize:'0.83rem', cursor:busy ? 'default' : 'pointer' }}>Cancel</button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            style={{ background:'rgba(74,154,90,0.15)', border:'1px solid rgba(74,154,90,0.4)', borderRadius:4, padding:'7px 16px', color:'var(--green, #4a9a5a)', fontSize:'0.83rem', cursor:canConfirm ? 'pointer' : 'not-allowed', opacity:canConfirm ? 1 : 0.45 }}>
            {busy ? 'Moving...' : 'Move & Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
