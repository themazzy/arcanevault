import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, ResponsiveMenu } from './UI'
import { getPrice, formatPrice, getScryfallKey } from '../lib/scryfall'
import { useLongPress } from '../hooks/useLongPress'
import { lastInputWasTouch } from '../lib/inputType'
import uiStyles from './UI.module.css'
import styles from '../pages/DeckBrowser.module.css'
import { GridViewIcon, StacksViewIcon, TextViewIcon, TableViewIcon } from '../icons'

const NON_DRAGGABLE_IMG_PROPS = {
  draggable: false,
  onDragStart: e => e.preventDefault(),
  onContextMenu: e => e.preventDefault(),
  style: {
    WebkitUserDrag: 'none',
    WebkitTouchCallout: 'none',
    userSelect: 'none',
  },
}

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

// True on devices where a fine pointer (mouse/trackpad) is available — false on touch-only phones
const CAN_HOVER = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches

export const CARD_BROWSER_GROUP_OPTIONS = [
  { id: 'type', label: 'By Type' },
  { id: 'category', label: 'By Function' },
  { id: 'none', label: 'Ungrouped' },
]

export const CARD_BROWSER_VIEW_MODES = [
  { id: 'stacks', label: 'Stacks', Icon: StacksViewIcon },
  { id: 'text',   label: 'Text',   Icon: TextViewIcon },
  { id: 'grid',   label: 'Grid',   Icon: GridViewIcon },
  { id: 'table',  label: 'Table',  Icon: TableViewIcon },
]

function getDisplayKey(card) {
  return card?._displayKey || card?.id
}

function getOrderedBrowserViewModes() {
  const order = ['grid', 'stacks', 'table', 'text']
  return order
    .map(id => CARD_BROWSER_VIEW_MODES.find(mode => mode.id === id))
    .filter(Boolean)
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

function TextRow({ card, sfCard, selectMode, isSelected, onToggleSelect, onEnterSelectMode, onHover, onHoverEnd }) {
  const totalQty = card._folder_qty ?? card.qty ?? 1
  const key = getDisplayKey(card)
  const img = sfCard?.image_uris?.normal || sfCard?.card_faces?.[0]?.image_uris?.normal
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
      onMouseEnter={CAN_HOVER && !lastInputWasTouch && !selectMode && img ? () => onHover?.(img) : undefined}
      onMouseLeave={e => { if (CAN_HOVER && !selectMode) onHoverEnd?.(); lpLeave?.(e) }}
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

function TextView({ groups, groupOrder, sfMap, selectMode, selectedCards, onToggleSelect, onEnterSelectMode, hideHeaders, onHover, onHoverEnd, collapsedGroups, onToggleGroup }) {
  return (
    <div className={styles.textView}>
      {groupOrder.filter(group => groups[group]?.length).map(group => {
        const cards = groups[group]
        const total = cards.reduce((sum, card) => sum + (card._folder_qty || card.qty || 1), 0)
        const isCollapsed = collapsedGroups?.has(group)
        return (
          <div key={group} className={styles.textGroup}>
            {!hideHeaders && (
              <button className={`${styles.textGroupHeader} ${styles.groupHeaderToggleBtn}`} onClick={() => onToggleGroup?.(group)}>
                <span className={`${styles.groupArrow}${isCollapsed ? ` ${styles.groupArrowCollapsed}` : ''}`}>▾</span>
                <span className={styles.groupHeaderTitle} style={{ color: CAT_COLORS[group] || 'var(--gold-dim)' }}>{group}</span>
                <span className={styles.textGroupCount}>{total}</span>
              </button>
            )}
            {!isCollapsed && cards
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map(card => (
                <TextRow
                  key={getDisplayKey(card)}
                  card={card}
                  sfCard={sfMap[getScryfallKey(card)]}
                  selectMode={selectMode}
                  isSelected={selectedCards?.has(getDisplayKey(card))}
                  onToggleSelect={onToggleSelect}
                  onEnterSelectMode={onEnterSelectMode}
                  onHover={onHover}
                  onHoverEnd={onHoverEnd}
                />
              ))}
          </div>
        )
      })}
    </div>
  )
}

function TableRow({ card, sf, priceSource, isSelected, selectMode, onClick, onEnterSelectMode, onToggleSelect, onAdjustQty, splitState, onHover, onHoverEnd, visibleCols }) {
  const totalQty = card._folder_qty ?? card.qty ?? 1
  const key = getDisplayKey(card)
  const selQty = splitState?.get(key) ?? 1
  const img = sf?.image_uris?.normal || sf?.card_faces?.[0]?.image_uris?.normal
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
  const hoverEnter = CAN_HOVER && !lastInputWasTouch && !selectMode && img ? () => onHover?.(img) : undefined
  const hoverLeave = CAN_HOVER && !selectMode ? () => onHoverEnd?.() : undefined
  const typeLine = (sf?.type_line || '-').split('—')[0].trim()
  const setCode = (card.set_code || sf?.set || '-').toUpperCase()
  const collectorNumber = card.collector_number || sf?.collector_number
  const rarity = sf?.rarity || '-'
  const pt = sf?.power != null
    ? `${sf.power}/${sf.toughness ?? '?'}`
    : sf?.card_faces?.[0]?.power != null
      ? `${sf.card_faces[0].power}/${sf.card_faces[0].toughness ?? '?'}`
      : '-'
  const mobileMeta = []
  if (visibleCols.type) mobileMeta.push(typeLine)
  if (visibleCols.set) mobileMeta.push(`${setCode}${collectorNumber ? ` #${collectorNumber}` : ''}`)
  if (visibleCols.price && price != null) mobileMeta.push(formatPrice(price, priceSource))
  if (visibleCols.pt && pt !== '-') mobileMeta.push(pt)
  if (visibleCols.rarity && rarity !== '-') mobileMeta.push(rarity)
  if (visibleCols.cmc && sf?.cmc != null) mobileMeta.push(`CMC ${sf.cmc}`)
  if (visibleCols.color) mobileMeta.push(`Color ${(sf?.color_identity || []).join('') || 'C'}`)
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
      <td className={styles.td} style={{ textAlign: 'center', color: 'var(--text-faint)' }} onMouseEnter={hoverEnter} onMouseLeave={hoverLeave}>
        {selectMode && isSelected && totalQty > 1 ? (
          <span className={styles.tableQtyAdj}>
            <button className={styles.tableQtyBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(key, -1, totalQty) }}>−</button>
            <span className={styles.tableQtyVal}>{selQty}/{totalQty}</span>
            <button className={styles.tableQtyBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(key, +1, totalQty) }}>+</button>
          </span>
        ) : totalQty}
      </td>
      <td className={styles.td} onMouseEnter={hoverEnter} onMouseLeave={hoverLeave}>
        <div>
          <span className={styles.tableName}>{card.name}</span>
          {card.foil && <span className={styles.tableFoil}>✦</span>}
          {mobileMeta.length > 0 && (
            <div className={styles.tableMetaMobile}>{mobileMeta.join(' | ')}</div>
          )}
          {rowFolderMeta(card)}
        </div>
      </td>
      {visibleCols.mana && (
        <td className={`${styles.td} ${getTableColClass('mana')}`.trim()} style={{ textAlign: 'center' }}>
          <InlineMana cost={mc} size={13} />
        </td>
      )}
      {visibleCols.cmc && (
        <td className={`${styles.td} ${getTableColClass('cmc')}`.trim()} style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: '0.8rem' }}>
          {sf?.cmc ?? '—'}
        </td>
      )}
      {visibleCols.type && (
        <td className={`${styles.td} ${getTableColClass('type')}`.trim()} style={{ color: 'var(--text-faint)', fontSize: '0.76rem' }}>
          {(sf?.type_line || '—').split('—')[0].trim()}
        </td>
      )}
      {visibleCols.set && (
        <td className={`${styles.td} ${getTableColClass('set')}`.trim()} style={{ fontSize: '0.72rem', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
          <span style={{ textTransform: 'uppercase' }}>{card.set_code || sf?.set || '—'}</span>
          {(card.collector_number || sf?.collector_number)
            ? <span style={{ color: 'var(--text-faint)' }}> #{card.collector_number || sf?.collector_number}</span>
            : null}
        </td>
      )}
      {visibleCols.rarity && (
        <td className={`${styles.td} ${getTableColClass('rarity')}`.trim()} style={{ fontSize: '0.7rem', textTransform: 'capitalize', color: ({ common: 'var(--text-faint)', uncommon: '#a0a8b8', rare: 'var(--gold)', mythic: '#e07020' })[sf?.rarity] || 'var(--text-faint)' }}>
          {sf?.rarity || '—'}
        </td>
      )}
      {visibleCols.color && (
        <td className={`${styles.td} ${getTableColClass('color')}`.trim()} style={{ textAlign: 'center' }}>
          {(sf?.color_identity || []).length
            ? <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
                {sf.color_identity.map(c => (
                  <img key={c} src={`https://svgs.scryfall.io/card-symbols/${c}.svg`} alt={c} style={{ width: 13, height: 13 }} />
                ))}
              </span>
            : <span style={{ color: 'var(--text-faint)', fontSize: '0.7rem' }}>C</span>}
        </td>
      )}
      {visibleCols.pt && (
        <td className={`${styles.td} ${getTableColClass('pt')}`.trim()} style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
          {sf?.power != null
            ? `${sf.power}/${sf.toughness ?? '?'}`
            : sf?.card_faces?.[0]?.power != null
              ? `${sf.card_faces[0].power}/${sf.card_faces[0].toughness ?? '?'}`
              : '—'}
        </td>
      )}
      {visibleCols.price && (
        <td className={`${styles.td} ${getTableColClass('price')}`.trim()} style={{ textAlign: 'right', fontFamily: 'var(--font-display)', fontSize: '0.8rem', color: (scryfallPrice == null && price != null) ? 'var(--text-dim)' : 'var(--green)' }}>
          {price != null ? formatPrice(price, priceSource) : '—'}
        </td>
      )}
    </tr>
  )
}

const TABLE_OPTIONAL_COLS = [
  ['mana',   'Mana Cost'],
  ['cmc',    'CMC'],
  ['type',   'Type'],
  ['set',    'Set'],
  ['rarity', 'Rarity'],
  ['color',  'Color'],
  ['pt',     'P / T'],
  ['price',  'Price'],
]

const LS_COL_KEY = 'arcanevault_browser_table_columns_v1'
const DEFAULT_VISIBLE_COLS = { mana: true, cmc: false, type: true, set: false, rarity: false, color: false, pt: false, price: true }
const TABLE_COL_FOLD_CLASS = {
  mana: 'colFoldSm',
  cmc: 'colFoldSm',
  rarity: 'colFoldSm',
  color: 'colFoldSm',
  type: 'colFoldXs',
  pt: 'colFoldXs',
  set: 'colFoldXxs',
  price: 'colFoldXxs',
}

function loadVisibleCols() {
  try { return { ...DEFAULT_VISIBLE_COLS, ...JSON.parse(localStorage.getItem(LS_COL_KEY) || 'null') } } catch { return { ...DEFAULT_VISIBLE_COLS } }
}

function getTableColClass(col) {
  return TABLE_COL_FOLD_CLASS[col] ? styles[TABLE_COL_FOLD_CLASS[col]] : ''
}

function TableView({ cards, sfMap, priceSource, groups, groupOrder, groupBy, onSelect, selectMode, selectedCards, onToggleSelect, onEnterSelectMode, onAdjustQty, splitState, onHover, onHoverEnd, collapsedGroups, onToggleGroup }) {
  const [sortCol, setSortCol] = useState('name')
  const [sortDir, setSortDir] = useState(1)
  const [visibleCols, setVisibleCols] = useState(loadVisibleCols)

  const toggleCol = col => setVisibleCols(prev => {
    const next = { ...prev, [col]: !prev[col] }
    try { localStorage.setItem(LS_COL_KEY, JSON.stringify(next)) } catch {}
    return next
  })

  const isGrouped = groupBy && groupBy !== 'none'
  const visCount = Object.values(visibleCols).filter(Boolean).length
  const colCount = (selectMode ? 1 : 0) + 2 + visCount

  const sorted = useMemo(() => {
    if (isGrouped) return cards
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
      if (sortCol === 'mana' || sortCol === 'cmc') {
        va = sfA?.cmc ?? 99
        vb = sfB?.cmc ?? 99
      }
      if (sortCol === 'set') {
        va = sfA?.set || a.set_code || ''
        vb = sfB?.set || b.set_code || ''
        return sortDir * (va < vb ? -1 : va > vb ? 1 : 0)
      }
      if (sortCol === 'rarity') {
        const RO = { common: 0, uncommon: 1, rare: 2, mythic: 3 }
        va = RO[sfA?.rarity] ?? 0
        vb = RO[sfB?.rarity] ?? 0
      }
      if (sortCol === 'color') {
        va = (sfA?.color_identity || []).length
        vb = (sfB?.color_identity || []).length
      }
      if (sortCol === 'pt') {
        va = parseFloat(sfA?.power) || 0
        vb = parseFloat(sfB?.power) || 0
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
  }, [cards, priceSource, sfMap, sortCol, sortDir, isGrouped])

  const arrow = col => (!isGrouped && sortCol === col) ? (sortDir > 0 ? '↑' : '↓') : ''

  const renderRows = cardList => cardList.map(card => {
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
        onAdjustQty={onAdjustQty}
        splitState={splitState}
        onHover={onHover}
        onHoverEnd={onHoverEnd}
        visibleCols={visibleCols}
      />
    )
  })

  return (
    <>
      <div className={styles.tableColPicker}>
        <ResponsiveMenu
          title="Visible Columns"
          align="left"
          wrapClassName={styles.columnMenuWrap}
          trigger={({ toggle }) => (
            <button className={styles.groupByBtn} onClick={toggle} title="Choose visible columns">Columns</button>
          )}
        >
          {() => (
            <div className={uiStyles.responsiveMenuList}>
              {TABLE_OPTIONAL_COLS.map(([col, label]) => (
                <label key={col} className={`${styles.columnMenuItem} ${visibleCols[col] ? styles.columnMenuItemActive : ''}`}>
                  <input type="checkbox" className={styles.columnMenuCheckbox} checked={!!visibleCols[col]} onChange={() => toggleCol(col)} />
                  <span className={styles.columnMenuLabel}>{label}</span>
                  <span className={styles.columnMenuCheck} aria-hidden="true">{visibleCols[col] ? '✓' : ''}</span>
                </label>
              ))}
            </div>
          )}
        </ResponsiveMenu>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {selectMode && <th className={styles.th} style={{ width: 32 }} />}
              {[['qty', 'Qty'], ['name', 'Name'], ...TABLE_OPTIONAL_COLS.filter(([col]) => visibleCols[col])].map(([col, label]) => (
                <th
                  key={col}
                  className={`${styles.th} ${getTableColClass(col)}`.trim()}
                  onClick={!isGrouped ? () => {
                    if (sortCol === col) setSortDir(dir => -dir)
                    else { setSortCol(col); setSortDir(1) }
                  } : undefined}
                  style={isGrouped ? { cursor: 'default' } : {}}
                >
                  {label}{arrow(col) ? <span className={styles.thArrow}>{arrow(col)}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isGrouped
              ? groupOrder.filter(g => groups[g]?.length).map(group => {
                  const groupCards = groups[group]
                  const total = groupCards.reduce((s, c) => s + (c._folder_qty ?? c.qty ?? 1), 0)
                  const isCollapsed = collapsedGroups?.has(group)
                  return (
                    <Fragment key={group}>
                      <tr className={styles.tableGroupRow} onClick={() => onToggleGroup?.(group)}>
                        <td className={styles.tableGroupCell} colSpan={colCount}>
                          <span className={`${styles.groupArrow}${isCollapsed ? ` ${styles.groupArrowCollapsed}` : ''}`}>▾</span>
                          <span className={styles.tableGroupName} style={{ color: CAT_COLORS[group] || 'var(--gold-dim)' }}>{group}</span>
                          <span className={styles.tableGroupCount}>{total}</span>
                        </td>
                      </tr>
                      {!isCollapsed && renderRows(groupCards)}
                    </Fragment>
                  )
                })
              : renderRows(sorted)
            }
          </tbody>
        </table>
      </div>
    </>
  )
}

function StackCard({ card, sf, idx, stackIdx, isPushedDown, priceSource, selectMode, isSelected, onSelect, onToggleSelect, onAdjustQty, splitState, onHoverPreview, onHoverPreviewEnd, onPinPreview, onHoverStart, onHoverEnd, onEnterSelectMode }) {
  const img = sf?.image_uris?.normal || sf?.card_faces?.[0]?.image_uris?.normal
  const totalQty = card._folder_qty ?? card.qty ?? 1
  const scryfallPrice = getPrice(sf, card.foil, { price_source: priceSource })
  const unitPrice = scryfallPrice ?? (parseFloat(card.purchase_price) || null)
  const price = unitPrice != null ? unitPrice * totalQty : null
  const isBuyFallback = scryfallPrice == null && unitPrice != null
  const key = getDisplayKey(card)
  const selQty = splitState?.get(key) ?? 1
  const cardRef = useRef(null)
  const hoverTimerRef = useRef(null)
  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.(key, totalQty)
  }, { delay: 500 })
  const { onMouseLeave: lpLeave, fired: lpFired, ...lpRest } = longPress

  const getPreviewPos = () => {
    if (!img || !cardRef.current) return null
    const rect = cardRef.current.getBoundingClientRect()
    const pad = 14, previewWidth = 200, previewHeight = previewWidth * (88 / 63)
    const roomRight = window.innerWidth - rect.right
    const roomLeft = rect.left
    const side = roomRight >= previewWidth + pad ? 'right' : roomLeft >= previewWidth + pad ? 'left' : roomRight >= roomLeft ? 'right' : 'left'
    const top = Math.max(12, Math.min(rect.top, window.innerHeight - previewHeight - 12))
    const left = side === 'right' ? rect.right + pad : rect.left - previewWidth - pad
    return { img, top, left: Math.max(12, Math.min(left, window.innerWidth - previewWidth - 12)), width: previewWidth }
  }

  const handleMouseEnter = CAN_HOVER && !lastInputWasTouch && !selectMode && img
    ? () => {
        onHoverStart?.()
        if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = setTimeout(() => {
          const pos = getPreviewPos()
          if (pos) onHoverPreview?.(pos)
        }, 90)
      }
    : undefined

  const handleMouseLeave = e => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
    onHoverEnd?.()
    onHoverPreviewEnd?.()
    lpLeave?.(e)
  }

  const handleContextMenu = e => {
    e.preventDefault()
    const pos = getPreviewPos()
    if (pos) onPinPreview?.(pos)
    // Clear push immediately — right-click triggers browser button-capture
    // which prevents mouseleave from firing until the button is released.
    onHoverEnd?.()
  }

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
  }, [])

  return (
    <div
      {...lpRest}
      ref={cardRef}
      className={`${styles.stackCard}${isSelected ? ` ${styles.stackCardSelected}` : ''}${isPushedDown ? ` ${styles.stackCardPushedDown}` : ''}`}
      style={{ zIndex: idx }}
      onClick={() => {
        if (lpFired.current) { lpFired.current = false; return }
        if (!selectMode) return onSelect?.(card)
        onToggleSelect?.(key, totalQty)
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onContextMenu={handleContextMenu}
      title={card.name}
    >
      {selectMode && (
        <div className={`${styles.rowCheckbox} ${isSelected ? styles.rowCheckboxChecked : ''}`} style={{ position: 'absolute', top: 4, left: 4, zIndex: 10 }}>
          {isSelected && '✓'}
        </div>
      )}
      <div className={styles.stackImgWrap}>
        {img
          ? <img src={img} alt={card.name} className={styles.stackCardImg} loading="lazy" {...NON_DRAGGABLE_IMG_PROPS} />
          : <div className={styles.stackCardPlaceholder}>{card.name}</div>}
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
      {price != null && (
        <div className={isBuyFallback ? styles.stackPriceFallback : styles.stackPrice}>
          {formatPrice(price, priceSource)}
        </div>
      )}
    </div>
  )
}

function StacksView({ groups, groupOrder, sfMap, priceSource, onSelect, selectMode, selectedCards, onToggleSelect, onAdjustQty, splitState, onEnterSelectMode, hideHeaders, collapsedGroups, onToggleGroup }) {
  const [activePreview, setActivePreview] = useState(null)
  const [pinnedPreview, setPinnedPreview] = useState(null)
  // { group, stackIdx } — which card is currently being hovered (mouse only)
  const [hoverState, setHoverState] = useState(null)

  useEffect(() => {
    if (!pinnedPreview) return
    const onKey = e => { if (e.key === 'Escape') setPinnedPreview(null) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pinnedPreview])

  const displayPreview = pinnedPreview ?? activePreview

  const stackGroups = useMemo(() => (
    groupOrder
      .filter(group => groups[group]?.length)
      .map(group => ({
        group,
        cards: groups[group],
        total: groups[group].reduce((sum, card) => sum + (card._folder_qty || card.qty || 1), 0),
      }))
  ), [groupOrder, groups])

  return (
    <div className={styles.stacksWrap} onClick={() => setPinnedPreview(null)}>
      {stackGroups.map(({ group, cards, total }) => (
        <div key={group} className={styles.stackGroup}>
          {!hideHeaders && (
            <button className={`${styles.stackGroupHeader} ${styles.groupHeaderToggleBtn}`} onClick={() => onToggleGroup?.(group)}>
              <span className={`${styles.groupArrow}${collapsedGroups?.has(group) ? ` ${styles.groupArrowCollapsed}` : ''}`}>▾</span>
              <span className={styles.groupHeaderTitle} style={{ color: CAT_COLORS[group] || 'var(--gold-dim)' }}>{group}</span>
              <span className={styles.stackGroupCount}>{total}</span>
            </button>
          )}
          {!collapsedGroups?.has(group) && (
            <div className={styles.stackCards}>
              {cards.map((card, idx) => {
                const key = getDisplayKey(card)
                const isPushedDown = hoverState !== null && hoverState.group === group && idx > hoverState.stackIdx
                return (
                  <StackCard
                    key={key}
                    card={card}
                    sf={sfMap[getScryfallKey(card)]}
                    idx={idx + 1}
                    stackIdx={idx}
                    isPushedDown={isPushedDown}
                    priceSource={priceSource}
                    selectMode={selectMode}
                    isSelected={selectedCards?.has(key)}
                    onSelect={onSelect}
                    onToggleSelect={onToggleSelect}
                    onAdjustQty={onAdjustQty}
                    splitState={splitState}
                    onHoverPreview={setActivePreview}
                    onHoverPreviewEnd={() => setActivePreview(null)}
                    onPinPreview={setPinnedPreview}
                    onHoverStart={() => setHoverState({ group, stackIdx: idx })}
                    onHoverEnd={() => setHoverState(null)}
                    onEnterSelectMode={onEnterSelectMode}
                  />
                )
              })}
            </div>
          )}
        </div>
      ))}
      {displayPreview?.img && (
        <div
          className={`${styles.stackHoverPreview}${pinnedPreview ? ` ${styles.stackHoverPreviewPinned}` : ''}`}
          style={{ top: `${displayPreview.top}px`, left: `${displayPreview.left}px`, width: `${displayPreview.width}px` }}
        >
          <img src={displayPreview.img} alt="" className={styles.stackHoverPreviewImg} loading="lazy" {...NON_DRAGGABLE_IMG_PROPS} />
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
      onMouseLeave={e => { lpLeave?.(e) }}
      {...lpRest}
    >
      {selectMode && (
        <div className={`${styles.rowCheckbox} ${isSelected ? styles.rowCheckboxChecked : ''}`} style={{ position: 'absolute', top: 6, left: 6, zIndex: 10 }}>
          {isSelected && '✓'}
        </div>
      )}
      <div className={styles.gridImgWrap}>
        {img ? <img src={img} alt={card.name} className={styles.gridImg} loading="lazy" {...NON_DRAGGABLE_IMG_PROPS} /> : <div className={styles.gridImgPlaceholder}>{card.name}</div>}
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

const DENSITY_MIN_WIDTH = { cozy: 210, comfortable: 160, compact: 128 }
const MOBILE_GRID_BREAKPOINT = 430
const MOBILE_DENSITY_COLS = { cozy: 1, comfortable: 2, compact: 3 }

function GridView({ cards, sfMap, priceSource, onSelect, selectMode, selectedCards, onToggleSelect, onAdjustQty, splitState, onEnterSelectMode, density, groups, groupOrder, groupBy, collapsedGroups, onToggleGroup }) {
  const minW = DENSITY_MIN_WIDTH[density] || 160
  const isSmallScreen = typeof window !== 'undefined' && window.innerWidth <= MOBILE_GRID_BREAKPOINT
  const mobileCols = MOBILE_DENSITY_COLS[density] || 2
  const gridStyle = isSmallScreen
    ? { gridTemplateColumns: `repeat(${mobileCols}, minmax(0, 1fr))` }
    : { gridTemplateColumns: `repeat(auto-fill, minmax(${minW}px, 1fr))` }

  const renderCards = (cardList) => cardList.map(card => {
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
        onEnterSelectMode={onEnterSelectMode}
      />
    )
  })

  if (groupBy && groupBy !== 'none' && groups && groupOrder) {
    return (
      <div className={styles.gridGroups}>
        {groupOrder.filter(g => groups[g]?.length).map(g => {
          const groupCards = groups[g]
          const total = groupCards.reduce((sum, c) => sum + (c._folder_qty ?? c.qty ?? 1), 0)
          const isCollapsed = collapsedGroups?.has(g)
          return (
            <div key={g} className={styles.gridGroup}>
              <button className={`${styles.textGroupHeader} ${styles.groupHeaderToggleBtn}`} onClick={() => onToggleGroup?.(g)}>
                <span className={`${styles.groupArrow}${isCollapsed ? ` ${styles.groupArrowCollapsed}` : ''}`}>▾</span>
                <span className={styles.groupHeaderTitle}>{g}</span>
                <span className={styles.textGroupCount}>{total}</span>
              </button>
              {!isCollapsed && (
                <div className={styles.cardGrid} style={gridStyle}>
                  {renderCards(groupCards)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className={styles.cardGrid} style={gridStyle}>
      {renderCards(cards)}
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
            {getOrderedBrowserViewModes().map(mode => (
              <button
                key={mode.id}
                className={`${styles.viewBtn} ${viewMode === mode.id ? styles.viewActive : ''}`}
                onClick={() => setViewMode(mode.id)}
                title={mode.label}
              >
                <mode.Icon size={13} />
                <span>{mode.label}</span>
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
              {getOrderedBrowserViewModes().map(mode => (
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
  density,
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
  const effectiveViewMode = viewMode === 'list' ? 'table' : viewMode
  const { groups, groupOrder } = useMemo(() => buildGroups(cards, sfMap, groupBy), [cards, groupBy, sfMap])
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())

  const toggleGroup = group => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  if (effectiveViewMode === 'stacks') {
    return (
      <StacksView
        groups={groups}
        groupOrder={groupOrder}
        sfMap={sfMap}
        priceSource={priceSource}
        onSelect={onSelect}
        selectMode={selectMode}
        selectedCards={selectedCards}
        onToggleSelect={onToggleSelect}
        onAdjustQty={onAdjustQty}
        splitState={splitState}
        onEnterSelectMode={onEnterSelectMode}
        hideHeaders={groupBy === 'none'}
        collapsedGroups={collapsedGroups}
        onToggleGroup={toggleGroup}
      />
    )
  }

  if (effectiveViewMode === 'text') {
    return (
      <TextView
        groups={groups}
        groupOrder={groupOrder}
        sfMap={sfMap}
        selectMode={selectMode}
        selectedCards={selectedCards}
        onToggleSelect={onToggleSelect}
        onEnterSelectMode={onEnterSelectMode}
        hideHeaders={groupBy === 'none'}
        onHover={onHover}
        onHoverEnd={onHoverEnd}
        collapsedGroups={collapsedGroups}
        onToggleGroup={toggleGroup}
      />
    )
  }

  if (effectiveViewMode === 'table') {
    return (
      <TableView
        cards={cards}
        sfMap={sfMap}
        priceSource={priceSource}
        groups={groups}
        groupOrder={groupOrder}
        groupBy={groupBy}
        onSelect={onSelect}
        selectMode={selectMode}
        selectedCards={selectedCards}
        onToggleSelect={onToggleSelect}
        onEnterSelectMode={onEnterSelectMode}
        onAdjustQty={onAdjustQty}
        splitState={splitState}
        onHover={onHover}
        onHoverEnd={onHoverEnd}
        collapsedGroups={collapsedGroups}
        onToggleGroup={toggleGroup}
      />
    )
  }

  return (
    <GridView
      cards={cards}
      sfMap={sfMap}
      priceSource={priceSource}
      density={density}
      groups={groups}
      groupOrder={groupOrder}
      groupBy={groupBy}
      onSelect={onSelect}
      onHover={onHover}
      onHoverEnd={onHoverEnd}
      selectMode={selectMode}
      selectedCards={selectedCards}
      onToggleSelect={onToggleSelect}
      onAdjustQty={onAdjustQty}
      splitState={splitState}
      onEnterSelectMode={onEnterSelectMode}
      collapsedGroups={collapsedGroups}
      onToggleGroup={toggleGroup}
    />
  )
}
