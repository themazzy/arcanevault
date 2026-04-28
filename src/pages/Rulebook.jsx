import { useEffect, useMemo, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from '../icons'
import styles from './Rulebook.module.css'

function normalize(value) {
  return String(value || '').toLowerCase()
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

function ToggleIcon({ open }) {
  return open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />
}

function RuleText({ text }) {
  return String(text || '').split('\n').map((line, index) => (
    <p key={index} className={styles.ruleParagraph}>{line}</p>
  ))
}

export default function RulebookPage() {
  const [query, setQuery] = useState('')
  const [rulesData, setRulesData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [openCategories, setOpenCategories] = useState(() => new Set(['1']))
  const [openSections, setOpenSections] = useState(() => new Set(['100']))
  const isSearching = query.trim().length > 0

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
    () => filterRules(rulesData?.categories || [], query),
    [rulesData, query],
  )
  const visibleRules = useMemo(() => countRules(filteredCategories), [filteredCategories])

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
            placeholder="Search rule number, category, section, or text"
            aria-label="Search rules"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className={styles.clearButton}>
              Clear
            </button>
          )}
        </div>
        <div className={styles.resultMeta}>
          {visibleRules.toLocaleString()} of {rulesData.totalRules.toLocaleString()} entries
        </div>
      </section>

      <div className={styles.rulebook}>
        {filteredCategories.map(category => {
          const categoryOpen = isSearching || openCategories.has(category.id)
          return (
            <section key={category.id} className={styles.category}>
              <button
                type="button"
                className={styles.categoryHeader}
                onClick={() => toggleCategory(category.id)}
                aria-expanded={categoryOpen}
              >
                <span className={styles.toggle}><ToggleIcon open={categoryOpen} /></span>
                <span className={styles.categoryNumber}>{category.number}</span>
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
                                <div className={styles.ruleNumber}>{rule.number}</div>
                                <div className={styles.ruleText}><RuleText text={rule.text} /></div>
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
    </div>
  )
}
