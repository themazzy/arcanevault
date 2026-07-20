import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { useSettings, THEMES, PREMIUM_THEMES } from './SettingsContext'
import { PRICE_SOURCES, sfGet } from '../lib/scryfall'
import BRAND_MARK from '../icons/DeckLoom_logo.png'
import styles from './SetupWizard.module.css'
import { CheckIcon } from '../icons'

const SetupWizardContext = createContext({ open: () => {} })
export const useSetupWizard = () => useContext(SetupWizardContext)

export function SetupWizardProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false)

  const open = useCallback(() => {
    setIsOpen(true)
  }, [])

  const close = useCallback(() => setIsOpen(false), [])

  return (
    <SetupWizardContext.Provider value={{ open }}>
      {children}
      {isOpen && <SetupWizardModal onClose={close} />}
    </SetupWizardContext.Provider>
  )
}

const STEPS = [
  { id: 'overview', label: 'Overview' },
  { id: 'theme', label: 'Theme' },
  { id: 'text', label: 'Display' },
  { id: 'prices', label: 'Prices' },
  { id: 'done', label: 'Done' },
]

function SetupWizardModal({ onClose }) {
  const settings = useSettings()
  const [step, setStep] = useState(0)

  const isLast = step === STEPS.length - 1

  const handleNext = () => {
    if (isLast) { onClose(); return }
    setStep(s => s + 1)
  }

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Personalize DeckLoom">
      <div className={styles.modal}>
        <div className={styles.header}>
          <div className={styles.headerLogo}>
            <img className={styles.brandMark} src={BRAND_MARK} alt="" aria-hidden="true" />
            <span className={styles.logoText}>Deck<span>Loom</span></span>
          </div>
          <div className={styles.progressRow}>
            <div className={styles.steps}>
              {STEPS.map((s, i) => (
                <div
                  key={s.id}
                  className={[
                    styles.stepDot,
                    i === step ? styles.stepDotActive : '',
                    i < step ? styles.stepDotDone : '',
                  ].filter(Boolean).join(' ')}
                />
              ))}
            </div>
            <div className={styles.stepLabel}>{STEPS[step].label} &middot; {step + 1} of {STEPS.length}</div>
          </div>
        </div>

        <div className={styles.body}>
          {step === 0 && <WelcomeStep />}
          {step === 1 && <ThemeStep settings={settings} />}
          {step === 2 && <TextStep settings={settings} />}
          {step === 3 && <PriceStep settings={settings} />}
          {step === 4 && <DoneStep />}
        </div>

        <div className={styles.footer}>
          <div>
            {step > 0 && (
              <button className={styles.btnBack} onClick={() => setStep(s => s - 1)}>
                ← Back
              </button>
            )}
          </div>
          <div className={styles.footerRight}>
            {!isLast && (
              <button className={styles.btnSkip} onClick={onClose}>
                Close
              </button>
            )}
            <button
              className={styles.btnNext}
              onClick={handleNext}
            >
              {isLast ? 'Done' : 'Next →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function WelcomeStep() {
  return (
    <div className={styles.stepContent}>
      <div className={styles.welcomeGlyph}>⬡</div>
      <h2 className={styles.stepTitle}>Personalize DeckLoom</h2>
      <p className={styles.stepDesc}>
        Review the preferences that shape how DeckLoom looks and displays collection values. Every change remains available in Settings.
      </p>
      <div className={styles.featureList}>
        {[
          ['Theme', 'Choose a colour palette and optional contrast settings'],
          ['Display', 'Adjust typography, card-name size, motion, and grid density'],
          ['Price market', 'Choose the marketplace used for collection values'],
        ].map(([title, desc]) => (
          <div key={title} className={styles.featureItem}>
            <div className={styles.featureItemTitle}>{title}</div>
            <div className={styles.featureItemDesc}>{desc}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Toggle({ value, onChange }) {
  return (
    <button
      type="button"
      className={`${styles.toggle}${value ? ' ' + styles.toggleOn : ''}`}
      aria-pressed={value}
      onClick={() => onChange(!value)}
    >
      <span className={styles.toggleKnob} />
    </button>
  )
}

function ThemeStep({ settings }) {
  const current = settings.theme || 'shadow'
  const isLight = THEMES[current]?.mode === 'light'
  return (
    <div className={styles.stepContent}>
      <h2 className={styles.stepTitle}>Choose your theme</h2>
      <p className={styles.stepDesc}>Pick a colour palette. Changes are applied instantly and synced across devices.</p>
      <div className={styles.themeGrid}>
        {Object.entries(THEMES).map(([id, theme]) => {
          const active = current === id
          const locked = PREMIUM_THEMES.has(id) && !settings.premium
          const { bg, accent, hi, text } = theme.preview
          return (
            <button
              key={id}
              className={`${styles.themeSwatch}${active ? ' ' + styles.themeSwatchActive : ''}${locked ? ' ' + styles.themeSwatchLocked : ''}`}
              onClick={() => !locked && settings.save({ theme: id })}
              style={{ '--sw-bg': bg, '--sw-accent': accent, '--sw-hi': hi, '--sw-text': text }}
              title={locked ? `${theme.name} — cosmetic supporter theme available after donating` : theme.name}
            >
              <div className={styles.swatchBar}>
                <div style={{ flex: 2, background: accent, borderRadius: '2px 0 0 2px' }} />
                <div style={{ flex: 1, background: hi }} />
                <div style={{ flex: 1, background: `${text}60`, borderRadius: '0 2px 2px 0' }} />
              </div>
              <div className={styles.swatchName}>{theme.name}</div>
              <div className={styles.swatchLore}>{theme.lore}</div>
              {active && <div className={styles.swatchCheck}><CheckIcon size={12} /></div>}
              {locked && <div className={styles.swatchCheck}>Lock</div>}
            </button>
          )
        })}
      </div>

      <div className={styles.toggleRows}>
        {!isLight && (
          <div className={styles.toggleRow}>
            <div className={styles.toggleRowLabel}>
              <div className={styles.toggleRowTitle}>OLED Black Mode</div>
              <div className={styles.toggleRowDesc}>Sets backgrounds to pure black — saves power on OLED screens and deepens contrast.</div>
            </div>
            <Toggle value={!!settings.oled_mode} onChange={v => settings.save({ oled_mode: v })} />
          </div>
        )}
        <div className={styles.toggleRow}>
          <div className={styles.toggleRowLabel}>
            <div className={styles.toggleRowTitle}>Higher Contrast</div>
            <div className={styles.toggleRowDesc}>Strengthens text, borders, and visual separation throughout the app.</div>
          </div>
          <Toggle value={!!settings.higher_contrast} onChange={v => settings.save({ higher_contrast: v })} />
        </div>
      </div>
    </div>
  )
}

const MOBILE_DENSITY_COLS = { cozy: 1, comfortable: 2, compact: 3 }
const PREVIEW_COUNT = 8

function DensityPreview({ density }) {
  const [cards, setCards] = useState([])
  const [fetched, setFetched] = useState(false)

  useEffect(() => {
    let cancelled = false
    sfGet('/cards/search?q=lang%3Aen+is%3Anonfoil+(rarity%3Ar+OR+rarity%3Am)&order=random&unique=art')
      .then(data => {
        if (cancelled) return
        setCards((data?.data || []).slice(0, PREVIEW_COUNT))
        setFetched(true)
      })
      .catch(() => { if (!cancelled) setFetched(true) })
    return () => { cancelled = true }
  }, [])

  const mobileCols = MOBILE_DENSITY_COLS[density] || 2
  const gridCols = `repeat(${mobileCols}, minmax(0, 1fr))`

  return (
    <div className={styles.densityPreview} style={{ gridTemplateColumns: gridCols }}>
      {fetched
        ? cards.map(card => {
            const img = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal
            return (
              <div key={card.id} className={styles.densityCard}>
                <div className={styles.densityCardImg}>
                  {img
                    ? <img src={img} alt={card.name} loading="lazy" decoding="async" draggable={false} />
                    : <div className={styles.densityCardImgFallback}>{card.name}</div>
                  }
                </div>
                <div className={styles.densityCardName}>{card.name}</div>
                <div className={styles.densityCardMeta}>{(card.set || '').toUpperCase()}</div>
              </div>
            )
          })
        : Array.from({ length: PREVIEW_COUNT }).map((_, i) => (
            <div key={i} className={styles.densityCard}>
              <div className={`${styles.densityCardImg} ${styles.densityCardImgSkeleton}`} />
              <div className={styles.densitySkeletonLine} />
              <div className={styles.densitySkeletonLine} style={{ width: '55%' }} />
            </div>
          ))
      }
    </div>
  )
}

function TextStep({ settings }) {
  const font = settings.body_font ?? 'serif'
  const previewFamily = font === 'sans' ? 'Inter, system-ui, sans-serif' : 'Crimson Pro, Georgia, serif'
  const displayFamily = font === 'sans' ? 'Inter, system-ui, sans-serif' : 'Cinzel, Georgia, serif'
  const density = settings.grid_density || 'comfortable'
  return (
    <div className={styles.stepContent}>
      <h2 className={styles.stepTitle}>Display &amp; readability</h2>
      <p className={styles.stepDesc}>Adjust font style, weight, size, and how many cards appear per row.</p>

      <div className={styles.textGroup}>
        <div className={styles.textGroupLabel}>Body Font</div>
        <div className={styles.optionRow}>
          {[
            { value: 'serif', label: 'Serif', family: 'Crimson Pro, Georgia, serif' },
            { value: 'sans', label: 'Sans-serif', family: 'Inter, system-ui, sans-serif' },
          ].map(({ value, label, family }) => (
            <button
              key={value}
              className={`${styles.optionBtn}${font === value ? ' ' + styles.optionBtnActive : ''}`}
              style={{ fontFamily: family }}
              onClick={() => settings.save({ body_font: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.textGroup}>
        <div className={styles.textGroupLabel}>Font Weight</div>
        <div className={styles.optionRow}>
          {[
            { value: 300, label: 'Thin' },
            { value: 400, label: 'Regular' },
            { value: 420, label: 'Medium' },
            { value: 500, label: 'Bold' },
          ].map(({ value, label }) => (
            <button
              key={value}
              className={`${styles.optionBtn}${settings.font_weight === value ? ' ' + styles.optionBtnActive : ''}`}
              style={{ fontWeight: value }}
              onClick={() => settings.save({ font_weight: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.textGroup}>
        <div className={styles.textGroupLabel}>Font Size</div>
        <div className={styles.optionRow}>
          {[
            { value: 14, label: 'Small' },
            { value: 16, label: 'Default' },
            { value: 18, label: 'Large' },
            { value: 20, label: 'X-Large' },
          ].map(({ value, label }) => (
            <button
              key={value}
              className={`${styles.optionBtn}${settings.font_size === value ? ' ' + styles.optionBtnActive : ''}`}
              style={{ fontSize: value }}
              onClick={() => settings.save({ font_size: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.textPreviewBox}>
        <div className={styles.textPreviewBody} style={{ fontFamily: previewFamily }}>
          The quick brown fox jumps over the lazy dog. <em>Italics.</em>
        </div>
        <div className={styles.textPreviewDisplay} style={{ fontFamily: displayFamily }}>
          Section Header · Card Type · Label
        </div>
      </div>

      <div className={styles.textGroup}>
        <div className={styles.textGroupLabel}>Card Grid Density</div>
        <div className={styles.optionRow}>
          {[
            { value: 'cozy', label: 'Cozy' },
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ].map(({ value, label }) => (
            <button
              key={value}
              className={`${styles.optionBtn}${density === value ? ' ' + styles.optionBtnActive : ''}`}
              onClick={() => settings.save({ grid_density: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <DensityPreview density={density} />
      </div>

      <div className={styles.toggleRows}>
        <div className={styles.toggleRow}>
          <div className={styles.toggleRowLabel}>
            <div className={styles.toggleRowTitle}>Reduced Motion</div>
            <div className={styles.toggleRowDesc}>Tones down hover lifts, transitions, and animations throughout the app.</div>
          </div>
          <Toggle value={!!settings.reduce_motion} onChange={v => settings.save({ reduce_motion: v })} />
        </div>
      </div>
    </div>
  )
}

function PriceStep({ settings }) {
  return (
    <div className={styles.stepContent}>
      <h2 className={styles.stepTitle}>Pick your price market</h2>
      <p className={styles.stepDesc}>Where should collection values be sourced from? You can change this any time in Settings.</p>
      <div className={styles.priceList}>
        {PRICE_SOURCES.map(src => {
          const active = settings.price_source === src.id
          return (
            <button
              key={src.id}
              className={`${styles.priceOption}${active ? ' ' + styles.priceOptionActive : ''}`}
              onClick={() => settings.save({ price_source: src.id })}
            >
              <div className={styles.priceOptionLabel}>{src.label}</div>
              <div className={styles.priceOptionDesc}>{src.description}</div>
              {active && <div className={styles.priceCheck}><CheckIcon size={14} /></div>}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function DoneStep() {
  return (
    <div className={styles.stepContent}>
      <div className={styles.doneGlyph}>✦</div>
      <h2 className={styles.stepTitle}>Preferences updated</h2>
      <p className={styles.stepDesc}>
        Your choices have been saved and will sync across devices.
      </p>
      <div className={styles.doneNote}>
        You can revisit them any time from <strong>Settings → Personalization</strong>.
      </div>
    </div>
  )
}
