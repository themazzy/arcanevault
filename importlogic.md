# Import Logic — Audit & Unification Plan

## Current State Audit

### Entry Points

| Location | Button/Trigger | Accepts | Format | Missing |
|---|---|---|---|---|
| `Collection.jsx` | DropZone (empty) + "Import CSV" in FilterBar | `.csv` only | Manabox CSV only | Paste text, `.txt`, plain decklist |
| `Folders.jsx` (binders) | ↑ Import button | Paste text or `.csv`/`.txt` file | Manabox CSV or `4 Name` decklist | Set/collector in text, foil markers, URL |
| `Lists.jsx` (wishlists) | ↑ Import button | Paste text or `.csv`/`.txt` file | Same as Folders | Same as Folders |
| `DeckBrowser.jsx` (collection decks) | **MISSING — no import at all** | — | — | Everything |
| `DeckBuilder.jsx` (builder decks) | Collapsible panel: URL tab + Paste List tab | URL or paste text | URL (Archidekt/Moxfield/Goldfish) or `4 Name` | File upload (`.csv`/`.txt`), set/collector in text |

### `parseTextDecklist` — Current Format Support

The shared parser in `src/lib/deckBuilderApi.js:288` handles:

- ✅ `4 Lightning Bolt`
- ✅ `4x Lightning Bolt`
- ✅ `// comment` lines skipped
- ✅ `Commander:` / `Deck:` / `Sideboard:` section headers
- ⚠️ `4 Lightning Bolt (M10) 155` — set + collector number **stripped and discarded**
- ❌ `4 *F* Lightning Bolt` — MTGO foil marker (not parsed)
- ❌ `4 Lightning Bolt [M10]` — bracket set code (not parsed)
- ❌ `4 Lightning Bolt (M10) 155 [Foil]` — Moxfield export style (not parsed)
- ❌ `Lightning Bolt` — no qty (should default to 1)

---

## Problems to Fix

### P1 — DeckBrowser has no import
Collection decks (type `deck`) viewed in `DeckBrowser.jsx` have an Export button but zero import. `ImportModal` already supports `folderType="deck"` internally; it just needs wiring up.

### P2 — Collection.jsx accepts CSV only
The main collection import only handles Manabox CSV. Users cannot paste a decklist or upload a `.txt` file. Also: this import is specifically for full Manabox exports — there is no lightweight "add a few cards by name" path for the collection page itself.

### P3 — parseTextDecklist discards set/collector info
Set code and collector number in text (from Moxfield, Archidekt, MTGO exports, Arena) are currently stripped and thrown away. When present, they allow exact-printing resolution via Scryfall instead of name-only lookup.

### P4 — Foil markers in text not parsed
`*F*` (MTGO), `[Foil]` (Moxfield), `(foil)` are not detected. Cards imported from MTGO or Moxfield text always come in as non-foil.

### P5 — DeckBuilder has no file upload
Builder deck import has URL and Paste List tabs but no way to upload a `.txt` or `.csv` file.

### P6 — ImportModal hint text is misleading
The hint says "Paste a decklist (4 Lightning Bolt), a Manabox CSV, or upload a .csv/.txt file" but doesn't mention set codes, collector numbers, or foil markers as valid syntax.

---

## Implementation Plan

### Step 1 — Extend `parseTextDecklist` (`src/lib/deckBuilderApi.js`)

Upgrade the regex to also capture optional set code, collector number, and foil markers:

**Supported after change:**

```
4 Lightning Bolt
4x Lightning Bolt
4 Lightning Bolt (M10) 155
4 Lightning Bolt [M10]
4 Lightning Bolt (M10) 155 [Foil]
4 *F* Lightning Bolt
4 Lightning Bolt *F*
Lightning Bolt             ← qty defaults to 1
1 Sheoldred, the Apocalypse (ONE) 107 *F*
```

**New return shape per entry** (backward-compatible — new fields optional):
```js
{ name, qty, isCommander, board, setCode?, collectorNumber?, foil }
```

Detection order:
1. Strip `*F*` or `[Foil]` → set `foil = true`, remove marker from remainder
2. Match `(SET) 123` or `[SET] 123` or `(SET)` → capture `setCode`, `collectorNumber`
3. Match `qty name` or `name` (qty defaults to 1)
4. Strip remaining `// back face` suffix

Keep the existing `replace(/\s*\(.*?\)\s*\d*/g, '')` for the `name` field so set code suffixes don't appear in the displayed name.

---

### Step 2 — Smarter card resolution in `ImportModal` (`src/components/ImportModal.jsx`)

Currently resolution uses `fetchCardsByNames(names)` which does an exact-name Scryfall search. When a parsed entry has `setCode` + `collectorNumber`, use a more precise lookup:

- Group entries into two buckets: **has set+collector** vs **name-only**
- For set+collector: batch call `https://api.scryfall.com/cards/{set}/{number}` (or a collection POST using `{set, collector_number}` identifiers)
- For name-only: existing `fetchCardsByNames` path

The Scryfall Collection endpoint (`POST /cards/collection`) accepts up to 75 identifiers of mixed types:
```json
{ "identifiers": [
  { "set": "m10", "collector_number": "155" },
  { "name": "Sol Ring" }
]}
```
Use this to resolve all cards in one or two requests instead of batching by name.

Also: when resolved card differs from the text (e.g., name resolves to a different printing), still use the resolved card — the user requested that specific printing.

---

### Step 3 — Add import to `DeckBrowser.jsx`

**Change:** Add an `↑ Import` button beside the existing `↓ Export` button in the header and in the mobile `ResponsiveMenu`.

**Wire up:** Render `ImportModal` with:
```jsx
<ImportModal
  userId={user.id}
  folderType="deck"
  folders={[folder]}          // current deck only
  defaultFolderId={folder.id} // pre-select it
  onClose={() => setShowImport(false)}
  onSaved={() => { setShowImport(false); loadCards() }}
/>
```

Because `defaultFolderId` is pre-set and `folders` only contains the current deck, the destination picker step will show the deck pre-selected. The user can still change it if needed (unlikely from inside a specific deck view, but fine).

**State to add:** `const [showImport, setShowImport] = useState(false)` alongside existing `showExport`.

---

### Step 4 — Upgrade Collection.jsx import

Collection.jsx has a distinct import flow from `ImportModal` — it's a full Manabox bulk import that preserves set/collector/condition/language and rebuilds all folders.

**Changes:**
1. Allow `.txt` files in addition to `.csv` in the DropZone and the file `<input>`.
2. For `.txt` files: parse via `parseTextDecklist` (not `parseManaboxCSV`), then present an `ImportModal` for the user to pick a destination binder — OR show an inline minimal flow.
3. Keep the existing Manabox CSV full-import flow unchanged for `.csv` files.

**Rationale:** `.csv` from Manabox = full structured import (set codes, conditions, binder groupings). `.txt` = decklist-style import — needs a destination binder.

**Option A (simpler):** Detect file type in `handleImport`:
- `.csv` → existing Manabox flow
- `.txt` → open `ImportModal` pre-loaded with file text

**Option B (heavier):** Build a mode-selector step inside `Collection.jsx` itself.

→ **Recommend Option A.** Minimal change, reuses existing `ImportModal`.

Also add paste-text support: a small "Import from text" button (or link) that opens `ImportModal` with `folderType="binder"` and no pre-selected folder. This covers the "I want to add these cards to a binder" use case from the collection page.

---

### Step 5 — Add file upload to DeckBuilder import

DeckBuilder has URL + Paste List tabs built inline (not as a modal). Add a third tab: **Upload File**.

```
[🔗 URL]  [📋 Paste List]  [📂 Upload File]
```

The Upload File tab:
- `<input type="file" accept=".csv,.txt">` 
- On file select, read as text
- If `.csv` and has `name` header → `parseManaboxCSV` → extract names, map to deck_cards
- If `.txt` → `parseTextDecklist`
- Then proceed with same Scryfall resolution + `deck_cards` insert as the Paste List tab

---

### Step 6 — `ImportModal` UX improvements

1. **Hint text update:** Mention all supported formats:
   ```
   Paste a decklist, Manabox CSV, or upload a .csv/.txt file.
   Supported formats: "4 Lightning Bolt", "4 Lightning Bolt (M10) 155",
   "4 *F* Sol Ring", Manabox CSV export.
   ```

2. **Preview enhancement:** Show `setCode` + `collectorNumber` if present, and a `✦ foil` badge, in the preview list rows. This lets users confirm the exact printing before importing.
   ```
   ×4  Lightning Bolt  (M10) 155
   ×1  Sol Ring  ✦ foil
   ```

3. **Missing cards handling:** Currently missed cards only show a name. If set+collector was specified, show that too for easier debugging.

4. **No destination pre-selected edge case:** When `ImportModal` is opened from DeckBrowser with `defaultFolderId` set, skip showing the folder picker step (just show "Importing into: [Deck Name]" as a label) since the destination is already known.

---

### Step 7 — Consistent "Import" button labeling

Audit and harmonize button labels across all entry points:

| Current | Should Be |
|---|---|
| "Import CSV" (Collection FilterBar) | "↑ Import" |
| "↑ Import" (Folders) | Keep |
| "↑ Import" (Lists) | Keep |
| Missing (DeckBrowser) | "↑ Import" |
| Collapsible panel (DeckBuilder) | Keep as-is (it's a different pattern — builder context) |

---

## Files to Change

| File | Change |
|---|---|
| `src/lib/deckBuilderApi.js` | Extend `parseTextDecklist` to capture set code, collector number, foil |
| `src/components/ImportModal.jsx` | Use Scryfall Collection endpoint, richer preview, skip picker when pre-selected |
| `src/pages/DeckBrowser.jsx` | Add `showImport` state + `↑ Import` button + `ImportModal` render |
| `src/pages/Collection.jsx` | Accept `.txt` files → open ImportModal; add "Import from text" button |
| `src/pages/DeckBuilder.jsx` | Add Upload File tab to existing import panel |

No new files needed. `csvParser.js` is unchanged (Manabox format is fine as-is).

---

## What NOT to Change

- `parseManaboxCSV` — the Manabox format is well-supported, no changes needed
- Collection.jsx full-import Manabox flow — keep exactly as-is for `.csv`
- `DeckBuilder.jsx` URL import tab — works correctly, don't touch
- The 3-step ImportModal flow (input → preview → importing → done) — keep it, just enhance each step

---

## Text Format Examples Reference

All of these should parse correctly after Step 1:

```
// Plain count + name
4 Lightning Bolt
4x Lightning Bolt
Lightning Bolt

// With set code
4 Lightning Bolt (M10)
4 Lightning Bolt [M10]

// With set + collector number (exact printing)
4 Lightning Bolt (M10) 155
4 Lightning Bolt [M10] 155

// Foil markers
4 *F* Lightning Bolt
4 Lightning Bolt *F*
4 Lightning Bolt (M10) 155 *F*
4 Lightning Bolt (M10) 155 [Foil]
4 Lightning Bolt (foil)

// Section headers (already supported)
Commander:
1 Sheoldred, the Apocalypse

Deck:
1 Sol Ring

Sideboard:
1 Pithing Needle

// Manabox CSV (separate path, already works)
name,quantity,set code,...
```
