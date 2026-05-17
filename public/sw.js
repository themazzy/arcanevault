// public/sw.js
const CACHE_NAME = 'arcanevault-images-v1'
// Exact-match allowlist. Using a Set + .has() prevents subdomain confusion
// (e.g. an attacker-controlled cards.scryfall.io.evil.com would have matched
// the previous substring check and poisoned the cache).
const IMAGE_HOSTS = new Set(['cards.scryfall.io', 'c1.scryfall.com'])

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(
  // Drop any cache that isn't the current version. Lets us bump CACHE_NAME
  // in the future without leaving the old image cache pinned forever.
  caches.keys()
    .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
    .then(() => self.clients.claim())
))

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (!IMAGE_HOSTS.has(url.hostname)) return

  e.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(e.request)
      if (cached) return cached

      try {
        const response = await fetch(e.request)
        if (response.ok) cache.put(e.request, response.clone())
        return response
      } catch {
        return new Response('', { status: 408 })
      }
    })
  )
})

// Trim cache to most recent 3000 images to prevent unbounded growth
self.addEventListener('message', async (e) => {
  if (e.data !== 'trim') return
  const cache = await caches.open(CACHE_NAME)
  const keys = await cache.keys()
  if (keys.length > 3000) {
    const toDelete = keys.slice(0, keys.length - 3000)
    await Promise.all(toDelete.map(k => cache.delete(k)))
  }
})
