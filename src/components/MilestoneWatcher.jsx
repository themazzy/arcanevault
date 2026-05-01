import { useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from './Auth'
import { useSettings } from './SettingsContext'
import { useToast } from './ToastContext'
import { checkAndNotifyMilestones } from '../lib/milestoneTracker'

export default function MilestoneWatcher() {
  const { user } = useAuth()
  const settings = useSettings()
  const { showToast } = useToast()
  const nickname = settings?.nickname

  useEffect(() => {
    if (!user?.id || !nickname) return
    let cancelled = false

    const run = async () => {
      try {
        const { data } = await sb.rpc('get_public_profile', { p_username: nickname })
        if (cancelled || !data?.stats) return
        checkAndNotifyMilestones({
          stats: data.stats,
          profile: data,
          userId: user.id,
          showToast,
        })
      } catch {}
    }

    const t = setTimeout(run, 2500)
    return () => { cancelled = true; clearTimeout(t) }
  }, [user?.id, nickname, showToast])

  return null
}
