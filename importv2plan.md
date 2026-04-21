# Import V2 Plan

## Phase 1: Correctness and Flow Foundations

Goal: make imports predictable, print-safe, and easier to reason about before expanding supported sources.

1. **Unify the import flows**
   - Consolidate parsing, normalization, Scryfall resolution, save planning, and result reporting into shared import utilities.
   - Current paths to align:
     - `src/components/ImportModal.jsx`
     - `src/pages/Collection.jsx` drag-drop CSV import
     - `src/pages/DeckBuilder.jsx` deck import
   - Trade-off: this is more invasive than patching one modal, but it prevents the same bug from being fixed three times.

2. **Fix print-preserving CSV parsing in `ImportModal`**
   - Preserve separate rows for different set codes, collector numbers, foil states, languages, conditions, and purchase metadata.
   - Avoid deduping Manabox CSV rows by only `name + foil`.
   - Trade-off: preview may show more rows, but it reflects actual collection inventory.

3. **Make import semantics explicit: add vs replace**
   - Add clear import modes:
     - Add to existing quantities
     - Replace destination contents
     - Skip duplicates
   - Apply the selected mode consistently for binders, collection decks, and wishlists.
   - Trade-off: adds one decision to the UI, but removes hidden behavior differences.

4. **Improve preview before saving**
   - Resolve cards before final import.
   - Show matched cards, exact set/collector where available, unresolved rows, merged duplicates, and destination impact.
   - Example impact copy:
     - `87 cards will be added`
     - `12 existing rows will be updated`
     - `3 rows need attention`
   - Trade-off: preview takes slightly longer, but failures happen before writing data.

5. **Better error reporting**
   - Report line number, original input, card name, set code, collector number, and reason.
   - Distinguish parse errors, Scryfall misses, duplicate handling, and Supabase save failures.
   - Trade-off: more result detail, but easier recovery for large imports.

## Phase 2: UX Expansion and Source Coverage

Goal: improve supported formats, destination choices, and production-safe source imports after the core flow is reliable.

6. **Use a real CSV parser**
   - Replace ad hoc CSV parsing in `src/lib/csvParser.js` with a robust parser.
   - Handle quoted headers, escaped quotes, commas in fields, and malformed rows consistently.
   - Trade-off: adds or vendors a small parser dependency, but avoids fragile CSV edge cases.

7. **Support full Manabox folder import from the modal**
   - Let the modal preserve Manabox folder grouping instead of forcing all CSV rows into one selected binder.
   - Reuse the same folder creation/linking behavior currently handled by collection drag-drop.
   - Trade-off: modal flow needs a folder-mapping preview, but drag-drop and button import become consistent.

8. **Un-disable URL import only if production can support it**
   - Decide whether to support URL import through production infrastructure, likely Supabase Edge Functions or another server-side proxy.
   - Keep Archidekt, Moxfield, and MTGGoldfish behavior consistent between collection import and deck builder import.
   - Trade-off: requires backend work; without it, URL import should remain clearly unavailable in production.

9. **Make deck-builder import exact-print aware**
   - Resolve imported deck cards by set/collector when provided instead of name-only lookup.
   - Preserve foil and board metadata.
   - Reuse the same Scryfall collection lookup strategy as collection import.
   - Trade-off: slightly more complex lookup, but imported deck versions match source lists.

10. **Add import modes for target type**
    - Let users choose Binder, Collection Deck, Wishlist, or Builder Deck where the context allows it.
    - Keep destination-specific rules visible:
      - Wishlists are not owned inventory.
      - Collection decks allocate exact owned card rows.
      - Builder decks are deck plans, not ownership.
    - Trade-off: broader modal scope, but it prevents users from choosing the wrong import entry point.

## Suggested First Slice

Start with Phase 1 items 1-5:

1. Shared import normalization and resolution utilities.
2. A resolved preview in `ImportModal`.
3. Explicit add/replace/skip behavior.
4. Structured import result reporting.
5. Collection and deck-builder paths migrated onto the shared behavior.
