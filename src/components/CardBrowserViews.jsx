import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Badge, ResponsiveMenu } from './UI'
import { getPrice, formatPrice, getScryfallKey } from '../lib/scryfall'
import { useLongPress } from '../hooks/useLongPress'
import { lastInputWasTouch } from '../lib/inputType'
import { countActive } from './CardComponents'
import uiStyles from './UI.module.css'
import styles from '../pages/DeckBrowser.module.css'
import { AddIcon, CheckIcon, ExportIcon, FilterIcon, GridViewIcon, ImportIcon, ShareIcon, SortIcon, StacksViewIcon, TextViewIcon, TableViewIcon } from '../icons'
import { CAT_ORDER, CAT_COLORS, getCardCategoryFromCard } from '../lib/cardCategory'

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

// Browser-friendly labels for the floating mobile sort sheet — kept short for icon-pill layout.
// Keep value list in sync with the FilterBar sortOptions in CardComponents.jsx.
// Label convention (project-wide): "Name A→Z" for alphabetical, "Field ↑/↓"
// for numeric, plain "Field" for categorical, "Recently …" for dates.
const BROWSER_SORT_OPTIONS = [
  ['name', 'Name A→Z'],
  ['name_desc', 'Name Z→A'],
  ['price_desc', 'Price ↓'],
  ['price_asc', 'Price ↑'],
  ['pl_desc', 'P&L ↓'],
  ['pl_asc', 'P&L ↑'],
  ['cmc_asc', 'Mana Value ↑'],
  ['cmc_desc', 'Mana Value ↓'],
  ['rarity', 'Rarity'],
  ['set', 'Set'],
  ['qty', 'Quantity'],
  ['added', 'Recently Added'],
]

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

function getBrowserCardImage(card, sfCard, size = 'normal') {
  return sfCard?.image_uris?.[size]
    || sfCard?.card_faces?.[0]?.image_uris?.[size]
    || sfCard?.image_uris?.normal
    || sfCard?.card_faces?.[0]?.image_uris?.normal
    || card?.image_uri
    || null
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

function buildGroups(cards, sfMap, groupBy, groupResolver, groupOrderOverride) {
  if (groupBy === 'none') return { groups: { All: cards }, groupOrder: ['All'] }
  const groups = {}
  const order = groupOrderOverride?.length ? groupOrderOverride : (groupBy === 'category' ? CAT_ORDER : TYPE_ORDER)
  for (const card of cards) {
    const sf = sfMap[getScryfallKey(card)]
    const key = groupResolver?.(card, sf, groupBy)
      || (card.is_commander && groupBy === 'type' ? 'Commander' : null)
      || (groupBy === 'category'
      ? getCardCategoryFromCard(card, sf)
      : getCardType(sf?.type_line || sf?.card_faces?.[0]?.type_line || card.type_line || ''))
    if (!groups[key]) groups[key] = []
    groups[key].push(card)
  }
  const extras = Object.keys(groups).filter(group => !order.includes(group)).sort((a, b) => a.localeCompare(b))
  return { groups, groupOrder: [...order, ...extras] }
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
  const img = getBrowserCardImage(card, sfCard)
  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.(key, totalQty)
  }, { delay: 500 })
  const { onMouseLeave: lpLeave, consumeFired, ...lpRest } = longPress

  const handleClick = () => {
    if (consumeFired()) return
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
  const img = getBrowserCardImage(card, sf)
  const longPress = useLongPress(() => {
    if (selectMode) return
    onEnterSelectMode?.()
    onToggleSelect?.(key, totalQty)
  }, { delay: 500 })
  const { onMouseLeave: lpLeave, consumeFired, ...lpRest } = longPress
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
        if (consumeFired()) return
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

function StackCard({ card, sf, idx, isPushedDown, priceSource, selectMode, isSelected, onSelect, onToggleSelect, onAdjustQty, splitState, onHoverPreview, onHoverPreviewEnd, onPinPreview, onHoverStart, onHoverEnd, onEnterSelectMode }) {
  const img = getBrowserCardImage(card, sf)
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
  const { onMouseLeave: lpLeave, consumeFired, ...lpRest } = longPress

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
        if (consumeFired()) return
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

function StacksView({ groups, groupOrder, sfMap, priceSource, onSelect, selectMode, selectedCards, onToggleSelect, onAdjustQty, splitState, onEnterSelectMode, hideHeaders, collapsedGroups, onToggleGroup, density }) {
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
  const stackWidth = STACK_WIDTH_BY_DENSITY[density] || STACK_WIDTH_BY_DENSITY.comfortable

  return (
    <div className={styles.stacksWrap} style={{ '--stack-col-w': `${stackWidth}px` }} onClick={() => setPinnedPreview(null)}>
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
      {displayPreview?.img && createPortal(
        <div
          className={`${styles.stackHoverPreview}${pinnedPreview ? ` ${styles.stackHoverPreviewPinned}` : ''}`}
          style={{ top: `${displayPreview.top}px`, left: `${displayPreview.left}px`, width: `${displayPreview.width}px` }}
        >
          <img src={displayPreview.img} alt="" className={styles.stackHoverPreviewImg} loading="lazy" {...NON_DRAGGABLE_IMG_PROPS} />
        </div>,
        document.body,
      )}
    </div>
  )
}

function GridCard({ card, sf, priceSource, selectMode, isSelected, onSelect, onToggleSelect, onAdjustQty, splitState, onEnterSelectMode }) {
  const img = getBrowserCardImage(card, sf)
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
  const { onMouseLeave: lpLeave, consumeFired, ...lpRest } = longPress

  const handleClick = () => {
    if (consumeFired()) return
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
const STACK_WIDTH_BY_DENSITY = { cozy: 240, comfortable: 200, compact: 170 }
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

export function CardBrowserViewControls({
  viewMode,
  setViewMode,
  groupBy,
  setGroupBy,
  selectMode = false,
  sort,
  setSort,
  filters,
  filterOpen = false,
  onToggleFilters,
  onAddCards,
  onImport,
  onExport,
  onShare,
}) {
  const activeFilters = countActive(filters)
  const sortLabel = BROWSER_SORT_OPTIONS.find(([value]) => value === sort)?.[1] || 'Sort'

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
      <div className={`${styles.mobileControlsMenu}${selectMode ? ` ${styles.mobileControlsMenuHidden}` : ''}`}>
        {onAddCards && (
          <button
            className={`${styles.mobileControlsBtn} ${styles.mobileControlsBtnPrimary}`}
            onClick={onAddCards}
            title="Add cards"
            aria-label="Add cards"
          >
            <AddIcon size={15} />
            <span>Add</span>
          </button>
        )}
        {setSort && (
          <ResponsiveMenu
            title="Sort Cards"
            forceSheet
            portal
            trigger={({ open, toggle }) => (
              <button
                className={`${styles.mobileControlsBtn}${open ? ` ${styles.mobileControlsBtnActive}` : ''}`}
                onClick={toggle}
                title={`Sort: ${sortLabel}`}
                aria-label="Sort cards"
              >
                <SortIcon size={15} />
                <span>Sort</span>
              </button>
            )}
          >
            {({ close }) => (
              <div className={uiStyles.responsiveMenuList}>
                {BROWSER_SORT_OPTIONS.map(([value, label]) => (
                  <button
                    key={value}
                    className={`${uiStyles.responsiveMenuAction} ${sort === value ? uiStyles.responsiveMenuActionActive : ''}`}
                    onClick={() => { setSort(value); close() }}
                  >
                    <span>{label}</span>
                    <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{sort === value ? <CheckIcon size={11} /> : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </ResponsiveMenu>
        )}
        {onToggleFilters && (
          <button
            className={`${styles.mobileControlsBtn}${filterOpen || activeFilters ? ` ${styles.mobileControlsBtnActive}` : ''}`}
            onClick={onToggleFilters}
            title={activeFilters ? `${activeFilters} active filters` : 'Filter cards'}
            aria-label="Filter cards"
          >
            <FilterIcon size={15} />
            <span>Filter{activeFilters ? ` ${activeFilters}` : ''}</span>
          </button>
        )}
        {onImport && (
          <button
            className={styles.mobileControlsBtn}
            onClick={onImport}
            title="Import"
            aria-label="Import"
          >
            <ImportIcon size={15} />
            <span>Import</span>
          </button>
        )}
        {onExport && (
          <button
            className={styles.mobileControlsBtn}
            onClick={onExport}
            title="Export"
            aria-label="Export"
          >
            <ExportIcon size={15} />
            <span>Export</span>
          </button>
        )}
        {onShare && (
          <button
            className={styles.mobileControlsBtn}
            onClick={onShare}
            title="Share"
            aria-label="Share"
          >
            <ShareIcon size={15} />
            <span>Share</span>
          </button>
        )}
      </div>
      <div className={styles.mobileTopControls}>
        <ResponsiveMenu
          title="Group Cards"
          forceSheet
          portal
          trigger={({ open, toggle }) => (
            <button className={`${styles.mobileControlsBtn}${open || groupBy !== 'none' ? ` ${styles.mobileControlsBtnActive}` : ''}`} onClick={toggle}>
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
          forceSheet
          portal
          trigger={({ open, toggle }) => (
            <button className={`${styles.mobileControlsBtn}${open ? ` ${styles.mobileControlsBtnActive}` : ''}`} onClick={toggle}>
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
  groupResolver,
  groupOrder,
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
  const { groups, groupOrder: resolvedGroupOrder } = useMemo(
    () => buildGroups(cards, sfMap, groupBy, groupResolver, groupOrder),
    [cards, groupBy, groupOrder, groupResolver, sfMap]
  )
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
        groupOrder={resolvedGroupOrder}
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
        density={density}
      />
    )
  }

  if (effectiveViewMode === 'text') {
    return (
      <TextView
        groups={groups}
        groupOrder={resolvedGroupOrder}
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
        groupOrder={resolvedGroupOrder}
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
      groupOrder={resolvedGroupOrder}
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
