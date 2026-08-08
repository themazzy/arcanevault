import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ADJECTIVES, NOUNS } from './nicknameGenerator'

// Nicknames are assigned at signup by a Postgres trigger
// (assign_default_user_settings -> generate_nickname), so the authoritative
// word lists live in SQL. This module keeps a JS copy, which means the two can
// drift silently — nothing imports the JS generator at runtime any more, so a
// mismatch would never surface as a bug, just as inconsistent handles.
//
// These tests pin the SQL migration's arrays against the JS ones. If you change
// either list, change both and this passes again.

const MIGRATION = fileURLToPath(
  new URL(
    '../../supabase/migrations/20260808120000_assign_default_user_settings_on_signup.sql',
    import.meta.url,
  ),
)

// Pull `'Foo','Bar',...` out of `v_<name> constant text[] := array[ ... ];`
function sqlArray(sql, varName) {
  const block = new RegExp(`${varName}\\s+constant\\s+text\\[\\]\\s*:=\\s*array\\[([\\s\\S]*?)\\]`, 'i')
  const match = sql.match(block)
  if (!match) throw new Error(`could not find ${varName} in the migration`)
  return [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1])
}

describe('nickname word lists: SQL/JS parity', () => {
  const sql = readFileSync(MIGRATION, 'utf8')

  it('adjectives match src/lib/nicknameGenerator.js exactly', () => {
    expect(sqlArray(sql, 'v_adjectives')).toEqual(ADJECTIVES)
  })

  it('nouns match src/lib/nicknameGenerator.js exactly', () => {
    expect(sqlArray(sql, 'v_nouns')).toEqual(NOUNS)
  })

  it('worst-case generated nickname fits the 24-char cap', () => {
    const longestAdj = Math.max(...ADJECTIVES.map(w => w.length))
    const longestNoun = Math.max(...NOUNS.map(w => w.length))
    // The SQL widens to 4 digits after 8 collisions; that is the longest form.
    expect(longestAdj + longestNoun + 4).toBeLessThanOrEqual(24)
  })
})
