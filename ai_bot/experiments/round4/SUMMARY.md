# Round 4 — Shared Worker Pool & Hard Beam

Date: 2026-08-03
Branch: `codex-ds/ai_bot`
Guide: `ai_bot/DEVELOPMENT_GUIDE.md` §15 (第 4 轮)

## Completed

- Hard search (`src/shared/ai/search/beam.ts`): top-5 pre-scored candidates,
  one seeded determinization, Bot completes its own turn incl. pending
  resolutions, every opponent plays one full Normal turn, leaf evaluated
  after the Bot's own reply (2-ply leaf, still inside the one-round horizon).
  Hard deadline (default 80ms) and 800-node cap return best-so-far.
- Shared Worker Thread pool (`src/server/ai/worker-pool.ts` + `worker.ts`):
  bounded queue (default 256), live-before-background priority, watchdog
  (budget + 50ms), worker crash rebuild with job retry, structured-clone
  messages, `workers: 0` inline mode for tests, pool metrics.
  Fixed a first-drain bug where freshly spawned workers never received queued
  jobs; verified with concurrent multi-job tests.
- AppConfig + `.env.example`: `AI_BOT_ENABLED`, `AI_BOT_WORKERS` (auto → 1-2,
  cap 4), `AI_BOT_QUEUE_LIMIT`, `AI_BOT_HARD_MAX_MS`; invalid values fail
  startup. `AI_BOT_ENABLED=false` disables the coordinator cleanly.
- BotController difficulty routing: Easy/Normal inline; Hard/Expert through
  the pool with Normal fallback (`fallbackLevel 2`) on queue-full/watchdog/
  worker crash. Committed heuristic weights are loaded at startup with the
  built-in fallback.
- Import cycle policy↔beam broken (shared `policy-normal.ts` + `errors.ts`)
  so the worker entry loads cleanly.
- `ai:benchmark --policy normal-v1|hard-v1` and `ai:load-test` (real server,
  real matches, human-seat auto-driver, event-loop + HTTP latency sampling).

## Acceptance results (Mac, Node 24)

Hard vs current Normal (both heuristic-v1 weights), 800 seeded 2-player
games, full seat rotation:

- Win rate: **63.6%** (Wilson 95% CI 60.2–66.9) → point ≥ 55% and CI lower
  bound > 50% ✓
- Average rank 1.35; seat wins 249/400 vs 260/400 (no systematic seat bias) ✓
- Decision timing: p50 9.37ms, p95 14.36ms, p99 16.38ms — worker budget
  ≤ 80ms ✓; 0 illegal moves; 4 cap-truncated rules-layer traps recorded
  (repros saved under `.local-data/ai-bot/runs/hard-vs-normal-final/`).
- Load test (10/25/50 concurrent Hard-bot matches, 2 pool workers):
  main-thread event-loop p99 max **2.611ms** (target < 50ms), HTTP
  `/api/auth/me` responsive, pool completed 2000 jobs with 0 timeouts and
  0 worker restarts; queue depth peaked at 1.
- Unit/integration: Hard determinism, hidden-information invariance, legal
  moves, tiny-budget best-so-far, worker pool thread mode (3 concurrent
  jobs / 2 workers), plus the full existing suite.

## Gates

`npm run typecheck` clean · `npm test` 182 tests · `npm run build` clean ·
`npm run test:e2e` 2 specs passed (Easy bot E2E now runs with the pool in
auto mode).

## Notes / next round entry

- The first Hard implementation was a coin flip vs Normal (50.7%); adding the
  Bot's own reply to the leaf evaluation lifted it to 63.6%. This validates
  the guide's instruction to benchmark rather than assume search strength.
- Expert (round 5) will decide whether conditional micro-MCTS adds value on
  top of Hard; default remains off.
- Hard worker p95 stays well inside budget; the 4 cap-truncated games remain
  the documented rules-layer poverty-trap artifact.
