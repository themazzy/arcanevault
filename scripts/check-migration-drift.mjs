import { spawnSync } from 'node:child_process'

const isWindows = process.platform === 'win32'
const executable = isWindows ? process.env.ComSpec : 'npx'
const args = isWindows
  ? ['/d', '/s', '/c', 'npx.cmd supabase migration list --linked']
  : ['supabase', 'migration', 'list', '--linked']
const result = spawnSync(executable, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
})

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)

let payload
try {
  payload = JSON.parse(result.stdout)
} catch {
  console.error('Could not parse Supabase migration list output.')
  console.error(result.stdout)
  process.exit(1)
}

const drift = (payload.migrations || []).filter(row => !row.local || !row.remote || row.local !== row.remote)
if (drift.length) {
  console.error(`Migration drift detected in ${drift.length} row(s):`)
  for (const row of drift) console.error(`  local=${row.local || '-'} remote=${row.remote || '-'}`)
  process.exit(1)
}

console.log(`Migration history aligned (${payload.migrations?.length || 0} migrations).`)
