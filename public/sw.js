// public/sw.js
const CACHE_NAME = 'arcanevault-images-v1'
const IMAGE_HOSTS = ['cards.scryfall.io', 'c1.scryfall.com']

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (!IMAGE_HOSTS.some(h => url.hostname.includes(h))) return

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
