/**
 * Unit tests for the ds-search engine (PIMC-MCTS, no neural networks):
 * legality, determinism, hidden-information invariance, budget respect and
 * the child-player prediction that keeps tree perspectives correct.
 */

import { describe, expect, it } from 'vitest';

import { createPlayerView } from '../../src/game/playerView.js';
import { createObservation } from '../../src/shared/ai/observation.js';
import { HAND_TUNED_WEIGHTS } from '../../src/shared/ai/models/default.js';
import {
  computeDsSearchDecision,
  predictChildPlayer,
} from '../../src/shared/ai/search/ds-search.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from '../../src/shared/ai/simulate.js';
import { enumerateLegalActions } from '../../src/shared/ai/legal-actions.js';
import { chooseNormalMove } from '../../src/shared/ai/policy-normal.js';
import type {
  MainAction,
  SplendorState,
  TokenCounts,
} from '../../src/shared/types/game.js';
import type { BoardContextView } from '../../src/shared/ai/types.js';
import { createSeededState, samePlayerViewStates } from './helpers.js';

const weights = { ...HAND_TUNED_WEIGHTS } as unknown as Record<string, number>;

const ctxFor = (state: SplendorState, playerID: string): BoardContextView => ({
  currentPlayer: state.initialFirstPlayer,
  playOrder: state.playerOrder,
  playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
});

const decide = (
  state: SplendorState,
  playerID: string,
  seed: string,
  budgetMs = 120,
  detCount = 2,
  maxSimulations = 400,
) => {
  const observation = createObservation(
    createPlayerView(state, playerID),
    playerID,
    ctxFor(state, playerID),
  );
  return computeDsSearchDecision({
    observation,
    ctx: ctxFor(state, playerID),
    seed,
    weights,
    budget: {
      deadlineEpochMs: performance.now() + budgetMs,
      maxSimulations,
      determinizations: detCount,
      detIndex: 0,
      detCount,
    },
  });
};

const applyDecision = (
  state: SplendorState,
  playerID: string,
  move: { move: string; args: unknown[] },
): boolean => {
  const sim = createSimulation(structuredClone(state), ctxFor(state, playerID));
  const [argument] = move.args;
  const result =
    move.move === 'mainAction'
      ? applySimulationMainAction(sim, playerID, argument as MainAction)
      : move.move === 'discardTokens'
        ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
        : applySimulationNoble(sim, playerID, argument as string);
  return result.ok;
};

describe('ds-search engine', () => {
  it('returns a legal move with policy ds-search-v1', () => {
    const { state } = createSeededState(2, 'ds-legality');
    const playerID = state.initialFirstPlayer;
    const { decision } = decide(state, playerID, 'ds-legality-seed');
    expect(decision.policy).toBe('ds-search-v1');
    expect(decision.nodesVisited).toBeGreaterThan(0);
    expect(applyDecision(state, playerID, decision.move)).toBe(true);
  });

  it('handles pending discard and noble resolutions legally', () => {
    const { state } = createSeededState(2, 'ds-pending');
    const playerID = state.initialFirstPlayer;
    // Force a token overflow so the bot must discard.
    state.players[playerID].tokens.white = 5;
    state.players[playerID].tokens.blue = 5;
    state.players[playerID].tokens.green = 2;
    const sim = createSimulation(structuredClone(state), ctxFor(state, playerID));
    const overflowAction = enumerateLegalActions(sim.G, playerID, playerID).find(
      (candidate) => candidate.actionKey.startsWith('takeSame'),
    );
    const applied =
      overflowAction &&
      applySimulationMainAction(
        sim,
        playerID,
        overflowAction.move.args[0] as MainAction,
      );
    if (applied?.ok && sim.G.pending?.type === 'discard') {
      const observation = createObservation(
        createPlayerView(sim.G, playerID),
        playerID,
        {
          currentPlayer: playerID,
          playOrder: sim.playOrder,
          playOrderPos: sim.playOrderPos,
        },
      );
      const { decision } = computeDsSearchDecision({
        observation,
        ctx: {
          currentPlayer: playerID,
          playOrder: sim.playOrder,
          playOrderPos: sim.playOrderPos,
        },
        seed: 'ds-pending-seed',
        weights,
        budget: {
          deadlineEpochMs: performance.now() + 200,
          maxSimulations: 300,
          determinizations: 1,
          detIndex: 0,
          detCount: 1,
        },
      });
      expect(decision.move.move).toBe('discardTokens');
      expect(applyDecision(sim.G, playerID, decision.move)).toBe(true);
    }
  });

  it('is deterministic for the same (observation, seed)', () => {
    const { state } = createSeededState(2, 'ds-determinism');
    const playerID = state.initialFirstPlayer;
    const first = decide(state, playerID, 'same-seed', 1000, 2, 200).decision;
    const second = decide(state, playerID, 'same-seed', 1000, 2, 200).decision;
    // The chosen move is deterministic; wall-clock metadata is not.
    expect(second.move).toEqual(first.move);
    expect(second.policy).toBe(first.policy);
  });

  it('respects the hidden-information invariant (same playerView => same move)', () => {
    const { first, second } = samePlayerViewStates();
    const playerID = '1';
    const firstMove = decide(first, playerID, 'fair-seed', 800, 2, 150).decision
      .move;
    const secondMove = decide(second, playerID, 'fair-seed', 800, 2, 150)
      .decision.move;
    expect(secondMove).toEqual(firstMove);
  });

  it('stays inside the wall-clock budget', () => {
    const { state } = createSeededState(2, 'ds-budget');
    const playerID = state.initialFirstPlayer;
    const startedAt = performance.now();
    const { decision } = decide(state, playerID, 'budget-seed', 250, 3, 10_000);
    const elapsedMs = performance.now() - startedAt;
    expect(decision.nodesVisited).toBeGreaterThan(0);
    // Generous headroom for CI noise: the 250ms budget must not become 2s.
    expect(elapsedMs).toBeLessThan(1_500);
    expect(applyDecision(state, playerID, decision.move)).toBe(true);
  });

  it('supports shared-root SO-MCTS across determinizations', () => {
    const { state } = createSeededState(2, 'ds-somcts');
    const playerID = state.initialFirstPlayer;
    const observation = createObservation(
      createPlayerView(state, playerID),
      playerID,
      ctxFor(state, playerID),
    );
    const run = () =>
      computeDsSearchDecision({
        observation,
        ctx: ctxFor(state, playerID),
        seed: 'ds-somcts-seed',
        weights,
        budget: {
          deadlineEpochMs: performance.now() + 250,
          maxSimulations: 1200,
          determinizations: 3,
          detIndex: 0,
          detCount: 3,
          soMcts: true,
          leafMode: 'best2ply',
          roundRobin: true,
        },
      });
    const first = run();
    const second = run();
    expect(applyDecision(state, playerID, first.decision.move)).toBe(true);
    expect(first.decision.nodesVisited).toBeGreaterThan(0);
    // Deterministic move for the same (observation, seed).
    expect(second.decision.move).toEqual(first.decision.move);
  });
});

describe('predictChildPlayer', () => {
  /**
   * Differential test: for several mid-game states, every enumerated
   * candidate's predicted next-decision player must equal the player that
   * the authoritative simulation actually lands on after the apply.
   */
  it('matches the authoritative simulation for every candidate in mid-game states', () => {
    for (let game = 0; game < 12; game += 1) {
      const { state } = createSeededState(2, `ds-predict-${game}`);
      const playerID = state.initialFirstPlayer;
      const sim0 = createSimulation(structuredClone(state), ctxFor(state, playerID));
      // Play 3-9 full turns with the normal policy to reach varied states.
      const turns = 3 + (game % 7);
      let guard = 0;
      while (sim0.G.result === null && guard < turns * 2) {
        guard += 1;
        const candidate = chooseNormalMove(
          sim0.G,
          sim0.currentPlayer,
          {
            currentPlayer: sim0.currentPlayer,
            playOrder: sim0.playOrder,
            playOrderPos: sim0.playOrderPos,
          },
          `ds-predict-play:${game}:${guard}`,
          weights,
        );
        const [argument] = candidate.move.args;
        const result =
          candidate.move.move === 'mainAction'
            ? applySimulationMainAction(sim0, sim0.currentPlayer, argument as MainAction)
            : candidate.move.move === 'discardTokens'
              ? applySimulationDiscard(sim0, sim0.currentPlayer, argument as TokenCounts)
              : applySimulationNoble(sim0, sim0.currentPlayer, argument as string);
        if (!result.ok) break;
      }
      if (sim0.G.result !== null) continue;
      const current = sim0.currentPlayer;
      const ctx = {
        currentPlayer: current,
        playOrder: sim0.playOrder,
        playOrderPos: sim0.playOrderPos,
      };
      for (const candidate of enumerateLegalActions(sim0.G, current, current)) {
        const predicted = predictChildPlayer(
          sim0.G,
          current,
          ctx,
          candidate.move,
        );
        const sim = createSimulation(structuredClone(sim0.G), ctx);
        const [argument] = candidate.move.args;
        const result =
          candidate.move.move === 'mainAction'
            ? applySimulationMainAction(sim, current, argument as MainAction)
            : candidate.move.move === 'discardTokens'
              ? applySimulationDiscard(sim, current, argument as TokenCounts)
              : applySimulationNoble(sim, current, argument as string);
        expect(result.ok).toBe(true);
        expect(sim.currentPlayer).toBe(predicted);
      }
    }
  });
});
