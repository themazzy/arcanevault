# DESIGN.md

UI/UX conventions for DeckLoom. `CLAUDE.md` covers architecture and data flow; **this file covers how things look and behave.**

Two kinds of content live here, and the difference matters:

- **Rules** — follow them. Most exist because breaking them caused a real bug, noted inline.
- **§11 Known discrepancies** — where the app *doesn't* follow its own rules today, measured. Don't cite these as precedent.

> **When these disagree with the code, the code is not automatically right.** Several rules below were already documented and still widely ignored (see §11). But when a *token* disagrees with a hardcoded value, the token wins.

---

## 1. Foundations — tokens

All in `src/index.css` under `:root`. **Never hand-pick a value a token already covers.**

### Colour & surface

```css
var(--gold)        /* #c9a84c — primary accent */
var(--gold-dim)
var(--green)       /* #5dba70 — positive / price */
var(--red)         /* destructive */
var(--purple)
var(--bg) var(--bg2) var(--bg3)      /* page → panel → nested */
var(--text) var(--text-dim) var(--text-faint)
var(--border) var(--border-hi)
var(--font-display)  /* Cinzel — headings, titles, buttons, tabs */
var(--font-serif)    /* body */
```

**Surface overlays** — these invert per theme. Prefer them over raw `rgba(255,255,255,…)`:

```css
var(--s1) var(--s2) var(--s3) var(--s4)   /* ascending tint */
var(--s-card) var(--s-subtle) var(--s-medium)
var(--s-border)   /* subtle border  — instead of rgba(255,255,255,0.07) */
var(--s-border2)  /* stronger border — interactive outlines */
```

> **Light-theme rule.** A hardcoded `rgba(255,255,255,0.X)` border or background is invisible on light themes. Use the `--s-*` tokens. (The `.btn` block in `UI.module.css` is a deliberate exception: it sets raw rgba defaults, then overrides every one under `[data-theme-mode="light"]`. If you copy that pattern, you owe the override too.)

### Type scale

```css
--font-xs: 0.68rem   --font-sm: 0.78rem   --font-md: 0.88rem
--font-base: 0.95rem --font-lg: 1.05rem   --font-xl: 1.2rem
--font-2xl: 1.5rem   --font-3xl: 2rem
```

`:root[data-font="sans"]` rescales all of these ~8% down — Inter's x-height reads larger than Crimson Pro at the same rem. **Any new size token needs a sans variant too.**

### Controls

Every interactive control — button, select, input, toggle — sizes from these:

```css
--control-height: 30px
--control-padding-x: 13px
--control-font-size: 0.72rem   /* 0.66rem in sans mode */
--control-letter-spacing: 0.04em
```

### Labels

Small uppercase labels (chip labels, field labels, eyebrows, tab labels) compose from `src/styles/typography.module.css` — never re-pick values:

```css
.myLabel { composes: labelMd from '../styles/typography.module.css'; color: var(--text-faint); }
```

| class | token | use |
|---|---|---|
| `labelSm` | `--label-size-sm` (0.62rem) | dense/compact labels |
| `labelMd` | `--label-size-md` (0.68rem) | **the default** — field labels, eyebrows, chips |
| `labelLg` | `--label-size-lg` (0.72rem) | tabs, section heads |

All three carry `text-transform: uppercase` + `letter-spacing: var(--label-tracking)`.

**Colour is deliberately not in these classes.** Labels legitimately appear in `--text-faint`, `--text-dim`, `--gold` and `--gold-dim`; a colour here would race the consuming module's colour on stylesheet order (§10). Set colour at the use site.

### Motion

`[data-reduce-motion="true"]` (set on `<html>` by `SettingsContext` from the `reduce_motion` setting) flattens every animation and transition globally in `index.css`. **You do not need to handle reduce-motion per component** — write the animation and it's covered.

Prefer transitions that fade or slide *in response to input*. A permanently pulsing element reads as an alert, not an affordance.

### Z-index

**There is no ladder, and that's a problem** — 49 distinct values are in use, topping out at `99999` (§11). Until one exists: stay inside the band your neighbours use, and never invent a new ceiling. Known anchors:

| value | what |
|---|---|
| `200` | modal overlay (`UI.module.css .overlay`) |
| `750` | portaled `ResponsiveMenu` panel (must clear the modal) |

---

## 2. Primitives — `src/components/UI.jsx`

`Button` · `Input` · `Select` · `Modal` · `ResponsiveMenu` · `ResponsiveHeaderActions` · `SectionHeader` · `Badge` · `EmptyState` · `ErrorBox` · `ProgressBar` · `DropZone`

**Reach for these first.** See §11 — the codebase does not consistently do this, so you'll see plenty of counter-examples. They are not the standard.

---

## 3. Buttons

Use `<Button>`, or `uiStyles.btn` on a raw `<button>` when you need markup control.

```jsx
<Button variant="danger" size="sm" onClick={…}>Delete</Button>
<button className={`${uiStyles.btn} ${uiStyles.sm} ${uiStyles.green}`}>Save Changes</button>
```

**Variants** (each only remaps `--btn-*` custom properties — that's the extension point):

| variant | use |
|---|---|
| `default` / `primary` | gold — the main action |
| `secondary` | neutral |
| `ghost` | lowest emphasis |
| `danger` | destructive (red) |
| `green` | confirm/save |
| `purple` | special (foil, premium) |
| `toggle` + `active` | segmented / toggle buttons |

**Sizes:** `sm` = the control tokens (30px) · `md` = 34px · `lg` = 38px. Modifiers: `block`, `iconOnly`, `segmented`.

Buttons are: **4px radius, 1px border, `--font-display`, `line-height: 1`, `:hover` + `:focus-visible` + `:disabled` states.** To style a new button, remap the `--btn-*` properties — don't rewrite the box.

**Every interactive element needs `:hover` and `:focus-visible`.** `.btn` gives you both; hand-rolled buttons routinely ship without focus states.

---

## 4. Chips vs buttons

> **A chip and a button must never be mistakable.** This is a shape contract, and it's the fastest read on the page — it lands before anyone parses text.

| | chip (static) | button (clickable) |
|---|---|---|
| radius | `999px` (pill) | `4px` |
| border | **none** | 1px |
| height | 24px | 30px (`--control-height`) |
| fill | flat tint | tint + hover change |
| hover | none | required |

Reference: `.chipBase` / `.detailChip` in `CardComponents.module.css`.

**Chips need `line-height: 1`.** `body` sets `line-height: 1.6`, so inside a fixed-height chip the text centres as a ~17px line box whose lower half is empty descender space that all-caps labels never use — the glyphs visibly ride high. `align-items: center` cannot fix this; it's centring the box correctly, the box is just wrong. Same trap applies to any fixed-height box with all-caps text.

---

## 5. Controls in a row

Every control in a form row pins to the control tokens so the row reads as one strip, not five differently-sized widgets:

```css
.editField .editControl {   /* scoped via parent — see §10 */
  height: var(--control-height);
  min-height: var(--control-height);
  padding: 0 var(--control-padding-x);
  font-size: var(--control-font-size);
  box-sizing: border-box;
}
```

Use `repeat(auto-fit, minmax(150px, 1fr))` for flow rather than breakpoints.

> `flex` is **ignored on grid children.** `.editField { flex: 1 }` inside a grid does nothing. This has bitten us.

**A control that opens a picker should look like `Select`**, not like a button — reuse `uiStyles.select` + `uiStyles.selectChevron` for the trigger. A dashed-border button reads as a dropzone, and a picker with no chevron doesn't announce itself. See the Change Printing trigger in `CardComponents.jsx`.

---

## 6. Menus, dropdowns & modals

### The portal rule

> **A `Select`/`ResponsiveMenu` inside any container that clips overflow MUST pass `portal`.**

`portal` renders the panel into `document.body`, `position: fixed`, at `z-index: var(--z-popover)`. Without it the panel renders inline and is cut off by the nearest clipping ancestor.

**What actually clips — this is narrower than it looks:**

- `Modal`'s `allowOverflow` defaults to **`true`** (`.modal { overflow: visible }`), so **the primitive does not clip by default**. Only `allowOverflow={false}` clips — 2 sites app-wide (`CardDetail`, `ConfirmModal`).
- The real trap is **hand-rolled modals**: `MakeDeckModal` (`.modal { overflow: hidden }` + `.sidebar { overflow-y: auto }`) and `SyncModal` (inline `overflow: hidden` panel + scrolling body) both clipped. Any `overflow: hidden`/`auto`/`scroll` ancestor does it.

**Smell:** `menuDirection="up"` or a lone `portal` on one Select among several in the same panel usually means someone hit this and patched their instance only. Both were present in the code.

Of 72 `Select`/`ResponsiveMenu` sites, 44 don't pass `portal` — but most are page-level, where nothing clips. **Don't add `portal` reflexively**; it costs a fixed-position panel that can't scroll with its container. Add it when a clipping ancestor exists.

`ResponsiveMenu` becomes a bottom sheet at ≤640px automatically, or with `forceSheet`.

### Modal

Use `<Modal>` from `UI.jsx`. It handles overlay, Escape, focus trap + restore, scroll lock, and animated height.

- `allowOverflow` (default **true**) — set `false` when content must clip.
- `className` — per-modal overrides (e.g. `.detailModal { max-width: 1080px }`). **Never widen the shared `.modal`.**
- Scroll lock is `Modal`'s job — `CardDetail` also locks `body` while open; don't add a third.

Don't hand-roll an overlay. 17 exist outside `UI.module.css` (§11); they're debt, not precedent.

### Tabs

Underline tabs — reference: `.detailTabs` in `CardComponents.module.css`, mirrored from DeckBuilder's `.tabBar`/`.rightTabBar`.

- Bar: `bg2 28%` tint, 6px radius, `overflow: hidden`, no frame border.
- Tabs: `flex: 1` (equal width), 30px, `--font-display`, control-token type, **not uppercase**.
- Active: gold text + 10% gold gradient wash.
- Indicator: **one sliding pseudo-element** on the bar, positioned `translateX(var(--tab-index) * 100%)` with `width: calc(100% / var(--tab-count))`, both passed inline from JSX. A per-tab `border-bottom` can't travel — it cross-fades, which doesn't read as movement.
- Dividers: **pseudo-elements, not borders.** A real border widens every tab but the first and desyncs the percentage-positioned indicator.
- Hover: gold glow blooms inward + a dim underline previews where the indicator will land.

---

## 7. Interaction states

> **Anything with `cursor: pointer` owes the user `:hover` AND `:focus-visible`.**

| state | rule |
|---|---|
| `:hover` | required — the pointer affordance |
| `:focus-visible` | **required** — the keyboard affordance. `outline: 1px solid var(--border-hi); outline-offset: 2px` (use `-2px` inset where the element clips) |
| `:active` | optional; a slightly stronger fill |
| `:disabled` | `opacity: 0.45; cursor: not-allowed` |

`.btn` gives you all four. Hand-rolled buttons routinely ship with hover only — the app has **635** `:hover` rules against **28** `:focus-visible` (§11), meaning the keyboard experience is essentially unstyled. Don't add to that.

**Hover must not be the only channel.** Touch has no hover, so never hide information or an action behind it alone; treat it as reinforcement. `BuildAssistant` gates on `matchMedia('(hover: hover)')` when hover carries real weight.

**Don't let `:hover` outrank the active state** — see §10.

---

## 8. Responsive & mobile

**Breakpoints.** `index.css` lists `--bp-sm 480 / --bp-md 768 / --bp-lg 1024 / --bp-xl 1280` as a comment ("reference only"). Reality: **29 distinct max-widths** are in use and `--bp-xl` is used zero times (§11). Until that's reconciled:

| px | meaning | authority |
|---|---|---|
| **640** | **menu → bottom sheet** | `ResponsiveMenu` (`window.innerWidth <= 640` in `UI.jsx`); 15 CSS uses |
| **900** | deck-builder mobile layout | `DeckBuilder` (`innerWidth <= 900`); paired with `min-width: 901px` |
| 480 | phone tweaks | 16 uses — the most common |

> **A JS viewport check must have a CSS counterpart at the same px.** `ResponsiveMenu` switches to a sheet at 640 in JS; if your CSS assumes 600 or 720, the two disagree for a band of widths and the menu is styled for the wrong mode. Only three JS checks exist (`UI.jsx` 640, `DeckBuilder` 900 and 640) — keep it that way, and prefer CSS.

**Prefer intrinsic layout to breakpoints.** `repeat(auto-fit, minmax(150px, 1fr))` adapts with no media query. Reach for a breakpoint only when the layout genuinely changes shape.

**Safe areas.** Anything pinned to the bottom needs `env(safe-area-inset-bottom, 0px)` (49 uses). Content that a floating bar could cover reserves `var(--mobile-floating-bar-height)` (76px).

**Prefer `Modal`/`ResponsiveMenu`** — they already handle their own mobile forms (sheet, full-bleed) so you don't re-derive them.

---

## 9. Content conventions

**Icons** — `src/icons/index.jsx` is the single source of truth: **61** icons built on a shared `<Icon>` wrapper (`viewBox="0 0 16 16"`, `currentColor`, `aria-hidden`, props `size` default 16 / `color` / `className`). `SettingsIcon` is the sole `0 0 24 24` — it carries a detailed Material gear that must match CardScanner's menu button; don't swap it for a simpler cog.

- **Add new icons to `src/icons/index.jsx`.** Don't inline `<svg>` in a component — 40 already are (§11), in five different viewBox systems.
- Import from `src/icons` directly. `components/Icons.jsx` is a **compatibility shim** re-exporting folder-type icons; 2 files still use it — don't add more.
- **Never** use `⚙ ☰ ✕ ⊞ ≡ ⊟ ✓ ×` as icon substitutes.
- Size via the `size` prop, not CSS. Sizes are ad-hoc today (14 distinct values, 9→38) — **prefer 12 / 14 / 16**, which cover 80% of use.

**Toasts** — `useToast()` → `showToast(msg, { tone, duration })`. **Never `alert()`.** For destructive confirms use a `Modal`, not `confirm()`.

**Prices** — always `formatPrice(value, priceSourceId)`. Never format money by hand. `price_source` comes from `useSettings()` — never hardcode.

**Italics** — reserved for **flavour text** (`.flavorText`). Type lines are roman. The one exception is placeholders/empty states (`::placeholder`, `.oracleEmpty`), which are a different convention from italic *content*.

**Separators in meta lines** — `•` (U+2022 BULLET), drawn in CSS on `span + span::before`, not typed into JSX. Fields are conditional; a hardcoded bullet leaves a dangling dot when its field is absent. Spacing goes in the bullet's own margins — a flex `gap` applies to one side only and the dot drifts left.

---

## 10. CSS rules that prevent real bugs

**One selector, one definition.** Duplicate selectors don't replace each other — the browser merges them *per property*. Properties only in the earlier block survive and apply, invisibly. This shipped a phantom `border-bottom` and `margin-bottom: -1px` on the card-detail tabs for months, and left `.folderCardSelected` wearing two selection styles at once. A pass in 2026-07 fixed 20 of 24; 4 remain (§11).

**Specificity, not stylesheet order.** CSS modules build into separate chunks, so two equal-specificity rules in different modules have **no reliable winner**. To override a primitive, scope via a parent (`.editField .editControl` beats `.select`) rather than trusting load order.

**Never put `font-size`/`letter-spacing`/`text-transform` next to a `composes`.** The composed class is a *different class* on the same element, so a local declaration of the same property races it on chunk order. Compose or declare — not both.

**Never `!important` an active state to beat its own hover.** `.tab:hover` (0,2,0) outranks `.tabActive` (0,1,0), so the active tab greys out on hover. The fix is `:not()`: `.tab:hover:not(.tabActive)`. Reaching for `!important` here hides the real problem. *(DeckBuilder's `.tab` still has this bug.)*

**Inline `style` beats every stylesheet rule.** An inline `textTransform: 'capitalize'` silently defeated a shared `text-transform` rule. Don't reach for inline style for anything a class can do — reserve it for genuinely dynamic values (`--tab-index`).

---

## 11. Known discrepancies

Measured 2026-07-17. **These are debt, not precedent.**

| # | finding | scale |
|---|---|---|
| 1 | `<button>` styled with local classes instead of `Button`/`uiStyles.btn` | **647** sites vs 124 `<Button>` + 17 `uiStyles.btn` |
| 2 | Local CSS classes re-implementing a button (cursor+border+padding) | **263** rules |
| 3 | Hand-rolled modal overlays outside `UI.module.css` | **17** (incl. `SyncModal`, `MakeDeckModal`, `MoveOwnedCardsModal` — named `*Modal` but not using `Modal`) |
| 4 | ~~`Select`/`ResponsiveMenu` not passing `portal`~~ | **FIXED / mostly a false alarm.** Corrected count was 44 of 72, not 49 (the first scan's regex broke on `>` inside arrow-function props). Of those, almost none clipped: `Modal`'s `allowOverflow` defaults to `true`. 3 real bugs existed in **hand-rolled** modals (`SyncModal` ×2, `MakeDeckModal` ×1) — all fixed |
| 5 | Hardcoded `rgba(255,255,255,…)` | **459 → 271.** Two passes: 74 exact-token swaps, then 115 near-misses snapped with a **≤0.02 alpha tolerance** (imperceptible in dark, correct in light). The ~271 left are either out of scope (gradient stops, white text over always-dark card art, custom props with their own light overrides) or >0.02 off — `0.16`/`0.2` borders **are** visibly different from `--s-border2` (0.12), so snapping them is a design call, not cleanup |
| 6 | Hand-rolled uppercase labels not composing the scale | ~245 rules, **30** font-sizes, **16** letter-spacings |
| 7 | Control heights hardcoded instead of `--control-height` | 32px×37, 34px×29, 36px×26, 28px×20, 26px×12 |
| 8 | ~~`.sectionLabel`~~ | **FIXED.** Was 6 hand-rolled copies (5 font-sizes, 3 letter-spacings, 3 rule colours). Now one shared `sectionLabel` in `typography.module.css`; 5 modules `composes` it. Auth keeps its own — it rules **both** sides (`::before`+`::after`) for a centred label, a real variant, not drift |
| 9 | ~~Dot-grid background~~ | **FIXED.** Only 2 were real drift (DeckView `.page` 0.045, GuidedBuildOverlay 0.05) — both now 0.04. DeckGoldfish's 0.16/0.34 at 22px is `.zoneGrid`, a playtest zone grid, not the page background |
| 10 | Gold top-border card | **13 → 5 alphas.** The doc defines two states (base 0.35, hover 0.65) and those were already the top two; 19 near-misses snapped to whichever state their *selector* says they are. Left: 0.5/0.55/0.7 (>0.11 off, or Active/Selected states) |
| 11 | Z-index | **49** distinct values, max `99999`, no ladder |
| 12 | Unicode glyphs as icons | **Mostly a misread on my part, now resolved.** `⚙ ☰ ✕ ⊞ ≡ ⊟` — the glyphs that genuinely render inconsistently — appear **zero** times in rendered UI. `×` in qty badges (`×3`) is a **multiplication sign** and correct. `✓`: 40 → 14. Migrated the menu checks, 9 bespoke `*Check` spans and 9 selection ticks to `CheckIcon` (size 12 in a ~0.72–0.85rem slot, matching shipped precedent). **The 14 left are intentional:** prose (`'✓ Saved'`, `setMsg('✓ …')`) and paired glyph states (`✓`/`…`, `✓`/`+`) where an SVG on one side only would look worse |
| 13 | ~~`alert()` / `confirm()`~~ | **FIXED** — new `ConfirmModal` primitive replaces both `confirm()`s; the `alert()` is an error toast |
| 14 | ~~Shadowed selectors~~ | **FIXED — 24 → 0** |
| 15 | ~~**`:focus-visible` coverage**~~ | **FIXED.** Was 28 rules against 635 `:hover`. A zero-specificity `:where(…):focus-visible` rule in `index.css` now covers every interactive element app-wide; per-component focus styles still win |
| 16 | `cursor: pointer` classes with no `:hover` at all | **66** (DeckBuilder 11, Settings 7, CardScanner 6, Admin 5) |
| 17 | Inline `<svg>` outside `src/icons` | **40 → 38** (UI.jsx's duplicate Chevron/Close now come from the icon system). Remaining: DeckStats 10, DeckBrowser 10, CardScanner 7, in 5 viewBox systems. Each needs a new icon added to `src/icons` first |
| 18 | Icon `size` props | **14** distinct values (9→38); no scale. `12/14/16` cover most. Menu checks standardised on 12 |
| 19 | ~~`components/Icons.jsx` shim~~ | **FIXED** — both importers moved to `src/icons`; shim deleted |
| 20 | Breakpoints | **29** distinct max-widths (480×16, 640×15, 600×15, 900×12, 768×7, 700×7, 980×6, 620×5, 520×5, 380×5…). The documented `--bp-*` scale is barely used: `--bp-lg` once, **`--bp-xl` never** |
| 21 | `--mobile-floating-bar-height` | 4 uses vs **49** `env(safe-area-inset-*)` — bottom-bar clearance is mostly hand-rolled |

**Stale documentation found while auditing:** `CLAUDE.md`'s view-toggle-pill snippet specifies `6px` radius and `rgba(255,255,255,0.04)`; both real implementations (`Folders`, `DeckBrowser`) use `5px` + `--s1`/`--s-card`. The code is right, the doc is stale.

### Fixing this

**Migrate opportunistically, not in a sweep.** Nothing in the 1194-test suite catches label drift, a wrong border, or a clipped dropdown — every migrated element needs an eyeball. A big-bang pass would shift hundreds of elements at once with no automated safety net.

The exceptions worth doing deliberately, highest value first:

1. **#15 focus states** — the only *accessibility* item on this list. A keyboard user currently cannot see where they are on most of the app. Cheapest broad win: give the 66 hover-less pointer classes (#16) and the 647 local buttons (#1) a shared focus rule, or migrate them to `.btn`, which already has one.
2. **#4 portal bugs** — real, user-visible clipping. Needs per-site checking (which sites are actually in a modal).
3. **#14 `.folderCardSelected`** — a live double-decoration bug.
4. **#13 `alert()`/`confirm()`** — 3 sites, trivial.
5. **#20 breakpoints / #11 z-index** — pick a real scale, then migrate. Both are "decide once" tasks that stop the bleeding even before migration.
