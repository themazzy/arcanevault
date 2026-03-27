import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { Button, Checkbox, Modal, SectionHeader, Spinner } from './UI'
import styles from './MoveCardsModal.module.css'

// ── MoveCardsModal ────────────────────────────────────────────────────────────
// When moving from a binder, show collection-type selector (decks/bindings/wishlists)
// then show a filtered list of available destinations with create new option
function FolderTypeIcon({ type }) {
  if (type === 'binder') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="42" height="42">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" stroke="currentColor" strokeWidth="1.8"/>
        <path d="M6.5 2H20v2H6.5a2.5 2.5 0 0 1-2.5-2.5V3.5a3.5 3.5 0 0 0-3.5 3.5V17" stroke="currentColor" strokeWidth="1.8"/>
        <path d="M14 20.5v-1.5a3 3 0 0 0-3-3H9" stroke="currentColor" strokeWidth="1.8"/>
      </svg>
    )
  }
  if (type === 'deck') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="42" height="42">
        <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.8"/>
        <path d="M2 10h18M6 3v3M18 3v3" stroke="currentColor" strokeWidth="1.8"/>
        <path d="M4 20a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3.5a1.5 1.5 0 0 0-1.5-1.5h-9a1.5 1.5 0 0 0-1.5 1.5V20" stroke="currentColor" strokeWidth="1.8"/>
      </svg>
    )
  }
  // wishlist (list)
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" width="42" height="42">
      <path d="M4.5 12.5L12 20l7.5-7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M4 17v3c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

export default function MoveCardsModal({
  onClose,
  selectedCards,     // Set<Card> - cards to move (from parent)
  folder,            // Folder - current binder folder (from parent)
  folders,           // all folders (excluding current binder)
  user,
  cardCount,         // total copies selected
  targetFolders,     // folders filtered by collection type (optional)
  onCreateFolder,    // callback when new folder is created
}) {
  const [selectedType, setSelectedType] = useState(null)  // 'binder'|'deck'|'list'
  const [foldersByType, setFoldersByType] = useState({
    binder: [],
    deck: [],
    list: []
  })
  const [creating, setCreating] = useState(false)
  const [createType, setCreateType] = useState('binder')
  const [createName, setCreateName] = useState('')
  const [saving, setSaving] = useState(false)

  // Group folders by type
  useEffect(() => {
    const grouped = { binder: [], deck: [], list: [] }
    folders.forEach(f => {
      if (!f.type || f.isGroup) return
      if (['binder', 'deck', 'list'].includes(f.type)) {
        grouped[f.type].push(f)
      }
    })
    setFoldersByType(grouped)
  }, [folders])

  // Filter by selected type (if any)
  const filtered = selectedType
    ? foldersByType[selectedType] || []
    : [...foldersByType.binder, ...foldersByType.deck, ...foldersByType.list]

  const handleCreate = async () => {
    if (!createName.trim()) return
    setSaving(true)
    try {
      const name = createName.trim()
      const type = createType
      // Check for duplicates
      const existing = foldersByType[type].find(f => f.name.toLowerCase() === name.toLowerCase())
      if (existing) {
        setCreating(false)
        setSaving(false)
        return
      }
      const { data } = await sb.from('folders').insert({
        name,
        type,
        owner_id: user.id
      }).select().single()
      if (data) {
        onCreateFolder?.(type, name)
        setCreating(false)
        setCreateName('')
        setSelectedType(type)
      }
    } finally {
      setSaving(false)
    }
  }

  // Get the folder we're moving cards from (we'll use it in the UI)
  const movingFolder = folders.find(f => f.isMoving)

  return (
    <>
      {/* Collection type selector */}
      {!selectedType && (
        <Modal onClose={onClose}>
          <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', marginBottom: 16, fontSize: '1.1rem' }}>
            Move {cardCount === 1 ? `${cardCount} card` : `${cardCount} cards`}
          </h2>
          <p style={{ color: 'var(--text-dim)', marginBottom: 20, fontSize: '0.9rem' }}>
            Choose which collection to move them to:
          </p>

          <div className={styles.typeGrid}>
            <button
              className={`${styles.typeBtn} ${selectedType === 'binder' ? styles.typeBtnActive : ''}`}
              onClick={() => setSelectedType('binder')}
            >
              <FolderTypeIcon type="binder" />
              <span>Binders</span>
              {foldersByType.binder.length + 1 && <span className={styles.count}>(+1)</span>}
            </button>
            <button
              className={`${styles.typeBtn} ${selectedType === 'deck' ? styles.typeBtnActive : ''}`}
              onClick={() => setSelectedType('deck')}
            >
              <FolderTypeIcon type="deck" />
              <span>Decks</span>
              {foldersByType.deck.length + 1 && <span className={styles.count}>(+1)</span>}
            </button>
            <button
              className={`${styles.typeBtn} ${selectedType === 'list' ? styles.typeBtnActive : ''}`}
              onClick={() => setSelectedType('list')}
            >
              <FolderTypeIcon type="list" />
              <span>Wishlists</span>
              {foldersByType.list.length + 1 && <span className={styles.count}>(+1)</span>}
            </button>
          </div>
        </Modal>
      )}

      // Handle moving cards to a folder
      const handleMove = async (targetFolder) => {
        if (!targetFolder?.id) return
        const ids = Array.from(selectedCards)
        const rows = ids.map(id => ({ folder_id: targetFolder.id, card_id: id, qty: 1 }))
        await sb.from('folder_cards').upsert(rows, { onConflict: 'folder_id,card_id', ignoreDuplicates: true })
        await sb.from('folder_cards').delete().eq('folder_id', movingFolder?.id).in('card_id', ids)
      }

      // Folder list + create new */
      {selectedType && (
        <Modal onClose={onClose}>
          <div className={styles.modalContent}>
            <div className={styles.header}>
              <div>
                <h2 style={{ fontFamily: 'var(--font-display)', color: 'var(--gold)', margin: 0, fontSize: '1.1rem' }}>
                  {selectedType === 'list' ? 'Wishlists' : selectedType.charAt(0).toUpperCase() + selectedType.slice(1)}s
                </h2>
                <p style={{ color: 'var(--text-dim)', fontSize: '0.88rem' }}>
                  {cardCount === 1
                    ? `Move 1 copy of`
                    : `Move ${cardCount} copies of`}
                  <strong>{folders.find(f => f.isMoving)?.name}</strong>
                </p>
              </div>
              <Button variant="ghost" icon={true} onClick={onClose}>✕</Button>
            </div>

            {/* Create new folder */}
            {!creating ? (
              <button className={styles.createBtn} onClick={() => setCreating(true)}>
                + Create New {selectedType.charAt(0).toUpperCase() + selectedType.slice(1)}
              </button>
            ) : (
              <div className={styles.createForm}>
                <select
                  className={styles.createSelect}
                  value={createType}
                  onChange={e => setCreateType(e.target.value)}
                >
                  <option value="binder">Binder</option>
                  <option value="deck">Deck</option>
                  <option value="list">Wishlist</option>
                </select>
                <input
                  autoFocus
                  className={styles.createInput}
                  value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleCreate()
                    if (e.key === 'Escape') setCreating(false)
                  }}
                  placeholder={`Name new ${selectedType}…`}
                />
                <div className={styles.createActions}>
                  <Button onClick={handleCreate} disabled={saving || !createName.trim()}>
                    {saving ? '…' : 'Create & Move'}
                  </Button>
                  <button className={styles.createCancel} onClick={() => setCreating(false)}>✕</button>
                </div>
              </div>
            )}

            {/* Folder list */}
            {filtered.length > 0 && (
              <div className={styles.folderList}>
                {filtered.map(f => (
                  <label
                    key={f.id}
                    className={styles.folderItem}
                    onClick={() => {
                      handleMove(f)
                      onClose()
                    }}
                  >
                    <input
                      type="checkbox"
                      checked
                      readOnly
                    />
                    <div className={styles.folderIcon}>
                      <FolderTypeIcon type={f.type} />
                    </div>
                    <div className={styles.folderInfo}>
                      <span className={styles.folderName}>{f.name}</span>
                      {f.cardCount > 0 && (
                        <span className={styles.folderCount}>{f.cardCount} {f.cardCount === 1 ? 'card' : 'cards'}</span>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
}