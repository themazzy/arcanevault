import { useMemo } from 'react'
import { getCardLegalityWarnings } from './deckLegality'
import { normalizeBoard, normalizeCardName } from './deckBuilderHelpers'
import { getScryfallKey } from './scryfall'

// Computes per-card legality warnings (format legality, EDH color identity,
// singleton violations, restricted-list violations). Returns a Map keyed by
// deck_card id with an array of warnings each card carries.
//
// Maybeboard cards are intentionally skipped — they're not part of the deck's
// playable composition and shouldn't surface as deck errors.
export function useDeckCardLegalityWarnings({
  deckCards,
  builderSfMap,
  format,
  isEDH,
  colorIdentity,
}) {
  return useMemo(() => {
    const warningsById = new Map()
    const playableCards = deckCards.filter(dc => normalizeBoard(dc.board) !== 'maybe')
    const formatId = format?.id || 'commander'
    const addWarnings = (id, warnings) => {
      if (!id || !warnings?.length) return
      warningsById.set(id, [...(warningsById.get(id) || []), ...warnings])
    }

    for (const dc of playableCards) {
      const sf = dc.set_code && dc.collector_number ? builderSfMap[getScryfallKey(dc)] : null
      if (!dc.is_commander) {
        addWarnings(dc.id, getCardLegalityWarnings({
          card: { ...dc, legalities: sf?.legalities || dc.legalities },
          formatId,
          formatLabel: format?.label,
          isEDH,
          commanderColorIdentity: colorIdentity,
        }))
      }

      const legality = sf?.legalities?.[formatId]
      if (legality === 'restricted' && (dc.qty || 0) > 1) {
        addWarnings(dc.id, [{
          reason: 'restricted',
          text: `${dc.name} is restricted in ${format?.label || formatId}.`,
        }])
      }
    }

    if (isEDH) {
      const nameGroups = new Map()
      for (const dc of playableCards) {
        const name = normalizeCardName(dc.name)
        if (!name) continue
        nameGroups.set(name, [...(nameGroups.get(name) || []), dc])
      }
      for (const [, cards] of nameGroups) {
        const qty = cards.reduce((sum, dc) => sum + (dc.qty || 0), 0)
        if (qty <= 1) continue
        const typeLine = String(cards[0]?.type_line || '').toLowerCase()
        if (typeLine.includes('basic land')) continue
        for (const dc of cards) {
          addWarnings(dc.id, [{
            reason: 'duplicate',
            text: `${dc.name} has ${qty} copies in a singleton format.`,
          }])
        }
      }
    }

    return warningsById
  }, [builderSfMap, colorIdentity, deckCards, format, isEDH])
}
