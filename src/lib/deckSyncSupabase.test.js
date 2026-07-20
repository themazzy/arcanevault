import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('./supabase', () => ({
  sb: { rpc },
}))

import { setLinkedDeckBracket } from './deckSync'

describe('setLinkedDeckBracket', () => {
  beforeEach(() => {
    rpc.mockReset()
  })

  it('persists an automatic bracket through the linked-pair RPC', async () => {
    const data = {
      deck_meta: { bracket: 3, bracketManual: false },
      counterpart_meta: { bracket: 3, bracketManual: false },
    }
    rpc.mockResolvedValue({ data, error: null })

    await expect(setLinkedDeckBracket('builder-1', 3)).resolves.toBe(data)
    expect(rpc).toHaveBeenCalledWith('set_linked_deck_bracket', {
      p_deck_id: 'builder-1',
      p_bracket: 3,
      p_manual: false,
    })
  })

  it('persists manual overrides and clears both fields with a null bracket', async () => {
    rpc.mockResolvedValue({ data: {}, error: null })

    await setLinkedDeckBracket('builder-1', 5, true)
    await setLinkedDeckBracket('builder-1', null, true)

    expect(rpc).toHaveBeenNthCalledWith(1, 'set_linked_deck_bracket', {
      p_deck_id: 'builder-1',
      p_bracket: 5,
      p_manual: true,
    })
    expect(rpc).toHaveBeenNthCalledWith(2, 'set_linked_deck_bracket', {
      p_deck_id: 'builder-1',
      p_bracket: null,
      p_manual: true,
    })
  })

  it('surfaces Supabase errors', async () => {
    const error = new Error('linked bracket update failed')
    rpc.mockResolvedValue({ data: null, error })

    await expect(setLinkedDeckBracket('builder-1', 4)).rejects.toBe(error)
  })
})
