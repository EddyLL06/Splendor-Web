# Round 10 — Alternating PUCT + Search-Derived Training Targets

Date: 2026-08-03
Branch: `codex-ds/ai_bot`

## What changed

- `src/shared/ai/search/neural-puct.ts`: added a two-player alternating PUCT
  (network priors for both sides, negamax backup, rollout-augmented leaf
  values). Three real bugs were found and fixed during benchmarking:
  1. terminal children were not pushed onto the backup path (skipped
     negamax flip);
  2. child selection used the child's own-perspective Q without negation
     (maximized the opponent's value);
  3. the final root aggregation used opponent-perspective totals (inverted
     the decision). After the fixes the root Q ordering is correct, but the
     alternating search still underperforms the bot-tree search until the
     value head improves, so the data teacher uses `mode: 'bot-tree'`.
- Search-derived training targets (guide §5.3): the exporter now records
  the PUCT root visit distribution (`visits`) and clamped search value
  (`searchValue`) for neural-teacher positions; the trainer uses soft
  cross-entropy policy targets and search-value targets instead of raw
  one-hot choices / game outcomes. Fixed NaN losses (masked -inf log-probs
  and unbounded ±1e6 terminal value targets).
- Multi-file dataset loading, `--value-weight`, `--init` fine-tuning, and a
  `--mode` switch for the neural benchmark.

## Results vs Hard (2p, rotated seats, 0 illegal/deadlocks)

| Model / training | Search | Win rate (95% CI) | games |
| --- | --- | --- | --- |
| s2 (one-hot targets) | bot-tree PUCT | 58.3% (45.7-69.9) | 60 |
| v1-all (30 epochs, 41k pos) | bot-tree PUCT | ~50% band (n=30, noisy) | 30 |
| s4 (visit+search-value targets) | bot-tree PUCT | **61.7% (49.0-72.9)** | 60 |

The search-target training loop is the strongest signal so far. Round 5
data (s5) with the s4 teacher is generating next.
