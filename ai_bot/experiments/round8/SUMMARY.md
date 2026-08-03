# Round 8 — Neural Expert Pipeline (guide M0-M3): env parity, encoder, policy baseline, PUCT

Date: 2026-08-03
Branch: `codex-ds/ai_bot`
Guide: `/Users/eddyliulin/Downloads/splendor_ai_expert_model_development_guide.md`

## Completed (in guide order)

### M0/M1 — Simulator lock + baselines (Python env)

- `ai_bot/neural/env/game.py`: 1:1 Python port of the authoritative TS rules
  (setup, selectors, engine incl. the two-color takeDifferent fallback,
  legal actions with identical canonical keys, simulation wrapper, player
  view redaction). `ai_bot/neural/env/rng.py` mirrors mulberry32/FNV-1a.
- Differential parity: `scripts/ai/neural/trace.ts` writes first-legal-action
  traces; `ai_bot/neural/tests/parity_test.py` replays them and asserts
  identical action keys, moves, full-state hashes and observations.
  **60/60 games pass (2/3/4 players).**

### M1/M2 — Encoder + policy baseline

- `src/shared/ai/neural/encode.ts` + Python mirror: fixed 462-dim padded
  entity observation (acting-player-relative), 43-dim action vectors.
  Golden-vector parity test passes (`ai_bot/neural/tests/golden_test.py`).
- Dataset: `scripts/ai/neural/export-games.ts` — seeded self-play with the
  existing search policies as teachers (21,693 positions, seed neural-s1).
- `ai_bot/neural/model/net.py` Deep-Sets policy-value net (~330k params);
  `train/train_policy.py` trains in ~15s/12 epochs on this Mac (CPU).
  Holdout exact-move accuracy 41.7% vs ~5% random baseline.
- ONNX export (`export_onnx.py`, opset 17, dynamic action axis) +
  `onnxruntime-node` inference (`src/shared/ai/neural/inference.ts`).

### M3 — Search teacher (PUCT)

- `src/shared/ai/search/neural-puct.ts`: bounded flat PUCT over root actions
  with network priors, Normal-rollout lines, network value leaves, 2 seeded
  determinizations, 96 sims, 200ms deadline.
- `scripts/ai/neural/benchmark.ts`: neural (policy or PUCT) vs Hard with
  seat rotation.

## Results vs Hard (2p, rotated seats)

| Agent | Win rate (95% CI) | p50 decision | games |
| --- | --- | --- | --- |
| Neural policy-only | 37.5% (24.2-53) | 0.18 ms | 40 |
| Neural PUCT (96 sims x 2 det) | 50.0% (33.2-66.8) | 202 ms | 30 |
| Best heuristic expert (depth-2) | 47.3% (39.5-55.3) | 44 ms | 150 |
| Tuned heuristic (train 62%) | 42.0% holdout (34.4-50) | 46 ms | 150 |

The tuned heuristic overfit its train seeds (20pp train/holdout gap).
Neural PUCT is the current front-runner and the guide's recommended path.

## Next round

- Round-2 data with the PUCT search as teacher (neural-s2) -> retrain
  (expert iteration), re-export, re-benchmark; then 3/4-player runs.
- Then wire the neural worker into the server worker pool with fallbacks
  (guide §9) once strength is proven.

## Gates

TypeScript typecheck clean. Full Vitest suite not re-run this round (no
shared-rule changes; Python parity suite is the new gate for the env port).
`onnxruntime-node@1.20.1` added as a production dependency (worker-side
inference, loaded once).
