import { useEffect, useState } from 'react'

const VIEW_MODES = new Set(['grid', 'stacks', 'table', 'text'])
const GROUP_MODES = new Set(['none', 'type', 'category'])

export function readLibraryBrowserPreferences(scope, {
  defaultView = 'grid',
  defaultGroup = 'none',
  allowedViews = VIEW_MODES,
} = {}) {
  if (typeof window === 'undefined') return { viewMode: defaultView, groupBy: defaultGroup }
  try {
    const stored = JSON.parse(window.localStorage.getItem(`deckloom:library-browser:${scope}`) || '{}')
    return {
      viewMode: allowedViews.has(stored.viewMode) ? stored.viewMode : defaultView,
      groupBy: GROUP_MODES.has(stored.groupBy) ? stored.groupBy : defaultGroup,
    }
  } catch {
    return { viewMode: defaultView, groupBy: defaultGroup }
  }
}

export function useLibraryBrowserPreferences(scope, options = {}) {
  const { defaultView = 'grid', defaultGroup = 'none', allowedViews = VIEW_MODES } = options
  const [initial] = useState(() => readLibraryBrowserPreferences(scope, { defaultView, defaultGroup, allowedViews }))
  const [viewMode, setViewMode] = useState(initial.viewMode)
  const [groupBy, setGroupBy] = useState(initial.groupBy)

  useEffect(() => {
    try {
      window.localStorage.setItem(`deckloom:library-browser:${scope}`, JSON.stringify({ viewMode, groupBy }))
    } catch {}
  }, [scope, viewMode, groupBy])

  return { viewMode, setViewMode, groupBy, setGroupBy }
}

export const LIBRARY_VIEW_MODES = VIEW_MODES
