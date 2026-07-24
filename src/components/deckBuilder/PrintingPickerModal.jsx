import { useState, useEffect, useRef, useId } from 'react'
import { CloseIcon, FolderTypeIcon } from '../../icons'
import { sb } from '../../lib/supabase'
import { fetchCardsByScryfallIds } from '../../lib/deckBuilderApi'
import { overlaySharedCardPrices } from '../../lib/sharedCardPrices'
import { getPrice, formatPrice } from '../../lib/scryfall'
import { FOLDER_TAG_COLOR, FOLDER_TAG_BORDER } from '../../lib/folderTagColors'
import { formatAttractionLights } from '../../lib/attractions'
import { Button, useModalKeys } from '../UI'
import { useSettings } from '../SettingsContext'
import CardThumb from '../CardThumb'
import styles from './PrintingPickerModal.module.css'

export default function PrintingPickerModal({ cardName, options, selectedCardId, onSelect, onClose }) {
  const { price_source } = useSettings()
  const [details, setDetails] = useState([])
  const [sourceByCardId, setSourceByCardId] = useState(() => new Map())
  const [priceByScryfallId, setPriceByScryfallId] = useState(() => new Map())
  const modalRef = useRef(null)
  const titleId = useId()
  useModalKeys(modalRef, { onClose })

  useEffect(() => {
    let cancelled = false
    async function load() {
      const ids = [...new Set(options.map(option => option.scryfall_id).filter(Boolean))]
      const cardIds = [...new Set(options.map(option => option.card_id).filter(Boolean))]

      // Set names come from card metadata; source placements are looked up by the
      // owned card_id (folder_cards / deck_allocations are RLS-scoped to the user).
      const [fetched, folderCardsRes, deckAllocRes] = await Promise.all([
        ids.length ? fetchCardsByScryfallIds(ids) : Promise.resolve([]),
        cardIds.length ? sb.from('folder_cards').select('card_id, folder_id, qty').in('card_id', cardIds) : Promise.resolve({ data: [] }),
        cardIds.length ? sb.from('deck_allocations').select('card_id, deck_id, qty').in('card_id', cardIds) : Promise.resolve({ data: [] }),
      ])
      if (cancelled) return

      const byId = new Map(fetched.map(card => [card.id, card]))
      setDetails(options.map(option => {
        const sf = option.scryfall_id ? byId.get(option.scryfall_id) : null
        return {
          ...option,
          set_name: sf?.set_name || (option.set_code ? String(option.set_code).toUpperCase() : 'Unknown set'),
          lights: sf ? formatAttractionLights(sf) : '',
        }
      }))

      const folderCards = folderCardsRes.data || []
      const deckAllocs = deckAllocRes.data || []
      const folderIds = [...new Set([...folderCards.map(r => r.folder_id), ...deckAllocs.map(r => r.deck_id)])]
      const { data: folderRows } = folderIds.length
        ? await sb.from('folders').select('id, name, type').in('id', folderIds)
        : { data: [] }
      if (cancelled) return

      const folderById = new Map((folderRows || []).map(folder => [folder.id, folder]))
      const src = new Map()
      const addPart = (cardId, folder, qty) => {
        if (!folder) return
        const list = src.get(cardId) || []
        list.push({ name: folder.name, type: folder.type, qty: qty || 0 })
        src.set(cardId, list)
      }
      for (const row of folderCards) addPart(row.card_id, folderById.get(row.folder_id), row.qty)
      for (const row of deckAllocs) addPart(row.card_id, folderById.get(row.deck_id), row.qty)
      setSourceByCardId(src)

      // Shared market prices, keyed by set+collector like the deck builder.
      const priceCards = options
        .map(option => ({ scryfall_id: option.scryfall_id, set_code: option.set_code, collector_number: option.collector_number }))
        .filter(card => card.scryfall_id && card.set_code && card.collector_number)
      if (priceCards.length) {
        const priceMap = await overlaySharedCardPrices(priceCards, {})
        if (cancelled) return
        const next = new Map()
        for (const card of priceCards) {
          const entry = priceMap[`${String(card.set_code).toLowerCase()}-${card.collector_number}`]
          if (entry) next.set(card.scryfall_id, entry)
        }
        setPriceByScryfallId(next)
      }
    }
    load()
    return () => { cancelled = true }
  }, [options])

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div ref={modalRef} className={styles.modal} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className={styles.header}>
          <div style={{ minWidth: 0 }}>
            <div id={titleId} className={styles.title}>Choose owned printing</div>
            <div className={styles.subtitle}>Pick which owned copy of {cardName} to use. Hover or tap a card to enlarge it.</div>
          </div>
          <button onClick={onClose} className={styles.closeBtn} aria-label="Close"><CloseIcon size={13} /></button>
        </div>

        <div className={styles.body}>
          <div className={styles.grid}>
            {details.map(option => {
              const selected = selectedCardId === option.card_id
              const parts = sourceByCardId.get(option.card_id) || []
              const priceEntry = priceByScryfallId.get(option.scryfall_id)
              const priceValue = priceEntry ? getPrice(priceEntry, !!option.foil, { price_source }) : null
              return (
                <div key={option.card_id} className={`${styles.tile} ${selected ? styles.tileSelected : ''}`}>
                  <CardThumb scryfallId={option.scryfall_id} name={option.name} variant="card" fill />
                  <div className={styles.info}>
                    <div className={styles.setName}>{option.set_name}</div>
                    <div className={styles.meta}>
                      {option.set_code ? `${String(option.set_code).toUpperCase()} #${option.collector_number || '?'}` : 'Owned printing'}{option.foil ? ' · foil' : ''}
                    </div>
                    <div className={styles.availRow}>
                      <span className={styles.meta}>{option.available_qty}× available</span>
                      <span className={`${styles.price} ${priceValue == null ? styles.priceNa : ''}`}>
                        {priceValue != null ? formatPrice(priceValue, price_source) : '—'}
                      </span>
                    </div>
                    {option.lights && <div className={styles.lights}>Lights {option.lights}</div>}
                    {parts.length ? (
                      <div className={styles.sourceRow}>
                        {parts.map((part, i) => (
                          <span
                            key={i}
                            className={styles.locBadge}
                            style={{ background: FOLDER_TAG_COLOR[part.type], borderColor: FOLDER_TAG_BORDER[part.type] }}
                            title={`${part.type}: ${part.name}`}
                          >
                            <FolderTypeIcon type={part.type} size={11} />
                            {part.name}{part.qty > 1 ? ` ×${part.qty}` : ''}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.locUnknown}>Location unknown</div>
                    )}
                  </div>
                  <Button
                    variant={selected ? 'primary' : 'secondary'}
                    size="sm"
                    block
                    onClick={() => onSelect(option.card_id)}
                  >
                    {selected ? 'Selected' : 'Use this printing'}
                  </Button>
                </div>
              )
            })}
          </div>
        </div>

        <div className={styles.footer}>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  )
}
