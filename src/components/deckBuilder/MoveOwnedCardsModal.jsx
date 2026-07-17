import { useState } from 'react'
import { Button, Modal, Select } from '../UI'
import styles from './MoveOwnedCardsModal.module.css'

export default function MoveOwnedCardsModal({ title, message, items, folders, onConfirm, onClose }) {
  const [targetId, setTargetId] = useState('')
  const [busy, setBusy] = useState(false)
  const canConfirm = !!targetId && !busy

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

  // A move is in flight — don't let Escape or an overlay click strand it.
  // The hand-rolled overlay this replaced had no Escape at all, so this is a
  // new affordance that needs the same guard the Cancel button always had.
  const guardedClose = () => { if (!busy) onClose() }

  return (
    <Modal
      onClose={guardedClose}
      closeOnOverlay={!busy}
      closeOnEscape={!busy}
      className={styles.modal}
    >
      <h3 className={styles.title}>{title}</h3>

      <div className={styles.body}>
        <p className={styles.message}>{message}</p>

        <div className={styles.items}>
          {items.map(item => (
            <div key={item.key} className={styles.item}>
              <span>{item.name}</span>
              <span className={styles.itemQty}>{item.qty}x</span>
            </div>
          ))}
        </div>

        <Select value={targetId} onChange={e => setTargetId(e.target.value)} title="Select destination" portal searchable>
          <option value="">Select binder or deck</option>
          {folders.map(folder => (
            <option key={folder.id} value={folder.id}>
              {folder.type === 'binder' ? 'Binder' : 'Deck'}: {folder.name}
            </option>
          ))}
        </Select>

        {folders.length === 0 && (
          <div className={styles.warning}>
            No other binders or decks are available. Create one first, then try again.
          </div>
        )}
      </div>

      <div className={styles.actions}>
        <Button variant="secondary" size="sm" onClick={guardedClose} disabled={busy}>Cancel</Button>
        <Button variant="green" size="sm" onClick={handleConfirm} disabled={!canConfirm}>
          {busy ? 'Moving…' : 'Move & Continue'}
        </Button>
      </div>
    </Modal>
  )
}
