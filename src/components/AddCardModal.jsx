import { useState } from 'react'
import { sb } from '../lib/supabase'
import { Modal, Button, ErrorBox } from './UI'
import styles from './AddCardModal.module.css'

export default function AddCardModal({ userId, onClose, onSaved, prefillCard = null }) {
  const [name, setName] = useState(prefillCard?.name || '')
  const [setCode, setSetCode] = useState(prefillCard?.set_code || '')
  const [collectorNumber, setCollectorNumber] = useState(prefillCard?.collector_number || '')
  const [foil, setFoil] = useState(prefillCard?.foil || false)
  const [qty, setQty] = useState(prefillCard?.qty || 1)
  const [condition, setCondition] = useState(prefillCard?.condition || 'near_mint')
  const [language, setLanguage] = useState(prefillCard?.language || 'en')
  const [purchasePrice, setPurchasePrice] = useState(prefillCard?.purchase_price || 0)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!name || !setCode) { setError('Name and set code are required.'); return }
    setSaving(true); setError('')
    const card = {
      user_id: userId,
      name: name.trim(),
      set_code: setCode.trim().toLowerCase(),
      collector_number: collectorNumber.trim() || null,
      foil,
      qty: parseInt(qty) || 1,
      condition,
      language,
      purchase_price: parseFloat(purchasePrice) || 0,
      currency: 'EUR',
    }
    const { error: err } = prefillCard?.id
      ? await sb.from('cards').update(card).eq('id', prefillCard.id)
      : await sb.from('cards').upsert(card, { onConflict: 'user_id,set_code,collector_number,foil,language,condition' })
    if (err) setError(err.message)
    else onSaved()
    setSaving(false)
  }

  return (
    <Modal onClose={onClose}>
      <h2 className={styles.title}>{prefillCard?.id ? 'Edit Card' : 'Add Card'}</h2>
      <div className={styles.form}>
        <div className={styles.row}>
          <div className={styles.field}>
            <label>Card Name *</label>
            <input className={styles.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Lightning Bolt" />
          </div>
        </div>
        <div className={styles.row2}>
          <div className={styles.field}>
            <label>Set Code *</label>
            <input className={styles.input} value={setCode} onChange={e => setSetCode(e.target.value)} placeholder="e.g. lea" />
          </div>
          <div className={styles.field}>
            <label>Collector #</label>
            <input className={styles.input} value={collectorNumber} onChange={e => setCollectorNumber(e.target.value)} placeholder="e.g. 161" />
          </div>
        </div>
        <div className={styles.row2}>
          <div className={styles.field}>
            <label>Quantity</label>
            <input className={styles.input} type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} />
          </div>
          <div className={styles.field}>
            <label>Purchase Price (EUR)</label>
            <input className={styles.input} type="number" min="0" step="0.01" value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} />
          </div>
        </div>
        <div className={styles.row2}>
          <div className={styles.field}>
            <label>Condition</label>
            <select className={styles.input} value={condition} onChange={e => setCondition(e.target.value)}>
              <option value="near_mint">Near Mint</option>
              <option value="lightly_played">Lightly Played</option>
              <option value="moderately_played">Moderately Played</option>
              <option value="heavily_played">Heavily Played</option>
              <option value="damaged">Damaged</option>
            </select>
          </div>
          <div className={styles.field}>
            <label>Language</label>
            <input className={styles.input} value={language} onChange={e => setLanguage(e.target.value)} placeholder="en" />
          </div>
        </div>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={foil} onChange={e => setFoil(e.target.checked)} />
          Foil
        </label>
        <ErrorBox>{error}</ErrorBox>
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Card'}</Button>
        </div>
      </div>
    </Modal>
  )
}
