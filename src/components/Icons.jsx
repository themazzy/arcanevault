// Inline SVG icons matching the dark fantasy aesthetic

export function BinderIcon({ size = 14, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Book/binder with rings */}
      <rect x="2" y="1" width="9" height="12" rx="1" stroke={color} strokeWidth="1.1" fill="none"/>
      <line x1="4.5" y1="1" x2="4.5" y2="13" stroke={color} strokeWidth="1.1"/>
      <circle cx="3.5" cy="4.5" r="0.8" fill={color}/>
      <circle cx="3.5" cy="7" r="0.8" fill={color}/>
      <circle cx="3.5" cy="9.5" r="0.8" fill={color}/>
      <line x1="6" y1="4" x2="10" y2="4" stroke={color} strokeWidth="0.9" strokeLinecap="round"/>
      <line x1="6" y1="6.5" x2="10" y2="6.5" stroke={color} strokeWidth="0.9" strokeLinecap="round"/>
      <line x1="6" y1="9" x2="9" y2="9" stroke={color} strokeWidth="0.9" strokeLinecap="round"/>
    </svg>
  )
}

export function DeckIcon({ size = 14, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Stacked cards */}
      <rect x="3" y="5" width="8" height="7" rx="1" stroke={color} strokeWidth="1.1" fill="none"/>
      <rect x="2" y="3" width="8" height="7" rx="1" stroke={color} strokeWidth="1.1" fill="none" opacity="0.7"/>
      <rect x="1" y="1" width="8" height="7" rx="1" stroke={color} strokeWidth="1.1" fill="none" opacity="0.4"/>
    </svg>
  )
}

export function ListIcon({ size = 14, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Wishlist / scroll */}
      <rect x="2" y="1.5" width="10" height="11" rx="1" stroke={color} strokeWidth="1.1" fill="none"/>
      <line x1="4.5" y1="4.5" x2="9.5" y2="4.5" stroke={color} strokeWidth="0.9" strokeLinecap="round"/>
      <line x1="4.5" y1="7" x2="9.5" y2="7" stroke={color} strokeWidth="0.9" strokeLinecap="round"/>
      <line x1="4.5" y1="9.5" x2="8" y2="9.5" stroke={color} strokeWidth="0.9" strokeLinecap="round"/>
      <circle cx="3.2" cy="4.5" r="0.65" fill={color}/>
      <circle cx="3.2" cy="7" r="0.65" fill={color}/>
      <circle cx="3.2" cy="9.5" r="0.65" fill={color}/>
    </svg>
  )
}

export function FolderTypeIcon({ type, size = 14 }) {
  const colors = {
    binder: 'rgba(201,168,76,0.85)',
    deck:   'rgba(138,111,196,0.85)',
    list:   'rgba(100,180,100,0.85)',
  }
  const color = colors[type] || colors.binder
  if (type === 'deck')   return <DeckIcon size={size} color={color} />
  if (type === 'list')   return <ListIcon size={size} color={color} />
  return <BinderIcon size={size} color={color} />
}
