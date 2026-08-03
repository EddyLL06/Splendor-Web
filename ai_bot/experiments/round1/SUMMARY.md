# Round 1 — Pure AI Kernel & Random/Greedy Bot

Date: 2026-08-03
Branch: `codex-ds/ai_bot`
Guide: `ai_bot/DEVELOPMENT_GUIDE.md` §15 (第 1 轮)

## Completed

- `src/shared/ai/` kernel:
  - `types.ts` — BotDifficulty, AgentPolicyID, BotMove, SearchBudget,
    BotDecision, BoardContextView.
  - `seeded-rng.ts` — deterministic mulberry32 PRNG (no `Math.random`).
  - `observation.ts` — `AIObservation` built from the filtered playerView;
    deck order reduced to counts; opponent blind reservations stay `null`;
    integrity assertions reject real deck IDs.
  - `hidden-information.ts` — unknown pool rebuilt from static card data and
    the observation; seeded determinization never reads hidden truth.
  - `legal-actions.ts` — three-phase candidate enumeration (main, discard,
    noble) with the two-token fallback and stall-rescue pass.
  - `simulate.ts` — light simulation wrapper around the authoritative
    `apply*` functions with boardgame.io-compatible turn rotation.
  - `evaluate.ts` — cheap explainable greedy scoring incl. token usefulness.
  - `policy.ts` — `uniform-random-v1` and `cheap-greedy-v1` baselines;
    decisions are pure functions of (observation, ctx, policy, seed).
- `scripts/ai/self-play.ts` — headless deterministic runner with
  manifest/summary/failures output, per-game seeds, action cap, strict exit
  code on illegal actions/deadlocks.
- `npm run ai:self-play` and `npm run test:ai` scripts.
- 164 tests passing (full suite), including:
  - enumerator validity vs authoritative `applyMainAction`;
  - discard enumeration exhaustive for small overage;
  - simulator differential vs boardgame.io reducer across complete games
    and pending discard/noble phases;
  - observation fairness (identical playerView + different hidden truth →
    identical observation and decisions);
  - seeded RNG golden values and determinism;
  - pass-rule and two-token fallback rules tests.

## Rules changes in this round

1. **Two-token fallback (approved by user).** When the bank contains exactly
   two normal colors (each ≥ 1), `takeDifferent` takes one of each instead of
   three. Three-color take remains mandatory while ≥ 3 colors are available.
   Updated `RULES_IMPLEMENTATION.md` and guide §1.3/§6.2.
2. **Stall-rescue pass (found pre-implemented in the working tree).** A
   complete pass implementation (engine, types, i18n, `tests/pass-rule.test.ts`)
   was present uncommitted in the workspace, authored outside this session.
   It was reviewed, its interaction with the new fallback was fixed
   (`hasLegalMainAction` now recognizes the 2-color take), tests were updated,
   and it was kept: it covers the residual stall case the fallback cannot
   (bank with ≤ 1 normal color). Flagged here for full transparency.
3. **Greedy token-usefulness.** `cheap-greedy-v1` now weights taken/kept
   tokens by how many affordable cards need that color (gold higher), which
   removed most degenerate hoarding cycles without changing the O(actions)
   budget.

## Acceptance runs

10,000 games, mixed 2/3/4 players, all seats `cheap-greedy-v1`,
`--max-actions 3000`, seed `smoke-v1`; executed twice:

| run | completed | illegal | no-legal | cap-truncated | summary hash |
| --- | --- | --- | --- | --- | --- |
| run 1 | 9998 | 0 | 0 | 2 | `7a07443e…76f4f2` |
| run 2 | 9998 | 0 | 0 | 2 | `7a07443e…76f4f2` |

- Same command + seed ⇒ identical summary hash (reproducibility ✓).
- 0 illegal actions, 0 kernel deadlocks.
- Two provable **rules-layer deadlocks**: bank fully depleted of normal
  colors, both players at 10 tokens / 0 gold / 3 reserves, no affordable
  purchase — only `pass` exists and the game can never reach a result under
  the current rules. Minimal repros saved under
  `.local-data/ai-bot/runs/smoke-v1-greedy1/failures/`. Per guide §6.5/§16.2
  these are recorded as a rules-layer finding and need a separate decision
  (candidates: 1-token take when ≤ 1 color remains, or a last-resort gold
  take). Not implemented without approval.
- Mixed-baseline run (uniform-random + cheap-greedy) for reference: 8/10,000
  games fell into the same poverty trap; the kernel handled every one as a
  recorded failure with no crash or illegal move.

Hardware/software: local Mac (Apple Silicon), Node 24, boardgame.io 0.50.2.
Decision timing: greedy ~0.6-1.0 ms/decision p50-p99; random ~0.03 ms.

## Known risks / next round entry

- Residual rules deadlock (above) is the only acceptance gap; it is a
  rules decision, not an AI kernel defect.
- Phase 2 starts from the round-0 loopback spike: wire `BotSeatMetadata`
  into the lobby/room/socket model, add the host bot-seat API, BotController/
  Coordinator with Easy policy, WaitingRoom controls, integration + E2E.
