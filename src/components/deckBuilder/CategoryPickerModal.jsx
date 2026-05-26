import { useState } from 'react'
import { Modal } from '../UI'
import { CheckIcon } from '../../icons'
import styles from '../../pages/DeckBuilder.module.css'

// Modal that lets the user manually pin a deck card to a category, clear a
// manual pin (falling back to the inferred category), or create a brand-new
// custom category on the fly.
export function CategoryPickerModal({ card, categories, onSelect, onCreate, onClear, onClose }) {
  const [newName, setNewName] = useState('')

  return (
    <Modal onClose={onClose} className={styles.categoryPickerModal}>
      <div className={styles.categoryPickerBody}>
        <div className={styles.categoryPickerTitle}>Change Category</div>
        <div className={styles.categoryPickerCard}>{card?.name}</div>
        <div className={styles.categoryPickerList}>
          {categories.map(category => (
            <button
              key={category.id || category.name}
              className={`${styles.categoryPickerOption}${card?.category_id && category.id === card.category_id ? ' ' + styles.categoryPickerOptionActive : ''}`}
              onClick={() => onSelect(category)}
            >
              <span>{category.name}</span>
              {card?.category_id && category.id === card.category_id && <CheckIcon size={13} />}
            </button>
          ))}
          {card?.category_id && (
            <button className={styles.categoryPickerOption} onClick={onClear}>
              <span>Use Inferred Category</span>
            </button>
          )}
        </div>
        <div className={styles.categoryCreateRow}>
          <input
            className={styles.categoryCreateInput}
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New category"
          />
          <button
            className={styles.categoryCreateBtn}
            onClick={() => {
              if (!newName.trim()) return
              onCreate(newName)
            }}
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  )
}
