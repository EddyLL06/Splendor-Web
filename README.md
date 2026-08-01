# Gem Council

Gem Council is a production-oriented, browser-based multiplayer implementation
of the original base-game rules. Version 1 adds verified accounts, secure
email/password authentication, profiles and avatars, public/private rooms, and
complete English and Simplified Chinese interfaces while preserving the
authoritative boardgame.io rules engine and hidden-information model.

The interface uses text, CSS shapes, labels, and symbols. No official card
artwork or scanned game assets are bundled.

## Version 1 features

- Complete two-to-four-player Splendor-style setup and play
- Verified email registration and purpose-separated password reset
- Argon2id password hashes and revocable 30-day server sessions
- Account usernames and 512×512 sanitized WebP avatars at every table
- Authenticated lobby, waiting room, HTTP API, and Socket.IO moves
- Public rooms listed to signed-in players and private invitation-only rooms
- One seat per internal account ID in each match, with safe credential rotation
  and reclaim after refresh or re-login
- English first-visit default and a persistent EN/中文 switch
- Responsive desktop/mobile board, explicit payments and mandatory resolutions
- SQLite persistence for accounts, challenges, sessions, and avatar metadata
- In-memory-only live games, with no match history, rankings, replays, or stats
- Deterministic unit, integration, Socket.IO, security, migration, and browser
  end-to-end tests

## Requirements

- Node.js 24 LTS (`>=24 <25`; `.nvmrc` pins the verified release)
- npm 12 or a compatible npm release for Node.js 24

Dependencies are pinned to exact versions. boardgame.io remains at `0.50.2`.

## Local installation

```bash
npm ci
npm run config:local
npm run prisma:generate
npm run prisma:migrate:deploy
npm run dev
```

`config:local` adds missing variables and strong random secrets to the ignored
`.env` without printing or replacing existing values. It preserves an existing
Resend key and sender configuration.

The development command starts:

- React/Vite client: `http://localhost:5173`
- Account, lobby, multiplayer, and Socket.IO server: `http://localhost:8000`

Vite proxies `/api`, `/games`, `/socket.io`, and controlled avatar requests to
the server. Leave `VITE_GAME_SERVER_URL` blank for this same-origin development
path. Use `npm run dev:client` or `npm run dev:server` to run one process.

Development state is disposable and ignored under:

```text
.local-data/
  database/app.sqlite
  avatars/
  tmp/
```

## Account and room flow

1. Choose **Create account**, enter an email, username, and password, then send
   a six-digit verification code.
2. Enter the code within its configured lifetime. A successful registration
   verifies the email and creates a login session.
3. Sign in later with email and password. **Reset password** sends a separate,
   purpose-bound code and revokes every older session when completed.
4. Open **Profile** to change the username, upload/replace an avatar, or remove
   it. A generated initials/pattern avatar is used by default.
5. Create a public or private two-to-four-seat room. Public rooms appear in the
   lobby; private rooms are reachable only by their invitation link.
6. The server uses the authenticated account username and internal user ID. It
   ignores forged browser names and prevents one account from claiming two
   seats in the same room.
7. Each tab keeps only its signed boardgame.io seat credential in
   `sessionStorage` for reconnect. The account session is a separate opaque,
   HTTP-only cookie and never enters web storage, game state, or action logs.

Usernames are 2–20 Unicode letters/numbers or underscores after NFKC
normalization. Spaces, emoji, markup, invisible characters, and other
punctuation are rejected. Matching and uniqueness are case-insensitive.

Passwords are 10–128 printable, non-space ASCII characters. They are never
trimmed or otherwise transformed, and there are no artificial composition
rules for uppercase, lowercase, digits, or symbols.

## Email and Resend

Production uses the provider-independent email interface through the Resend
adapter. The verified sender domain is `auth.example.com`; the default identity
is `Gem Council <no-reply@auth.example.com>`. `EMAIL_FROM` may use another valid
mailbox under that verified domain, and `EMAIL_REPLY_TO` is optional.

Set `RESEND_API_KEY` only in the ignored local environment or the deployment
secret manager. Verification emails contain the purpose, six-digit code,
expiry, and a warning to ignore an unsolicited message. They contain no
tracking or marketing content. Tests force the fake adapter and never perform
an outbound email request.

Registration-code requests deliberately return the same generic response for
already registered and unregistered addresses. Password-reset requests do the
same for existing and missing accounts. A provider failure removes the pending
challenge rather than pretending a usable code was delivered.

## Avatar restrictions

- One JPEG, PNG, or WebP file, maximum 2 MB
- Content detected from decoded bytes; filename, extension, and browser MIME
  declaration are not trusted
- SVG, GIF/animation, appended polyglot data, malformed files, oversized pixel
  dimensions, and decompression-bomb inputs are rejected
- The image is auto-oriented, cropped to a fixed 512×512 square, stripped of
  metadata, and re-encoded as WebP
- Server-generated random storage keys stay beneath `AVATAR_STORAGE_DIR`
- Replacement writes the new file before updating metadata and removes the old
  file only after the database update succeeds
- Retrieval is through authenticated `/api/users/:id/avatar`; the storage
  directory is never publicly served

## Database and migrations

Prisma uses SQLite through the current better-sqlite3 driver adapter. Committed
migration history is the only production schema path:

```bash
npm run prisma:generate
npm run prisma:migrate:deploy
```

Use `npm run prisma:migrate:dev` only while intentionally developing a new
schema migration. Do not use schema push as a deployment substitute.

The persisted models are:

- `User`: normalized unique email/username, Argon2id hash, verified/status data
- `EmailVerificationChallenge`: purpose-bound HMAC code hash, expiry, resend
  time, durable failure count, and one-time consumption
- `Session`: keyed opaque-token hash, CSRF secret, expiry/activity/revocation
- `AvatarAsset`: one-to-one user metadata and unique random storage key

SQLite unique indexes, foreign keys, cascade behavior, and data checks enforce
integrity in addition to application validation.

## Production storage and deployment

For a complete start-to-finish deployment example, including Node.js 24,
systemd, Nginx, HTTPS, backups, updates, and troubleshooting, see
[SERVER_SETUP.md](./SERVER_SETUP.md).

Put all persistent paths on an external mounted volume and use absolute paths,
for example:

```dotenv
APP_DATA_DIR=/srv/gem-council/data
DATABASE_URL=file:/srv/gem-council/data/database/app.sqlite
AVATAR_STORAGE_DIR=/srv/gem-council/data/avatars
UPLOAD_TEMP_DIR=/srv/gem-council/data/tmp
```

Never place these paths in `public/`, `dist/`, or `dist-server/`. The server
validates broad, public, file, and symlink paths and confirms write access at
startup.

A safe deployment sequence is:

```bash
npm ci --include=dev
npm run prisma:generate
npm run prisma:migrate:deploy
npm run build
npm start
```

Serve `dist/` as the static client and proxy `/api`, `/games`, and
`/socket.io/` to the single Node process. Use exact HTTPS origins in
`GAME_ALLOWED_ORIGINS`; wildcard origins are incompatible with credentialed
cookies and sockets. Run the migration before switching application traffic.

Back up the SQLite database **and** avatar directory together. A database-only
backup can leave avatar metadata without its file, while an avatar-only backup
loses ownership metadata. Stop writes or use a consistent SQLite snapshot and
coordinated filesystem snapshot.

## Environment variables

See `.env.example`; it contains names and safe defaults only.

| Variable | Default / requirement | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `APP_BASE_URL` | `http://localhost:5173` | Exact browser origin and secure-cookie context |
| `VITE_GAME_SERVER_URL` | blank | Optional explicit lobby/Socket server URL |
| `GAME_SERVER_PORT` | `8000` | Single Node server port |
| `GAME_ALLOWED_ORIGINS` | app origin | Comma-separated exact HTTP(S) origins |
| `APP_DATA_DIR` | `.local-data` | Parent runtime data directory |
| `DATABASE_URL` | local SQLite URL | `file:` URL without query/fragment |
| `AVATAR_STORAGE_DIR` | local avatars | Private avatar file directory |
| `UPLOAD_TEMP_DIR` | local tmp | Private temporary upload directory |
| `EMAIL_PROVIDER` | `resend` | `resend`; `fake` is accepted only in tests |
| `RESEND_API_KEY` | required for Resend | Provider secret; never commit or log |
| `EMAIL_FROM` | verified default sender | Resend From identity |
| `EMAIL_REPLY_TO` | blank | Optional Reply-To address |
| `SESSION_SECRET` | strong random required | HMAC key for stored session hashes |
| `VERIFICATION_CODE_PEPPER` | strong random required | HMAC key for code hashes |
| `GAME_CREDENTIAL_SECRET` | strong random required | Seat-credential signature key |
| `SESSION_DURATION_DAYS` | `30` | Account-session lifetime |
| `VERIFICATION_CODE_TTL_MINUTES` | `10` | Code lifetime |
| `VERIFICATION_CODE_RESEND_SECONDS` | `60` | Durable resend cooldown |
| `VERIFICATION_CODE_MAX_ATTEMPTS` | `5` | Durable wrong-code limit |

Non-test secrets must contain at least 256 bits of random material. Rotate a
secret deliberately: changing the session or game credential key invalidates
the corresponding active credentials.

## Security design

- Passwords use salted, parameterized Argon2id hashes.
- Verification codes use a cryptographic generator and a challenge/email/
  purpose-bound HMAC; plaintext codes exist only during delivery.
- Account sessions use random opaque tokens. Only keyed hashes are stored, and
  cookies are `HttpOnly`, `SameSite=Lax`, `Secure` under HTTPS/production, and
  scoped to `/`.
- Every authenticated mutation requires an exact allowed `Origin` and matching
  per-session `X-CSRF-Token`; protection does not rely on SameSite alone.
- Structured schemas, strict body limits, controlled multipart handling,
  security headers, exact credentialed CORS, and centralized stable error codes
  prevent raw provider/SQL/stack output from reaching clients.
- In-memory limits cover code requests, verification, login, and avatar upload;
  SQLite also preserves verification failure counts.
- Seat credentials are independently signed and bound to account ID, session
  ID, match ID, player ID, expiry, and authoritative seat metadata. Revoked or
  expired sessions cannot submit moves.
- Deck order and blind reservations remain player-view filtered. Login tokens,
  seat credentials, signing secrets, and decoded credential contents never
  enter `G` or the public action log.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run config:local` | Safely add missing ignored local environment values |
| `npm run storage:prepare` | Validate and prepare private storage paths |
| `npm run dev` | Start client and server together |
| `npm run dev:client` | Start only Vite on port 5173 |
| `npm run dev:server` | Start only the Node server |
| `npm run data:generate` | Validate CSV inputs and regenerate typed game data |
| `npm run prisma:generate` | Generate the Prisma client |
| `npm run prisma:migrate:dev` | Develop a new migration intentionally |
| `npm run prisma:migrate:deploy` | Apply committed migrations |
| `npm run typecheck` | Strict client and server TypeScript checks |
| `npm test` | Full deterministic Vitest unit/integration/Socket suite |
| `npm run test:e2e` | Isolated two-browser-context Chrome journey |
| `npm run test:watch` | Vitest watch mode |
| `npm run build` | Generate data, typecheck, bundle client, compile server |
| `npm start` | Start the compiled production Node server |

Each server-focused test suite creates its own temporary SQLite database and
data directories outside `.local-data`, applies the committed migration, uses
deterministic test secrets, and injects the fake email provider. The E2E suite
does the same and requires an installed Google Chrome channel.

## Architecture and privacy

```text
prisma/                    Schema and committed SQLite migration
scripts/                   Data, environment, storage, and E2E helpers
src/client/                Auth state, i18n, lobby, profile, and game UI
src/game/                  boardgame.io game integration and playerView
src/server/auth/           Registration, login, reset, and sessions
src/server/database/       Prisma adapter lifecycle
src/server/email/          Provider interface, Resend, fake, bilingual content
src/server/http/           Koa integration, routes, CORS/CSRF/error boundary
src/server/multiplayer/    In-memory store, secure lobby, seat credentials
src/server/profile/        Avatar decode/re-encode/storage pipeline
src/server/storage/        Private-path preparation and cleanup
src/server/validation/     Strict request and identity validation
src/shared/                Pure rules, generated data, and shared types
tests/                     Unit and HTTP/Socket integration tests
e2e/                       Isolated browser journey
```

The supplied `card_data/*.csv` files remain the source of truth. The
deterministic converter validates every row and writes
`src/shared/data/generated-game-data.ts`; do not edit that generated file.

Live boardgame.io state is deliberately held only in `MemoryMatchStore`.
Restarting the Node process removes every room and active game. This version
does **not** persist matches and includes no match history, replay storage,
ranking, ELO, leaderboard, match statistics, moderation workflow, AI player,
spectator workflow, or expansion content. Account/SQLite backups cannot restore
an interrupted live match.

See [RULES_IMPLEMENTATION.md](./RULES_IMPLEMENTATION.md) for the exact base-game
rule mapping and documented digital adaptations.
