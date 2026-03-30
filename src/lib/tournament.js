const POD_SCORING = {
  3: [5, 2, 0],
  4: [5, 3, 1, 0],
}

export const TOURNAMENT_FORMATS = [
  { id: 'standard', label: 'Standard', mode: 'duel', recommendedPlayers: 8 },
  { id: 'pioneer', label: 'Pioneer', mode: 'duel', recommendedPlayers: 8 },
  { id: 'modern', label: 'Modern', mode: 'duel', recommendedPlayers: 8 },
  { id: 'pauper', label: 'Pauper', mode: 'duel', recommendedPlayers: 8 },
  { id: 'draft', label: 'Draft', mode: 'duel', recommendedPlayers: 8 },
  { id: 'commander', label: 'Commander', mode: 'pod', podSizes: [4, 3], recommendedPlayers: 4 },
  { id: 'oathbreaker', label: 'Oathbreaker', mode: 'pod', podSizes: [4, 3], recommendedPlayers: 4 },
  { id: 'planechase', label: 'Planechase', mode: 'pod', podSizes: [4, 3], recommendedPlayers: 4 },
  { id: 'custom_duel', label: 'Custom Duel', mode: 'duel', recommendedPlayers: 8 },
  { id: 'custom_pod', label: 'Custom Pod', mode: 'pod', podSizes: [4, 3], recommendedPlayers: 4 },
]

export const TOURNAMENT_STRUCTURES = [
  { id: 'single_elimination', label: 'Single Elimination', modes: ['duel'] },
  { id: 'round_robin', label: 'Round Robin', modes: ['duel'] },
  { id: 'swiss', label: 'Swiss', modes: ['duel', 'pod'] },
]

export function getFormatById(formatId) {
  return TOURNAMENT_FORMATS.find(f => f.id === formatId) || TOURNAMENT_FORMATS[0]
}

export function getStructureById(structureId) {
  return TOURNAMENT_STRUCTURES.find(s => s.id === structureId) || TOURNAMENT_STRUCTURES[0]
}

export function supportsStructure(formatId, structureId) {
  const format = getFormatById(formatId)
  const structure = getStructureById(structureId)
  return structure.modes.includes(format.mode)
}

export function getDefaultRounds(structureId, playerCount, mode) {
  if (structureId === 'single_elimination') return Math.max(1, Math.ceil(Math.log2(Math.max(2, playerCount))))
  if (structureId === 'round_robin') return Math.max(1, playerCount - 1)
  if (mode === 'pod') {
    if (playerCount <= 8) return 3
    if (playerCount <= 16) return 4
    return 5
  }
  if (playerCount <= 8) return 3
  if (playerCount <= 16) return 4
  if (playerCount <= 32) return 5
  return 6
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function pairKey(a, b) {
  return [a, b].sort().join(':')
}

function nextId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function shuffle(list) {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function getPodGroupSizes(total, podSize) {
  if (total <= podSize) return [total]
  const sizes = []
  let remaining = total

  while (remaining > 0) {
    if (remaining === 6) {
      sizes.push(3, 3)
      break
    }
    if (remaining === 7) {
      sizes.push(4, 3)
      break
    }
    if (remaining === 10) {
      sizes.push(4, 3, 3)
      break
    }
    if (remaining === 5) {
      sizes.push(4, 1)
      break
    }
    if (remaining < 3) {
      sizes.push(remaining)
      break
    }

    sizes.push(Math.min(podSize, remaining))
    remaining -= Math.min(podSize, remaining)
  }

  return sizes
}

function buildHistory(rounds) {
  const faced = new Map()
  const byeIds = new Set()

  rounds.forEach(round => {
    round.matches.forEach(match => {
      if (match.kind === 'bye') {
        byeIds.add(match.participants[0])
        return
      }
      const ids = [...match.participants]
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const key = pairKey(ids[i], ids[j])
          faced.set(key, (faced.get(key) || 0) + 1)
        }
      }
    })
  })

  return { faced, byeIds }
}

function buildSingleEliminationRound(participantIds, roundNumber) {
  const bracketSize = 2 ** Math.ceil(Math.log2(Math.max(2, participantIds.length)))
  const slots = [...participantIds]
  while (slots.length < bracketSize) slots.push(null)

  return {
    id: nextId('round'),
    number: roundNumber,
    status: 'active',
    matches: chunk(slots, 2).map((pair, index) => {
      const live = pair.filter(Boolean)
      if (live.length === 1) {
        return {
          id: nextId('match'),
          table: index + 1,
          kind: 'bye',
          participants: live,
          result: { type: 'bye', winnerId: live[0] },
          completed: true,
        }
      }
      return {
        id: nextId('match'),
        table: index + 1,
        kind: 'duel',
        participants: live,
        result: null,
        completed: false,
      }
    }),
  }
}

function buildRoundRobinRounds(participantIds) {
  const ids = [...participantIds]
  if (ids.length % 2 === 1) ids.push(null)

  const rounds = []
  let arr = [...ids]
  for (let round = 0; round < ids.length - 1; round += 1) {
    const matches = []
    const half = arr.length / 2
    for (let i = 0; i < half; i += 1) {
      const a = arr[i]
      const b = arr[arr.length - 1 - i]
      if (a && b) {
        matches.push({
          id: nextId('match'),
          table: matches.length + 1,
          kind: 'duel',
          participants: [a, b],
          result: null,
          completed: false,
        })
      } else {
        const live = a || b
        matches.push({
          id: nextId('match'),
          table: matches.length + 1,
          kind: 'bye',
          participants: [live],
          result: { type: 'bye', winnerId: live },
          completed: true,
        })
      }
    }
    rounds.push({
      id: nextId('round'),
      number: round + 1,
      status: round === 0 ? 'active' : 'pending',
      matches,
    })

    arr = [arr[0], arr[arr.length - 1], ...arr.slice(1, -1)]
  }

  return rounds
}

function getMedian(list) {
  if (!list.length) return 0
  const sorted = [...list].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

export function computeStandings(tournament) {
  const players = new Map(tournament.participants.map(p => [p.id, p]))
  const table = tournament.participants.map((p, index) => ({
    participantId: p.id,
    name: p.name,
    deckName: p.deckName || '',
    type: p.type,
    seed: index + 1,
    points: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    byes: 0,
    played: 0,
    podWins: 0,
    placements: [],
    opponents: new Set(),
    opponentsPoints: 0,
  }))
  const rowMap = new Map(table.map(r => [r.participantId, r]))

  tournament.rounds.forEach(round => {
    round.matches.forEach(match => {
      if (!match.completed || !match.result) return
      if (match.kind === 'bye') {
        const row = rowMap.get(match.participants[0])
        if (!row) return
        row.byes += 1
        row.played += 1
        row.wins += 1
        row.points += tournament.mode === 'pod' ? 5 : 3
        return
      }

      if (match.kind === 'duel') {
        const [a, b] = match.participants
        const rowA = rowMap.get(a)
        const rowB = rowMap.get(b)
        rowA?.opponents.add(b)
        rowB?.opponents.add(a)
        rowA && (rowA.played += 1)
        rowB && (rowB.played += 1)

        if (match.result.type === 'draw') {
          if (rowA) {
            rowA.draws += 1
            rowA.points += 1
          }
          if (rowB) {
            rowB.draws += 1
            rowB.points += 1
          }
          return
        }

        const winner = rowMap.get(match.result.winnerId)
        const loser = rowMap.get(match.result.loserId)
        if (winner) {
          winner.wins += 1
          winner.points += 3
        }
        if (loser) loser.losses += 1
        return
      }

      if (match.kind === 'pod') {
        const placements = match.result.placements || []
        placements.forEach(({ participantId, placement }) => {
          const row = rowMap.get(participantId)
          if (!row) return
          row.played += 1
          row.placements.push(placement)
          if (placement === 1) row.podWins += 1
          const scores = POD_SCORING[placements.length] || POD_SCORING[4]
          row.points += scores[placement - 1] ?? 0
          if (placement === 1) row.wins += 1
          else row.losses += 1

          placements.forEach(other => {
            if (other.participantId !== participantId) row.opponents.add(other.participantId)
          })
        })
      }
    })
  })

  table.forEach(row => {
    row.opponentsPoints = [...row.opponents].reduce((sum, opponentId) => sum + (rowMap.get(opponentId)?.points || 0), 0)
    row.avgPlacement = row.placements.length
      ? row.placements.reduce((sum, value) => sum + value, 0) / row.placements.length
      : 0
  })

  table.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points
    if (tournament.mode === 'pod' && b.podWins !== a.podWins) return b.podWins - a.podWins
    if (b.wins !== a.wins) return b.wins - a.wins
    if (a.avgPlacement !== b.avgPlacement) return a.avgPlacement - b.avgPlacement
    if (b.opponentsPoints !== a.opponentsPoints) return b.opponentsPoints - a.opponentsPoints
    return a.seed - b.seed
  })

  table.forEach((row, index) => {
    row.rank = index + 1
    row.player = players.get(row.participantId)
  })

  return table
}

function buildSwissDuelRound(tournament, standings) {
  const history = buildHistory(tournament.rounds)
  const sorted = standings.map(row => row.participantId)
  const available = [...sorted]
  const matches = []
  let byeParticipant = null

  if (available.length % 2 === 1) {
    const byeCandidate = [...available].reverse().find(id => !history.byeIds.has(id)) || available[available.length - 1]
    byeParticipant = byeCandidate
    available.splice(available.indexOf(byeCandidate), 1)
  }

  while (available.length) {
    const a = available.shift()
    let partnerIndex = available.findIndex(b => !history.faced.has(pairKey(a, b)))
    if (partnerIndex === -1) partnerIndex = 0
    const [b] = available.splice(partnerIndex, 1)
    matches.push({
      id: nextId('match'),
      table: matches.length + 1,
      kind: 'duel',
      participants: [a, b],
      result: null,
      completed: false,
    })
  }

  if (byeParticipant) {
    matches.push({
      id: nextId('match'),
      table: matches.length + 1,
      kind: 'bye',
      participants: [byeParticipant],
      result: { type: 'bye', winnerId: byeParticipant },
      completed: true,
    })
  }

  return matches
}

function podPenalty(history, pod) {
  let score = 0
  for (let i = 0; i < pod.length; i += 1) {
    for (let j = i + 1; j < pod.length; j += 1) {
      score += history.faced.get(pairKey(pod[i], pod[j])) || 0
    }
  }
  return score
}

function buildSwissPodRound(tournament, standings) {
  const history = buildHistory(tournament.rounds)
  const podSize = tournament.podSize || 4
  const ids = standings.map(row => row.participantId)
  const rotated = [...ids]
  const rounds = []
  const targetSizes = getPodGroupSizes(rotated.length, podSize)

  targetSizes.forEach(currentSize => {
    let bestPod = rotated.slice(0, currentSize)
    let bestScore = Number.POSITIVE_INFINITY

    const limit = Math.min(rotated.length, currentSize + 4)
    for (let start = 0; start <= limit - currentSize; start += 1) {
      const candidate = rotated.slice(start, start + currentSize)
      const score = podPenalty(history, candidate)
      if (score < bestScore) {
        bestScore = score
        bestPod = candidate
      }
    }

    bestPod.forEach(id => rotated.splice(rotated.indexOf(id), 1))
    rounds.push(bestPod)
  })

  return rounds.map((participants, index) => ({
    id: nextId('match'),
    table: index + 1,
    kind: participants.length === 1 ? 'bye' : 'pod',
    participants,
    result: participants.length === 1 ? { type: 'bye', winnerId: participants[0] } : null,
    completed: participants.length === 1,
  }))
}

export function buildNextSwissRound(tournament) {
  const standings = computeStandings(tournament)
  return {
    id: nextId('round'),
    number: tournament.rounds.length + 1,
    status: 'active',
    matches: tournament.mode === 'pod'
      ? buildSwissPodRound(tournament, standings)
      : buildSwissDuelRound(tournament, standings),
  }
}

export function buildNextEliminationRound(tournament) {
  const lastRound = tournament.rounds[tournament.rounds.length - 1]
  const winners = lastRound.matches
    .map(match => match.result?.winnerId || null)
    .filter(Boolean)

  if (winners.length <= 1) return null

  return {
    id: nextId('round'),
    number: tournament.rounds.length + 1,
    status: 'active',
    matches: chunk(winners, 2).map((pair, index) => {
      if (pair.length === 1) {
        return {
          id: nextId('match'),
          table: index + 1,
          kind: 'bye',
          participants: [pair[0]],
          result: { type: 'bye', winnerId: pair[0] },
          completed: true,
        }
      }
      return {
        id: nextId('match'),
        table: index + 1,
        kind: 'duel',
        participants: pair,
        result: null,
        completed: false,
      }
    }),
  }
}

export function createTournament(config) {
  const format = getFormatById(config.formatId)
  const mode = format.mode
  const participantIds = shuffle(config.participants.map(p => p.id))

  let rounds = []
  if (config.structureId === 'single_elimination') {
    rounds = [buildSingleEliminationRound(participantIds, 1)]
  } else if (config.structureId === 'round_robin') {
    rounds = buildRoundRobinRounds(participantIds)
  } else {
    rounds = [buildNextSwissRound({
      participants: config.participants,
      rounds: [],
      mode,
      podSize: config.podSize,
    })]
  }

  if (rounds[0]) rounds[0].status = 'active'

  return {
    id: crypto.randomUUID(),
    sessionId: config.sessionId || null,
    joinCode: config.joinCode || null,
    name: config.name.trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    structureId: config.structureId,
    formatId: config.formatId,
    mode,
    podSize: config.podSize || 4,
    totalRounds: config.totalRounds,
    matchFormat: config.matchFormat || 'bo1',
    scoring: mode === 'pod' ? clone(POD_SCORING[config.podSize || 4] || POD_SCORING[4]) : [3, 1, 0],
    participants: clone(config.participants),
    rounds,
    status: 'active',
    winnerId: null,
  }
}

export function isRoundComplete(round) {
  return round.matches.every(match => match.completed)
}

export function isTournamentComplete(tournament) {
  if (tournament.status === 'completed') return true
  const activeRound = tournament.rounds[tournament.rounds.length - 1]
  if (!activeRound || !isRoundComplete(activeRound)) return false
  if (tournament.structureId === 'single_elimination') {
    const winners = activeRound.matches.map(match => match.result?.winnerId).filter(Boolean)
    return winners.length <= 1
  }
  return tournament.rounds.length >= tournament.totalRounds
}

export function recordDuelResult(tournament, roundId, matchId, result) {
  const next = clone(tournament)
  const round = next.rounds.find(r => r.id === roundId)
  const match = round?.matches.find(m => m.id === matchId)
  if (!match) return tournament

  if (result.type === 'draw') {
    match.result = { type: 'draw' }
  } else {
    const loserId = match.participants.find(id => id !== result.winnerId)
    match.result = { type: 'win', winnerId: result.winnerId, loserId }
  }
  match.completed = true
  round.status = isRoundComplete(round) ? 'completed' : 'active'
  next.updatedAt = new Date().toISOString()
  return next
}

export function recordPodResult(tournament, roundId, matchId, placements) {
  const next = clone(tournament)
  const round = next.rounds.find(r => r.id === roundId)
  const match = round?.matches.find(m => m.id === matchId)
  if (!match) return tournament

  match.result = {
    type: 'placements',
    placements: placements
      .map(item => ({ ...item, placement: Number(item.placement) }))
      .sort((a, b) => a.placement - b.placement),
  }
  match.completed = true
  round.status = isRoundComplete(round) ? 'completed' : 'active'
  next.updatedAt = new Date().toISOString()
  return next
}

export function advanceTournament(tournament) {
  const next = clone(tournament)
  const activeRound = next.rounds[next.rounds.length - 1]
  if (!activeRound || !isRoundComplete(activeRound)) return tournament

  if (isTournamentComplete(next)) {
    const standings = computeStandings(next)
    next.status = 'completed'
    next.winnerId = standings[0]?.participantId || null
    next.updatedAt = new Date().toISOString()
    return next
  }

  const round = next.structureId === 'single_elimination'
    ? buildNextEliminationRound(next)
    : next.structureId === 'swiss'
      ? buildNextSwissRound(next)
      : null

  if (round) {
    next.rounds.push(round)
  } else if (next.structureId === 'round_robin') {
    const pending = next.rounds.find(r => r.status === 'pending')
    if (pending) pending.status = 'active'
  }

  next.updatedAt = new Date().toISOString()
  return next
}

export function getCurrentRound(tournament) {
  return tournament.rounds.find(round => round.status === 'active') || tournament.rounds[tournament.rounds.length - 1] || null
}

export function getTournamentSummary(tournament) {
  const standings = computeStandings(tournament)
  const currentRound = getCurrentRound(tournament)
  return {
    standings,
    currentRound,
    medianPoints: getMedian(standings.map(row => row.points)),
  }
}
