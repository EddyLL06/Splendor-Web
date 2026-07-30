# Gem Council

Gem Council is a complete browser-based multiplayer implementation of the
original base-game rules. It uses
React, strict TypeScript, Vite, Node.js, and boardgame.io’s Socket.IO transport
and in-memory match storage.

The interface uses text, CSS shapes, labels, and symbols. No official card
artwork or scanned game assets are bundled in the application.

## Version 0 features

- Complete two-to-four-player setup and play
- Independently shuffled three-tier development decks
- Four-card markets with safe refill and exhausted-deck handling
- Correct token supply and noble counts for each player count
- Three-different and two-matching token actions
- Public and blind card reservation, including the three-card limit
- Explicit colored and gold-joker purchase payment
- Permanent discounts, free purchases, and strategic gold use
- Mandatory return-to-ten token resolution
- Automatic or player-selected noble visits
- Random first player and equal-turn final-round handling
- Score, fewest-card tiebreak, and shared winners
- Authoritative server validation and useful disabled states in the UI
- Redacted deck order and blind-reservation identities
- Public action log that does not reveal private cards or credentials
- Minimal room browser, invite links, waiting room, refresh reconnect, leave,
  and rematch
- Responsive desktop and mobile layouts
- Deterministic source-data, rule, privacy, setup, and boardgame.io integration
  tests

## Requirements

- Node.js `>=20.11 <21` (developed and verified with Node.js `20.11.1`)
- npm `10.4.0` or a compatible npm 10 release

Dependencies are pinned to exact versions in `package.json`.

## Install and run

```bash
npm install
npm run dev
```

The development command starts:

- React client: `http://localhost:5173`
- Multiplayer and lobby server: `http://localhost:8000`

You can run either process separately:

```bash
npm run dev:client
npm run dev:server
```

For a production build:

```bash
npm run build
npm start
```

`npm start` serves the compiled multiplayer server. Serve the generated `dist/`
directory with any static file server for a production client.

## Create and join a match

1. Open `http://localhost:5173`.
2. Enter a display name.
3. Choose two, three, or four seats and create a match.
4. Copy the invite link from the waiting room.
5. Open the link in another browser tab, browser profile, or private window.
6. Enter a different display name and claim an open seat.
7. When all seats are occupied, every player enters the board automatically.

The invite URL contains only the match ID. It never contains a player
credential. Each joined tab stores its own match credential in `sessionStorage`
so a refresh reconnects that tab to its seat.

To test multiple players on one computer, use separate tabs. `sessionStorage`
is tab-scoped, so each tab can hold a separate seat credential. A separate
browser profile or private window is also supported.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the client and server together |
| `npm run dev:client` | Start only Vite on port 5173 |
| `npm run dev:server` | Start only the boardgame.io server on port 8000 |
| `npm run data:generate` | Validate the CSV files and regenerate typed data |
| `npm run typecheck` | Run strict client and server TypeScript checks |
| `npm test` | Run the deterministic Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run build` | Generate data, typecheck, bundle the client, and compile the server |
| `npm start` | Start the compiled multiplayer server |

## Environment variables

Copy `.env.example` to `.env` when overriding local defaults.

| Variable | Used by | Default | Purpose |
| --- | --- | --- | --- |
| `VITE_GAME_SERVER_URL` | Client | `http://localhost:8000` | Lobby and Socket.IO server URL |
| `GAME_SERVER_PORT` | Server | `8000` | Multiplayer server port |
| `GAME_ALLOWED_ORIGINS` | Server | `http://localhost:5173` | Comma-separated CORS origins |

When testing from another device, set `VITE_GAME_SERVER_URL` to an address that
device can reach and add the client origin to `GAME_ALLOWED_ORIGINS`.

## Source CSV conversion

The supplied files remain untouched in `card_data/`:

- `deck1.csv`
- `deck2.csv`
- `deck3.csv`
- `nobles.csv`

`scripts/convert-game-data.ts` is the only source-data conversion path. It:

- recognizes and skips the unusual second-line metadata row;
- parses every actual value as a non-negative integer;
- rejects missing, malformed, negative, or non-integer data;
- validates 40, 30, and 20 cards plus 10 nobles;
- validates suits `0–4` and the 8/6/4 per-suit tier distributions;
- assigns stable `L1-001`, `L2-001`, `L3-001`, and `N-001` IDs; and
- writes `src/shared/data/generated-game-data.ts` deterministically.

The original CSV files are the source of truth. Do not edit the generated
module manually.

## Architecture

```text
card_data/                 Supplied source CSV files
scripts/
  convert-game-data.ts     Deterministic parser and generator
src/
  shared/
    constants/             Color mapping and count helpers
    data/                  Generated data and safe lookups
    rules/                 Pure setup, validation, payment, and turn rules
    types/                 Shared strict TypeScript state and action types
  game/
    SplendorGame.ts        boardgame.io integration
    playerView.ts          Per-player hidden-information filter
  server/
    server.ts              Multiplayer/lobby server and CORS configuration
  client/
    components/            Board, cards, payments, and resolution panels
    screens/               Lobby and waiting room
    session.ts             Tab-local reconnect credential handling
tests/                     Deterministic data, rules, privacy, and integration tests
```

Pure rules return a new state only for valid actions. The boardgame.io move
layer converts rejected rules into its `INVALID_MOVE` result. boardgame.io then
runs the move only for the active player and the server stores the authoritative
result.

The modeled `pending` resolution state prevents any second main action while a
player must return tokens or choose a noble. A turn ends automatically only
after `turnReady` is set by the complete resolution pipeline; client-triggered
boardgame.io turn events are disabled.

## Hidden-information strategy

The authoritative state keeps real deck order and all reserved card IDs.
`playerView` creates a JSON-safe copy for each client:

- every future deck card ID becomes the same opaque placeholder, preserving
  only the remaining count;
- the owner sees the ID of their blind-reserved cards;
- opponents and spectators receive `null` for blind-reserved IDs;
- cards reserved from the public market remain visible; and
- credentials never enter game state or the public action log.

Scores, permanent bonuses, card counts, token counts, nobles, public
reservations, market cards, and action history remain public.

## Known Version 0 limitations

- **Matches are stored only in memory and disappear whenever the server
  restarts.**
- Display names and credentials are not user accounts. Clearing the tab’s
  session storage loses that tab’s reconnect credential.
- There is no database, ranking, match history, moderation, spectator workflow,
  AI player, or expansion content.
- A rematch still requires each player to click **Play again** and join the new
  waiting room.
- Local production hosting of the static `dist/` client is intentionally left
  to the operator; the project does not include a database-backed deployment.
- boardgame.io `0.50.2` predates modern Node ESM package exports. The project
  uses its published CommonJS runtime files for the server and `INVALID_MOVE`
  while preserving the package’s official TypeScript declarations.

See [RULES_IMPLEMENTATION.md](./RULES_IMPLEMENTATION.md) for the exact rule
mapping and documented digital adaptations.
