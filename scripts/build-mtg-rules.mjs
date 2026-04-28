import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const inputPath = path.join(root, 'public', 'rules', 'MagicCompRules-20260417.txt')
const outputPath = path.join(root, 'public', 'rules', 'mtgRules.json')

const raw = fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, '')
const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
const start = lines.findIndex((line, idx) => idx > 50 && /^1\. Game Concepts$/.test(line))
if (start < 0) throw new Error('Could not find start of numbered rules')

const title = lines[0]
const effectiveLine = lines.find(line => /^These rules are effective as of /.test(line)) || ''
const effectiveDate = effectiveLine.replace(/^These rules are effective as of /, '').replace(/\.$/, '')

const categories = []
let currentCategory = null
let currentSection = null
let currentRule = null
let glossary = null
let currentGlossaryEntry = null

function finishRule() {
  currentRule = null
}

function ensureGlossary() {
  if (!glossary) {
    glossary = {
      id: 'glossary',
      number: 'Glossary',
      title: 'Glossary',
      sections: [
        { id: 'glossary-terms', number: 'Glossary', title: 'Terms', rules: [] },
      ],
    }
  }
  return glossary.sections[0]
}

for (let i = start; i < lines.length; i += 1) {
  const line = lines[i]
  if (line === 'Credits') break

  if (line === 'Glossary') {
    finishRule()
    currentCategory = null
    currentSection = ensureGlossary()
    currentGlossaryEntry = null
    continue
  }

  if (glossary && currentSection === glossary.sections[0]) {
    if (/^[A-Z][A-Za-z0-9 ’'(),/-]*$/.test(line) && !/[.;:]$/.test(line)) {
      currentGlossaryEntry = {
        id: `glossary-${line.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
        number: line,
        text: '',
      }
      currentSection.rules.push(currentGlossaryEntry)
      continue
    }
    if (currentGlossaryEntry) {
      currentGlossaryEntry.text = currentGlossaryEntry.text
        ? `${currentGlossaryEntry.text}\n${line}`
        : line
    }
    continue
  }

  const categoryMatch = line.match(/^([1-9])\. (.+)$/)
  if (categoryMatch) {
    finishRule()
    currentCategory = {
      id: categoryMatch[1],
      number: categoryMatch[1],
      title: categoryMatch[2],
      sections: [],
    }
    categories.push(currentCategory)
    currentSection = null
    continue
  }

  const sectionMatch = line.match(/^([1-9]\d\d)\. (.+)$/)
  if (sectionMatch && currentCategory) {
    finishRule()
    currentSection = {
      id: sectionMatch[1],
      number: sectionMatch[1],
      title: sectionMatch[2],
      rules: [],
    }
    currentCategory.sections.push(currentSection)
    continue
  }

  const ruleMatch = line.match(/^([1-9]\d\d\.\d+[a-z]?\.?)\s+(.+)$/)
  if (ruleMatch && currentSection) {
    currentRule = {
      id: ruleMatch[1].replace(/\.$/, ''),
      number: ruleMatch[1],
      text: ruleMatch[2],
    }
    currentSection.rules.push(currentRule)
    continue
  }

  if (currentRule) {
    currentRule.text = `${currentRule.text}\n${line}`
  }
}

if (glossary) categories.push(glossary)

const totalRules = categories.reduce(
  (sum, category) => sum + category.sections.reduce((sub, section) => sub + section.rules.length, 0),
  0,
)

const output = {
  title,
  effectiveDate,
  sourceUrl: 'https://magic.wizards.com/en/rules',
  downloadUrl: 'https://media.wizards.com/2026/downloads/MagicCompRules%2020260417.txt',
  generatedAt: new Date().toISOString(),
  totalRules,
  categories,
}

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`)
console.log(`Wrote ${totalRules} rules and glossary entries to ${path.relative(root, outputPath)}`)
