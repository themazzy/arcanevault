import { useMemo, useState } from 'react'
import { Badge, ResponsiveMenu } from './UI'
import { getPrice, formatPrice, getScryfallKey } from '../lib/scryfall'
import { useLongPress } from '../hooks/useLongPress'
import uiStyles from './UI.module.css'
import styles from '../pages/DeckBrowser.module.css'

const TYPE_ORDER = ['Commander', 'Creatures', 'Planeswalkers', 'Battles', 'Instants',
  'Sorceries', 'Artifacts', 'Enchantments', 'Lands', 'Other']

const CAT_ORDER = ['Ramp', 'Mana Rock', 'Card Draw', 'Removal', 'Board Wipe',
  'Counterspell', 'Tutor', 'Burn', 'Tokens', 'Graveyard', 'Protection',
  'Extra Turns', 'Combo', 'Creature', 'Artifact', 'Enchantment',
  'Instant', 'Sorcery', 'Planeswalker', 'Land', 'Other']

const CAT_COLORS = {
  Ramp: '#4a9a5a',
  'Mana Rock': '#5a8a9a',
  'Card Draw': '#5a70bb',
  Removal: '#cc5555',
  'Board Wipe': '#aa3333',
  Counterspell: '#4470cc',
  Tutor: '#9a5abb',
  Burn: '#e07020',
  Tokens: '#6a9a4a',
  Graveyard: '#7a4a8a',
  Protection: '#aaaaaa',
  'Extra Turns': '#cc88aa',
  Combo: '#c9a84c',
  Creature: '#5a8a5a',
  Artifact: '#8a8a9a',
  Enchantment: '#7a6aaa',
  Instant: '#5555bb',
  Sorcery: '#9944aa',
  Planeswalker: '#cc7722',
  Land: '#6a7a5a',
  Other: '#666',
}

export const CARD_BROWSER_GROUP_OPTIONS = [
  { id: 'type', label: 'By Type' },
  { id: 'category', label: 'By Function' },
  { id: 'none', label: 'Ungrouped' },
]

export const CARD_BROWSER_VIEW_MODES = [
  { id: 'list', label: 'List', desktopLabel: '≡ List' },
  { id: 'stacks', label: 'Stacks', desktopLabel: '⊟ Stacks' },
  { id: 'text', label: 'Text', desktopLabel: '¶ Text' },
  { id: 'grid', label: 'Grid', desktopLabel: '⊞ Grid' },
  { id: 'table', label: 'Table', desktopLabel: '⊞ Table' },
]

function getDisplayKey(card) {
  return card?._displayKey || card?.id
}

function getCardType(typeLine = '') {
  const tl = typeLine.toLowerCase()
  if (tl.includes('battle')) return 'Battles'
  if (tl.includes('creature')) return 'Creatures'
  if (tl.includes('planeswalker')) return 'Planeswalkers'
  if (tl.includes('instant')) return 'Instants'
  if (tl.includes('sorcery')) return 'Sorceries'
  if (tl.includes('artifact')) return 'Artifacts'
  if (tl.includes('enchantment')) return 'Enchantments'
  if (tl.includes('land')) return 'Lands'
  return 'Other'
}

function getCardCategory(card, sfCard) {
  const faceOracle = sfCard?.card_faces?.map(f => f.oracle_text || '').join('\n') || ''
  const oracle = (sfCard?.oracle_text || faceOracle).toLowerCase()
  const type = (sfCard?.type_line || sfCard?.card_faces?.[0]?.type_line || '').toLowerCase()

  if (/counter target (spell|creature spell|instant or sorcery|noncreature spell)/.test(oracle)) return 'Counterspell'
  if (/search your library for a?.*(basic )?land/.test(oracle)) return 'Ramp'
  if (type.includes('artifact') && /\{t\}.*add /.test(oracle)) return 'Mana Rock'
  if (!type.includes('land') && /add \{[wubrg2c]/.test(oracle)) return 'Ramp'
  if (/draw (two|three|four|\d+) cards|draw a card/.test(oracle)) return 'Card Draw'
  if (/(destroy|exile) all (creatures|permanents|nonland)/.test(oracle)) return 'Board Wipe'
  if (/search your library for a? ?(instant|sorcery|creature|artifact|enchantment|planeswalker)/.test(oracle) &&
      !oracle.includes('basic land')) return 'Tutor'
  if (/(exile|destroy) target (creature|permanent|artifact|enchantment|planeswalker)/.test(oracle)) return 'Removal'
  if (/deals? \d+ damage to (any target|target player|each opponent|each player)/.test(oracle)) return 'Burn'
  if (/create (a|one|two|three|four|\d+) .*token/.test(oracle)) return 'Tokens'
  if (/return.*from (your |a )?(graveyard|exile)/.test(oracle)) return 'Graveyard'
  if (/gains? hexproof|gains? indestructible|protection from/.test(oracle)) return 'Protection'
  if (/take an? extra turn/.test(oracle)) return 'Extra Turns'
  if (/infinite|whenever.*untap.*\{t\}.*\{t\}|win the game|you lose no life/.test(oracle)) return 'Combo'

  if (type.includes('land')) return 'Land'
  if (type.includes('creature')) return 'Creature'
  if (type.includes('planeswalker')) return 'Planeswalker'
  if (type.includes('instant')) return 'Instant'
  if (type.includes('sorcery')) return 'Sorcery'
  if (type.includes('artifact')) return 'Artifact'
  if (type.includes('enchantment')) return 'Enchantment'
  return 'Other'
}

function buildGroups(cards, sfMap, groupBy) {
  if (groupBy === 'none') return { groups: { All: cards }, groupOrder: ['All'] }
  const groups = {}
  const order = groupBy === 'category' ? CAT_ORDER : TYPE_ORDER
  for (const card of cards) {
    const sf = sfMap[getScryfallKey(card)]
    const key = groupBy === 'category'
      ? getCardCategory(card, sf)
      : getCardType(sf?.type_line || sf?.card_faces?.[0]?.type_line || '')
    if (!groups[key]) groups[key] = []
    groups[key].push(card)
  }
  return { groups, groupOrder: order }
}

function InlineMana({ cost, size = 14 }) {
  if (!cost) return null
  const syms = [...cost.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
  return (
    <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
      {syms.map((s, i) => (
        <img
          key={`${s}-${i}`}
          src={`https://svgs.scryfall.io/card-symbols/${s.replace(/\//g, '').toUpperCase()}.svg`}
          alt={`{${s}}`}
          style={{ width: size, height: size, verticalAlign: 'middle', display: 'inline-block', flexShrink: 0 }}
        />
      ))}
    </span>
  )
}

function TypeIcon({ type, size = 14, style }) {
  const icons = {
    Commander: <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={style}><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm2 4h10v-2H7v2z"/></svg>,
    Creatures: <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={style}><path d="M20.71 3.29a1 1 0 00-1.42 0L13 9.59l-1.29-1.3-1.42 1.42 1.3 1.29L3 19.59V21h1.41l8.59-8.59 1.29 1.3 1.42-1.42-1.3-1.29 6.3-6.29a1 1 0 000-1.42z"/><path d="M6.5 17.5l-2 2 1 1 2-2z" opacity=".5"/></svg>,
    Planeswalkers: <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={style}><circle cx="12" cy="5" r="2"/><path d="M12 9c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4zm-1 9h2l1 4h-4l1-4z"/><path d="M10 9l-3 5h2l-1 5h4l-1-5h2z" opacity=".3"/></svg>,
    Battles: <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={style}><path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm0 15l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/></svg>,
    Instants: <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={style}><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>,
    Sorceries: <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={style}><path d="M12 23c-4.97 0-9-4.03-9-9 0-4.97 3.5-8.5 7-10 .5 1.5-.5 3.5-1 4.5 1.5-1 3-2 3.5-3.5C13 8.5 14 11.5 12 14c1 0 2.5-.5 3-1.5.5 2.5-.5 5-1 6 3-1.5 5-4.5 5-8 0-5.52-4.48-10-10-10C4.48 0 0 4.48 0 10c0 5.52 4.48 10 10 10h2c-4.42 0-8-3.58-8-8 0-1.5.42-2.89 1.15-4.08C5.77 10.76 8 13.5 8 15c.5-1.5-.5-4 0-6 1 1.5 2 3 1.5 5.5C10.5 13 11 12 12 12c-1 4-4 6-4 9 0 .34.03.67.08 1H12z"/></svg>,
    Artifacts: <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={style}><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7 7 0 00-1.62-.94l-.36-2.54A.484.484 0 0014 2h-4a.484.484 0 00-.48.41l-.36 2.54a7.4 7.4 0 00-1.62.94l-2.39-.96a.48.48 0 00-.59.22L2.74 8.47c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.36 1.04.67 1.62.94l.36 2.54c.05.24.27.41.48.41h4c.24 0 .44-.17.47-.41l.36-2.54a7.4 7.4 0 001.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 00-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>,
    Enchantments: <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={style}><path d="M12 3L9.5 8.5H4l4.5 3.5L7 17.5l5-3.5 5 3.5-1.5-5.5L20 8.5h-5.5z" opacity=".35"/><path d="M12 2l1.09 3.26L16.18 4l-2.09 2.74L17 9l-3.35-.5L12 12l-1.65-3.5L7 9l2.91-2.26L7.82 4l3.09 1.26z"/></svg>,
    Lands: <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={style}><path d="M14 6l-1-2H5v17h2v-7h5l1 2h7V6h-6zm4 8h-4l-1-2H7V6h5l1 2h5v6z"/></svg>,
    Other: <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" style={style}><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/></svg>,
  }
  return icons[type] || icons.Other
}

function rowFolderMeta(card) {
  return card._folderName ? (
    <div style={{ fontSize: '0.66rem', color: 'var(--gold-dim)', marginTop: 2, letterSpacing: '0.03em' }}>
      {card._folderName}
    </div>
  ) : null
}

function TextRow({ card, selectMode, isSelected, onToggleSelect, onEnterSelectMode }) {
  const totalQty = card._folder_qty ?? card.qty ?? 1
  const key = getDisplayKey(card)
  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.(key, totalQty)
  }, { delay: 500 })
  const { onMouseLeave: lpLeave, fired: lpFired, ...lpRest } = longPress

  const handleClick = () => {
    if (lpFired.current) {
      lpFired.current = false
      return
    }
    if (selectMode) onToggleSelect?.(key, totalQty)
  }

  return (
    <div
      className={`${styles.textRow}${isSelected ? ` ${styles.textRowSelected}` : ''}${selectMode ? ` ${styles.textRowSelectable}` : ''}`}
      onClick={handleClick}
      onMouseLeave={e => { lpLeave?.(e) }}
      {...lpRest}
    >
      {selectMode && (
        <div className={`${styles.textCheckbox}${isSelected ? ` ${styles.textCheckboxChecked}` : ''}`}>
          {isSelected && '✓'}
        </div>
      )}
      <span className={styles.textQty}>{totalQty}x</span>
      <span className={styles.textName}>{card.name}{card._folderName ? ` · ${card._folderName}` : ''}</span>
      {card.foil && <span className={styles.textFoil}>✦</span>}
    </div>
  )
}

function TextView({ groups, groupOrder, selectMode, selectedCards, onToggleSelect, onEnterSelectMode, hideHeaders }) {
  return (
    <div className={styles.textView}>
      {groupOrder.filter(group => groups[group]?.length).map(group => {
        const cards = groups[group]
        const total = cards.reduce((sum, card) => sum + (card._folder_qty || card.qty || 1), 0)
        return (
          <div key={group} className={styles.textGroup}>
            {!hideHeaders && (
              <div className={styles.textGroupHeader}>
                <span style={{ color: CAT_COLORS[group] || 'var(--gold-dim)' }}>{group}</span>
                <span className={styles.textGroupCount}>{total}</span>
              </div>
            )}
            {cards
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(card => (
                <TextRow
                  key={getDisplayKey(card)}
                  card={card}
                  selectMode={selectMode}
                  isSelected={selectedCards?.has(getDisplayKey(card))}
                  onToggleSelect={onToggleSelect}
                  onEnterSelectMode={onEnterSelectMode}
                />
              ))}
          </div>
        )
      })}
    </div>
  )
}

function TableRow({ card, sf, priceSource, isSelected, selectMode, onClick, onEnterSelectMode, onToggleSelect }) {
  const totalQty = card._folder_qty ?? card.qty ?? 1
  const key = getDisplayKey(card)
  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.(key, totalQty)
  }, { delay: 500 })
  const { onMouseLeave: lpLeave, fired: lpFired, ...lpRest } = longPress
  const scryfallPrice = getPrice(sf, card.foil, { price_source: priceSource })
  const unitPrice = scryfallPrice ?? (parseFloat(card.purchase_price) || null)
  const price = unitPrice != null ? unitPrice * totalQty : null
  const mc = sf?.mana_cost || sf?.card_faces?.[0]?.mana_cost || ''
  return (
      <tr
        className={`${styles.tr}${isSelected ? ` ${styles.trSelected}` : ''}`}
        onClick={() => {
          if (lpFired.current) {
            lpFired.current = false
            return
          }
          onClick?.()
        }}
        onMouseLeave={e => { lpLeave?.(e) }}
        {...lpRest}
      >
      {selectMode && (
        <td className={styles.td} style={{ textAlign: 'center', paddingRight: 0 }}>
          <div className={`${styles.tableCheckbox}${isSelected ? ` ${styles.tableCheckboxChecked}` : ''}`}>
            {isSelected && '✓'}
          </div>
        </td>
      )}
      <td className={styles.td} style={{ textAlign: 'center', color: 'var(--text-faint)' }}>
        {totalQty}
      </td>
      <td className={styles.td}>
        <div>
          <span className={styles.tableName}>{card.name}</span>
          {card.foil && <span className={styles.tableFoil}>✦</span>}
          {rowFolderMeta(card)}
        </div>
      </td>
      <td className={styles.td} style={{ textAlign: 'center', color: 'var(--text-dim)' }}>
        <InlineMana cost={mc} size={13} />
      </td>
      <td className={styles.td} style={{ color: 'var(--text-faint)', fontSize: '0.76rem' }}>
        {(sf?.type_line || '—').split('—')[0].trim()}
      </td>
      <td className={styles.td} style={{ textAlign: 'right', fontFamily: 'var(--font-display)', fontSize: '0.8rem', color: (scryfallPrice == null && price != null) ? 'var(--text-dim)' : 'var(--green)' }}>
        {price != null ? formatPrice(price, priceSource) : '—'}
      </td>
    </tr>
  )
}

function TableView({ cards, sfMap, priceSource, onSelect, selectMode, selectedCards, onToggleSelect, onEnterSelectMode }) {
  const [sortCol, setSortCol] = useState('name')
  const [sortDir, setSortDir] = useState(1)

  const sorted = useMemo(() => {
    return [...cards].sort((a, b) => {
      const sfA = sfMap[getScryfallKey(a)]
      const sfB = sfMap[getScryfallKey(b)]
      let va
      let vb
      if (sortCol === 'name') {
        va = a.name
        vb = b.name
        return sortDir * (va < vb ? -1 : va > vb ? 1 : 0)
      }
      if (sortCol === 'cmc') {
        va = sfA?.cmc ?? 99
        vb = sfB?.cmc ?? 99
      }
      if (sortCol === 'type') {
        va = getCardType(sfA?.type_line || sfA?.card_faces?.[0]?.type_line || '')
        vb = getCardType(sfB?.type_line || sfB?.card_faces?.[0]?.type_line || '')
        return sortDir * (va < vb ? -1 : va > vb ? 1 : 0)
      }
      if (sortCol === 'price') {
        va = getPrice(sfA, a.foil, { price_source: priceSource }) ?? -1
        vb = getPrice(sfB, b.foil, { price_source: priceSource }) ?? -1
      }
      if (sortCol === 'qty') {
        va = a._folder_qty || a.qty || 1
        vb = b._folder_qty || b.qty || 1
      }
      return sortDir * (va - vb)
    })
  }, [cards, priceSource, sfMap, sortCol, sortDir])

  const arrow = col => (sortCol === col ? (sortDir > 0 ? '↑' : '↓') : '')

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {selectMode && <th className={styles.th} style={{ width: 32 }} />}
            {[['qty', 'Qty'], ['name', 'Name'], ['cmc', 'CMC'], ['type', 'Type'], ['price', 'Price']].map(([key, label]) => (
              <th
                key={key}
                className={styles.th}
                onClick={() => {
                  if (sortCol === key) setSortDir(dir => -dir)
                  else {
                    setSortCol(key)
                    setSortDir(1)
                  }
                }}
              >
                {label} <span className={styles.thArrow}>{arrow(key)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(card => {
            const key = getDisplayKey(card)
            return (
              <TableRow
                key={key}
                card={card}
                sf={sfMap[getScryfallKey(card)]}
                priceSource={priceSource}
                isSelected={selectedCards?.has(key)}
                selectMode={selectMode}
                onClick={() => selectMode ? onToggleSelect?.(key, card._folder_qty || card.qty || 1) : onSelect?.(card)}
                onEnterSelectMode={onEnterSelectMode}
                onToggleSelect={onToggleSelect}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function StackCard({ card, sf, idx, priceSource, selectMode, isSelected, onSelect, onToggleSelect, onAdjustQty, splitState, onHover, onHoverEnd, onEnterSelectMode }) {
  const img = sf?.image_uris?.normal || sf?.card_faces?.[0]?.image_uris?.normal
  const totalQty = card._folder_qty ?? card.qty ?? 1
  const scryfallPrice = getPrice(sf, card.foil, { price_source: priceSource })
  const unitPrice = scryfallPrice ?? (parseFloat(card.purchase_price) || null)
  const price = unitPrice != null ? unitPrice * totalQty : null
  const isBuyFallback = scryfallPrice == null && unitPrice != null
  const key = getDisplayKey(card)
  const selQty = splitState?.get(key) ?? 1
  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.(key, totalQty)
  }, { delay: 500 })
  const { onMouseLeave: lpLeave, fired: lpFired, ...lpRest } = longPress

  return (
    <div
      className={`${styles.stackCard} ${isSelected ? styles.stackCardSelected : ''}`}
      style={{ zIndex: idx }}
      onClick={() => {
        if (lpFired.current) {
          lpFired.current = false
          return
        }
        if (!selectMode) return onSelect?.(card)
        onToggleSelect?.(key, totalQty)
      }}
      onMouseEnter={() => !selectMode && img && onHover?.(img)}
      onMouseLeave={e => { if (!selectMode) onHoverEnd?.(); lpLeave?.(e) }}
      title={card.name}
      {...lpRest}
    >
      {selectMode && (
        <div className={`${styles.rowCheckbox} ${isSelected ? styles.rowCheckboxChecked : ''}`} style={{ position: 'absolute', top: 4, left: 4, zIndex: 10 }}>
          {isSelected && '✓'}
        </div>
      )}
      <div className={styles.stackImgWrap}>
        {img ? <img src={img} alt={card.name} className={styles.stackCardImg} loading="lazy" /> : <div className={styles.stackCardPlaceholder}>{card.name}</div>}
        {totalQty > 1 && !isSelected && <div className={styles.stackQty}>×{totalQty}</div>}
        {card.foil && <div className={styles.stackFoil}><Badge variant="foil">Foil</Badge></div>}
        {selectMode && isSelected && totalQty > 1 && (
          <div className={styles.qtyOverlay}>
            <button className={styles.qtyOverlayBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(key, +1, totalQty) }}>+</button>
            <div className={styles.qtyOverlayDisplay}>{selQty} of {totalQty}</div>
            <button className={styles.qtyOverlayBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(key, -1, totalQty) }}>−</button>
          </div>
        )}
      </div>
      <div className={styles.stackNameRow}>
        <div className={styles.stackCardName}>{card.name}</div>
        {card.foil && <span className={styles.foilMark}>✦</span>}
      </div>
      {card._folderName && (
        <div style={{ fontSize: '0.6rem', color: 'var(--gold-dim)', textAlign: 'center', padding: '0 2px', lineHeight: 1.2 }}>
          {card._folderName}
        </div>
      )}
      {price != null && (
        <div className={isBuyFallback ? styles.stackPriceFallback : styles.stackPrice}>
          {formatPrice(price, priceSource)}
        </div>
      )}
    </div>
  )
}

function StacksView({ groups, groupOrder, sfMap, priceSource, onSelect, onHover, onHoverEnd, selectMode, selectedCards, onToggleSelect, onAdjustQty, splitState, onEnterSelectMode, hideHeaders }) {
  return (
    <div className={styles.stacksWrap}>
      {groupOrder.filter(group => groups[group]?.length).map(group => {
        const cards = groups[group]
        const total = cards.reduce((sum, card) => sum + (card._folder_qty || card.qty || 1), 0)
        return (
          <div key={group} className={styles.stackGroup}>
            {!hideHeaders && (
              <div className={styles.stackGroupHeader}>
                <span style={{ color: CAT_COLORS[group] || 'var(--gold-dim)' }}>{group}</span>
                <span className={styles.stackGroupCount}>{total}</span>
              </div>
            )}
            <div className={styles.stackCards}>
              {cards.map((card, idx) => {
                const key = getDisplayKey(card)
                return (
                  <StackCard
                    key={key}
                    card={card}
                    sf={sfMap[getScryfallKey(card)]}
                    idx={idx}
                    priceSource={priceSource}
                    selectMode={selectMode}
                    isSelected={selectedCards?.has(key)}
                    onSelect={onSelect}
                    onToggleSelect={onToggleSelect}
                    onAdjustQty={onAdjustQty}
                    splitState={splitState}
                    onHover={onHover}
                    onHoverEnd={onHoverEnd}
                    onEnterSelectMode={onEnterSelectMode}
                  />
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ListRow({ card, sfCard, priceSource, onSelect, onHover, onHoverEnd, selectMode, isSelected, onToggleSelect, onAdjustQty, splitState, onEnterSelectMode }) {
  const scryfallPrice = getPrice(sfCard, card.foil, { price_source: priceSource })
  const totalQty = card._folder_qty ?? card.qty ?? 1
  const unitPrice = scryfallPrice ?? (parseFloat(card.purchase_price) || null)
  const price = unitPrice != null ? unitPrice * totalQty : null
  const isBuyFallback = scryfallPrice == null && unitPrice != null
  const typeLine = sfCard?.type_line || sfCard?.card_faces?.[0]?.type_line || ''
  const mc = sfCard?.mana_cost || sfCard?.card_faces?.[0]?.mana_cost || ''
  const img = sfCard?.image_uris?.normal || sfCard?.card_faces?.[0]?.image_uris?.normal || null
  const key = getDisplayKey(card)
  const selQty = splitState?.get(key) ?? 1
  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.(key, totalQty)
  }, { delay: 500 })
  const { onMouseLeave: lpLeave, fired: lpFired, ...lpRest } = longPress

  const handleClick = () => {
    if (lpFired.current) {
      lpFired.current = false
      return
    }
    if (!selectMode) {
      onSelect?.(card)
      return
    }
    onToggleSelect?.(key, totalQty)
  }

  return (
    <div
      className={`${styles.deckRow} ${isSelected ? styles.deckRowSelected : ''} ${selectMode ? styles.deckRowSelectMode : ''}`}
      onClick={handleClick}
      onMouseEnter={() => !selectMode && img && onHover?.(img)}
      onMouseLeave={e => { if (!selectMode) onHoverEnd?.(); lpLeave?.(e) }}
      {...lpRest}
    >
      {selectMode && isSelected && totalQty > 1 ? (
        <span className={styles.deckRowQtyAdj}>
          <button className={styles.deckRowQtyBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(key, -1, totalQty) }}>−</button>
          <span className={styles.deckRowQtyVal}>{selQty}/{totalQty}</span>
          <button className={styles.deckRowQtyBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(key, +1, totalQty) }}>+</button>
        </span>
      ) : selectMode ? (
        <span className={`${styles.rowCheckbox} ${isSelected ? styles.rowCheckboxChecked : ''}`}>{isSelected && '✓'}</span>
      ) : (
        <span className={styles.deckRowQty}>×{totalQty}</span>
      )}
      <span className={styles.deckRowName}>
        <span>{card.name}</span>
        {card._folderName ? <span style={{ display: 'block', fontSize: '0.66rem', color: 'var(--gold-dim)', marginTop: 2 }}>{card._folderName}</span> : null}
      </span>
      <span className={styles.deckRowMana}><InlineMana cost={mc} size={13} /></span>
      <span className={styles.deckRowType}>{typeLine.split('—')[0].trim()}</span>
      <span className={`${styles.deckRowPrice} ${card.foil ? styles.foilPrice : ''} ${isBuyFallback ? styles.priceFallback : ''}`}>
        {price != null ? formatPrice(price, priceSource) : '—'}
      </span>
    </div>
  )
}

function ListGroup({ groupName, cards, sfMap, priceSource, onSelect, color, onHover, onHoverEnd, selectMode, selectedCards, onToggleSelect, onAdjustQty, splitState, onEnterSelectMode, hideHeader }) {
  const [collapsed, setCollapsed] = useState(false)
  const total = cards.reduce((sum, card) => sum + (card._folder_qty ?? card.qty ?? 1), 0)

  return (
    <div className={styles.listGroup}>
      {!hideHeader && (
        <button className={styles.groupHeader} onClick={() => setCollapsed(v => !v)}>
          <span className={styles.groupIcon} style={{ color: color || 'var(--gold-dim)' }}>
            <TypeIcon type={groupName} size={13} style={{ verticalAlign: 'middle' }} />
          </span>
          <span className={styles.groupName}>{groupName}</span>
          <span className={styles.groupCount}>{total}</span>
          <span className={styles.groupToggle}>{collapsed ? '▸' : '▾'}</span>
        </button>
      )}
      {(!collapsed || hideHeader) && (
        <div className={styles.groupRows}>
          {cards.map(card => {
            const key = getDisplayKey(card)
            return (
              <ListRow
                key={key}
                card={card}
                sfCard={sfMap[getScryfallKey(card)]}
                priceSource={priceSource}
                onSelect={onSelect}
                onHover={onHover}
                onHoverEnd={onHoverEnd}
                selectMode={selectMode}
                isSelected={selectedCards?.has(key)}
                onToggleSelect={onToggleSelect}
                onAdjustQty={onAdjustQty}
                splitState={splitState}
                onEnterSelectMode={onEnterSelectMode}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function GridCard({ card, sf, priceSource, selectMode, isSelected, onSelect, onToggleSelect, onAdjustQty, splitState, onHover, onHoverEnd, onEnterSelectMode }) {
  const img = sf?.image_uris?.normal || sf?.card_faces?.[0]?.image_uris?.normal
  const totalQty = card._folder_qty ?? card.qty ?? 1
  const scryfallPrice = getPrice(sf, card.foil, { price_source: priceSource })
  const unitPrice = scryfallPrice ?? (parseFloat(card.purchase_price) || null)
  const price = unitPrice != null ? unitPrice * totalQty : null
  const isBuyFallback = scryfallPrice == null && unitPrice != null
  const key = getDisplayKey(card)
  const selQty = splitState?.get(key) ?? 1
  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.(key, totalQty)
  }, { delay: 500 })
  const { onMouseLeave: lpLeave, fired: lpFired, ...lpRest } = longPress

  const handleClick = () => {
    if (lpFired.current) {
      lpFired.current = false
      return
    }
    if (!selectMode) return onSelect?.(card)
    onToggleSelect?.(key, totalQty)
  }

  return (
    <div
      className={`${styles.gridCard} ${isSelected ? styles.gridCardSelected : ''}`}
      onClick={handleClick}
      onMouseEnter={() => !selectMode && img && onHover?.(img)}
      onMouseLeave={e => { if (!selectMode) onHoverEnd?.(); lpLeave?.(e) }}
      {...lpRest}
    >
      {selectMode && (
        <div className={`${styles.rowCheckbox} ${isSelected ? styles.rowCheckboxChecked : ''}`} style={{ position: 'absolute', top: 6, left: 6, zIndex: 10 }}>
          {isSelected && '✓'}
        </div>
      )}
      <div className={styles.gridImgWrap}>
        {img ? <img src={img} alt={card.name} className={styles.gridImg} loading="lazy" /> : <div className={styles.gridImgPlaceholder}>{card.name}</div>}
        {totalQty > 1 && !isSelected && <div className={styles.gridQty}>×{totalQty}</div>}
        {card.foil && <div className={styles.gridFoil}><Badge variant="foil">Foil</Badge></div>}
        {selectMode && isSelected && totalQty > 1 && (
          <div className={styles.qtyOverlay}>
            <button className={styles.qtyOverlayBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(key, +1, totalQty) }}>+</button>
            <div className={styles.qtyOverlayDisplay}>{selQty} of {totalQty}</div>
            <button className={styles.qtyOverlayBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(key, -1, totalQty) }}>−</button>
          </div>
        )}
      </div>
      <div className={styles.gridInfo}>
        <div className={styles.gridNameRow}>
          <div className={styles.gridName}>{card.name}</div>
          {card.foil && <span className={styles.foilMark}>✦</span>}
        </div>
        <div className={styles.gridSetRow}>
          <span className={styles.gridSet}>{(card.set_code || '').toUpperCase()}</span>
          {price != null && (
            <span className={isBuyFallback ? styles.gridPriceFallback : styles.gridPrice}>
              {formatPrice(price, priceSource)}
            </span>
          )}
        </div>
        {card._folderName && (
          <div style={{ fontSize: '0.62rem', color: 'var(--gold-dim)', marginTop: 2, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {card._folderName}
          </div>
        )}
      </div>
    </div>
  )
}

function GridView({ cards, sfMap, priceSource, onSelect, onHover, onHoverEnd, selectMode, selectedCards, onToggleSelect, onAdjustQty, splitState, onEnterSelectMode }) {
  return (
    <div className={styles.cardGrid}>
      {cards.map(card => {
        const key = getDisplayKey(card)
        return (
          <GridCard
            key={key}
            card={card}
            sf={sfMap[getScryfallKey(card)]}
            priceSource={priceSource}
            selectMode={selectMode}
            isSelected={selectedCards?.has(key)}
            onSelect={onSelect}
            onToggleSelect={onToggleSelect}
            onAdjustQty={onAdjustQty}
            splitState={splitState}
            onHover={onHover}
            onHoverEnd={onHoverEnd}
            onEnterSelectMode={onEnterSelectMode}
          />
        )
      })}
    </div>
  )
}

export function CardBrowserViewControls({ viewMode, setViewMode, groupBy, setGroupBy }) {
  return (
    <>
      <div className={styles.desktopControls}>
        <div className={styles.controlLeft}>
          <div className={styles.groupByToggle}>
            {CARD_BROWSER_GROUP_OPTIONS.map(option => (
              <button
                key={option.id}
                className={`${styles.groupByBtn} ${groupBy === option.id ? styles.groupByActive : ''}`}
                onClick={() => setGroupBy(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className={styles.viewToggle}>
            {CARD_BROWSER_VIEW_MODES.map(mode => (
              <button
                key={mode.id}
                className={`${styles.viewBtn} ${viewMode === mode.id ? styles.viewActive : ''}`}
                onClick={() => setViewMode(mode.id)}
              >
                {mode.desktopLabel}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className={styles.mobileControlsMenu}>
        <ResponsiveMenu
          title="Group Cards"
          trigger={({ open, toggle }) => (
            <button className={styles.mobileControlsBtn} onClick={toggle}>
              <span>Group</span>
              <svg className={`${styles.mobileControlsChevron} ${open ? styles.mobileControlsChevronOpen : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="2,3 5,6.5 8,3" />
              </svg>
            </button>
          )}
        >
          {({ close }) => (
            <div className={uiStyles.responsiveMenuList}>
              {CARD_BROWSER_GROUP_OPTIONS.map(option => (
                <button
                  key={option.id}
                  className={`${uiStyles.responsiveMenuAction} ${groupBy === option.id ? uiStyles.responsiveMenuActionActive : ''}`}
                  onClick={() => { setGroupBy(option.id); close() }}
                >
                  <span>{option.label}</span>
                  <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{groupBy === option.id ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          )}
        </ResponsiveMenu>
        <ResponsiveMenu
          title="View Mode"
          trigger={({ open, toggle }) => (
            <button className={styles.mobileControlsBtn} onClick={toggle}>
              <span>View</span>
              <svg className={`${styles.mobileControlsChevron} ${open ? styles.mobileControlsChevronOpen : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="2,3 5,6.5 8,3" />
              </svg>
            </button>
          )}
        >
          {({ close }) => (
            <div className={uiStyles.responsiveMenuList}>
              {CARD_BROWSER_VIEW_MODES.map(mode => (
                <button
                  key={mode.id}
                  className={`${uiStyles.responsiveMenuAction} ${viewMode === mode.id ? uiStyles.responsiveMenuActionActive : ''}`}
                  onClick={() => { setViewMode(mode.id); close() }}
                >
                  <span>{mode.label}</span>
                  <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{viewMode === mode.id ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          )}
        </ResponsiveMenu>
      </div>
    </>
  )
}

export function CardBrowserContent({
  cards,
  sfMap,
  priceSource,
  viewMode,
  groupBy,
  onSelect,
  selectMode,
  selectedCards,
  onToggleSelect,
  onAdjustQty,
  splitState,
  onEnterSelectMode,
  onHover,
  onHoverEnd,
}) {
  const { groups, groupOrder } = useMemo(() => buildGroups(cards, sfMap, groupBy), [cards, groupBy, sfMap])

  if (viewMode === 'list') {
    return (
      <div className={styles.deckList}>
        {groupOrder.filter(group => groups[group]?.length).map(group => (
          <ListGroup
            key={group}
            groupName={group}
            cards={groups[group]}
            sfMap={sfMap}
            priceSource={priceSource}
            onSelect={onSelect}
            color={groupBy === 'category' ? CAT_COLORS[group] : undefined}
            onHover={onHover}
            onHoverEnd={onHoverEnd}
            selectMode={selectMode}
            selectedCards={selectedCards}
            onToggleSelect={onToggleSelect}
            onAdjustQty={onAdjustQty}
            splitState={splitState}
            onEnterSelectMode={onEnterSelectMode}
            hideHeader={groupBy === 'none'}
          />
        ))}
      </div>
    )
  }

  if (viewMode === 'stacks') {
    return (
      <StacksView
        groups={groups}
        groupOrder={groupOrder}
        sfMap={sfMap}
        priceSource={priceSource}
        onSelect={onSelect}
        onHover={onHover}
        onHoverEnd={onHoverEnd}
        selectMode={selectMode}
        selectedCards={selectedCards}
        onToggleSelect={onToggleSelect}
        onAdjustQty={onAdjustQty}
        splitState={splitState}
        onEnterSelectMode={onEnterSelectMode}
        hideHeaders={groupBy === 'none'}
      />
    )
  }

  if (viewMode === 'text') {
    return (
      <TextView
        groups={groups}
        groupOrder={groupOrder}
        selectMode={selectMode}
        selectedCards={selectedCards}
        onToggleSelect={onToggleSelect}
        onEnterSelectMode={onEnterSelectMode}
        hideHeaders={groupBy === 'none'}
      />
    )
  }

  if (viewMode === 'table') {
    return (
      <TableView
        cards={cards}
        sfMap={sfMap}
        priceSource={priceSource}
        onSelect={onSelect}
        selectMode={selectMode}
        selectedCards={selectedCards}
        onToggleSelect={onToggleSelect}
        onEnterSelectMode={onEnterSelectMode}
      />
    )
  }

  return (
    <GridView
      cards={cards}
      sfMap={sfMap}
      priceSource={priceSource}
      onSelect={onSelect}
      onHover={onHover}
      onHoverEnd={onHoverEnd}
      selectMode={selectMode}
      selectedCards={selectedCards}
      onToggleSelect={onToggleSelect}
      onAdjustQty={onAdjustQty}
      splitState={splitState}
      onEnterSelectMode={onEnterSelectMode}
    />
  )
}
