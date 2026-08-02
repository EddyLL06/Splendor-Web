# Round 2 — Bot Seats, Lifecycle & Easy E2E

Date: 2026-08-03
Branch: `codex-ds/ai_bot`
Guide: `ai_bot/DEVELOPMENT_GUIDE.md` §15 (第 2 轮)

## Completed

Server:
- Bot seat model wired through the lobby:
  - `BotSeatMetadata` (`kind: 'bot'`) in `player.data`; every human-path
    accessor audited (join/leave/start/reclaim/roles/rematch/host transfer/
    public serializer).
  - Host-only APIs: `POST /api/matches/:id/bots` (add),
    `PATCH /api/matches/:id/bots/:playerID` (difficulty),
    `DELETE /api/matches/:id/bots/:playerID` (remove); unstarted rooms only,
    `withMatchLock`, fixed difficulty enum, server-generated names.
  - `RoomMatch.players[]` now carries `kind: 'bot'` + `difficulty`, no
    connection status, no viewer/host data.
- Bot transport:
  - `GameAccessTicketService` bot-role tickets (loopback-only, no session).
  - `AuthenticatedSocketIO` authorizes bot tickets against the Bot seat and
    registers bot socket presence; bots skip human expiry/host transfer.
  - Boardgame.io credential auth composed: bot seats authenticate with
    `BotTicketService` credentials, humans with the session-based
    `SeatCredentialService`.
- `BotController` (loopback `boardgame.io` client per seat) + `BotCoordinator`
  (per-match lifecycle): acts only when `ctx.currentPlayer` matches, handles
  pending resolutions, seeded 350-650ms think delay, generation-based stale
  cancellation, stop on game over/room deletion/rematch.
- Easy difficulty policy (`chooseEasyBotMove`): cheap scores, top-8 weighted
  random pick, deterministic per (observation, seed).

UI:
- WaitingRoom: empty-seat “Add bot” with difficulty selector (host only),
  bot badge (`Bot · Easy/Normal/Hard/Expert`), difficulty change and remove
  controls; English + 简体中文 strings.

Tests:
- `tests/ai/round2-bot-seats.integration.test.ts` (4 tests): API auth
  matrix; mixed room start with the Easy bot playing repeatedly through the
  authoritative chain; rematch retains bot seats/difficulty and the new bot
  plays; host transfer skips bot seats; room deletion cleans up controllers.
- `e2e/ai/bot-easy.spec.ts`: host adds an Easy bot, starts, waits for the
  human turn, makes one human move, and confirms the bot's next move lands.

## Gates

- `npm run typecheck` — clean.
- `npm test` — 34 files / 168 tests passed.
- `npm run build` — clean (pre-existing chunk-size warning only).
- `npm run test:e2e` — 2 specs passed (accounts-multiplayer + bot-easy).

## Decisions & known limitations

- Loopback transport confirmed as the move path (round-0 decision). Bot
  tickets use a 12h internal TTL for now; renewal logic is deferred to round 4
  hardening.
- Easy computation runs inline on the server process (O(candidates), ~1ms);
  the shared worker pool arrives in round 4.
- E2E resyncs the human page before its move; without a reload the human UI
  move can race the bot's action animation and silently not dispatch. Root
  cause is a client-side UI/state race, not the authoritative chain; the
  integration tests exercise the no-reload path directly.
- Bot controllers are not yet subject to `AI_BOT_ENABLED`; that gating is
  part of round 6 hardening.

## Next round entry

Round 3: full feature vector + hand-tuned weights, Normal 1-ply policy,
`ai:benchmark` / `ai:tune` / `ai:validate` CLIs, seed-set separation, first
versioned model JSON with schema + rules fingerprint + report.
