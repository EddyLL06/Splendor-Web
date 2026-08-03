# Round 5 — Expert Micro-MCTS Experiment & Promotion Decision

Date: 2026-08-03
Branch: `codex-ds/ai_bot`
Guide: `ai_bot/DEVELOPMENT_GUIDE.md` §15 (第 5 轮)

## Completed

- Conditional micro-MCTS (`src/shared/ai/search/micro-mcts.ts`, `expert-v1`):
  runs only when the top Hard prescores are close (gap ≤ 1% of the best
  score); up to 3 close candidates × up to 4 seeded determinizations ×
  bounded rollouts (150 simulations, 120ms deadline). Deterministic per
  (observation, seed); hidden-information invariant.
- Worker pool supports `expert` jobs; `AI_BOT_EXPERT_ENABLED` (default
  **false**) in config and `.env.example`; the BotController maps Expert
  difficulty to Hard unless the flag is on, so production cannot enable
  Expert by accident.
- Benchmark, load-test and policy tests extended to `expert-v1`.

## Experiment results (Mac, Node 24)

Expert vs Hard (both heuristic-v1 weights), 300 seeded 2-player games, full
seat rotation:

- Win rate: **39.0%** (Wilson 95% CI 33.7–44.6) — Expert is significantly
  WORSE than Hard; average rank 1.61; seat wins 58/150 vs 59/150 (balanced).
- Decision timing: p50 18.26ms, p95 31.45ms, p99 37.09ms (within the 120ms
  budget). 0 illegal moves, 0 deadlocks.
- Decision diversity: 28.1% of Expert decisions differ from Hard on the same
  states (it is not copying Hard; it is genuinely worse).
- Load test (10 concurrent Expert matches, 2 pool workers): main-thread
  event-loop p99 max 1.43ms, 187 pool jobs, 0 timeouts, 0 restarts — load is
  acceptable but buys no strength.

## Decision: Expert stays OFF (valid negative result)

The guide's promotion gate is "statistically credible win-rate gain plus
passing load thresholds". The holdout shows a credible LOSS (CI upper bound
44.6% < 50%), so:

- `AI_BOT_EXPERT_ENABLED=false` remains the production default.
- Expert difficulty in the UI/API currently falls back to Hard until a
  stronger search variant proves itself on holdout.
- Rollback: flipping the env flag back to false needs no code or model
  change; Expert code is inert and isolated from the Hard path.

## Promotion / rollback notes (guide §13.6)

- Model promotion is unchanged from round 3: candidates must beat the frozen
  production model on holdout `holdout-v1` with 0 illegal moves and no seat
  bias. `heuristic-v1.0.0` remains the production model.
- Tune candidates live in `.local-data/ai-bot/candidates/`; promotion runs
  `npm run ai:validate -- --candidate <candidate.json> --production
  ai_bot/models/heuristic-v1.json`.
- Rollback of a promoted model: revert the model JSON commit; the loader
  falls back to built-in hand-tuned weights if the file is missing or
  invalid, and the rules-fingerprint test blocks mismatched models.

## Gates

`npm run typecheck` clean · `npm test` 184 tests · `npm run build` clean.
E2E unchanged (Easy path) and previously green.
