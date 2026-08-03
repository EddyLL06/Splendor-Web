# Round 7 — Expert v2/v3 Search Rework + Match Memory + Expert Tuning

Date: 2026-08-03
Branch: `codex-ds/ai_bot`
Goal: make Expert stronger than Hard (user target: 75%+ win rate in 2/3/4p).

## What changed

- `src/shared/ai/memory.ts`: compact public-only match memory (per-opponent
  turn counts, last action type, turns-ago, purchases, reserves by tier,
  nobles, gold, last-4 take colors). Deterministic reducer over observations;
  no hidden card IDs; hidden-information invariant test added. Wired through
  headless runner, BotController and the worker pool (structured-clone safe).
- `src/shared/ai/search/micro-mcts.ts` rewritten twice based on benchmark
  feedback:
  - v2: rolling-horizon beam + event-value terms -> 7.5% -> 26.7% (event
    terms distorted root ranking into tier-3 reserve hoarding).
  - v3: iterated Hard-quality rounds (round 1 = Hard's own ranking, round 2 =
    second Hard-quality search of the Bot's next turn) with pure-model leaf
    + tiny expert corrections. Depth-3 was tried and abandoned (43%, p95
    128ms). Opponent hard-lite modeling was implemented behind a guard but
    disabled (cost).
- Expert-specific leaf corrections injected via reserved `__x_*` weight keys
  (tempo cancel, affordable bonus, token hoarding penalty), loaded by
  benchmark/validate CLIs through a top-level `expertExtras` field.
- `scripts/ai/tune-expert.ts` + `npm run ai:tune-expert`: coordinate search
  over expert knobs + base weights vs a frozen Hard baseline on train seeds.

## Benchmark trajectory (Expert vs Hard, 2p, rotated seats, heuristic-v1)

| Round | Search | 2p win rate (95% CI) | p95 ms | games |
| --- | --- | --- | --- | --- |
| R1 | v2 event beam | 7.5% (4.6-12) | 25 | 200 |
| R2 | v2 + root lift/beam fix | 18.0% (13.3-23.9) | 60 | 200 |
| R3 | v2 pure leaf | 26.7% (20.2-34.3) | 57 | 150 |
| v3-r1 | iterated rounds depth 2 | 47.3% (39.5-55.3) | 66 | 150 |
| v3-r2 | depth 3 | 43.3% (35.7-51.3) | 128 | 150 |
| v3-r4 | eval corrections | 42.7% (35.0-50.7) | 69 | 150 |

Root cause identified: the shared model's snapshot scoring rewards token
hoarding (tempo feature penalizes affordability), so deeper search amplifies
hoarding. Fix direction: tune an Expert-specific evaluation against frozen
Hard (Rinascimento event-value idea).

## First tuning results (train seeds)

`ai:tune-expert --seed expert-train-s1 --iterations 10 --eval-games 40`:
baseline 43.8% -> best 51.2% (affordableBonus=4, gold=3.1). Noisy at 40
games/iter; longer runs and holdout validation follow in round 8.

## Gates

typecheck clean; AI kernel tests (memory, policy, hard-policy) pass.
Full suite not yet re-run (pending final expert weights); will run before
promotion.
