# Round 12 — Attention Checkpoints, Ensemble Test, Pause Point

Date: 2026-08-03
Branch: `codex-ds/ai_bot`

## This round

- `src/shared/ai/neural/inference.ts`: added `EnsemblePolicy` (averaged
  priors/values) and a `NeuralPolicyLike` interface; the neural benchmark
  accepts a comma-separated model list.
- `src/shared/ai/search/neural-puct.ts`: added a `mode` switch
  (`auto|alternating|bot-tree`) and `onDebug` root-Q reporting; fixed three
  alternating-search bugs (terminal backup path, negamax child Q, root
  aggregation perspective) plus rollout-augmented leaves. The alternating
  search remains weaker than bot-tree and is parked (`mode: 'bot-tree'` is
  the production path). Rollout leaves were also tested on bot-tree and
  reverted (hurt win rate).
- `scripts/ai/neural/export-games.ts`: deadlock-safe (stall-rescue pass or
  drop the unfinished game), visit-distribution + search-value targets,
  500ms teacher budget (attention inference is slower than Deep Sets).
- Determinism note: wall-clock-budgeted searches are reproducible only when
  they complete within the budget; the hidden-info/determinism tests now use
  generous budgets. Next step: switch expert searches to deterministic
  node/sim caps only, with the worker-pool watchdog providing the timeout
  and a deterministic Normal fallback.

## Best results vs Hard (2p, rotated seats, 0 illegal/deadlocks)

| Agent | Win rate (95% CI) | games | notes |
| --- | --- | --- | --- |
| attention v1 (Deep Sets 40% acc) | 66.7% (54.1-77.3) | 60 | first attention model |
| attention s6 | 80.0% (68.2-88.2) | 60 | lucky sample |
| attention s6 (confirmation) | **63.0% (56.1-69.4)** | 200 | reliable estimate |
| ensemble attn-v1 + attn-s6 + s4 | 63.3% (50.7-74.4) | 60 | no gain over best single |

Reliable 2p strength is ~63-67%. The 75% target has NOT been consistently
reached; n=60 estimates swing +/-14pp.

## Pause point (user switching to a faster training device)

- s7 data generation was interrupted before writing any files; rerun
  `npm run ai:neural-export -- --seed neural-s7 ...` on the new device.
- Recommended next steps on the faster machine:
  1. Generate s7 (and s8) with the attention-s6 teacher at 500ms/96 sims.
  2. Fine-tune attention on each new set (`--arch attention --init
     policy-attn-s6/checkpoint-epoch-15.pt`), export ONNX, benchmark
     `--mode bot-tree` with 200-game confirmation runs.
  3. Re-test the alternating PUCT after several more value-head
     improvements (the theory is sound; the value head was too weak).
  4. Then run 3/4-player benchmarks for the full 2/3/4p target.

All checkpoints/artifacts live under `.local-data/ai-bot/` (git-ignored);
the committed code is ready to resume.
