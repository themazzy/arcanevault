import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json'
import { execSync } from 'node:child_process'

/**
 * Short commit SHA for the build stamp.
 *
 * GITHUB_SHA is preferred because Actions checks out a detached HEAD, where
 * `git rev-parse` still works but the env var is the authoritative answer.
 * Falls back to 'dev' rather than throwing — a missing stamp must never be
 * able to break a build.
 */
function buildSha() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev'
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    // Replaces the old hand-rolled public/sw.js (image cache only). Adds app
    // shell precaching so repeat visits load from disk, keeps the Scryfall
    // image runtime cache, and auto-updates on new deploys.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'inline',
      manifest: false, // public/site.webmanifest already exists
      workbox: {
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
        // Big/rarely-used statics are runtime-cached instead of precached.
        // scanner/hashpack (~11 MB of binary chunks) is cached in IndexedDB by
        // the scanner itself; ocr/** (~6 MB tesseract worker/core/traineddata)
        // is runtime-cached below on first OCR use.
        globIgnores: ['rules/**', 'set-icons/**', 'scanner/**', '**/*.map'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname === 'cards.scryfall.io' || url.hostname === 'c1.scryfall.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'scryfall-card-images',
              // 12,000 rather than the original 3,000, which was a third of one
              // real collection (11,354 distinct prints). A cap below the
              // collection size does not "limit" the cache so much as guarantee
              // permanent churn: browsing to the bottom of Collection evicted
              // roughly two-thirds of what it had just stored, so scrolling back
              // re-downloaded images the user already had — on every visit,
              // forever. The pathology is the re-download, so the cap has to
              // clear the collection at least once.
              //
              // Sizing: the grid renders the `grid` WebP tier, measured at
              // ~78 KB/card (vs 156 KB for `normal` JPEG), so 12,000 is ~936 MB
              // worst case. That is a ceiling, not a reservation — entries only
              // appear as they are browsed, eviction is LRU, and
              // purgeOnQuotaError yields the whole cache if the browser pushes
              // back, which matters on mobile where quotas are far tighter.
              expiration: { maxEntries: 12000, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.hostname === 'svgs.scryfall.io',
            handler: 'CacheFirst',
            options: {
              cacheName: 'scryfall-set-svgs',
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url, sameOrigin }) => sameOrigin && (url.pathname.startsWith('/set-icons/') || url.pathname.startsWith('/rules/')),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'local-statics',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (/[\\/]node_modules[\\/]@supabase[\\/]/.test(id)) return 'vendor-supabase'
          if (/[\\/]node_modules[\\/]@tanstack[\\/]/.test(id)) return 'vendor-query'
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{js,jsx}'],
    globals: false,
    // Stub credentials, for two reasons.
    //
    // 1. The suite did not run on a clean checkout. `src/lib/supabase.js`
    //    calls createClient() at module scope and supabase-js throws
    //    "supabaseUrl is required" on undefined input, so all 45 suites that
    //    transitively import it died at import time wherever no .env existed.
    //    That went unnoticed for as long as it did precisely because every
    //    machine running the tests happened to have one; CI was the first
    //    environment without.
    //
    // 2. Hermeticity. With a real .env loaded, any test that forgets to mock
    //    Supabase silently talks to PRODUCTION using the developer's own
    //    credentials. These values are deliberately non-resolvable so such a
    //    test fails loudly instead.
    //
    // Tests mock the client, so nothing here is ever dialled. The harnesses
    // under scripts/ need real credentials and are unaffected — they run on
    // vitest.harness.config.js, which does not set these.
    env: {
      VITE_SUPABASE_URL: 'https://stub.supabase.invalid',
      VITE_SUPABASE_ANON_KEY: 'stub-anon-key',
      // scripts/sync-oracle-cards.mjs process.exit(1)s at import without
      // these, which took oracleSyncSkip.test.js down with it. It falls back
      // to the VITE_ URL above, so only the service key is needed here.
      SUPABASE_SERVICE_KEY: 'stub-service-key',
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // The commit the running bundle was built from. package.json's version is
    // effectively static, so it cannot distinguish two builds — which made
    // "am I on the fix, or on a cached older build?" unanswerable from the
    // device. That question came up for real on 2026-08-16, where a stale
    // service worker was indistinguishable from a fix that had not worked.
    // Surfaced in Settings → App → Version.
    __BUILD_SHA__: JSON.stringify(buildSha()),
  },
  server: {
    // EDHREC and the deck-import sources no longer need dev proxies: EDHREC's
    // /pages/ JSON sends CORS *, and Archidekt/Moxfield/Goldfish imports go
    // through the Cloudflare Worker (deckloom.app/api/import/*) in all envs.
    proxy: {
      '/api/combos': {
        target: 'https://backend.commanderspellbook.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/combos/, ''),
        headers: {
          'Origin': 'https://commanderspellbook.com',
          'Referer': 'https://commanderspellbook.com/',
        },
      },
    },
  }
})
