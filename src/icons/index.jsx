// Unified SVG icon system — all icons 16×16 viewBox, currentColor
// Props: size (default 16), color (default 'currentColor'), className

function Icon({ size = 16, color = 'currentColor', className, children, viewBox = '0 0 16 16' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

// ─── Navigation ────────────────────────────────────────────────────────────────

export function HomeIcon(p) {
  return (
    <Icon {...p}>
      <path d="M2 7.5L8 2l6 5.5V14H10.5v-3.5h-5V14H2V7.5Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinejoin="round" />
    </Icon>
  )
}

export function CollectionIcon(p) {
  return (
    <Icon {...p}>
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="0.8" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="0.8" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="0.8" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="0.8" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
    </Icon>
  )
}

export function DecksIcon(p) {
  return (
    <Icon {...p}>
      <rect x="4" y="5.5" width="9" height="8" rx="1" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="2.5" y="3.5" width="9" height="8" rx="1" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" opacity="0.65" />
      <rect x="1" y="1.5" width="9" height="8" rx="1" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" opacity="0.35" />
    </Icon>
  )
}

export function BuilderIcon(p) {
  return (
    <Icon {...p}>
      <path d="M3 13L2 14l1-4 7.5-7.5 3 3L3 13Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M10.5 2.5l3 3" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
      <path d="M13.5 1.5l1 1-1.5 1.5-1-1 1.5-1.5Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinejoin="round" />
    </Icon>
  )
}

export function BindersIcon(p) {
  return (
    <Icon {...p}>
      <rect x="2" y="1" width="10.5" height="14" rx="1" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <line x1="5" y1="1" x2="5" y2="15" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <circle cx="3.5" cy="5" r="0.9" fill={p.color ?? 'currentColor'} />
      <circle cx="3.5" cy="8" r="0.9" fill={p.color ?? 'currentColor'} />
      <circle cx="3.5" cy="11" r="0.9" fill={p.color ?? 'currentColor'} />
      <line x1="7" y1="4.5" x2="11.5" y2="4.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinecap="round" />
      <line x1="7" y1="7.5" x2="11.5" y2="7.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinecap="round" />
      <line x1="7" y1="10.5" x2="10" y2="10.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinecap="round" />
    </Icon>
  )
}

export function WishlistsIcon(p) {
  return (
    <Icon {...p}>
      <rect x="2" y="2" width="12" height="12" rx="1.2" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <path d="M8 5.2L9 7.4l2.4.3-1.7 1.7.4 2.4L8 10.7l-2.1 1.1.4-2.4L4.6 7.7l2.4-.3L8 5.2Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinejoin="round" />
    </Icon>
  )
}

export function TradingIcon(p) {
  return (
    <Icon {...p}>
      <path d="M2 5h10M10 3l2 2-2 2" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 11H4M6 9l-2 2 2 2" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function StatsIcon(p) {
  return (
    <Icon {...p}>
      <rect x="1.5" y="9" width="3" height="5.5" rx="0.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="6.5" y="6" width="3" height="8.5" rx="0.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="11.5" y="2.5" width="3" height="12" rx="0.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
    </Icon>
  )
}

export function LifeIcon(p) {
  return (
    <Icon {...p}>
      <path d="M8 13.5C8 13.5 2 9.5 2 5.5a3 3 0 0 1 6-0.5A3 3 0 0 1 14 5.5c0 4-6 8-6 8Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinejoin="round" />
    </Icon>
  )
}

export function ScannerIcon(p) {
  return (
    <Icon {...p}>
      <rect x="2" y="4" width="12" height="10" rx="1.2" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <circle cx="8" cy="9" r="2.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" />
      <circle cx="8" cy="9" r="0.8" fill={p.color ?? 'currentColor'} />
      <path d="M6 2h4" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
      <path d="M11.5 4.5l.5-.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
    </Icon>
  )
}

// ─── Actions ───────────────────────────────────────────────────────────────────

export function AddIcon(p) {
  return (
    <Icon {...p}>
      <circle cx="8" cy="8" r="6.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <line x1="8" y1="5" x2="8" y2="11" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="5" y1="8" x2="11" y2="8" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
    </Icon>
  )
}

export function RemoveIcon(p) {
  return (
    <Icon {...p}>
      <circle cx="8" cy="8" r="6.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <line x1="5" y1="8" x2="11" y2="8" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
    </Icon>
  )
}

export function CloseIcon(p) {
  return (
    <Icon {...p}>
      <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.5" strokeLinecap="round" />
      <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.5" strokeLinecap="round" />
    </Icon>
  )
}

export function EditIcon(p) {
  return (
    <Icon {...p}>
      <path d="M3 13L2 14l1-4 7-7 3 3-7 7Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M10 3l3 3" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
      <path d="M12.5 1.5l2 2-1.5 1.5-2-2 1.5-1.5Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinejoin="round" />
    </Icon>
  )
}

export function DeleteIcon(p) {
  return (
    <Icon {...p}>
      <polyline points="2,4 14,4" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
      <path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" />
      <rect x="3.5" y="4" width="9" height="9.5" rx="1" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <line x1="6" y1="7" x2="6" y2="11.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
      <line x1="10" y1="7" x2="10" y2="11.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
    </Icon>
  )
}

export function SearchIcon(p) {
  return (
    <Icon {...p}>
      <circle cx="7" cy="7" r="4.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" />
      <line x1="10.5" y1="10.5" x2="14" y2="14" stroke={p.color ?? 'currentColor'} strokeWidth="1.5" strokeLinecap="round" />
    </Icon>
  )
}

export function FilterIcon(p) {
  return (
    <Icon {...p}>
      <path d="M1.5 3.5h13L9.5 9v4.5L6.5 12V9L1.5 3.5Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinejoin="round" />
    </Icon>
  )
}

export function SortIcon(p) {
  return (
    <Icon {...p}>
      <path d="M4 3v10M2 11l2 2 2-2" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 13V3M10 5l2-2 2 2" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function ImportIcon(p) {
  return (
    <Icon {...p}>
      <path d="M8 2v8M5.5 7.5L8 10l2.5-2.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11v2.5h10V11" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function ExportIcon(p) {
  return (
    <Icon {...p}>
      <path d="M8 10V2M5.5 4.5L8 2l2.5 2.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 11v2.5h10V11" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function CopyIcon(p) {
  return (
    <Icon {...p}>
      <rect x="5" y="5" width="9" height="9" rx="1" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
    </Icon>
  )
}

export function SaveIcon(p) {
  return (
    <Icon {...p}>
      <rect x="2" y="2" width="12" height="12" rx="1" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="4.5" y="2" width="7" height="4" rx="0.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" />
      <rect x="3.5" y="8.5" width="9" height="5" rx="0.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" />
      <line x1="8" y1="10" x2="8" y2="12.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinecap="round" />
    </Icon>
  )
}

export function ShareIcon(p) {
  return (
    <Icon {...p}>
      <circle cx="12.5" cy="3.5" r="1.8" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <circle cx="3.5" cy="8" r="1.8" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <circle cx="12.5" cy="12.5" r="1.8" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <line x1="5.2" y1="7" x2="10.9" y2="4.3" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
      <line x1="5.2" y1="9" x2="10.9" y2="11.7" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
    </Icon>
  )
}

export function SettingsIcon({ size = 16, color = 'currentColor', className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.92c.04-.36.07-.72.07-1.08s-.03-.73-.07-1.08l2.32-1.82c.21-.16.27-.46.13-.7l-2.2-3.81c-.13-.24-.42-.32-.66-.24l-2.74 1.1c-.57-.44-1.18-.81-1.85-1.09L14.05 2.1A.54.54 0 0 0 13.5 1.6h-3c-.27 0-.5.19-.54.46l-.41 2.89c-.67.28-1.29.65-1.85 1.09L5 4.94c-.25-.09-.53 0-.66.24L2.14 9c-.14.23-.08.53.13.7l2.32 1.82C4.53 11.27 4.5 11.63 4.5 12s.03.73.07 1.08L2.27 14.9c-.21.17-.27.47-.13.7l2.2 3.81c.13.24.41.32.66.24l2.74-1.1c.57.44 1.18.81 1.85 1.09l.41 2.9c.04.26.27.46.54.46h3c.27 0 .5-.2.54-.46l.41-2.9c.67-.28 1.28-.65 1.85-1.09l2.74 1.1c.25.08.53 0 .66-.24l2.2-3.81c.14-.23.08-.53-.13-.7l-2.32-1.82z" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ─── Folder Types ──────────────────────────────────────────────────────────────

export function BinderIcon(p) {
  const { size = 16, color = 'currentColor', className } = p
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <rect x="2" y="1" width="10.5" height="14" rx="1" stroke={color} strokeWidth="1.2" />
      <line x1="5" y1="1" x2="5" y2="15" stroke={color} strokeWidth="1.2" />
      <circle cx="3.5" cy="5" r="0.9" fill={color} />
      <circle cx="3.5" cy="8" r="0.9" fill={color} />
      <circle cx="3.5" cy="11" r="0.9" fill={color} />
      <line x1="7" y1="4.5" x2="11.5" y2="4.5" stroke={color} strokeWidth="1.0" strokeLinecap="round" />
      <line x1="7" y1="7.5" x2="11.5" y2="7.5" stroke={color} strokeWidth="1.0" strokeLinecap="round" />
      <line x1="7" y1="10.5" x2="10" y2="10.5" stroke={color} strokeWidth="1.0" strokeLinecap="round" />
    </svg>
  )
}

export function DeckIcon(p) {
  const { size = 16, color = 'currentColor', className } = p
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <rect x="4" y="5.5" width="9" height="8" rx="1" stroke={color} strokeWidth="1.2" />
      <rect x="2.5" y="3.5" width="9" height="8" rx="1" stroke={color} strokeWidth="1.1" opacity="0.65" />
      <rect x="1" y="1.5" width="9" height="8" rx="1" stroke={color} strokeWidth="1.0" opacity="0.35" />
    </svg>
  )
}

export function ListIcon(p) {
  const { size = 16, color = 'currentColor', className } = p
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <rect x="2" y="2" width="12" height="12" rx="1.2" stroke={color} strokeWidth="1.2" />
      <path d="M8 5.2L9 7.4l2.4.3-1.7 1.7.4 2.4L8 10.7l-2.1 1.1.4-2.4L4.6 7.7l2.4-.3L8 5.2Z" stroke={color} strokeWidth="1.0" strokeLinejoin="round" />
    </svg>
  )
}

export function BuilderDeckIcon(p) {
  const { size = 16, color = 'currentColor', className } = p
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <rect x="3.5" y="4.5" width="9" height="10" rx="1" stroke={color} strokeWidth="1.2" />
      <rect x="2" y="3" width="9" height="10" rx="1" stroke={color} strokeWidth="1.1" opacity="0.55" />
      <line x1="6" y1="7.5" x2="10" y2="7.5" stroke={color} strokeWidth="1.0" strokeLinecap="round" />
      <line x1="6" y1="9.5" x2="10" y2="9.5" stroke={color} strokeWidth="1.0" strokeLinecap="round" />
      <path d="M12 1.5l1.5 1.5-1 1-1.5-1.5L12 1.5Z" stroke={color} strokeWidth="1.0" strokeLinejoin="round" />
      <path d="M9 4.5l2.5-2.5 1.5 1.5-2.5 2.5" stroke={color} strokeWidth="1.0" strokeLinejoin="round" />
    </svg>
  )
}

export function FolderTypeIcon({ type, size = 16, className }) {
  const colors = {
    binder:        'rgba(201,168,76,0.9)',
    deck:          'rgba(138,111,196,0.9)',
    list:          'rgba(100,180,100,0.9)',
    builder_deck:  'rgba(100,160,220,0.9)',
  }
  const color = colors[type] ?? colors.binder
  if (type === 'deck')         return <DeckIcon size={size} color={color} className={className} />
  if (type === 'list')         return <ListIcon size={size} color={color} className={className} />
  if (type === 'builder_deck') return <BuilderDeckIcon size={size} color={color} className={className} />
  return <BinderIcon size={size} color={color} className={className} />
}

// ─── View Modes ────────────────────────────────────────────────────────────────

export function GridViewIcon(p) {
  return (
    <Icon {...p}>
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="0.7" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="0.7" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="0.7" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="0.7" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
    </Icon>
  )
}

export function ListViewIcon(p) {
  return (
    <Icon {...p}>
      <line x1="2" y1="4.5" x2="14" y2="4.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="2" y1="8" x2="14" y2="8" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="2" y1="11.5" x2="14" y2="11.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
    </Icon>
  )
}

export function StacksViewIcon(p) {
  return (
    <Icon {...p}>
      <rect x="4.5" y="6" width="9" height="7.5" rx="0.8" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <rect x="3" y="4" width="9" height="7.5" rx="0.8" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" opacity="0.6" />
      <rect x="1.5" y="2" width="9" height="7.5" rx="0.8" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" opacity="0.3" />
    </Icon>
  )
}

export function TextViewIcon(p) {
  return (
    <Icon {...p}>
      <line x1="2" y1="3.5" x2="14" y2="3.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="2" y1="6.5" x2="11" y2="6.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="2" y1="9.5" x2="14" y2="9.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="2" y1="12.5" x2="8" y2="12.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
    </Icon>
  )
}

export function TableViewIcon(p) {
  return (
    <Icon {...p}>
      <rect x="1.5" y="1.5" width="13" height="13" rx="1" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <line x1="1.5" y1="5.5" x2="14.5" y2="5.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" />
      <line x1="6" y1="5.5" x2="6" y2="14.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" />
      <line x1="10.5" y1="5.5" x2="10.5" y2="14.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" />
    </Icon>
  )
}

// ─── Status ────────────────────────────────────────────────────────────────────

export function CheckIcon(p) {
  return (
    <Icon {...p}>
      <polyline points="2.5,8 6,11.5 13.5,4" stroke={p.color ?? 'currentColor'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function WarningIcon(p) {
  return (
    <Icon {...p}>
      <path d="M8 2L14.5 13.5H1.5L8 2Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinejoin="round" />
      <line x1="8" y1="6.5" x2="8" y2="9.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.7" fill={p.color ?? 'currentColor'} />
    </Icon>
  )
}

export function BannedIcon(p) {
  return (
    <Icon {...p}>
      <circle cx="8" cy="8" r="6.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <line x1="3.4" y1="3.4" x2="12.6" y2="12.6" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
    </Icon>
  )
}

export function RestrictedIcon(p) {
  return (
    <Icon {...p}>
      <circle cx="8" cy="8" r="6.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <line x1="8" y1="5" x2="8" y2="8.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11" r="0.8" fill={p.color ?? 'currentColor'} />
    </Icon>
  )
}

export function FoilIcon(p) {
  return (
    <Icon {...p}>
      <path d="M8 2l.8 2.4 2.5.1-2 1.6.7 2.4L8 7.2l-2 1.3.7-2.4-2-1.6 2.5-.1L8 2Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M3.5 10.5l.4 1.2 1.3.1-1 .8.3 1.2-1-.6-1 .6.3-1.2-1-.8 1.3-.1.4-1.2Z" stroke={p.color ?? 'currentColor'} strokeWidth="0.9" strokeLinejoin="round" />
      <path d="M12 10l.3.9.9.1-.7.6.2.9-.7-.5-.7.5.2-.9-.7-.6.9-.1.3-.9Z" stroke={p.color ?? 'currentColor'} strokeWidth="0.8" strokeLinejoin="round" />
    </Icon>
  )
}

export function StarIcon(p) {
  return (
    <Icon {...p}>
      <path d="M8 2l1.5 3.1 3.5.5-2.5 2.4.6 3.5L8 9.7l-3.1 1.8.6-3.5L3 5.6l3.5-.5L8 2Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinejoin="round" />
    </Icon>
  )
}

// ─── Game ──────────────────────────────────────────────────────────────────────

export function SwordIcon(p) {
  return (
    <Icon {...p}>
      <line x1="13" y1="3" x2="3" y2="13" stroke={p.color ?? 'currentColor'} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M13 3l-4 1 3 3 1-4Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinejoin="round" />
      <line x1="4.5" y1="9" x2="3" y2="10.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
      <line x1="5.5" y1="11.5" x2="4" y2="13" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
    </Icon>
  )
}

export function ShieldIcon(p) {
  return (
    <Icon {...p}>
      <path d="M8 2L2.5 4.5v4C2.5 11 5 13.5 8 14.5c3-1 5.5-3.5 5.5-6v-4L8 2Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinejoin="round" />
    </Icon>
  )
}

export function LightningIcon(p) {
  return (
    <Icon {...p}>
      <path d="M9.5 2L5 9h4.5L6.5 14 13 7H8L9.5 2Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinejoin="round" />
    </Icon>
  )
}

export function TrophyIcon(p) {
  return (
    <Icon {...p}>
      <path d="M5 2h6v5a3 3 0 0 1-6 0V2Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <path d="M2 2.5h3M11 2.5h3" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
      <path d="M2 2.5c0 2 1.5 3.5 3 3.5M14 2.5c0 2-1.5 3.5-3 3.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" />
      <line x1="8" y1="10" x2="8" y2="12.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
      <line x1="5" y1="13.5" x2="11" y2="13.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" />
    </Icon>
  )
}

export function TargetIcon(p) {
  return (
    <Icon {...p}>
      <circle cx="8" cy="8" r="6.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <circle cx="8" cy="8" r="3.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" />
      <circle cx="8" cy="8" r="1" fill={p.color ?? 'currentColor'} />
    </Icon>
  )
}

export function DiceIcon(p) {
  return (
    <Icon {...p}>
      <rect x="2" y="2" width="12" height="12" rx="2" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <circle cx="5.5" cy="5.5" r="0.9" fill={p.color ?? 'currentColor'} />
      <circle cx="10.5" cy="10.5" r="0.9" fill={p.color ?? 'currentColor'} />
      <circle cx="10.5" cy="5.5" r="0.9" fill={p.color ?? 'currentColor'} />
      <circle cx="5.5" cy="10.5" r="0.9" fill={p.color ?? 'currentColor'} />
      <circle cx="8" cy="8" r="0.9" fill={p.color ?? 'currentColor'} />
    </Icon>
  )
}

export function CommanderIcon(p) {
  return (
    <Icon {...p}>
      <path d="M8 2L9.5 5.2l3.5.5-2.5 2.5.6 3.5L8 10l-3.1 1.7.6-3.5L3 5.7l3.5-.5L8 2Z" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinejoin="round" />
      <line x1="8" y1="11.5" x2="8" y2="14.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
      <line x1="6" y1="13" x2="10" y2="13" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
    </Icon>
  )
}

// ─── UI Chrome ─────────────────────────────────────────────────────────────────

export function ChevronDownIcon(p) {
  return (
    <Icon {...p}>
      <polyline points="3.5,5.5 8,10.5 12.5,5.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function ChevronUpIcon(p) {
  return (
    <Icon {...p}>
      <polyline points="3.5,10.5 8,5.5 12.5,10.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function ChevronLeftIcon(p) {
  return (
    <Icon {...p}>
      <polyline points="10.5,3.5 5.5,8 10.5,12.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function ChevronRightIcon(p) {
  return (
    <Icon {...p}>
      <polyline points="5.5,3.5 10.5,8 5.5,12.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </Icon>
  )
}

export function MenuIcon(p) {
  return (
    <Icon {...p}>
      <line x1="2" y1="4.5" x2="14" y2="4.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.4" strokeLinecap="round" />
      <line x1="2" y1="8" x2="14" y2="8" stroke={p.color ?? 'currentColor'} strokeWidth="1.4" strokeLinecap="round" />
      <line x1="2" y1="11.5" x2="14" y2="11.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.4" strokeLinecap="round" />
    </Icon>
  )
}

export function LockIcon(p) {
  return (
    <Icon {...p}>
      <rect x="3" y="7.5" width="10" height="7" rx="1" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <path d="M5 7.5V5a3 3 0 0 1 6 0v2.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="11" r="1.2" fill={p.color ?? 'currentColor'} />
    </Icon>
  )
}

export function BugIcon(p) {
  return (
    <Icon {...p}>
      <ellipse cx="8" cy="9" rx="3.5" ry="4.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <path d="M5 5.5a3 3 0 0 1 6 0" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" />
      <line x1="8" y1="4.5" x2="8" y2="6" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
      <line x1="1.5" y1="8" x2="4.5" y2="8" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
      <line x1="11.5" y1="8" x2="14.5" y2="8" stroke={p.color ?? 'currentColor'} strokeWidth="1.1" strokeLinecap="round" />
      <line x1="2" y1="11.5" x2="4.5" y2="10.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinecap="round" />
      <line x1="14" y1="11.5" x2="11.5" y2="10.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinecap="round" />
      <line x1="3" y1="5.5" x2="5" y2="7" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinecap="round" />
      <line x1="13" y1="5.5" x2="11" y2="7" stroke={p.color ?? 'currentColor'} strokeWidth="1.0" strokeLinecap="round" />
    </Icon>
  )
}

export function InfoIcon(p) {
  return (
    <Icon {...p}>
      <circle cx="8" cy="8" r="6.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" />
      <line x1="8" y1="7" x2="8" y2="11.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="5" r="0.8" fill={p.color ?? 'currentColor'} />
    </Icon>
  )
}

export function ExternalLinkIcon(p) {
  return (
    <Icon {...p}>
      <path d="M7 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
      <path d="M10 2h4v4" stroke={p.color ?? 'currentColor'} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="14" y1="2" x2="7.5" y2="8.5" stroke={p.color ?? 'currentColor'} strokeWidth="1.2" strokeLinecap="round" />
    </Icon>
  )
}
