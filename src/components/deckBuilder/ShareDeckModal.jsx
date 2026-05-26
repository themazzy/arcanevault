import { Link } from 'react-router-dom'
import { Modal } from '../UI'
import { ShareIcon } from '../../icons'
import styles from '../../pages/DeckBuilder.module.css'

/**
 * Public-share confirmation modal. Shown after a successful share-link
 * generation (or when the deck is already public and re-shared).
 *
 * `state` shape: { url, copied, madePublic, error }
 */
export default function ShareDeckModal({ state, deckId, onCopyLink, onClose }) {
  if (!state) return null
  return (
    <Modal onClose={onClose} className={styles.shareModal}>
      <div className={styles.shareModalBody}>
        <div className={styles.shareModalIcon}>
          <ShareIcon size={22} />
        </div>
        <h3 className={styles.shareModalTitle}>Share Deck</h3>
        {state.error ? (
          <p className={styles.shareModalText}>{state.error}</p>
        ) : (
          <p className={styles.shareModalText}>
            {state.madePublic
              ? 'This deck was switched to public and the share link is in your clipboard.'
              : state.copied
                ? 'The share link is in your clipboard.'
                : 'This deck is public. Copy the link below to share it.'}
          </p>
        )}
        <div className={styles.shareLinkBox}>
          <input className={styles.shareLinkInput} value={state.url} readOnly onFocus={e => e.target.select()} />
          <button
            className={styles.shareCopyBtn}
            onClick={() => onCopyLink(state.url)}
          >
            Copy
          </button>
        </div>
        {!state.copied && !state.error && (
          <div className={styles.shareModalNote}>Clipboard access was blocked by the browser, so the link is ready to copy manually.</div>
        )}
        <div className={styles.shareModalFooter}>
          <Link className={styles.headerLink} to={`/d/${deckId}`} onClick={onClose}>
            Open Public View
          </Link>
          <button className={styles.headerBtnPrimary} onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  )
}
