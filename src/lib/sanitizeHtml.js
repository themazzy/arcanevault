// Allow-list sanitiser for the admin-authored changelog bullets, which are
// rendered with dangerouslySetInnerHTML on every user's Home page. Only admins
// can write app_config, but the Admin bullet editor is a contentEditable that
// keeps whatever is pasted into it — an <img onerror> copied from a web page
// survives — so one compromised admin account would otherwise be stored XSS
// for everyone. Unknown elements are unwrapped (their text is kept), and every
// attribute is dropped except a safe href on <a>.
import { sanitizeUrl } from './miniMarkdown.jsx'

const ALLOWED_TAGS = new Set(['STRONG', 'B', 'EM', 'I', 'U', 'CODE', 'BR', 'A', 'SPAN'])
// Content of these is never meaningful text, so they go with their children.
const DROPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH'])

function cleanNode(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) continue // text
    if (child.nodeType !== 1) { child.remove(); continue } // comments etc.
    const tag = child.tagName.toUpperCase()
    if (DROPPED_TAGS.has(tag)) { child.remove(); continue }
    cleanNode(child)
    if (!ALLOWED_TAGS.has(tag)) {
      child.replaceWith(...child.childNodes)
      continue
    }
    const href = tag === 'A' ? sanitizeUrl(child.getAttribute('href')) : null
    for (const attr of [...child.attributes]) child.removeAttribute(attr.name)
    if (tag === 'A') {
      if (!href) { child.replaceWith(...child.childNodes); continue }
      child.setAttribute('href', href)
      if (/^https?:\/\//i.test(href)) {
        child.setAttribute('target', '_blank')
        child.setAttribute('rel', 'noopener noreferrer')
      }
    }
  }
}

export function sanitizeHtml(html) {
  if (typeof document === 'undefined') return ''
  const tpl = document.createElement('template')
  tpl.innerHTML = String(html || '')
  cleanNode(tpl.content)
  const out = document.createElement('div')
  out.appendChild(tpl.content)
  return out.innerHTML
}
