# Round 0 — Integration Probe & Contract Freeze

Date: 2026-08-03
Branch: `codex-ds/ai_bot`
Guide: `ai_bot/DEVELOPMENT_GUIDE.md` §15 (第 0 轮)

## Goal

Prove, without building the full AI, that a Bot can occupy a seat safely,
receive a filtered `playerView`, and submit a legal move through the same
authoritative boardgame.io update queue used by human players. Decide between
the loopback client and a direct dispatcher, and freeze the Bot seat contract.

## Completed

- Tagged Bot/human seat type draft and public serialization draft:
  `src/server/ai/bot-seat.ts`
  - `SeatIdentity = HumanSeatIdentity | BotSeatIdentity` (tagged union; Bot
    identity is explicit, never `userId.startsWith('bot:')`).
  - `BotSeatMetadata` draft (round-2 `player.data` shape), `PublicBotSeat`
    serialization (no credentials, tickets, model version or match IDs),
    server-generated name (`Bot N`), fixed difficulty enum.
- Minimal loopback-only Bot access ticket / seat credential spike:
  `src/server/ai/bot-ticket.ts`
  - HMAC-signed `role: 'bot'` tickets and seat credentials bound to
    `botId + matchId + playerId`, with expiry. No User/Session row is touched
    during verification. Not yet wired into `AuthenticatedSocketIO` (that is
    round 2, together with the loopback origin check).
- Loopback move spike through the real transport:
  `tests/ai/round0-loopback.integration.test.ts`
  - Real Koa/Socket.IO test application, 2 registered humans, match started.
  - A loopback `boardgame.io` client (spike stand-in for the future Bot
    controller) submits the fixed legal action `reserveDeck(tier 1)`.
  - Assertions: move reaches both clients through the same Socket.IO queue;
    `_stateID` advances by exactly one; action log contains the reservation;
    a freshly connected client re-syncs the same move from the authoritative
    store; deck cards are `__hidden__` for every client; the acting client
    sees its own blind reservation's real card ID while the observer sees
    `cardId: null`; a stale `update` with an old `_stateID` is rejected by
    the Master and cannot overwrite the newer state.
- Unit tests for the seat contract and ticket spike:
  `tests/ai/bot-seat.test.ts`, `tests/ai/bot-ticket.test.ts`.
- Direct-dispatcher feasibility record (below).

## Direct dispatcher vs loopback — decision

The guide (§4.3) allows a direct dispatcher only if it (a) uses stable
declared APIs without importing hashed private boardgame.io files, (b) shares
the per-match serial update queue, (c) reproduces Master-equivalent
credential/active-player/stateID/move validation, (d) applies the same
playerView/log filtering, and (e) passes differential/concurrency tests.

Inspection of the installed `boardgame.io@0.50.2` confirms the Master, reducer
and transport internals are emitted under hashed private chunks (for example
`dist/cjs/master-*.js`), so a direct dispatcher would depend on unstable
private imports. The loopback `Client + SocketIO` path uses only the public
`boardgame.io/client` and `boardgame.io/multiplayer` entry points, reuses the
transport's per-match queue, the Master's validation, and the server-side
playerView filtering, and is exercised end-to-end by the spike above.

**Decision: adopt the loopback client as the Bot move transport.** A direct
dispatcher is not pursued further.

## Commands & results

- `npm install --save-dev --save-exact socket.io-client@4.8.3` — added the
  direct dependency required by the guide before importing `socket.io-client`
  (it was previously only transitive).
- `npm run typecheck` — passed (including `tsc --noEmit` and
  `tsc -p tsconfig.server.json --noEmit`).
- `npx vitest run tests/ai` — 3 files, 8 tests passed.

Hardware/software: local Mac (Apple Silicon), Node 24, boardgame.io 0.50.2,
socket.io 4.8.3.

## Not done yet (by design)

- Bot seat API (`POST/PATCH/DELETE /api/matches/:id/bots`), host permissions,
  lobby/room integration and `RoomMatch` wiring — round 2.
- Bot controller/coordinator lifecycle, worker pool, Easy strategy UI — rounds
  2–4.
- Model weights, training, rules fingerprint — later rounds.

## Risks & next round entry

- The Bot ticket service is a contract spike; production acceptance requires
  loopback-origin enforcement and seat-kind checks in the socket middleware.
- `AuthenticatedSocketIO` still assumes every player seat is a human session;
  seat-model migration must audit join/leave/start/reclaim/role/rematch/socket
  paths before Bot seats can be created.
- Rollback: revert this round's commits; no database migration, no deployment
  config, no model files, and no rules change are involved.

## Invariant checks

- No direct `setState`-bypass move code.
- No imports of hashed private boardgame.io files.
- Bot decision input never contains deck order or opponent blind-reservation
  card IDs (proven for the spike by the playerView assertions above).
