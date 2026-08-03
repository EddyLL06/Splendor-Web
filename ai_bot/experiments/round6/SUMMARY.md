# Round 6 — Production Hardening (Phase 6)

Date: 2026-08-03
Branch: `codex-ds/ai_bot`
Guide: `ai_bot/DEVELOPMENT_GUIDE.md` §15 (第 6 轮)

## Completed

- Bounded, aggregate-only `AiMetrics` (`src/server/ai/metrics.ts`) wired
  through `AiWorkerPool` (peak queue depth, worker restarts, watchdog
  timeouts), `BotController` (decision durations, timeouts, fallbacks,
  no-legal, stale results) and exposed on the application object plus an
  authenticated `GET /api/diagnostics/ai` endpoint. Only aggregate numbers
  are stored/served; no match state, card IDs, tickets or credentials.
- Model startup check: `loadAiModel` verifies the model manifest's rules
  fingerprint against the deployed rule sources, logs match/mismatch status,
  and degrades to hand-tuned fallback weights with a logged warning instead
  of failing the app. A stripped production tree logs "fingerprint
  unavailable; skipped" rather than a false mismatch.
- Logging sanitization: bot lifecycle logs now use an irreversible 12-hex
  short hash of the match ID and only stable error messages (no raw match
  IDs, full state, hidden card IDs, credentials or tickets).
- Docs: README AI-bot section (env vars, 2-vCPU/2 GB resource guidance,
  rollback options, observability) and SERVER_SETUP production `.env`
  checklist plus AI model upgrade/rollback steps.
- `npm run ai:smoke`: one-command offline smoke (12 deterministic games
  across 2/3/4 players with cheap-greedy/normal/hard/expert, zero illegal or
  deadlock) plus `AI_BOT_ENABLED=false` config check proving the pure-human
  rollback needs no schema change.

## Gates

- `npm run typecheck` clean.
- `npm test`: **40 files / 194 tests passed** (incl. 8 new Phase 6 tests:
  metrics aggregation/window, sanitized short-hash, model fingerprint match,
  `AI_BOT_ENABLED=false` app boot with 0 workers + diagnostics endpoint,
  disabled coordinator early-return, inline worker pool).
- `npm run build` clean (client + server compile).
- `npm run test:e2e`: 2/2 Playwright specs passed.
- `npm run ai:smoke`: 12/12 games completed, 0 illegal, 0 deadlocks, model
  fingerprint match; hard p95 31.6ms, expert p95 61.5ms on this Mac.

## Notes / next round

- No rules, model, database schema or deployment-config changes in this
  round. `heuristic-v1.0.0` remains the production model; Expert stays OFF
  until the next round proves a holdout win-rate gain vs Hard.
- Known rules-layer deadlock (bank with no normal colors/gold, full reserves,
  nothing affordable -> only `pass`) remains documented and unchanged per
  the user-approved two-color `takeDifferent` fallback only.
