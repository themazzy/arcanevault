import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { sb } from '../lib/supabase'
import { getPrice, formatPrice, getScryfallKey } from '../lib/scryfall'
import { loadCardMapWithSharedPrices } from '../lib/sharedCardPrices'
import { useSettings } from '../components/SettingsContext'
import { useAuth } from '../components/Auth'
import { CardDetail, FilterBar, BulkActionBar, applyFilterSort, EMPTY_FILTERS } from '../components/CardComponents'
import { EmptyState, Badge, ResponsiveMenu } from '../components/UI'
import AddCardModal from '../components/AddCardModal'
import ExportModal from '../components/ExportModal'
import ImportModal from '../components/ImportModal'
import { CardBrowserViewControls, CardBrowserContent } from '../components/CardBrowserViews'
import styles from './DeckBrowser.module.css'
import uiStyles from '../components/UI.module.css'
import { parseDeckMeta } from '../lib/deckBuilderApi'
import { useLongPress } from '../hooks/useLongPress'
import { pruneUnplacedCards } from '../lib/collectionOwnership'
import { fetchDeckAllocations, upsertDeckAllocations } from '../lib/deckData'
import { getDeckAllocations, getCardsByIds, putCards, replaceDeckAllocations } from '../lib/db'

// ── Constants (kept for grouping/categorization used in views below) ──────────

const TYPE_ORDER = ['Commander', 'Creatures', 'Planeswalkers', 'Battles', 'Instants',
  'Sorceries', 'Artifacts', 'Enchantments', 'Lands', 'Other']

const CAT_ORDER = ['Ramp', 'Mana Rock', 'Card Draw', 'Removal', 'Board Wipe',
  'Counterspell', 'Tutor', 'Burn', 'Tokens', 'Graveyard', 'Protection',
  'Extra Turns', 'Combo', 'Creature', 'Artifact', 'Enchantment',
  'Instant', 'Sorcery', 'Planeswalker', 'Land', 'Other']

const CAT_COLORS = {
  'Ramp':'#4a9a5a', 'Mana Rock':'#5a8a9a', 'Card Draw':'#5a70bb', 'Removal':'#cc5555',
  'Board Wipe':'#aa3333', 'Counterspell':'#4470cc', 'Tutor':'#9a5abb', 'Burn':'#e07020',
  'Tokens':'#6a9a4a', 'Graveyard':'#7a4a8a', 'Protection':'#aaaaaa',
  'Extra Turns':'#cc88aa', 'Combo':'#c9a84c', 'Creature':'#5a8a5a',
  'Artifact':'#8a8a9a', 'Enchantment':'#7a6aaa', 'Instant':'#5555bb',
  'Sorcery':'#9944aa', 'Planeswalker':'#cc7722', 'Land':'#6a7a5a', 'Other':'#666',
}

// ── Helpers (kept for view grouping logic) ────────────────────────────────────

function getCardType(typeLine = '') {
  const tl = typeLine.toLowerCase()
  if (tl.includes('battle'))       return 'Battles'
  if (tl.includes('creature'))     return 'Creatures'
  if (tl.includes('planeswalker')) return 'Planeswalkers'
  if (tl.includes('instant'))      return 'Instants'
  if (tl.includes('sorcery'))      return 'Sorceries'
  if (tl.includes('artifact'))     return 'Artifacts'
  if (tl.includes('enchantment'))  return 'Enchantments'
  if (tl.includes('land'))         return 'Lands'
  return 'Other'
}

function getCardCategory(card, sfCard) {
  // DFCs store oracle_text and type_line on card_faces, not the root object
  const faceOracle = sfCard?.card_faces?.map(f => f.oracle_text || '').join('\n') || ''
  const oracle = (sfCard?.oracle_text || faceOracle).toLowerCase()
  const type   = (sfCard?.type_line   || sfCard?.card_faces?.[0]?.type_line || '').toLowerCase()
  const kw     = (sfCard?.keywords    || sfCard?.card_faces?.[0]?.keywords  || []).map(k => k.toLowerCase())

  // Specific functional categories first
  if (/counter target (spell|creature spell|instant or sorcery|noncreature spell)/.test(oracle)) return 'Counterspell'
  if (/search your library for a?.*(basic )?land/.test(oracle))                                  return 'Ramp'
  if (type.includes('artifact') && /\{t\}.*add /.test(oracle))                                   return 'Mana Rock'
  if (!type.includes('land') && /add \{[wubrg2c]/.test(oracle))                                  return 'Ramp'
  if (/draw (two|three|four|\d+) cards|draw a card/.test(oracle))                                return 'Card Draw'
  if (/(destroy|exile) all (creatures|permanents|nonland)/.test(oracle))                         return 'Board Wipe'
  if (/search your library for a? ?(instant|sorcery|creature|artifact|enchantment|planeswalker)/.test(oracle) &&
      !oracle.includes('basic land'))                                                              return 'Tutor'
  if (/(exile|destroy) target (creature|permanent|artifact|enchantment|planeswalker)/.test(oracle)) return 'Removal'
  if (/deals? \d+ damage to (any target|target player|each opponent|each player)/.test(oracle))  return 'Burn'
  if (/create (a|one|two|three|four|\d+) .*token/.test(oracle))                                  return 'Tokens'
  if (/return.*from (your |a )?(graveyard|exile)/.test(oracle))                                  return 'Graveyard'
  if (/gains? hexproof|gains? indestructible|protection from/.test(oracle))                      return 'Protection'
  if (/take an? extra turn/.test(oracle))                                                         return 'Extra Turns'
  if (/infinite|whenever.*untap.*\{t\}.*\{t\}|win the game|you lose no life/.test(oracle))      return 'Combo'

  // Fall back to card type
  if (type.includes('land'))        return 'Land'
  if (type.includes('creature'))    return 'Creature'
  if (type.includes('planeswalker'))return 'Planeswalker'
  if (type.includes('instant'))     return 'Instant'
  if (type.includes('sorcery'))     return 'Sorcery'
  if (type.includes('artifact'))    return 'Artifact'
  if (type.includes('enchantment')) return 'Enchantment'
  return 'Other'
}

// ── Mana symbol (used in TableView and DeckListRow) ───────────────────────────

function InlineMana({ cost, size = 14 }) {
  if (!cost) return null
  const syms = [...cost.matchAll(/\{([^}]+)\}/g)].map(m => m[1])
  return (
    <span style={{ display:'inline-flex', gap:2, alignItems:'center', flexWrap:'wrap' }}>
      {syms.map((s, i) => (
        <img key={i}
          src={`https://svgs.scryfall.io/card-symbols/${s.replace(/\//g,'').toUpperCase()}.svg`}
          alt={`{${s}}`}
          style={{ width:size, height:size, verticalAlign:'middle', display:'inline-block', flexShrink:0 }}
        />
      ))}
    </span>
  )
}

// ── TypeIcon (used in DeckListGroup) ─────────────────────────────────────────

function TypeIcon({ type, size = 14, style }) {
  const s = size
  const icons = {
    Commander: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm2 4h10v-2H7v2z"/>
      </svg>
    ),
    Creatures: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M20.71 3.29a1 1 0 00-1.42 0L13 9.59l-1.29-1.3-1.42 1.42 1.3 1.29L3 19.59V21h1.41l8.59-8.59 1.29 1.3 1.42-1.42-1.3-1.29 6.3-6.29a1 1 0 000-1.42z"/>
        <path d="M6.5 17.5l-2 2 1 1 2-2z" opacity=".5"/>
      </svg>
    ),
    Planeswalkers: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <circle cx="12" cy="5" r="2"/>
        <path d="M12 9c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4zm-1 9h2l1 4h-4l1-4z"/>
        <path d="M10 9l-3 5h2l-1 5h4l-1-5h2z" opacity=".3"/>
      </svg>
    ),
    Battles: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm0 15l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/>
      </svg>
    ),
    Instants: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M7 2v11h3v9l7-12h-4l4-8z"/>
      </svg>
    ),
    Sorceries: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M12 23c-4.97 0-9-4.03-9-9 0-4.97 3.5-8.5 7-10 .5 1.5-.5 3.5-1 4.5 1.5-1 3-2 3.5-3.5C13 8.5 14 11.5 12 14c1 0 2.5-.5 3-1.5.5 2.5-.5 5-1 6 3-1.5 5-4.5 5-8 0-5.52-4.48-10-10-10C4.48 0 0 4.48 0 10c0 5.52 4.48 10 10 10h2c-4.42 0-8-3.58-8-8 0-1.5.42-2.89 1.15-4.08C5.77 10.76 8 13.5 8 15c.5-1.5-.5-4 0-6 1 1.5 2 3 1.5 5.5C10.5 13 11 12 12 12c-1 4-4 6-4 9 0 .34.03.67.08 1H12z"/>
      </svg>
    ),
    Artifacts: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.49.49 0 00-.59-.22l-2.39.96a7 7 0 00-1.62-.94l-.36-2.54A.484.484 0 0014 2h-4a.484.484 0 00-.48.41l-.36 2.54a7.4 7.4 0 00-1.62.94l-2.39-.96a.48.48 0 00-.59.22L2.74 8.47c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.36 1.04.67 1.62.94l.36 2.54c.05.24.27.41.48.41h4c.24 0 .44-.17.47-.41l.36-2.54a7.4 7.4 0 001.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 00-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
      </svg>
    ),
    Enchantments: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M12 3L9.5 8.5H4l4.5 3.5L7 17.5l5-3.5 5 3.5-1.5-5.5L20 8.5h-5.5z" opacity=".35"/>
        <path d="M12 2l1.09 3.26L16.18 4l-2.09 2.74L17 9l-3.35-.5L12 12l-1.65-3.5L7 9l2.91-2.26L7.82 4l3.09 1.26z"/>
      </svg>
    ),
    Lands: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M14 6l-1-2H5v17h2v-7h5l1 2h7V6h-6zm4 8h-4l-1-2H7V6h5l1 2h5v6z"/>
      </svg>
    ),
    Other: (
      <svg viewBox="0 0 24 24" width={s} height={s} fill="currentColor" style={style}>
        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"/>
      </svg>
    ),
  }
  return icons[type] || icons.Other
}

// ── View: Text ────────────────────────────────────────────────────────────────

function TextRow({ card, selectMode, isSelected, onToggleSelect, onEnterSelectMode }) {
  const longPress = useLongPress(() => { if (!selectMode) onEnterSelectMode?.() }, { delay: 500 })
  const { onMouseLeave: lpLeave, ...lpRest } = longPress
  return (
    <div
      className={`${styles.textRow}${isSelected ? ' '+styles.textRowSelected : ''}${selectMode ? ' '+styles.textRowSelectable : ''}`}
      onClick={() => selectMode ? onToggleSelect(card.id, card._folder_qty||card.qty||1) : undefined}
      onMouseLeave={e => { lpLeave?.(e) }}
      {...lpRest}>
      {selectMode && (
        <div className={`${styles.textCheckbox}${isSelected ? ' '+styles.textCheckboxChecked : ''}`}>
          {isSelected && '✓'}
        </div>
      )}
      <span className={styles.textQty}>{card._folder_qty||card.qty||1}x</span>
      <span className={styles.textName}>{card.name}</span>
      {card.foil && <span className={styles.textFoil}>✦</span>}
    </div>
  )
}

function TextView({ groups, groupOrder, selectMode, selectedCards, onToggleSelect, onEnterSelectMode, hideHeaders }) {
  return (
    <div className={styles.textView}>
      {groupOrder.filter(g => groups[g]?.length).map(group => {
        const cards = groups[group]
        const total = cards.reduce((s,c) => s+(c._folder_qty||c.qty||1), 0)
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
              .sort((a,b) => a.name.localeCompare(b.name))
              .map(c => (
                <TextRow key={c.id} card={c}
                  selectMode={selectMode}
                  isSelected={selectedCards?.has(c.id)}
                  onToggleSelect={onToggleSelect}
                  onEnterSelectMode={onEnterSelectMode} />
              ))}
          </div>
        )
      })}
    </div>
  )
}

// ── View: Table ───────────────────────────────────────────────────────────────

function TableView({ cards, sfMap, priceSource, onSelect, selectMode, selectedCards, onToggleSelect, onEnterSelectMode }) {
  const [sortCol, setSortCol] = useState('name')
  const [sortDir, setSortDir] = useState(1)

  const sorted = useMemo(() => {
    return [...cards].sort((a,b) => {
      const sfA = sfMap[getScryfallKey(a)], sfB = sfMap[getScryfallKey(b)]
      let va, vb
      if (sortCol==='name')  { va=a.name; vb=b.name; return sortDir*(va<vb?-1:va>vb?1:0) }
      if (sortCol==='cmc')   { va=sfA?.cmc??99; vb=sfB?.cmc??99 }
      if (sortCol==='type')  { va=getCardType(sfA?.type_line||sfA?.card_faces?.[0]?.type_line||''); vb=getCardType(sfB?.type_line||sfB?.card_faces?.[0]?.type_line||''); return sortDir*(va<vb?-1:va>vb?1:0) }
      if (sortCol==='price') { va=getPrice(sfA,a.foil,{price_source:priceSource})??-1; vb=getPrice(sfB,b.foil,{price_source:priceSource})??-1 }
      if (sortCol==='qty')   { va=a._folder_qty||a.qty||1; vb=b._folder_qty||b.qty||1 }
      return sortDir*(va-vb)
    })
  }, [cards, sfMap, sortCol, sortDir, priceSource])

  const thClick = col => {
    if (sortCol===col) setSortDir(d => -d)
    else { setSortCol(col); setSortDir(1) }
  }
  const arrow = col => sortCol===col ? (sortDir>0?'↑':'↓') : ''

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {selectMode && <th className={styles.th} style={{ width: 32 }} />}
            {[['qty','Qty'],['name','Name'],['cmc','CMC'],['type','Type'],['price','Price']].map(([k,l]) => (
              <th key={k} className={styles.th} onClick={() => thClick(k)}>
                {l} <span className={styles.thArrow}>{arrow(k)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(card => {
            const sf = sfMap[getScryfallKey(card)]
            const scryfallPrice = getPrice(sf, card.foil, { price_source: priceSource })
            const price = scryfallPrice ?? (parseFloat(card.purchase_price) || null)
            const mc = sf?.mana_cost || sf?.card_faces?.[0]?.mana_cost || ''
            const isSelected = selectedCards?.has(card.id)
            const handleClick = () => selectMode
              ? onToggleSelect(card.id, card._folder_qty||card.qty||1)
              : onSelect(card)
            return (
              <TableRow key={card.id} card={card} sf={sf} mc={mc} price={price} scryfallPrice={scryfallPrice}
                priceSource={priceSource} isSelected={isSelected} selectMode={selectMode}
                onClick={handleClick} onEnterSelectMode={onEnterSelectMode} />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TableRow({ card, sf, mc, price, scryfallPrice, priceSource, isSelected, selectMode, onClick, onEnterSelectMode }) {
  const longPress = useLongPress(() => { if (!selectMode) onEnterSelectMode?.() }, { delay: 500 })
  const { onMouseLeave: lpLeave, ...lpRest } = longPress
  return (
    <tr
      className={`${styles.tr}${isSelected ? ' '+styles.trSelected : ''}`}
      onClick={onClick}
      onMouseLeave={e => { lpLeave?.(e) }}
      {...lpRest}>
      {selectMode && (
        <td className={styles.td} style={{ textAlign: 'center', paddingRight: 0 }}>
          <div className={`${styles.tableCheckbox}${isSelected ? ' '+styles.tableCheckboxChecked : ''}`}>
            {isSelected && '✓'}
          </div>
        </td>
      )}
      <td className={styles.td} style={{ textAlign:'center', color:'var(--text-faint)' }}>
        {card._folder_qty||card.qty||1}
      </td>
      <td className={styles.td}>
        <span className={styles.tableName}>{card.name}</span>
        {card.foil && <span className={styles.tableFoil}>✦</span>}
      </td>
      <td className={styles.td} style={{ textAlign:'center', color:'var(--text-dim)' }}>
        <InlineMana cost={mc} size={13} />
      </td>
      <td className={styles.td} style={{ color:'var(--text-faint)', fontSize:'0.76rem' }}>
        {(sf?.type_line||'—').split('—')[0].trim()}
      </td>
      <td className={styles.td} style={{ textAlign:'right', fontFamily:'var(--font-display)', fontSize:'0.8rem', color: (scryfallPrice == null && price != null) ? 'var(--text-dim)' : 'var(--green)' }}>
        {price != null ? formatPrice(price,priceSource) : '—'}
      </td>
    </tr>
  )
}

// ── View: Stacks ──────────────────────────────────────────────────────────────

function StackCard({ card, sf, idx, priceSource, selectMode, isSelected, totalQty, onSelect, onToggleSelect, onAdjustQty, splitState, onHover, onHoverEnd, onEnterSelectMode }) {
  const img = sf?.image_uris?.normal || sf?.card_faces?.[0]?.image_uris?.normal
  const qty = card._folder_qty ?? card.qty ?? 1
  const scryfallPrice = getPrice(sf, card.foil, { price_source: priceSource })
  const price = scryfallPrice ?? (parseFloat(card.purchase_price) || null)
  const isBuyFallback = scryfallPrice == null && price != null
  const selQty = splitState?.get(card.id) ?? 1
  const longPress = useLongPress(() => { if (!selectMode) onEnterSelectMode?.() }, { delay: 500 })
  const { onMouseLeave: lpLeave, ...lpRest } = longPress
  return (
    <div
      className={`${styles.stackCard} ${isSelected ? styles.stackCardSelected : ''}`}
      style={{ zIndex: idx }}
      onClick={() => {
        if (!selectMode) return onSelect(card)
        onToggleSelect(card.id, totalQty)
      }}
      onMouseEnter={() => !selectMode && img && onHover?.(img)}
      onMouseLeave={e => { if (!selectMode) onHoverEnd?.(); lpLeave?.(e) }}
      title={card.name}
      {...lpRest}>
      {selectMode && (
        <div className={`${styles.rowCheckbox} ${isSelected ? styles.rowCheckboxChecked : ''}`}
          style={{ position: 'absolute', top: 4, left: 4, zIndex: 10 }}>
          {isSelected && '✓'}
        </div>
      )}
      <div className={styles.stackImgWrap}>
      {img
        ? <img src={img} alt={card.name} className={styles.stackCardImg} loading="lazy" />
        : <div className={styles.stackCardPlaceholder}>{card.name}</div>
      }
      {qty > 1 && !isSelected && <div className={styles.stackQty}>×{qty}</div>}
      {card.foil && <div className={styles.stackFoil}><Badge variant="foil">Foil</Badge></div>}
      {selectMode && isSelected && totalQty > 1 && (
        <div className={styles.qtyOverlay}>
          <button className={styles.qtyOverlayBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(card.id, +1, totalQty) }}>+</button>
          <div className={styles.qtyOverlayDisplay}>{selQty} of {totalQty}</div>
          <button className={styles.qtyOverlayBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(card.id, -1, totalQty) }}>−</button>
        </div>
      )}
      </div>
      <div className={styles.stackNameRow}>
        <div className={styles.stackCardName}>{card.name}</div>
        {card.foil && <span className={styles.foilMark}>✦</span>}
      </div>
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
      {groupOrder.filter(g => groups[g]?.length).map(group => {
        const cards = groups[group]
        const total = cards.reduce((s,c) => s+(c._folder_qty||c.qty||1), 0)
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
                const totalQty = card._folder_qty || card.qty || 1
                const sf = sfMap[getScryfallKey(card)]
                return (
                  <StackCard
                    key={card.id}
                    card={card}
                    sf={sf}
                    idx={idx}
                    priceSource={priceSource}
                    selectMode={selectMode}
                    isSelected={selectedCards?.has(card.id)}
                    totalQty={totalQty}
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

// ── Deck List (grouped rows, existing) ────────────────────────────────────────

function DeckListRow({ card, sfCard, priceSource, onClick, onHover, onHoverEnd, selectMode, isSelected, totalQty, selQty, onAdjustQty, onEnterSelectMode }) {
  const scryfallPrice = getPrice(sfCard, card.foil, { price_source: priceSource })
  const price = scryfallPrice ?? (parseFloat(card.purchase_price) || null)
  const isBuyFallback = scryfallPrice == null && price != null
  const typeLine = sfCard?.type_line || sfCard?.card_faces?.[0]?.type_line || ''
  const mc = sfCard?.mana_cost || sfCard?.card_faces?.[0]?.mana_cost || ''
  const qty = card._folder_qty ?? card.qty ?? 1
  const img = sfCard?.image_uris?.normal || sfCard?.card_faces?.[0]?.image_uris?.normal || null
  const longPress = useLongPress(() => { if (!selectMode) onEnterSelectMode?.() }, { delay: 500 })
  const { onMouseLeave: lpLeave, ...lpRest } = longPress
  return (
    <div className={`${styles.deckRow} ${isSelected ? styles.deckRowSelected : ''} ${selectMode ? styles.deckRowSelectMode : ''}`}
      onClick={onClick}
      onMouseEnter={() => !selectMode && img && onHover?.(img)}
      onMouseLeave={e => { if (!selectMode) onHoverEnd?.(); lpLeave?.(e) }}
      {...lpRest}>
      {/* First column: checkbox or inline qty adjuster */}
      {selectMode && isSelected && totalQty > 1
        ? (
          <span className={styles.deckRowQtyAdj}>
            <button className={styles.deckRowQtyBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(card.id, -1, totalQty) }}>−</button>
            <span className={styles.deckRowQtyVal}>{selQty}/{totalQty}</span>
            <button className={styles.deckRowQtyBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(card.id, +1, totalQty) }}>+</button>
          </span>
        )
        : selectMode
          ? <span className={`${styles.rowCheckbox} ${isSelected ? styles.rowCheckboxChecked : ''}`}>{isSelected && '✓'}</span>
          : <span className={styles.deckRowQty}>×{qty}</span>
      }
      <span className={styles.deckRowName}>{card.name}</span>
      <span className={styles.deckRowMana}><InlineMana cost={mc} size={13} /></span>
      <span className={styles.deckRowType}>{typeLine.split('—')[0].trim()}</span>
      <span className={`${styles.deckRowPrice} ${card.foil ? styles.foilPrice : ''} ${isBuyFallback ? styles.priceFallback : ''}`}>
        {price != null ? formatPrice(price,priceSource) : '—'}
      </span>
    </div>
  )
}

function DeckListGroup({ groupName, cards, sfMap, priceSource, onSelect, color, onHover, onHoverEnd, selectMode, selectedCards, onToggleSelect, onAdjustQty, splitState, onEnterSelectMode, hideHeader }) {
  const [collapsed, setCollapsed] = useState(false)
  const total = cards.reduce((s,c) => s+(c._folder_qty||c.qty||1), 0)

  return (
    <div className={styles.listGroup}>
      {!hideHeader && (
        <button className={styles.groupHeader} onClick={() => setCollapsed(v => !v)}>
          <span className={styles.groupIcon} style={{ color: color||'var(--gold-dim)' }}>
            <TypeIcon type={groupName} size={13} style={{ verticalAlign:'middle' }} />
          </span>
          <span className={styles.groupName}>{groupName}</span>
          <span className={styles.groupCount}>{total}</span>
          <span className={styles.groupToggle}>{collapsed ? '▸' : '▾'}</span>
        </button>
      )}
      {(!collapsed || hideHeader) && (
        <div className={styles.groupRows}>
          {cards.map(card => {
            const totalQty = card._folder_qty || card.qty || 1
            const isSelected = selectedCards?.has(card.id)
            const selQty = splitState?.get(card.id) ?? 1
            return (
              <DeckListRow key={card.id} card={card}
                sfCard={sfMap[getScryfallKey(card)]}
                priceSource={priceSource}
                onClick={() => {
                  if (!selectMode) { onSelect(card); return }
                  onToggleSelect(card.id, totalQty)
                }}
                onHover={onHover}
                onHoverEnd={onHoverEnd}
                selectMode={selectMode}
                isSelected={isSelected}
                totalQty={totalQty}
                selQty={selQty}
                onAdjustQty={onAdjustQty}
                onEnterSelectMode={onEnterSelectMode} />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Card Grid (compact) ───────────────────────────────────────────────────────

function GridCard({ card, sf, priceSource, selectMode, isSelected, totalQty, onSelect, onToggleSelect, onAdjustQty, splitState, onHover, onHoverEnd, onEnterSelectMode }) {
  const img = sf?.image_uris?.normal || sf?.card_faces?.[0]?.image_uris?.normal
  const qty = card._folder_qty ?? card.qty ?? 1
  const scryfallPrice = getPrice(sf, card.foil, { price_source: priceSource })
  const price = scryfallPrice ?? (parseFloat(card.purchase_price) || null)
  const isBuyFallback = scryfallPrice == null && price != null
  const selQty = splitState?.get(card.id) ?? 1
  const longPress = useLongPress(() => { if (!selectMode) onEnterSelectMode?.() }, { delay: 500 })
  const { onMouseLeave: lpLeave, ...lpRest } = longPress
  return (
    <div
      className={`${styles.gridCard} ${isSelected ? styles.gridCardSelected : ''}`}
      onClick={() => {
        if (!selectMode) return onSelect(card)
        onToggleSelect(card.id, totalQty)
      }}
      onMouseEnter={() => !selectMode && img && onHover?.(img)}
      onMouseLeave={e => { if (!selectMode) onHoverEnd?.(); lpLeave?.(e) }}
      {...lpRest}>
      {selectMode && (
        <div className={`${styles.rowCheckbox} ${isSelected ? styles.rowCheckboxChecked : ''}`}
          style={{ position: 'absolute', top: 6, left: 6, zIndex: 10 }}>
          {isSelected && '✓'}
        </div>
      )}
      <div className={styles.gridImgWrap}>
        {img ? <img src={img} alt={card.name} className={styles.gridImg} loading="lazy" />
             : <div className={styles.gridImgPlaceholder}>{card.name}</div>}
        {qty > 1 && !isSelected && <div className={styles.gridQty}>×{qty}</div>}
        {card.foil && <div className={styles.gridFoil}><Badge variant="foil">Foil</Badge></div>}
        {selectMode && isSelected && totalQty > 1 && (
          <div className={styles.qtyOverlay}>
            <button className={styles.qtyOverlayBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(card.id, +1, totalQty) }}>+</button>
            <div className={styles.qtyOverlayDisplay}>{selQty} of {totalQty}</div>
            <button className={styles.qtyOverlayBtn} onClick={e => { e.stopPropagation(); onAdjustQty?.(card.id, -1, totalQty) }}>−</button>
          </div>
        )}
      </div>
        <div className={styles.gridInfo}>
          <div className={styles.gridNameRow}>
            <div className={styles.gridName}>{card.name}</div>
            {card.foil && <span className={styles.foilMark}>✦</span>}
          </div>
          <div className={styles.gridSetRow}>
            <span className={styles.gridSet}>{(card.set_code||'').toUpperCase()}</span>
            {price != null && (
            <span className={isBuyFallback ? styles.gridPriceFallback : styles.gridPrice}>
              {formatPrice(price, priceSource)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function DeckCardGrid({ cards, sfMap, priceSource, onSelect, onHover, onHoverEnd, selectMode, selectedCards, onToggleSelect, onAdjustQty, splitState, onEnterSelectMode }) {
  return (
    <div className={styles.cardGrid}>
      {cards.map(card => {
        const totalQty = card._folder_qty || card.qty || 1
        const sf = sfMap[getScryfallKey(card)]
        return (
          <GridCard
            key={card.id}
            card={card}
            sf={sf}
            priceSource={priceSource}
            selectMode={selectMode}
            isSelected={selectedCards?.has(card.id)}
            totalQty={totalQty}
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

// ── Main DeckBrowser ──────────────────────────────────────────────────────────

export default function DeckBrowser({ folder, onBack }) {
  const navigate = useNavigate()
  const { price_source, default_sort, grid_density } = useSettings()
  const { user } = useAuth()
  const [cards, setCards]           = useState([])
  const [sfMap, setSfMap]           = useState({})
  const [loading, setLoading]       = useState(true)
  const [detailCardId, setDetailCardId] = useState(null)
  const [allFolders, setAllFolders] = useState([])
  const [viewMode, setViewMode]     = useState('grid')
  const [groupBy, setGroupBy]       = useState('none')
  const [bracketOverride, setBracketOverride] = useState(null)
  const [search, setSearch]     = useState('')
  const [sort, setSort]         = useState('cmc_asc')
  const [filters, setFilters]   = useState({ ...EMPTY_FILTERS })
  // Select mode
  const [selectMode, setSelectMode]       = useState(false)
  const [selectedCards, setSelectedCards] = useState(new Set())
  const [splitState, setSplitState]       = useState(new Map()) // Map<cardId, selectedQty>
  // Hover preview
  const [showAddCard, setShowAddCard] = useState(false)
  const [showExport, setShowExport]   = useState(false)
  const [showImport, setShowImport]   = useState(false)
  const [hoverImg, setHoverImg] = useState(null)
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 })
  const handleHover    = useCallback((img) => setHoverImg(img), [])
  const handleHoverEnd = useCallback(() => setHoverImg(null), [])
  const handleMouseMove = useCallback((e) => setHoverPos({ x: e.clientX, y: e.clientY }), [])

  const loadCards = useCallback(async () => {
    setLoading(true)
    const allocs = await getDeckAllocations(folder.id)
    if (allocs?.length) {
      const cardIds = allocs.map(a => a.card_id).filter(Boolean)
      const localCards = await getCardsByIds(cardIds)
      const cardById = Object.fromEntries(localCards.map(c => [c.id, c]))
      const cardList = allocs
        .filter(a => cardById[a.card_id])
        .map(a => ({ ...cardById[a.card_id], _folder_qty: a.qty, _allocation_id: a.id }))
      setCards(cardList)
      const map = await loadCardMapWithSharedPrices(cardList)
      if (map) setSfMap({ ...map })
    } else {
      setCards([])
    }

    if (navigator.onLine) {
      try {
        const remote = await fetchDeckAllocations(folder.id)
        const remoteCards = remote.map(row => ({
          id: row.card_id,
          scryfall_id: row.scryfall_id,
          name: row.name,
          set_code: row.set_code,
          collector_number: row.collector_number,
          foil: row.foil,
          qty: row.qty,
          condition: row.condition,
          language: row.language,
          purchase_price: row.purchase_price,
        }))
        if (remoteCards.length) await putCards(remoteCards)
        await replaceDeckAllocations([folder.id], remote.map(row => ({
          id: row.id,
          deck_id: row.deck_id,
          user_id: row.user_id,
          card_id: row.card_id,
          qty: row.qty,
          updated_at: row.updated_at,
        })))
        const cardList = remote.map(row => ({
          id: row.card_id,
          scryfall_id: row.scryfall_id,
          name: row.name,
          set_code: row.set_code,
          collector_number: row.collector_number,
          foil: row.foil,
          qty: row.qty,
          condition: row.condition,
          language: row.language,
          purchase_price: row.purchase_price,
          _folder_qty: row.qty,
          _allocation_id: row.id,
        }))
        setCards(cardList)
        const map = await loadCardMapWithSharedPrices(cardList)
        if (map) setSfMap({ ...map })
      } catch {}
    }

    setLoading(false)
  }, [folder.id])

  useEffect(() => { loadCards() }, [loadCards])

  // Fetch all folders for "Move to" dropdown (RLS filters by user automatically)
  useEffect(() => {
    sb.from('folders').select('id, name, type').then(({ data }) => setAllFolders(data || []))
  }, [])

  const clearSelect = () => { setSelectedCards(new Set()); setSplitState(new Map()); setSelectMode(false) }
  const toggleSelectMode = () => { setSelectMode(v => { if (v) clearSelect(); return !v }) }

  const onToggleSelect = useCallback((id, totalQty) => {
    setSelectedCards(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        setSplitState(s => { const n = new Map(s); n.delete(id); return n })
      } else if (totalQty > 1) {
        next.add(id)
        setSplitState(s => new Map(s).set(id, 1))
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const onAdjustQty = useCallback((id, delta, totalQty) => {
    setSplitState(prev => {
      const current = prev.get(id) ?? 1
      const next = Math.min(totalQty, current + delta)
      if (next <= 0) {
        setSelectedCards(sel => {
          const updated = new Set(sel)
          updated.delete(id)
          return updated
        })
        const updated = new Map(prev)
        updated.delete(id)
        return updated
      }
      return new Map(prev).set(id, next)
    })
  }, [])

  const handleBulkDelete = async () => {
    const toDelete = [], toUpdate = []
    for (const id of selectedCards) {
      const card = cards.find(c => c.id === id)
      const totalQty = card?._folder_qty || card?.qty || 1
      const selQty = splitState.get(id) ?? 1
      const remaining = totalQty - selQty
      remaining > 0 ? toUpdate.push({ allocId: card?._allocation_id, remaining }) : toDelete.push(card?._allocation_id)
    }
    if (toDelete.length) await sb.from('deck_allocations').delete().eq('deck_id', folder.id).in('id', toDelete.filter(Boolean))
    for (const { allocId, remaining } of toUpdate) {
      await sb.from('deck_allocations').update({ qty: remaining }).eq('id', allocId)
    }
    setCards(prev => prev.map(c => {
      if (!selectedCards.has(c.id)) return c
      const totalQty = c._folder_qty || c.qty || 1
      const selQty = splitState.get(c.id) ?? 1
      const remaining = totalQty - selQty
      return remaining > 0 ? { ...c, _folder_qty: remaining } : null
    }).filter(Boolean))
    clearSelect()
  }

  const handleMoveToFolder = async (targetFolder) => {
    const toDelete = [], toUpdate = []
    const insertRows = []
    for (const id of selectedCards) {
      const card = cards.find(c => c.id === id)
      const totalQty = card?._folder_qty || card?.qty || 1
      const selQty = splitState.get(id) ?? 1
      const remaining = totalQty - selQty
      insertRows.push({ card_id: id, qty: selQty, user_id: user.id })
      remaining > 0 ? toUpdate.push({ allocId: card?._allocation_id, remaining }) : toDelete.push(card?._allocation_id)
    }
    if (targetFolder.type === 'deck') {
      await upsertDeckAllocations(targetFolder.id, user.id, insertRows)
    } else {
      await sb.from('folder_cards').upsert(
        insertRows.map(row => ({ folder_id: targetFolder.id, card_id: row.card_id, qty: row.qty })),
        { onConflict: 'folder_id,card_id', ignoreDuplicates: true }
      )
    }
    if (toDelete.length) await sb.from('deck_allocations').delete().eq('deck_id', folder.id).in('id', toDelete.filter(Boolean))
    for (const { allocId, remaining } of toUpdate) {
      await sb.from('deck_allocations').update({ qty: remaining }).eq('id', allocId)
    }
    setCards(prev => prev.map(c => {
      if (!selectedCards.has(c.id)) return c
      const totalQty = c._folder_qty || c.qty || 1
      const selQty = splitState.get(c.id) ?? 1
      const remaining = totalQty - selQty
      return remaining > 0 ? { ...c, _folder_qty: remaining } : null
    }).filter(Boolean))
    clearSelect()
  }

  const selectedQty = useMemo(() =>
    [...selectedCards].reduce((sum, id) => {
      const c = cards.find(c => c.id === id)
      const totalQty = c?._folder_qty || c?.qty || 1
      return sum + (splitState.get(id) ?? 1)
    }, 0)
  , [selectedCards, cards, splitState])

  const { totalValue, totalQty } = useMemo(() => {
    let v=0, q=0
    for (const c of cards) {
      const sf = sfMap[getScryfallKey(c)]
      const p = getPrice(sf, c.foil, { price_source }) ?? (parseFloat(c.purchase_price) || null)
      const qty = c._folder_qty || c.qty || 1
      if (p!=null) v += p*qty
      q += qty
    }
    return { totalValue:v, totalQty:q }
  }, [cards, sfMap, price_source])

  const filtered = useMemo(
    () => applyFilterSort(cards, sfMap, search, sort, filters),
    [cards, sfMap, search, sort, filters]
  )

  // Build groups based on groupBy mode
  const { groups, groupOrder } = useMemo(() => {
    if (groupBy === 'none') return { groups: { 'All': filtered }, groupOrder: ['All'] }
    const g = {}
    const order = groupBy === 'category' ? CAT_ORDER : TYPE_ORDER

    for (const c of filtered) {
      const sf = sfMap[getScryfallKey(c)]
      const key = groupBy === 'category'
        ? getCardCategory(c, sf)
        : getCardType(sf?.type_line || sf?.card_faces?.[0]?.type_line || '')
      if (!g[key]) g[key] = []
      g[key].push(c)
    }
    return { groups: g, groupOrder: order }
  }, [filtered, sfMap, groupBy])

  const selectedCard = detailCardId ? cards.find(c => c.id === detailCardId) : null
  const selectedSf   = selectedCard ? sfMap[getScryfallKey(selectedCard)] : null
  const handleCardSave = useCallback((updatedCard) => {
    setCards(prev => prev.map(c => c.id === updatedCard.id ? { ...c, ...updatedCard } : c))
  }, [])

  if (loading) return <EmptyState>Loading deck…</EmptyState>

  const VIEW_MODES = [
    { id:'list',   label:'≡ List' },
    { id:'stacks', label:'⊟ Stacks' },
    { id:'text',   label:'¶ Text' },
    { id:'grid',   label:'⊞ Grid' },
    { id:'table',  label:'⊞ Table' },
  ]

  const ORDERED_VIEW_MODES = ['grid', 'stacks', 'table', 'text']
    .map(id => VIEW_MODES.find(v => v.id === id))
    .filter(Boolean)

  const deckMeta = parseDeckMeta(folder.description || '{}')
  // Use only the explicitly-set bg_url for the header background.
  // coverArtUri is the builder-deck commander art — it is not a user-chosen
  // background for the collection deck view and should not bleed through here.
  const folderBgUrl = (() => { try { return JSON.parse(folder.description || '{}').bg_url || null } catch { return null } })()

  return (
    <div className={styles.deckBrowser} onMouseMove={handleMouseMove} onMouseLeave={handleHoverEnd}>
      {/* Header */}
      <div className={styles.header}>
        {folderBgUrl && (
          <div className={styles.headerBg} style={{ backgroundImage: `url(${folderBgUrl})` }} />
        )}
        <button className={styles.backBtn} onClick={onBack}>← Back to Decks</button>
        <div className={styles.titleRow}>
          <h1 className={styles.deckName}>{folder.name}</h1>
          <div className={styles.headerMeta}>
            <span>{totalQty} cards</span>
            <span className={styles.deckValue}>{formatPrice(totalValue, price_source)}</span>
            <div className={styles.headerActionsDesktop}>
              <button className={styles.addCardsBtn} onClick={() => setShowImport(true)}>
                ↑ Import
              </button>
              <button className={styles.addCardsBtn} onClick={() => setShowExport(true)}>
                ↓ Export
              </button>
              <button className={styles.addCardsBtn} onClick={() => setShowAddCard(true)}>
                + Add Cards
              </button>
              <button className={styles.editInBuilderBtn} onClick={() => navigate(`/builder/${folder.id}`)}>
                ⚔ Edit in Builder
              </button>
            </div>
            <div className={styles.headerActionsMobile}>
              <ResponsiveMenu
                title="Deck Actions"
                trigger={({ open, toggle }) => (
                  <button className={styles.mobileHeaderActionsBtn} onClick={toggle}>
                    <span>Actions</span>
                    <svg className={`${styles.mobileControlsChevron} ${open ? styles.mobileControlsChevronOpen : ''}`}
                      width="10" height="10" viewBox="0 0 10 10" fill="none"
                      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="2,3 5,6.5 8,3" />
                    </svg>
                  </button>
                )}
              >
                {({ close }) => (
                  <div className={uiStyles.responsiveMenuList}>
                    <button className={uiStyles.responsiveMenuAction}
                      onClick={() => { setShowImport(true); close() }}>
                      <span>Import</span>
                    </button>
                    <button className={uiStyles.responsiveMenuAction}
                      onClick={() => { setShowExport(true); close() }}>
                      <span>Export</span>
                    </button>
                    <button className={uiStyles.responsiveMenuAction}
                      onClick={() => { setShowAddCard(true); close() }}>
                      <span>Add Cards</span>
                    </button>
                    <button className={uiStyles.responsiveMenuAction}
                      onClick={() => { navigate(`/builder/${folder.id}`); close() }}>
                      <span>Edit in Builder</span>
                    </button>
                  </div>
                )}
              </ResponsiveMenu>
            </div>
          </div>
        </div>
      </div>

      {/* Controls */}
      <FilterBar search={search} setSearch={setSearch} sort={sort} setSort={setSort}
        filters={filters} setFilters={setFilters}
        selectMode={selectMode} onToggleSelectMode={toggleSelectMode} />

      <div className={styles.controlBar}>
        <span className={styles.countInfo}>{filtered.length < cards.length
          ? `${filtered.length} of ${cards.length} cards`
          : `${cards.length} cards`}
        </span>
        <CardBrowserViewControls
          viewMode={viewMode}
          setViewMode={setViewMode}
          groupBy={groupBy}
          setGroupBy={setGroupBy}
        />
        {false && (
        <>
        <div className={styles.desktopControls}>
          <div className={styles.controlLeft}>
            <div className={styles.groupByToggle}>
              <button className={`${styles.groupByBtn} ${groupBy==='type' ? styles.groupByActive : ''}`}
                onClick={() => setGroupBy('type')}>By Type</button>
              <button className={`${styles.groupByBtn} ${groupBy==='category' ? styles.groupByActive : ''}`}
                onClick={() => setGroupBy('category')}>By Function</button>
              <button className={`${styles.groupByBtn} ${groupBy==='none' ? styles.groupByActive : ''}`}
                onClick={() => setGroupBy('none')}>Ungrouped</button>
            </div>
          </div>
          <div className={styles.viewToggle}>
            {ORDERED_VIEW_MODES.map(v => (
              <button key={v.id}
                className={`${styles.viewBtn} ${viewMode===v.id ? styles.viewActive : ''}`}
                onClick={() => setViewMode(v.id)}>
                {v.label}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.mobileControlsMenu}>
          <ResponsiveMenu
            title="Group Cards"
            trigger={({ open, toggle }) => (
              <button className={styles.mobileControlsBtn} onClick={toggle}>
                <span>Group</span>
                <svg className={`${styles.mobileControlsChevron} ${open ? styles.mobileControlsChevronOpen : ''}`}
                  width="10" height="10" viewBox="0 0 10 10" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2,3 5,6.5 8,3" />
                </svg>
              </button>
            )}
          >
            {({ close }) => (
              <div className={uiStyles.responsiveMenuList}>
                <button className={`${uiStyles.responsiveMenuAction} ${groupBy==='type' ? uiStyles.responsiveMenuActionActive : ''}`}
                  onClick={() => { setGroupBy('type'); close() }}>
                  <span>By Type</span>
                  <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{groupBy==='type' ? '✓' : ''}</span>
                </button>
                <button className={`${uiStyles.responsiveMenuAction} ${groupBy==='category' ? uiStyles.responsiveMenuActionActive : ''}`}
                  onClick={() => { setGroupBy('category'); close() }}>
                  <span>By Function</span>
                  <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{groupBy==='category' ? '✓' : ''}</span>
                </button>
                <button className={`${uiStyles.responsiveMenuAction} ${groupBy==='none' ? uiStyles.responsiveMenuActionActive : ''}`}
                  onClick={() => { setGroupBy('none'); close() }}>
                  <span>Ungrouped</span>
                  <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{groupBy==='none' ? '✓' : ''}</span>
                </button>
              </div>
            )}
          </ResponsiveMenu>
          <ResponsiveMenu
            title="View Mode"
            trigger={({ open, toggle }) => (
              <button className={styles.mobileControlsBtn} onClick={toggle}>
                <span>View</span>
                <svg className={`${styles.mobileControlsChevron} ${open ? styles.mobileControlsChevronOpen : ''}`}
                  width="10" height="10" viewBox="0 0 10 10" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2,3 5,6.5 8,3" />
                </svg>
              </button>
            )}
          >
            {({ close }) => (
              <div className={uiStyles.responsiveMenuList}>
                {ORDERED_VIEW_MODES.map(v => (
                  <button key={v.id}
                    className={`${uiStyles.responsiveMenuAction} ${viewMode===v.id ? uiStyles.responsiveMenuActionActive : ''}`}
                    onClick={() => { setViewMode(v.id); close() }}>
                    <span>{v.label.replace(/^[^\w]+ /, '')}</span>
                    <span className={uiStyles.responsiveMenuCheck} aria-hidden="true">{viewMode===v.id ? '✓' : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </ResponsiveMenu>
        </div>
        </>
        )}
      </div>

      {selectMode && selectedCards.size > 0 && (
        <BulkActionBar
          selected={selectedCards}
          selectedQty={selectedQty}
          total={filtered.reduce((s, c) => s + (c._folder_qty || c.qty || 1), 0)}
          onSelectAll={() => {
            setSelectedCards(new Set(filtered.map(c => c.id)))
            setSplitState(new Map(
              filtered
                .filter(c => (c._folder_qty || c.qty || 1) > 1)
                .map(c => [c.id, c._folder_qty || c.qty || 1])
            ))
          }}
          onDeselectAll={() => clearSelect()}
          onDelete={handleBulkDelete}
          onMoveToFolder={handleMoveToFolder}
          folders={allFolders.filter(f => f.id !== folder.id)}
          onCreateFolder={async (type, name) => {
            const { data: newFolder } = await sb
              .from('folders')
              .insert({ name, type, user_id: user.id })
              .select()
              .single()
            if (newFolder) {
              setAllFolders(prev => [...prev, newFolder])
              await handleMoveToFolder(newFolder)
            }
          }}
        />
      )}

      {filtered.length === 0 && <EmptyState>No cards match.</EmptyState>}

      {/* ── Views ── */}
      {filtered.length > 0 && (
        <CardBrowserContent
          cards={filtered}
          sfMap={sfMap}
          priceSource={price_source}
          viewMode={viewMode}
          groupBy={groupBy}
          density={grid_density}
          onSelect={c => { handleHoverEnd(); setDetailCardId(c.id) }}
          selectMode={selectMode}
          selectedCards={selectedCards}
          onToggleSelect={onToggleSelect}
          onAdjustQty={onAdjustQty}
          splitState={splitState}
          onEnterSelectMode={() => setSelectMode(true)}
          onHover={handleHover}
          onHoverEnd={handleHoverEnd}
        />
      )}

      {false && viewMode === 'list' && filtered.length > 0 && (
        <div className={styles.deckList}>
          {groupOrder.filter(g => groups[g]?.length).map(g => (
            <DeckListGroup key={g} groupName={g} cards={groups[g]}
              sfMap={sfMap} priceSource={price_source}
              onSelect={c => { handleHoverEnd(); setDetailCardId(c.id) }}
              color={groupBy==='category' ? CAT_COLORS[g] : undefined}
              onHover={handleHover} onHoverEnd={handleHoverEnd}
              selectMode={selectMode} selectedCards={selectedCards} onToggleSelect={onToggleSelect}
              splitState={splitState} onAdjustQty={onAdjustQty}
              onEnterSelectMode={() => setSelectMode(true)}
              hideHeader={groupBy==='none'} />
          ))}
        </div>
      )}

      {false && viewMode === 'stacks' && filtered.length > 0 && (
        <StacksView groups={groups} groupOrder={groupOrder} sfMap={sfMap} priceSource={price_source}
          onSelect={c => { handleHoverEnd(); setDetailCardId(c.id) }}
          onHover={handleHover} onHoverEnd={handleHoverEnd}
          selectMode={selectMode} selectedCards={selectedCards} onToggleSelect={onToggleSelect}
          splitState={splitState} onAdjustQty={onAdjustQty}
          onEnterSelectMode={() => setSelectMode(true)}
          hideHeaders={groupBy==='none'} />
      )}

      {false && viewMode === 'text' && filtered.length > 0 && (
        <TextView groups={groups} groupOrder={groupOrder}
          selectMode={selectMode} selectedCards={selectedCards} onToggleSelect={onToggleSelect}
          onEnterSelectMode={() => setSelectMode(true)}
          hideHeaders={groupBy==='none'} />
      )}

      {false && viewMode === 'grid' && filtered.length > 0 && (
        <DeckCardGrid cards={filtered} sfMap={sfMap} priceSource={price_source} onSelect={c => { handleHoverEnd(); setDetailCardId(c.id) }}
          onHover={handleHover} onHoverEnd={handleHoverEnd}
          selectMode={selectMode} selectedCards={selectedCards} onToggleSelect={onToggleSelect}
          onAdjustQty={onAdjustQty} splitState={splitState}
          onEnterSelectMode={() => { setSelectMode(true) }} />
      )}

      {false && viewMode === 'table' && filtered.length > 0 && (
        <TableView cards={filtered} sfMap={sfMap}
          priceSource={price_source}
          onSelect={c => { handleHoverEnd(); setDetailCardId(c.id) }}
          selectMode={selectMode} selectedCards={selectedCards} onToggleSelect={onToggleSelect}
          onEnterSelectMode={() => setSelectMode(true)} />
      )}
      {selectedCard && (
        <CardDetail card={selectedCard} sfCard={selectedSf}
          priceSource={price_source}
          folders={[folder]}
          allFolders={allFolders}
          currentFolderId={folder.id}
          currentFolderType={folder.type}
          onSave={handleCardSave}
          onClose={() => setDetailCardId(null)} />
      )}

      {/* Floating hover preview */}
      {hoverImg && (
        <div className={styles.floatingPreview}
          style={{ left: hoverPos.x + 18, top: Math.max(8, hoverPos.y - 160), pointerEvents: 'none' }}>
          <img className={styles.floatingImg} src={hoverImg} alt="" />
        </div>
      )}

      {showAddCard && user && (
        <AddCardModal
          userId={user.id}
          folderMode
          defaultFolderType="deck"
          defaultFolderId={folder.id}
          onClose={() => setShowAddCard(false)}
          onSaved={async () => {
            setShowAddCard(false)
            const data = await fetchDeckAllocations(folder.id)
            if (data) {
              const cardList = data.map(row => ({
                id: row.card_id,
                scryfall_id: row.scryfall_id,
                name: row.name,
                set_code: row.set_code,
                collector_number: row.collector_number,
                foil: row.foil,
                condition: row.condition,
                language: row.language,
                _folder_qty: row.qty,
                _allocation_id: row.id,
              }))
              setCards(cardList)
              const map = await loadCardMapWithSharedPrices(cardList)
              if (map) setSfMap({ ...map })
            }
          }}
        />
      )}
      {showImport && user && (
        <ImportModal
          userId={user.id}
          folderType="deck"
          folders={[folder]}
          defaultFolderId={folder.id}
          onClose={() => setShowImport(false)}
          onSaved={() => { setShowImport(false); loadCards() }}
        />
      )}
      {showExport && (
        <ExportModal
          cards={cards}
          sfMap={sfMap}
          title={folder.name}
          folderType="deck"
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  )
}
