import { useEffect, useMemo, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from '../icons'
import styles from './Rulebook.module.css'

function normalize(value) {
  return String(value || '').toLowerCase()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchesRule(rule, needle) {
  return normalize(`${rule.number} ${rule.text}`).includes(needle)
}

function matchesSection(section, needle) {
  return normalize(`${section.number} ${section.title}`).includes(needle)
}

function matchesCategory(category, needle) {
  return normalize(`${category.number} ${category.title}`).includes(needle)
}

function filterRules(categories, query) {
  const needle = normalize(query).trim()
  if (!needle) return categories

  return categories
    .map(category => {
      const categoryMatch = matchesCategory(category, needle)
      const sections = category.sections
        .map(section => {
          const sectionMatch = matchesSection(section, needle)
          const rules = section.rules.filter(rule => (
            categoryMatch || sectionMatch || matchesRule(rule, needle)
          ))
          if (!categoryMatch && !sectionMatch && !rules.length) return null
          return { ...section, rules: sectionMatch || categoryMatch ? section.rules : rules }
        })
        .filter(Boolean)
      if (!categoryMatch && !sections.length) return null
      return { ...category, sections }
    })
    .filter(Boolean)
}

function countRules(categories) {
  return categories.reduce(
    (sum, category) => sum + category.sections.reduce((sub, section) => sub + section.rules.length, 0),
    0,
  )
}

function buildReferenceMap(categories) {
  const refs = new Map()
  categories.forEach(category => {
    refs.set(`category:${category.id}`, { kind: 'category', id: category.id, categoryId: category.id })
    refs.set(`section:${category.id}`, { kind: 'category', id: category.id, categoryId: category.id })

    category.sections.forEach(section => {
      refs.set(`section:${section.id}`, {
        kind: 'section',
        id: section.id,
        categoryId: category.id,
        sectionId: section.id,
      })
      refs.set(`rule:${section.id}`, {
        kind: 'section',
        id: section.id,
        categoryId: category.id,
        sectionId: section.id,
      })

      section.rules.forEach(rule => {
        const id = String(rule.id || '').replace(/\.$/, '')
        refs.set(`rule:${id}`, {
          kind: 'rule',
          id,
          categoryId: category.id,
          sectionId: section.id,
          ruleId: id,
        })
      })
    })
  })
  return refs
}

function ToggleIcon({ open }) {
  return open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />
}

function HighlightedText({ value, query }) {
  const text = String(value || '')
  const needle = String(query || '').trim()
  if (!needle) return text

  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'ig'))
  return parts.map((part, index) => (
    normalize(part) === normalize(needle)
      ? <mark key={index} className={styles.searchHighlight}>{part}</mark>
      : part
  ))
}

function ReferenceText({ value, query, references, onReferenceClick }) {
  const text = String(value || '')
  const pattern = /\b(section|rules?|rule)\s+(\d+(?:\.\d+)?[a-z]?)/ig
  const parts = []
  let cursor = 0
  let match

  while ((match = pattern.exec(text)) !== null) {
    const [label, type, number] = match
    const normalizedType = type.toLowerCase() === 'section' ? 'section' : 'rule'
    const target = references.get(`${normalizedType}:${number.replace(/\.$/, '')}`)
    if (!target) continue

    if (match.index > cursor) {
      parts.push({ text: text.slice(cursor, match.index) })
    }
    parts.push({ text: label, target })
    cursor = match.index + label.length
  }

  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor) })
  }

  if (!parts.length) return <HighlightedText value={text} query={query} />

  return parts.map((part, index) => {
    if (!part.target) return <HighlightedText key={index} value={part.text} query={query} />
    return (
      <a
        key={index}
        className={styles.ruleReference}
        href={`#${part.target.kind}-${part.target.id}`}
        onClick={event => onReferenceClick(event, part.target)}
      >
        <HighlightedText value={part.text} query={query} />
      </a>
    )
  })
}

function RuleText({ text, query, references, onReferenceClick }) {
  return String(text || '').split('\n').map((line, index) => (
    <p key={index} className={styles.ruleParagraph}>
      <ReferenceText
        value={line}
        query={query}
        references={references}
        onReferenceClick={onReferenceClick}
      />
    </p>
  ))
}

export default function RulebookPage() {
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [rulesData, setRulesData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [openCategories, setOpenCategories] = useState(() => new Set())
  const [openSections, setOpenSections] = useState(() => new Set())
  const [pendingTarget, setPendingTarget] = useState(null)
  const isSearching = submittedQuery.trim().length > 0

  useEffect(() => {
    let cancelled = false
    const url = `${import.meta.env.BASE_URL}rules/mtgRules.json`
    fetch(url)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      })
      .then(data => {
        if (!cancelled) setRulesData(data)
      })
      .catch(error => {
        if (!cancelled) setLoadError(error.message || 'Unable to load rules')
      })
    return () => { cancelled = true }
  }, [])

  const filteredCategories = useMemo(
    () => filterRules(rulesData?.categories || [], submittedQuery),
    [rulesData, submittedQuery],
  )
  const visibleRules = useMemo(() => countRules(filteredCategories), [filteredCategories])
  const references = useMemo(
    () => buildReferenceMap(rulesData?.categories || []),
    [rulesData],
  )

  useEffect(() => {
    if (!pendingTarget) return
    const element = document.getElementById(`${pendingTarget.kind}-${pendingTarget.id}`)
    if (!element) return
    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setPendingTarget(null)
  }, [pendingTarget, openCategories, openSections])

  const submitSearch = () => {
    setSubmittedQuery(query.trim())
  }

  const clearSearch = () => {
    setQuery('')
    setSubmittedQuery('')
  }

  const collapseAll = () => {
    setOpenCategories(new Set())
    setOpenSections(new Set())
    setSubmittedQuery('')
    setPendingTarget(null)
  }

  const toggleCategory = id => {
    setOpenCategories(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleSection = id => {
    setOpenSections(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleReferenceClick = (event, target) => {
    event.preventDefault()
    setSubmittedQuery('')
    if (target.categoryId) {
      setOpenCategories(prev => {
        const next = new Set(prev)
        next.add(target.categoryId)
        return next
      })
    }
    if (target.sectionId) {
      setOpenSections(prev => {
        const next = new Set(prev)
        next.add(target.sectionId)
        return next
      })
    }
    setPendingTarget(target)
    window.history.replaceState(null, '', `#${target.kind}-${target.id}`)
  }

  if (loadError) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyState}>Rulebook failed to load: {loadError}</div>
      </div>
    )
  }

  if (!rulesData) {
    return (
      <div className={styles.page}>
        <div className={styles.emptyState}>Loading rulebook...</div>
      </div>
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.heroSearch}>
        <header className={styles.hero}>
          <div>
            <div className={styles.eyebrow}>Rulebook</div>
            <h1>{rulesData.title}</h1>
            <p>Effective {rulesData.effectiveDate}</p>
          </div>
          <a className={styles.sourceLink} href={rulesData.sourceUrl} target="_blank" rel="noreferrer">
            Wizards Rules
          </a>
        </header>

        <section className={styles.searchPanel}>
          <div className={styles.searchBox}>
            <SearchIcon size={16} />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') submitSearch()
              }}
              placeholder="Search rule number, category, section, or text"
              aria-label="Search rules"
            />
            {query && (
              <button type="button" onClick={clearSearch} className={styles.clearButton}>
                Clear
              </button>
            )}
            <button type="button" onClick={submitSearch} className={styles.searchButton}>
              Search
            </button>
          </div>
          <div className={styles.resultMeta}>
            {visibleRules.toLocaleString()} of {rulesData.totalRules.toLocaleString()} entries
          </div>
        </section>
      </div>

      <div className={styles.rulebook}>
        {filteredCategories.map(category => {
          const categoryOpen = isSearching || openCategories.has(category.id)
          const showCategoryNumber = normalize(category.number) !== normalize(category.title)
          return (
            <section key={category.id} className={styles.category}>
              <button
                type="button"
                className={`${styles.categoryHeader} ${!showCategoryNumber ? styles.categoryHeaderNoNumber : ''}`}
                id={`category-${category.id}`}
                onClick={() => toggleCategory(category.id)}
                aria-expanded={categoryOpen}
              >
                <span className={styles.toggle}><ToggleIcon open={categoryOpen} /></span>
                {showCategoryNumber && <span className={styles.categoryNumber}>{category.number}</span>}
                <span className={styles.categoryTitle}>{category.title}</span>
                <span className={styles.categoryCount}>{countRules([category]).toLocaleString()}</span>
              </button>

              {categoryOpen && (
                <div className={styles.sectionList}>
                  {category.sections.map(section => {
                    const sectionOpen = isSearching || openSections.has(section.id)
                    return (
                      <div key={section.id} className={styles.ruleSection}>
                        <button
                          type="button"
                          className={styles.sectionHeader}
                          id={`section-${section.id}`}
                          onClick={() => toggleSection(section.id)}
                          aria-expanded={sectionOpen}
                        >
                          <span className={styles.toggle}><ToggleIcon open={sectionOpen} /></span>
                          <span className={styles.sectionNumber}>{section.number}</span>
                          <span className={styles.sectionTitle}>{section.title}</span>
                          <span className={styles.sectionCount}>{section.rules.length.toLocaleString()}</span>
                        </button>

                        {sectionOpen && (
                          <div className={styles.rulesList}>
                            {section.rules.map(rule => (
                              <article key={rule.id} className={styles.ruleRow} id={`rule-${rule.id}`}>
                                <div className={styles.ruleNumber}>
                                  <HighlightedText value={rule.number} query={submittedQuery} />
                                </div>
                                <div className={styles.ruleText}>
                                  <RuleText
                                    text={rule.text}
                                    query={submittedQuery}
                                    references={references}
                                    onReferenceClick={handleReferenceClick}
                                  />
                                </div>
                              </article>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )
        })}
        {!filteredCategories.length && (
          <div className={styles.emptyState}>No matching rules.</div>
        )}
      </div>

      <button type="button" className={styles.collapseAllButton} onClick={collapseAll}>
        Collapse All
      </button>
    </div>
  )
}
