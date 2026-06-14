import { describe, it, expect } from 'vitest'
import { slugify, sanitizeUrl, parseMarkdownBlocks, extractHeadings } from './miniMarkdown.jsx'

describe('slugify', () => {
  it('kebab-cases and strips punctuation', () => {
    expect(slugify('The Game Plan!')).toBe('the-game-plan')
    expect(slugify('  Win   Conditions  ')).toBe('win-conditions')
  })
  it('falls back for empty input', () => {
    expect(slugify('')).toBe('section')
    expect(slugify('!!!')).toBe('section')
  })
})

describe('sanitizeUrl', () => {
  it('allows http(s), mailto, anchors and in-app paths', () => {
    expect(sanitizeUrl('https://scryfall.com')).toBe('https://scryfall.com')
    expect(sanitizeUrl('mailto:a@b.com')).toBe('mailto:a@b.com')
    expect(sanitizeUrl('#section')).toBe('#section')
    expect(sanitizeUrl('/decks')).toBe('/decks')
  })
  it('blocks dangerous schemes', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull()
    expect(sanitizeUrl('data:text/html,evil')).toBeNull()
  })
})

describe('parseMarkdownBlocks', () => {
  it('parses headings, lists, code, quotes and paragraphs', () => {
    const md = [
      '# Title',
      '',
      'Intro paragraph line one',
      'still same paragraph',
      '',
      '- a',
      '- b',
      '',
      '1. first',
      '2. second',
      '',
      '> a quote',
      '',
      '```',
      'code line',
      '```',
      '',
      '---',
    ].join('\n')
    const blocks = parseMarkdownBlocks(md)
    const types = blocks.map(b => b.type)
    expect(types).toEqual(['heading', 'p', 'ul', 'ol', 'quote', 'code', 'hr'])
    expect(blocks[0]).toMatchObject({ level: 1, text: 'Title' })
    expect(blocks[1].text).toBe('Intro paragraph line one still same paragraph')
    expect(blocks[2].items).toEqual(['a', 'b'])
    expect(blocks[3].items).toEqual(['first', 'second'])
    expect(blocks[5].text).toBe('code line')
  })

  it('handles empty / nullish input', () => {
    expect(parseMarkdownBlocks('')).toEqual([])
    expect(parseMarkdownBlocks(null)).toEqual([])
  })
})

describe('extractHeadings', () => {
  it('returns deduped slugs with levels', () => {
    const md = '# Plan\n## Combo\n## Combo\ntext'
    expect(extractHeadings(md)).toEqual([
      { level: 1, text: 'Plan', slug: 'plan' },
      { level: 2, text: 'Combo', slug: 'combo' },
      { level: 2, text: 'Combo', slug: 'combo-2' },
    ])
  })
})
