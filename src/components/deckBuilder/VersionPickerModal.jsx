import { useState, useEffect, useRef, useId } from 'react'
import { fetchPaperPrintings } from '../../lib/deckBuilderApi'
import { loadLocalPlacementSnapshot, refreshRemotePlacementSnapshot } from '../../lib/deckPlacementData'
import { overlaySharedCardPrices } from '../../lib/sharedCardPrices'
import { getPrice, formatPrice } from '../../lib/scryfall'
import { FOLDER_TAG_COLOR, FOLDER_TAG_BORDER } from '../../lib/folderTagColors'
import { normalizeCardName } from '../../lib/deckBuilderHelpers'
import { CloseIcon, FolderTypeIcon } from '../../icons'
import { formatAttractionLights } from '../../lib/attractions'
import { Button, useModalKeys } from '../UI'
import CardThumb from '../CardThumb'
import styles from './VersionPickerModal.module.css'

// Keep in sync with `.grid`'s minmax. `fill` tiles size to the parent, so the
// tier can only follow the width the caller knows about.
const VERSION_TILE_W = 190

function LocationBadges({ locations }) {
  if (!locations?.length) return null
  const visible = locations.slice(0, 2)
  const extra = locations.length - visible.length
  return (
    <div className={styles.sourceRow}>
      {visible.map((loc, i) => (
        <span
          key={`${loc.type}-${loc.id || loc.name}-${i}`}
          className={styles.locBadge}
          style={{ background: FOLDER_TAG_COLOR[loc.type], borderColor: FOLDER_TAG_BORDER[loc.type] }}
          title={`${loc.type}: ${loc.name}${loc.qty ? ` (${loc.qty}x)` : ''}`}
        >
          <FolderTypeIcon type={loc.type} size={11} />
          {loc.name}{loc.qty > 1 ? ` ×${loc.qty}` : ''}
        </span>
      ))}
      {extra > 0 && <span className={styles.locMore}>+{extra}</span>}
    </div>
  )
}

export default function VersionPickerModal({ dc, ownedMap, userId, priceSource = 'cardmarket_trend', onSelect, onClose }) {
  const [printings, setPrintings] = useState([])
  const [loading, setLoading] = useState(true)
  const [locationsByScryfallId, setLocationsByScryfallId] = useState(() => new Map())
  const [priceByScryfallId, setPriceByScryfallId] = useState(() => new Map())
  const modalRef = useRef(null)
  const titleId = useId()
  useModalKeys(modalRef, { onClose })

  useEffect(() => {
    let cancelled = false

    const buildLocations = (snapshot) => {
      const ownedById = new Map((snapshot?.cards || [])
        .filter(row => normalizeCardName(row.name) === normalizeCardName(dc.name))
        .map(row => [row.id, row]))
      const nextLocations = new Map()
      const addLocation = (scryfallId, folder, qty) => {
        if (!scryfallId || !folder || (folder.type !== 'binder' && folder.type !== 'deck')) return
        const list = nextLocations.get(scryfallId) || []
        const existing = list.find(loc => loc.id === folder.id && loc.type === folder.type)
        if (existing) existing.qty += qty || 0
        else list.push({ id: folder.id, name: folder.name || 'Unknown', type: folder.type || 'binder', qty: qty || 0 })
        nextLocations.set(scryfallId, list)
      }

      for (const row of snapshot?.folderRows || []) {
        const owned = ownedById.get(row.card_id)
        addLocation(owned?.scryfall_id, snapshot.folderById.get(row.folder_id), row.qty)
      }
      for (const row of snapshot?.deckRows || []) {
        const owned = ownedById.get(row.card_id)
        addLocation(owned?.scryfall_id, snapshot.folderById.get(row.deck_id), row.qty)
      }
      return nextLocations
    }

    async function load() {
      setLoading(true)
      try {
        const [rawPrintings, localSnapshot] = await Promise.all([
          fetchPaperPrintings(dc.name),
          userId ? loadLocalPlacementSnapshot(userId, { names: [dc.name] }) : Promise.resolve(null),
        ])
        if (!cancelled) {
          const sorted = [
            ...rawPrintings.filter(p => (ownedMap.get(p.id) ?? 0) > 0),
            ...rawPrintings.filter(p => (ownedMap.get(p.id) ?? 0) === 0),
          ]
          setPrintings(sorted)
          setLocationsByScryfallId(buildLocations(localSnapshot))
          setLoading(false)

          const priceCards = rawPrintings
            .map(p => ({ scryfall_id: p.id, set_code: p.set, collector_number: p.collector_number }))
            .filter(c => c.scryfall_id && c.set_code && c.collector_number)
          if (priceCards.length) {
            overlaySharedCardPrices(priceCards, {})
              .then(map => {
                if (cancelled) return
                const next = new Map()
                for (const card of priceCards) {
                  const entry = map[`${String(card.set_code).toLowerCase()}-${card.collector_number}`]
                  if (entry) next.set(card.scryfall_id, entry)
                }
                setPriceByScryfallId(next)
              })
              .catch(err => console.warn('[VersionPicker] shared price load failed:', err?.message || err))
          }
        }

        if (userId) {
          const remoteSnapshot = await refreshRemotePlacementSnapshot(userId, { names: [dc.name] })
          if (!cancelled) setLocationsByScryfallId(buildLocations(remoteSnapshot))
        }
      } catch {
        if (!cancelled) setLocationsByScryfallId(new Map())
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [dc.name, userId, ownedMap])

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div ref={modalRef} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className={styles.header}>
          <div style={{ minWidth: 0 }}>
            <div id={titleId} className={styles.title}>Choose version</div>
            <div className={styles.subtitle}>Pick which printing of {dc.name} to use. Hover or tap a card to enlarge it.</div>
          </div>
          <button onClick={onClose} className={styles.closeBtn} aria-label="Close"><CloseIcon size={13} /></button>
        </div>

        <div className={styles.body}>
          {loading ? (
            <div className={styles.loading}>Loading printings…</div>
          ) : (
            <div className={styles.grid}>
              {printings.map(p => {
                const owned = ownedMap.get(p.id) ?? 0
                const isActive = p.id === dc.scryfall_id
                const locations = locationsByScryfallId.get(p.id) || []
                const priceEntry = priceByScryfallId.get(p.id)
                const priceValue = priceEntry ? getPrice(priceEntry, !!dc.foil, { price_source: priceSource }) : null
                const lights = formatAttractionLights(p)
                return (
                  <div key={p.id} className={`${styles.tile} ${isActive ? styles.tileSelected : ''}`}>
                    <CardThumb scryfallId={p.id} name={p.set_name} variant="card" fill renderWidth={VERSION_TILE_W} />
                    <div className={styles.info}>
                      <div className={styles.setName}>{p.set_name}{p.collector_number ? ` #${p.collector_number}` : ''}</div>
                      <div className={styles.availRow}>
                        <span className={styles.meta}>{owned > 0 ? `${owned}× owned` : 'Not owned'}</span>
                        <span className={`${styles.price} ${priceValue == null ? styles.priceNa : ''}`}>
                          {priceValue != null ? formatPrice(priceValue, priceSource) : '—'}
                        </span>
                      </div>
                      {lights && <div className={styles.lights}>Lights {lights}</div>}
                      <LocationBadges locations={locations} />
                    </div>
                    <Button
                      variant={isActive ? 'primary' : 'secondary'}
                      size="sm"
                      block
                      onClick={() => onSelect(p)}
                    >
                      {isActive ? 'Current version' : 'Use this version'}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className={styles.footer}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}
