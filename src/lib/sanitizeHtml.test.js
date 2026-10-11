// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeHtml } from './sanitizeHtml'

describe('sanitizeHtml', () => {
  it('keeps the markup the changelog actually uses', () => {
    expect(sanitizeHtml('<strong>New:</strong> try the <a href="/builder">builder</a>'))
      .toBe('<strong>New:</strong> try the <a href="/builder">builder</a>')
  })

  it('drops event handlers and unknown elements but keeps their text', () => {
    expect(sanitizeHtml('<img src=x onerror="alert(1)">hi <div onclick="x()">there</div>'))
      .toBe('hi there')
    expect(sanitizeHtml('<strong style="color:red" onmouseover="x()">bold</strong>'))
      .toBe('<strong>bold</strong>')
  })

  it('removes script-like elements with their content', () => {
    expect(sanitizeHtml('a<script>alert(1)</script>b<style>*{}</style>c')).toBe('abc')
    expect(sanitizeHtml('<svg><script>alert(1)</script></svg>ok')).toBe('ok')
  })

  it('unwraps links with unsafe targets', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('x')
    expect(sanitizeHtml('<a href="data:text/html,hi">x</a>')).toBe('x')
    expect(sanitizeHtml('<a>x</a>')).toBe('x')
  })

  it('opens external links in a new tab without an opener', () => {
    expect(sanitizeHtml('<a href="https://scryfall.com" target="_self">s</a>'))
      .toBe('<a href="https://scryfall.com" target="_blank" rel="noopener noreferrer">s</a>')
  })

  it('handles empty input', () => {
    expect(sanitizeHtml(null)).toBe('')
    expect(sanitizeHtml('')).toBe('')
  })
})
