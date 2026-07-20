// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { readLibraryBrowserPreferences } from './useLibraryBrowserPreferences'

describe('readLibraryBrowserPreferences', () => {
  beforeEach(() => window.localStorage.clear())

  it('restores valid view and grouping preferences', () => {
    window.localStorage.setItem(
      'deckloom:library-browser:binder',
      JSON.stringify({ viewMode: 'table', groupBy: 'type' }),
    )

    expect(readLibraryBrowserPreferences('binder')).toEqual({
      viewMode: 'table',
      groupBy: 'type',
    })
  })

  it('falls back when stored values are invalid or unavailable for the page', () => {
    window.localStorage.setItem(
      'deckloom:library-browser:collection',
      JSON.stringify({ viewMode: 'text', groupBy: 'invalid' }),
    )

    expect(readLibraryBrowserPreferences('collection', {
      defaultView: 'grid',
      allowedViews: new Set(['grid', 'table']),
    })).toEqual({ viewMode: 'grid', groupBy: 'none' })
  })

  it('ignores malformed storage', () => {
    window.localStorage.setItem('deckloom:library-browser:list', '{broken')
    expect(readLibraryBrowserPreferences('list')).toEqual({ viewMode: 'grid', groupBy: 'none' })
  })
})
