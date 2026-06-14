// Tiny, dependency-free Markdown renderer for deck primers. Renders to React
// nodes (never dangerouslySetInnerHTML) so user-authored content on public deck
// pages cannot inject markup. Supports a deliberately small subset: ATX
// headings, bold/italic, inline code, fenced code, links, blockquotes, ordered
// & unordered lists, and horizontal rules.
import React from 'react'

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-') || 'section'
}

// Only allow safe link targets — block javascript:, data:, etc.
export function sanitizeUrl(url) {
  const u = String(url || '').trim()
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u
  if (/^\/[^/]/.test(u) || u.startsWith('#')) return u   // in-app / anchor
  return null
}

// ── Block-level parse (pure, testable) ─────────────────────────────────────
export function parseMarkdownBlocks(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  const isBlockStart = l =>
    /^(#{1,6}\s|```|>\s?|[-*+]\s+|\d+\.\s+)/.test(l) || /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    if (/^```/.test(line)) {
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++ // closing fence
      blocks.push({ type: 'code', text: buf.join('\n') })
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() }); i++; continue }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue }

    if (/^>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++ }
      blocks.push({ type: 'quote', text: buf.join('\n') })
      continue
    }

    if (/^[-*+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^[-*+]\s+/, '')); i++ }
      blocks.push({ type: 'ul', items })
      continue
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, '')); i++ }
      blocks.push({ type: 'ol', items })
      continue
    }

    const buf = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i]); i++ }
    blocks.push({ type: 'p', text: buf.join(' ') })
  }
  return blocks
}

// Headings for a table of contents (deduped slugs).
export function extractHeadings(md) {
  const seen = new Map()
  return parseMarkdownBlocks(md)
    .filter(b => b.type === 'heading')
    .map(b => {
      let slug = slugify(b.text)
      if (seen.has(slug)) { const n = seen.get(slug) + 1; seen.set(slug, n); slug = `${slug}-${n}` }
      else seen.set(slug, 1)
      return { level: b.level, text: b.text, slug }
    })
}

// ── Inline rendering ────────────────────────────────────────────────────────
function renderEmphasis(text, kp) {
  const patterns = [
    { re: /\[([^\]]+)\]\(([^)\s]+)\)/, kind: 'link' },
    { re: /\*\*([^*]+)\*\*/,           kind: 'bold' },
    { re: /__([^_]+)__/,               kind: 'bold' },
    { re: /\*([^*]+)\*/,               kind: 'em' },
    { re: /_([^_]+)_/,                 kind: 'em' },
  ]
  const nodes = []
  let rest = text
  let n = 0
  while (rest) {
    let best = null
    for (const p of patterns) {
      const m = p.re.exec(rest)
      if (m && (!best || m.index < best.m.index)) best = { p, m }
    }
    if (!best) { nodes.push(rest); break }
    if (best.m.index > 0) nodes.push(rest.slice(0, best.m.index))
    const key = `${kp}-${n++}`
    const m = best.m
    if (best.p.kind === 'link') {
      const href = sanitizeUrl(m[2])
      nodes.push(href
        ? <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">{renderEmphasis(m[1], key)}</a>
        : m[0])
    } else if (best.p.kind === 'bold') {
      nodes.push(<strong key={key}>{renderEmphasis(m[1], key)}</strong>)
    } else {
      nodes.push(<em key={key}>{renderEmphasis(m[1], key)}</em>)
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return nodes
}

function renderInline(text, kp) {
  // Split out inline code first so emphasis/links inside backticks stay literal.
  return String(text).split(/(`[^`]+`)/).map((part, idx) => {
    if (/^`[^`]+`$/.test(part)) return <code key={`${kp}-c${idx}`}>{part.slice(1, -1)}</code>
    return <React.Fragment key={`${kp}-f${idx}`}>{renderEmphasis(part, `${kp}-${idx}`)}</React.Fragment>
  })
}

// ── React component ──────────────────────────────────────────────────────────
export default function Markdown({ source, className, headingSlugs = false }) {
  const blocks = React.useMemo(() => parseMarkdownBlocks(source), [source])
  const seen = new Map()
  const headingId = text => {
    if (!headingSlugs) return undefined
    let slug = slugify(text)
    if (seen.has(slug)) { const n = seen.get(slug) + 1; seen.set(slug, n); slug = `${slug}-${n}` }
    else seen.set(slug, 1)
    return slug
  }

  return (
    <div className={className}>
      {blocks.map((b, i) => {
        const key = `b${i}`
        switch (b.type) {
          case 'heading': {
            const Tag = `h${Math.min(b.level + 1, 6)}`   // primer h1 → page h2, etc.
            return <Tag key={key} id={headingId(b.text)}>{renderInline(b.text, key)}</Tag>
          }
          case 'hr':    return <hr key={key} />
          case 'code':  return <pre key={key}><code>{b.text}</code></pre>
          case 'quote': return <blockquote key={key}>{renderInline(b.text, key)}</blockquote>
          case 'ul':    return <ul key={key}>{b.items.map((it, j) => <li key={j}>{renderInline(it, `${key}-${j}`)}</li>)}</ul>
          case 'ol':    return <ol key={key}>{b.items.map((it, j) => <li key={j}>{renderInline(it, `${key}-${j}`)}</li>)}</ol>
          default:      return <p key={key}>{renderInline(b.text, key)}</p>
        }
      })}
    </div>
  )
}
