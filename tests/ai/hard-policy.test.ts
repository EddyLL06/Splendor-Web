import { describe, expect, it } from 'vitest';

import { createPlayerView } from '../../src/game/playerView.js';
import {
  computeHardDecision,
} from '../../src/shared/ai/search/beam.js';
import { chooseBotMove } from '../../src/shared/ai/policy.js';
import { createObservation } from '../../src/shared/ai/observation.js';
import { HAND_TUNED_WEIGHTS } from '../../src/shared/ai/models/default.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from '../../src/shared/ai/simulate.js';
import { AiWorkerPool, workerEntryFor } from '../../src/server/ai/worker-pool.js';
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

const hardDecision = (
  state: SplendorState,
  playerID: string,
  seed: string,
  budgetMs = 80,
) => {
  const observation = createObservation(
    createPlayerView(state, playerID),
    playerID,
    ctxFor(state, playerID),
  );
  return chooseBotMove(observation, ctxFor(state, playerID), {
    policy: 'hard-v1',
    seed,
    weights,
    budgetMs,
  });
};

describe('Hard beam search', () => {
  it('is deterministic per observation and seed', () => {
    const { state } = createSeededState(2, 'hard-det');
    const actor = state.initialFirstPlayer;
    const first = hardDecision(state, actor, 'hard-seed');
    const second = hardDecision(state, actor, 'hard-seed');
    expect(second.move).toEqual(first.move);
    expect(first.policy).toBe('hard-v1');
    expect(first.nodesVisited).toBeGreaterThan(0);
  });

  it('is invariant to hidden truth', () => {
    const { first, second } = samePlayerViewStates();
    expect(hardDecision(second, '1', 'fair', 40).move).toEqual(
      hardDecision(first, '1', 'fair', 40).move,
    );
  });

  it('produces only legal moves and returns best-so-far on tiny budgets', () => {
    for (let index = 0; index < 4; index += 1) {
      const { state } = createSeededState(2, `hard-legal-${index}`);
      const actor = state.initialFirstPlayer;
      const decision = hardDecision(state, actor, `seed-${index}`);
      const sim = createSimulation(structuredClone(state), ctxFor(state, actor));
      const [argument] = decision.move.args;
      const result =
        decision.move.move === 'mainAction'
          ? applySimulationMainAction(sim, actor, argument as MainAction)
          : decision.move.move === 'discardTokens'
            ? applySimulationDiscard(sim, actor, argument as TokenCounts)
            : applySimulationNoble(sim, actor, argument as string);
      expect(result.ok).toBe(true);
    }
    const { state } = createSeededState(2, 'hard-timeout');
    const decision = hardDecision(state, state.initialFirstPlayer, 'tiny', 1);
    expect(decision.move.move).toBeTruthy();
  });

  it('runs through the shared worker pool', async () => {
    const pool = new AiWorkerPool({
      workerCount: 1,
      entry: workerEntryFor(),
      queueLimit: 32,
      hardMaxMs: 80,
    });
    try {
      const { state } = createSeededState(2, 'hard-pool');
      const playerID = state.initialFirstPlayer;
      const observation = createObservation(
        createPlayerView(state, playerID),
        playerID,
        ctxFor(state, playerID),
      );
      const decision = await pool.requestHardDecision({
        observation,
        ctx: ctxFor(state, playerID),
        seed: 'pool-seed',
        weights,
        budget: {
          deadlineEpochMs: performance.now() + 80,
          maxNodes: 800,
          beamWidth: 5,
          maxDeterminizations: 1,
          maxSimulations: 0,
        },
      });
      expect(decision.policy).toBe('hard-v1');
      expect(decision.move.move).toBeTruthy();
      expect(pool.metrics.completedJobs).toBe(1);
    } finally {
      pool.dispose();
    }
  }, 20_000);
});

describe('Expert micro-MCTS', () => {
  const expertDecision = (
    state: SplendorState,
    playerID: string,
    seed: string,
    budgetMs = 120,
  ) => {
    const observation = createObservation(
      createPlayerView(state, playerID),
      playerID,
      ctxFor(state, playerID),
    );
    return chooseBotMove(observation, ctxFor(state, playerID), {
      policy: 'expert-v1',
      seed,
      weights,
      budgetMs,
    });
  };

  it('is deterministic and invariant to hidden truth', () => {
    const { state } = createSeededState(2, 'expert-det');
    const actor = state.initialFirstPlayer;
    expect(expertDecision(state, actor, 'expert-seed').move).toEqual(
      expertDecision(state, actor, 'expert-seed').move,
    );
    const { first, second } = samePlayerViewStates();
    expect(expertDecision(second, '1', 'fair', 60).move).toEqual(
      expertDecision(first, '1', 'fair', 60).move,
    );
  });

  it('produces legal moves under a tight budget', () => {
    const { state } = createSeededState(2, 'expert-legal');
    const actor = state.initialFirstPlayer;
    const decision = expertDecision(state, actor, 'legal', 40);
    const sim = createSimulation(structuredClone(state), ctxFor(state, actor));
    const [argument] = decision.move.args;
    const result =
      decision.move.move === 'mainAction'
        ? applySimulationMainAction(sim, actor, argument as MainAction)
        : decision.move.move === 'discardTokens'
          ? applySimulationDiscard(sim, actor, argument as TokenCounts)
          : applySimulationNoble(sim, actor, argument as string);
    expect(result.ok).toBe(true);
    expect(decision.policy).toBe('expert-v1');
  });
});
