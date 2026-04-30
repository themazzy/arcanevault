# DeckLoom — Feature Roadmap

## 1. Trading Log
**Location:** Subpage / tab of `src/pages/Trading.jsx`

### Goal
Record completed trades so users can track their trading history, P&L, and partners over time.

### Supabase migration
```sql
create table trade_log (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users not null,
  traded_at        timestamptz not null default now(),
  partner_name     text,
  notes            text,
  giving           jsonb not null default '[]',  -- [{name, set_code, collector_number, foil, qty, unit_price}]
  receiving        jsonb not null default '[]',  -- same shape
  giving_value     numeric not null default 0,
  receiving_value  numeric not null default 0
);
alter table trade_log enable row level security;
create policy "users manage own trades"
  on trade_log for all using (auth.uid() = user_id);
```

### UI changes
- Add two tabs to Trading page: **Compare** (existing) and **Log**
- In Compare view, add a **"Record this Trade"** button in the summary bar that pre-fills a modal with the current giving/receiving cards + values
- Log tab: list of past trades sorted by date, each showing partner name, giving vs receiving value, net gain/loss (colour coded green/red), and an expand toggle for card details
- Filters: date range, partner name, net positive/negative

### Files to touch
- `src/pages/Trading.jsx` — add tabs, record modal, log view
- `src/pages/Trading.module.css` — log list styles, tab styles
- Supabase migration (apply via MCP)

---

## 2. Collection Value Snapshots + Line Chart
**Location:** New section in `src/pages/Stats.jsx` Overview tab

### Goal
Show collection total value over time as a weekly line chart.

### Supabase migration
```sql
create table collection_snapshots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users not null,
  snapshot_date date not null,
  total_value   numeric not null,
  card_count    integer not null,
  unique (user_id, snapshot_date)
);
alter table collection_snapshots enable row level security;
create policy "users manage own snapshots"
  on collection_snapshots for all using (auth.uid() = user_id);
```

### Snapshot write logic
- When Stats page finishes loading prices, check IDB meta for `last_snapshot_<userId>`
- If older than 7 days (or missing), upsert a row for `date_trunc('week', now())` with current `totalValue` + `totalQty`
- Store last snapshot date in IDB meta to avoid redundant writes

### UI changes
- Load snapshots from Supabase on Stats mount (lightweight — max ~52 rows/year per user)
- Render as a recharts `LineChart` (already imported) above the summary stat cards
- Show at least 4 weeks of data before displaying; show "Not enough data yet" otherwise
- X axis: week dates, Y axis: formatted value

### Files to touch
- `src/pages/Stats.jsx` — snapshot write on load, fetch snapshots, add LineChart section
- `src/pages/Stats.module.css` — minor (chart already styled)
- Supabase migration (apply via MCP)

---

## 3. Deck Browser Submenu in Navbar
**Location:** `src/components/Layout.jsx`

### Goal
Surface the Deck Browser (`/builder`) as a nav item inside the Builder submenu so users can reach it directly.

### UI changes
- In the desktop sidebar and mobile bottom tabs, add a submenu or secondary link under the Builder nav item pointing to `/builder` (deck list index)
- The current `/builder` route already renders `Builder.jsx` (deck tiles index)
- The deck builder itself is at `/builder/:id`
- Consider labelling it **"My Decks"** in the submenu to distinguish from the editor

### Files to touch
- `src/components/Layout.jsx`
- `src/components/Layout.module.css` (if submenu needs new styles)

---

## Order of implementation
1. Trading Log (most user value, self-contained)
2. Collection Value Snapshots (lightweight, high impact on Stats page)
3. Deck Browser nav (trivial, do last)
