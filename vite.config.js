import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import pkg from './package.json'

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
        // opencv.js is ~10 MB — never precache it (would force the download on
        // every SW install); it's runtime-cached on first scanner use below.
        globIgnores: ['rules/**', 'set-icons/**', 'opencv/**', '**/*.map'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname === 'cards.scryfall.io' || url.hostname === 'c1.scryfall.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'scryfall-card-images',
              expiration: { maxEntries: 3000, maxAgeSeconds: 60 * 60 * 24 * 30, purgeOnQuotaError: true },
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
          {
            // Vendored opencv.js (~10 MB). CacheFirst so the scanner loads it
            // from disk after the first download and works offline thereafter.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith('/opencv/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'opencv-engine',
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
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
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
