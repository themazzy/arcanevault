import { Modal } from '../UI'
import { CloseIcon } from '../../icons'
import styles from '../../pages/DeckBuilder.module.css'

/**
 * Description + tags editor modal. Inputs are controlled by the parent so the
 * page can keep description/tags in its deckMeta state.
 */
export default function DeckMetaModal({
  description,
  onDescriptionChange,
  onDescriptionBlur,
  tags,
  newTagInput,
  onNewTagChange,
  onAddTag,
  onRemoveTag,
  onClose,
}) {
  return (
    <Modal onClose={onClose} className={styles.metaModal}>
      <div className={styles.metaModalBody}>
        <h3 className={styles.metaModalTitle}>Description &amp; Tags</h3>
        <label className={styles.metaModalLabel}>Description / Primer</label>
        <textarea
          className={styles.deckMetaDesc}
          value={description}
          onChange={e => onDescriptionChange(e.target.value)}
          onBlur={e => onDescriptionBlur(e.target.value)}
          placeholder={'Write a primer… Markdown supported:\n# Heading   **bold**   *italic*   - list   [link](https://…)'}
          rows={8}
          maxLength={8000}
          autoFocus
        />
        <div className={styles.metaModalHint}>
          Markdown supported — headings (##) build a table of contents on the public deck page.
        </div>
        <label className={styles.metaModalLabel}>Tags</label>
        <div className={styles.deckMetaTagRow}>
          {tags.map(tag => (
            <span key={tag} className={styles.deckMetaTag}>
              {tag}
              <button className={styles.deckMetaTagRemove} onClick={() => onRemoveTag(tag)}><CloseIcon size={13} /></button>
            </span>
          ))}
          <input
            className={styles.deckMetaTagInput}
            value={newTagInput}
            onChange={e => onNewTagChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); onAddTag(newTagInput) } }}
            onBlur={() => { if (newTagInput.trim()) onAddTag(newTagInput) }}
            placeholder={tags.length === 0 ? 'Add tags...' : '+'}
            maxLength={30}
          />
        </div>
        <div className={styles.metaModalFooter}>
          <button className={styles.headerBtnPrimary} onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  )
}
