# Competition Research — What MTG Players Want (June 2026)

Research into competing apps and community feature demand, mapped against
DeckLoom's stack constraints (static GitHub Pages + Supabase free tier +
Cloudflare Worker + Capacitor Android; no SSR, no email/push infra).

## The core finding

Every comparison article and community thread lands on the same complaint:
**"no single tool does everything, so players juggle 2–3 apps"** — Moxfield for
decks, Manabox for scanning, EchoMTG for portfolio value, Deckbox for trades,
playgroup.gg for game stats. DeckLoom's integrated architecture is positioned
against exactly this pain. The roadmap below closes specific gaps where a
dedicated app is still clearly better.

## Competitor strengths & weaknesses (from GrimDeck/Draftsim comparisons)

| App | Praised for | Criticized for |
|---|---|---|
| Moxfield | Best deck editor, huge community | Basic collection tracking, no scanner |
| Archidekt | Collection↔deck integration | Browser-only, clunky with big inventories |
| Manabox | Best mobile scanner, **Collector mode (set completion)** | Mobile-only, cramped UI |
| Dragon Shield | Scans sleeved cards, AR translation | 100-card free limit, wrong-reprint picks |
| EchoMTG | **Portfolio value over time** | Free tier caps at 360 cards |
| Deckbox | **Trade matching (wishlist↔tradelist)** | Web-only, stale deck builder |
| playgroup.gg | **Game stats: win rate, ELO, leagues** | Single-purpose |
| MTGGoldfish | **"What can I build from my cards?"** (Super Brew) | Premium-gated $6/mo |

## Tier 1 — high demand, fits the stack cleanly

1. **Commander Bracket / power-level analyzer.** Whole cottage industry since
   WotC's official 5-bracket system (Feb 2025): BrackCheck, Commander Power
   Meter, ScrollVault, DeckCheck, edhpowerlevel.com. Mechanics are static
   analysis: Game Changers list, mass land denial, chained extra turns,
   two-card combos (DeckLoom already has Commander Spellbook integration),
   tutor/fast-mana density. Pure client-side. Unique angle: integrate with
   ownership ("which of these cards do I own") and show the bracket on shared
   deck OG previews.
2. **Collection value over time.** EchoMTG's moat. Needs only ONE row per user
   per day (`user_id, date, total_eur, total_usd, card_count`) — tiny on free
   tier. Compute client-side on app open, upsert daily. Chart in Stats +
   "collection gained €X this month" on Home. The retention feature.
3. **Set completion / Collector mode.** Manabox's standout. Scryfall set lists
   client-side + IDB collection → completion %, missing list (tap → wishlist),
   cost-to-complete from price data. Pure client-side.
4. **Wishlist QoL** (top-voted on Moxfield's own feedback board):
   - shareable wishlists others can view AND check off (gift-list use case)
   - auto-remove from wishlist when card enters collection
   - "add to wishlist only if not owned"
   `shared_folders` machinery already exists.

## Tier 2 — high value, moderate effort

5. **Playgroup game stats.** Per-player win rate, ELO, streaks, per-deck
   performance, league leaderboards (playgroup.gg's product). `game_results`,
   `tracked_games`, lobby, and tournaments already collect the data — only the
   dashboards are missing. Strengthens the game-night viral loop.
6. **Life tracker completeness.** Standard in Moxtopper/Lifetap/Lotus: poison,
   energy, experience, commander tax, Monarch, Initiative, Day/Night,
   per-commander damage incl. partners, turn tracker. Differentiator: player
   backgrounds from the user's own deck art (standalone counters can't).
7. **Trade matching inside a playgroup.** Deckbox's moat, scoped to friends:
   match my wishlist against friends' collections. Needs a lightweight
   friends/playgroup concept; Trading page is half of it already.

## Tier 3 — possible, with eyes open

8. **"What can I build with my collection?"** MTGGoldfish premium-gates this.
   Now feasible: the Cloudflare Worker can proxy EDHREC/Goldfish in production
   (Vite proxies were dev-only). Worth a worker route for the existing EDHREC
   recs feature alone.
9. **Price alerts.** No email/push infra → in-app "movers" computed on open;
   Capacitor local notifications on Android. Don't promise real-time.

## Honest gaps that stay gaps

- **iOS** — biggest reach limitation; Capacitor makes it mostly config + Apple
  dev account when ready.
- MTGO/Arena import — different ecosystem.
- Global trade marketplace — moderation/liability not worth it.

## Recommended order

Bracket analyzer → value history → set completion → wishlist QoL → playgroup
stats → life-tracker counters → trade matching → EDHREC worker proxy.

## Sources

- https://grimdeck.com/blog/best-mtg-collection-tracker-deck-builder
- https://draftsim.com/mtg-collection-tracker/
- https://brackcheck.com/ · https://commanderpowermeter.com/ ·
  https://scrollvault.net/tools/commander-bracket/ · https://deckcheck.co/
- https://farseek.ai/blog/commander-brackets-explained
- https://moxfield.nolt.io/ (notably /1184 shareable wishlists, /1087
  collaborative check-off, GitHub issue #58 add-only-if-not-owned)
- https://playgroup.gg/ · https://draftsim.com/best-mtg-life-counter-app/
- https://moxtopper.com/ · https://www.echomtg.com/
