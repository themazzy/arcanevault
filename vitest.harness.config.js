import { defineConfig } from 'vite'

// Separate config for the offline measurement harnesses under scripts/.
//
// They live outside `npm test` on purpose: they hit the network (EDHREC,
// recommander.cards, Supabase), take minutes, and produce a report rather than
// a pass/fail. Run them explicitly via `npm run harness:build-assist`.
//
// Vitest (rather than plain node) is the runner because the harness imports the
// real app modules — extensionless imports, `import.meta.env` for the Supabase
// credentials, and the actual fetchers the Build Assistant uses. Reimplementing
// those in a standalone script would measure a copy of the pipeline instead of
// the pipeline.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.harness.js'],
    globals: false,
    testTimeout: 30 * 60 * 1000, // whole sweep runs inside one case
    hookTimeout: 60 * 1000,
  },
})
