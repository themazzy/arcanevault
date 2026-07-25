// Shared-game lobby for the life tracker.
//
// The lobby exists for exactly one reason: to attribute a game's result to other
// players' accounts. One device tracks life in the middle of the table; guests join
// only so their deck gets the win or loss on their own record. There is no mirrored
// life display, and guests are not required for a game to work.
//
// Kept out of the page so the Supabase calls are describable in one place and the
// page stays about the game.

import { sb } from './supabase'
import { PLAYER_COLORS, DEFAULT_NAMES } from './lifeGame'

// Ambiguous glyphs (I/O/0/1) are excluded — codes get read aloud across a table.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const CODE_ATTEMPTS = 5
const UNIQUE_VIOLATION = '23505'

export function generateJoinCode() {
  return Array.from(
    { length: CODE_LENGTH },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
  ).join('')
}

/**
 * Create a lobby and its unclaimed seats.
 * @returns {Promise<{ session: object }>}
 * @throws on a persistent failure — the caller surfaces it as a toast.
 */
export async function createLobby({ hostUserId, format, customLife, seatCount }) {
  let lastError = null

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = generateJoinCode()
    const { data: session, error } = await sb.from('game_sessions').insert({
      code,
      host_user_id: hostUserId,
      mode: format,
      custom_life: format === 'custom' ? customLife : null,
      player_count: seatCount,
      status: 'lobby',
    }).select().single()

    // Two hosts drew the same code — try another one.
    if (error?.code === UNIQUE_VIOLATION) { lastError = error; continue }
    if (error) throw error

    const slots = Array.from({ length: seatCount }, (_, i) => ({
      session_id: session.id,
      slot_index: i,
      player_name: DEFAULT_NAMES[i] || `Player ${i + 1}`,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length],
    }))
    const { error: slotError } = await sb.from('game_players').insert(slots)
    if (slotError) {
      // Don't leave a lobby with no seats behind.
      await sb.from('game_sessions').delete().eq('id', session.id)
      throw slotError
    }

    return { session }
  }

  throw lastError || new Error('Could not generate a free join code.')
}

export async function fetchLobbySlots(sessionId) {
  const { data, error } = await sb.from('game_players')
    .select('*')
    .eq('session_id', sessionId)
    .order('slot_index')
  if (error) throw error
  return data || []
}

/** The host claims their own seat before the lobby opens to guests. */
export async function claimSlot(slotId, { userId, name, color, deckId, deckName, artUrl }) {
  const { error } = await sb.from('game_players').update({
    user_id: userId,
    player_name: name,
    color,
    deck_id: deckId || null,
    deck_name: deckName || null,
    art_crop_url: artUrl || null,
    claimed_at: new Date().toISOString(),
  }).eq('id', slotId)
  if (error) throw error
}

export async function startLobby(sessionId) {
  const { error } = await sb.from('game_sessions')
    .update({ status: 'playing', started_at: new Date().toISOString() })
    .eq('id', sessionId)
  if (error) throw error
}

export async function cancelLobby(sessionId) {
  // ON DELETE CASCADE on game_players takes the seats with it.
  await sb.from('game_sessions').delete().eq('id', sessionId)
}

export async function endLobby(sessionId, endedAtIso) {
  const { error } = await sb.from('game_sessions')
    .update({ status: 'ended', ended_at: endedAtIso })
    .eq('id', sessionId)
  if (error) console.error('game_sessions finalize:', error)
}

/**
 * Watch a lobby's seats. Realtime plus a slow poll, because a postgres_changes
 * payload carries only the primary key under the default replica identity and
 * realtime can drop messages on a flaky phone connection.
 * @returns {() => void} cleanup
 */
export function subscribeLobby(sessionId, onChange, { pollMs = 4000 } = {}) {
  const channel = sb.channel(`life-lobby:${sessionId}`)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'game_players',
      filter: `session_id=eq.${sessionId}`,
    }, onChange)
    .subscribe()

  const poll = setInterval(onChange, pollMs)

  return () => {
    sb.removeChannel(channel)
    clearInterval(poll)
  }
}

/**
 * Re-apply lobby attribution to a running game, just before the result is saved.
 *
 * The host seeds players from the seats once, when the game starts. Guests can
 * still claim a seat or change their deck after that — people swap decks between
 * joining and shuffling up — and those changes have to reach the result rows or the
 * guest's win lands on the wrong deck, or on no account at all.
 *
 * A claimed seat's own account and deck always win: it is that player's record.
 * Unclaimed seats keep whatever the host set locally on the device.
 *
 * @param {object} game
 * @param {Array<object>} slots ordered by slot_index
 * @returns {object} a game with refreshed userId/deckId/deckName
 */
export function mergeSlotAttribution(game, slots) {
  if (!slots?.length) return game
  const bySlot = new Map(slots.map(slot => [slot.slot_index, slot]))
  return {
    ...game,
    players: game.players.map((player, index) => {
      const slot = bySlot.get(index)
      if (!slot?.user_id) return player
      return {
        ...player,
        userId: slot.user_id,
        deckId: slot.deck_id || null,
        deckName: slot.deck_name || null,
      }
    }),
  }
}

/**
 * Turn lobby seats into createGame seeds. Unclaimed seats still become players —
 * a four-seat lobby that only two people joined is still a four-player game.
 */
export function seedsFromSlots(slots) {
  return (slots || []).map(slot => ({
    name: slot.player_name,
    color: slot.color,
    deckId: slot.deck_id,
    deckName: slot.deck_name,
    artUrl: slot.art_crop_url,
    userId: slot.user_id,
  }))
}
