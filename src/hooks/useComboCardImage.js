import { useEffect, useState } from 'react'

const imageRequests = new Map()

function resolveImageUri(card) {
  return card?.image_uris?.normal
    || card?.card_faces?.[0]?.image_uris?.normal
    || card?.image_uris?.large
    || card?.card_faces?.[0]?.image_uris?.large
    || null
}

export function useComboCardImage(name, existingUri) {
  const [images, setImages] = useState(() => existingUri ? { [name]: existingUri } : {})

  useEffect(() => {
    if (existingUri || !name) return
    let cancelled = false
    let request = imageRequests.get(name)
    if (!request) {
      request = fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=json`)
        .then(response => response.ok ? response.json() : null)
        .then(resolveImageUri)
        .catch(() => null)
      imageRequests.set(name, request)
    }
    request.then(uri => {
      if (!uri) {
        if (imageRequests.get(name) === request) imageRequests.delete(name)
        return
      }
      if (!cancelled) {
        setImages(current => current[name] === uri ? current : { ...current, [name]: uri })
      }
    })
    return () => { cancelled = true }
  }, [existingUri, name])

  return existingUri || images[name] || null
}
