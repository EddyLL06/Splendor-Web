# Round 9 — Expert Iteration Cycles + Tree PUCT (guide M3)

Date: 2026-08-03
Branch: `codex-ds/ai_bot`

## What changed

- `src/shared/ai/search/neural-puct.ts` rewritten as a real tree PUCT over
  the Bot's moves: network priors at every expanded node, network value at
  leaves, Normal opponent responses, 2 seeded determinizations, wall-clock +
  simulation caps, root visit aggregation by canonical action key.
- `scripts/ai/neural/export-games.ts` supports `neural-puct-v1` as a teacher
  (search-generated training targets, guide §5.3).
- Three expert-iteration cycles: s1 (heuristic teachers, 21,693 positions) ->
  train -> PUCT 50%; s2 (PUCT teacher, 10,907 positions) -> fine-tune ->
  PUCT 58.3%; s3 (PUCT teacher, 8,347 positions) -> fine-tune -> PUCT 43.3%.
  Round-2 model remains the strongest checkpoint.

## Benchmark results vs Hard (2p, rotated seats, 0 illegal/deadlocks)

| Config | Win rate (95% CI) | p50 ms | games |
| --- | --- | --- | --- |
| Neural policy-only s1 | 37.5% (24.2-53) | 0.18 | 40 |
| Flat PUCT s1 (96x2, 200ms) | 50.0% (33.2-66.8) | 202 | 30 |
| Flat PUCT s2 (96x2, 200ms) | 58.3% (45.7-69.9) | 202 | 60 |
| Flat PUCT s3 (96x2, 200ms) | 43.3% (31.6-55.9) | 202 | 60 |
| Flat PUCT s2 (144x3, 300ms) | 40.0% (27.6-53.8) | 302 | 50 |
| Tree PUCT s2 (96x2, 300ms) | 54.0% (40.4-67) | 301 | 50 |

Across all heuristic and neural configurations the Expert is in a 42-58%
band against Hard. The 75%+ promotion target was NOT reached. Differences
between 40% and 58% runs are within the 95% CI at these sample sizes; the
true strength is estimated near parity with Hard.

## Analysis / blockers

- Value head error remains high (~0.6), so search Q is noisy; policy
  exact-match accuracy is ~35-42% (random is ~4-5%), meaning the policy
  learns but the teacher targets are themselves only Hard-strength.
- Self-play teachers are the current Hard/Expert heuristics or the neural
  search itself; without a fundamentally stronger teacher, expert iteration
  plateaus near the teacher's strength.
- The guide's own promotion gate (§8.2) is 55% over 1,000+ games; even the
  best single run (58.3% at n=60) would need a much larger sample to be
  credible, and the aggregated evidence does not support it.

## Next steps if continued (not started)

1. Value-head warm start from TD/self-play outcomes with longer rollouts.
2. Opponent league + lower temperature + larger replay (guide §7.5).
3. Full tree PUCT with network-prior opponents (currently Normal).
4. 1,000-game promotion runs before any claim.
