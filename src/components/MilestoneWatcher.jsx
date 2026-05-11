import { useEffect } from 'react'
import { useAuth } from './Auth'
import { useSettings } from './SettingsContext'
import { useToast } from './ToastContext'
import { checkAndNotifyMilestones } from '../lib/milestoneTracker'
import { getLocalCards, getLocalFolders } from '../lib/db'

function parseFolderMeta(description) {
  if (!description) return {}
  if (typeof description === 'object') return description
  try { return JSON.parse(description) || {} } catch { return {} }
}

function buildMilestoneShape(cards, folders, settings) {
  const stats = {
    total_cards: 0,
    unique_cards: 0,
    foil_count: 0,
    sets_count: 0,
    color_distribution: {},
  }

  const uniquePrints = new Set()
  const sets = new Set()
  for (const card of cards || []) {
    const qty = Number(card.qty || 1)
    stats.total_cards += qty
    if (card.foil) stats.foil_count += qty

    const setCode = String(card.set_code || '').trim().toLowerCase()
    const collectorNumber = String(card.collector_number || '').trim()
    if (setCode) sets.add(setCode)
    if (setCode && collectorNumber) uniquePrints.add(`${setCode}-${collectorNumber}-${card.foil ? 'foil' : 'regular'}`)
  }

  stats.unique_cards = uniquePrints.size
  stats.sets_count = sets.size

  const publicDeckCount = (folders || []).filter(folder => {
    const meta = parseFolderMeta(folder.description)
    return (folder.type === 'deck' || folder.type === 'builder_deck') &&
      meta.is_public === true &&
      !(folder.type === 'deck' && meta.linked_builder_id)
  }).length

  return {
    stats,
    profile: {
      nickname: settings?.nickname || '',
      bento_config: settings?.profile_config || {},
      public_deck_count: publicDeckCount,
      collection_value: null,
      game_stats: null,
    },
  }
}

export default function MilestoneWatcher() {
  const { user } = useAuth()
  const settings = useSettings()
  const { showToast } = useToast()
  const nickname = settings?.nickname
  const profileConfig = settings?.profile_config

  useEffect(() => {
    if (!user?.id || !nickname) return
    let cancelled = false

    const run = async () => {
      try {
        const [cards, folders] = await Promise.all([
          getLocalCards(user.id).catch(() => []),
          getLocalFolders(user.id).catch(() => []),
        ])
        if (cancelled) return
        const data = buildMilestoneShape(cards, folders, { nickname, profile_config: profileConfig })
        checkAndNotifyMilestones({
          stats: data.stats,
          profile: data.profile,
          userId: user.id,
          showToast,
        })
      } catch {}
    }

    const t = setTimeout(run, 2500)
    return () => { cancelled = true; clearTimeout(t) }
  }, [user?.id, nickname, profileConfig, showToast])

  return null
}
