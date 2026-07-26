/**
 * Failure messaging for the change-owned-identity flow (printing, foil,
 * language, condition).
 *
 * `change_owned_card_identity` raises its refusals with errcode 23505 and text
 * meant for the user, but the same code can arrive from Postgres itself (the
 * unique index on cards) with a message that names an index. Anything of that
 * shape is rewritten; everything else is passed through so genuine errors —
 * including the RPC's own wording — stay legible.
 */

const RAW_UNIQUE_VIOLATION = /duplicate key value|violates unique constraint|cards_unique_owned_print_idx/i

export const DUPLICATE_PRINTING_MESSAGE =
  'You already own that version somewhere else. Move those copies here first, or pick different details.'

export function changePrintingErrorMessage(err) {
  const message = typeof err?.message === 'string' ? err.message.trim() : ''
  if (RAW_UNIQUE_VIOLATION.test(message)) return DUPLICATE_PRINTING_MESSAGE
  return message || 'Could not save those changes.'
}
