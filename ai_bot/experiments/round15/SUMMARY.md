# Round 15 — Neural Expert v3: GPU Expert Iteration + Production Upgrade (3000ms Budget)

Date: 2026-08-04
Branch: `codex-ds/neural-v2`

## Goal

Train a stronger neural Expert with the available GPU (RTX 4070 SUPER via WSL),
raise the Expert decision budget to 3000 ms per move, and ship the model through
the repo's validation gates as a branch + PR. Target: 75% 2p win rate vs Hard.

## What changed

- **3000ms Expert budget**: `AI_BOT_EXPERT_MAX_MS` default 500 -> 3000 in
  `src/server/config.ts`, the worker fallback, exporter/benchmark deadlines,
  `.env.example`, README, SERVER_SETUP and the neural worker test.
- **Parallel self-play tooling**: `--teachers`, `--budget-ms`, `--sims`,
  `--determinizations`, `--progress-every`, per-worker ONNX thread control
  (`AI_NEURAL_INTRA_OP_THREADS`), and capped-game accounting in the exporter.
- **Low-memory GPU training**: datasets are streamed into disk-backed memmaps
  (no full corpus in RAM), card lookups are cached, CUDA is warmed before
  precompute, TF32 matmuls + batch 512 are used, and per-batch progress logs
  were added. Peak RSS dropped from >12GB + swap to ~8.6GB with 0 swaps.
- **Training bugfix**: PUCT `searchValue` targets are now clamped to [-1,1] in
  the streaming dataset (terminal search values are ±1e6 and previously
  exploded the value loss); action masking uses a finite -1e4 fill so fp16
  gradients stay finite (training currently runs fp32/TF32).
- **New model**: `policy-attn-v3.onnx` (403k params, 1.68MB, attention 128/4/2)
  + manifest, trained on 535,812 positions from three all-neural/mixed
  self-play rounds (s7: 350.6k, s8: 114.6k, s9: 70.6k; 0 capped games).

## Training rounds

| Round | Data | Teacher | Holdout acc | Value err |
| --- | --- | --- | --- | --- |
| v1 | s7 (mixed pool) | s6 | 44.2% | 0.536 |
| v2 | s7+s8 (all-neural) | attn128-v1 | 49.0% | 0.479 |
| v3 | s7+s8+s9 (all-neural) | attn128-v2 | **51.7%** | **0.441** |

## Validation vs Hard (bot-tree PUCT 96x2, 3000ms, 0 illegal / 0 deadlocks)

| Metric | s6 (old) | v3 (new) |
| --- | --- | --- |
| 2p win rate | 72.0% (100) | **79.5%** (200, CI 73.4-84.5) |
| 3p win rate | 48.0% (100) | **59.0%** (100) |
| 4p win rate | 31.0% (100) | **56.0%** (100) |

Same-seed 2p head-to-head: v1 79%, v2 81%, v3 78% (100 games each); final
200-game confirmation selected v3 (79.5% vs v2 75.0%).
Alternating PUCT remains weaker (12.5% @40) and 192x3 did not beat 96x2.

## Deployment fit (2 pinned cores, 96x2, 3000ms budget)

- p50 288ms, p95 425ms, p99 451ms (limit 3000ms)
- Peak RSS 262MB (limit 2GB)

## Gates

- `npm run ai:neural-test` (golden + parity): pass
- `npm test`: 203/203 pass
- `npm run build`: pass
- `npm run ai:smoke`: 12/12 games, 0 illegal, 0 deadlocks

## Rollback

The previous `policy-attn-s6.onnx` + manifest remain committed; reverting the
config default (or setting `AI_BOT_NEURAL_MODEL`) restores the old Expert.
