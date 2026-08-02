# Round 3 — Normal Heuristic & Training Pipeline

Date: 2026-08-03
Branch: `codex-ds/ai_bot`
Guide: `ai_bot/DEVELOPMENT_GUIDE.md` §15 (第 3 轮)

## Completed

- Full normalized feature vector (`src/shared/ai/features.ts`, `features-v1`):
  score, leader gap, distance to 15, five bonus colors, bonus balance,
  purchased count, noble progress/count, tokens/gold, affordable cards,
  discard waste, reserved slots, opponent max score/noble threat, blocking
  value, tempo, tie-break card count, per-tier market value. All clamped to
  bounded ranges.
- Model format (`src/shared/ai/models/schema.ts`): zod-validated JSON with
  schema version, model version, createdAt, rules fingerprint (sha256 over
  rules/data files), feature version, full weight set, training and
  validation manifests; unknown/missing/NaN weights rejected.
- First committed model: `ai_bot/models/heuristic-v1.json`
  (`heuristic-v1.0.0`, hand-tuned `features-v1` weights, live fingerprint
  `1ba7ffbd…e9e192` verified by test).
- Normal 1-ply policy (`normal-v1`): evaluates every candidate by simulating
  it with the authoritative rules and scoring the post-state with the linear
  model; seeded tie-breaks; terminal win/loss overrides.
- Offline CLIs:
  - `ai:self-play` (refactored onto a shared headless runner with
    `--model` support),
  - `ai:benchmark` (candidate vs frozen baseline, seat rotation, Wilson 95%
    CIs, avg rank, seat-bias and p50/p95/p99 timing),
  - `ai:tune` (random-restart coordinate search on train seeds),
  - `ai:validate` (holdout promotion check).
- Shared `scripts/ai/lib/headless.ts` runner + `lib/fingerprint.ts`.
- Enumerator fix: noble candidates are re-validated against
  `getEligibleNobleIDs` (guide §6.4).

## Acceptance results (Mac, Node 24)

Benchmark `validation-v1`, 3000 games (1000 per player count), heuristic-v1
vs frozen `uniform-random-v1`, full seat rotation:

| players | win rate | 95% CI | avg rank | seat wins | p50/p95/p99 ms |
| --- | --- | --- | --- | --- | --- |
| 2 | 95.8% | 94.4–96.9 | 1.03 | 478/500, 480/500 | 0.74 / 1.19 / 1.35 |
| 3 | 92.4% | 90.6–93.9 | 1.09 | 309/334, 307/333, 308/333 | 0.79 / 1.21 / 1.41 |
| 4 | 91.7% | 89.8–93.3 | 1.14 | 220–238 across 4 seats | 0.85 / 1.38 / 1.60 |

- Illegal actions: 0. Cap-truncated games: 22/3000 (previously documented
  rules-layer poverty traps created by the random baseline; repros saved).
- Holdout `holdout-v1` (4000 games, 2p, never-tuned seeds): win rate 95.54%,
  CI 94.85–96.13%, wins 3821, shared 1, illegal 0 → **promoted=true**
  (criterion: ≥60% point estimate vs frozen random).
- Normal decision p95 ≈ 1.2 ms ≪ 20 ms budget on this Mac.
- Tune pipeline demo (`train-v1`, 30 iterations × 40 eval games) reached
  97.5% train win rate and wrote a schema-valid candidate; train/holdout
  seeds are separate by construction (`train-v1` vs `holdout-v1`).
- Reproducibility: summary hashes included in manifests; identical commands
  reproduce identical outputs (same runner as phase 1).

## Gates

`npm run typecheck` clean · `npm test` 37 files / 178 tests · `npm run build`
clean. Committed model fingerprint test guards rule drift.

## Risks / next round entry

- 22/3000 benchmark games hit the action cap via the documented rules-layer
  trap (random-baseline artifact, not a kernel defect); a further rules
  decision (1-token/gold fallback) would eliminate them.
- Hand-tuned weights are a strong baseline; tune candidates live under
  `.local-data/ai-bot/candidates/` until a candidate beats the production
  model on holdout (round 5 promotion gate).
- Round 4: shared worker pool, Hard top-5 one-round beam with 1
  determinization, cancellation/backpressure/watchdog, load tests.
