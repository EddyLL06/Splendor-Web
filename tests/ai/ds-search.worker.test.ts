/// <reference types="node" />

import { describe, expect, it } from 'vitest';

import { createPlayerView } from '../../src/game/playerView.js';
import { createObservation } from '../../src/shared/ai/observation.js';
import { HAND_TUNED_WEIGHTS } from '../../src/shared/ai/models/default.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from '../../src/shared/ai/simulate.js';
import {
  AiWorkerPool,
  mergeDsSearchResults,
  workerEntryFor,
} from '../../src/server/ai/worker-pool.js';
import type {
  MainAction,
  SplendorState,
  TokenCounts,
} from '../../src/shared/types/game.js';
import type { BoardContextView } from '../../src/shared/ai/types.js';
import { createSeededState } from './helpers.js';

const weights = { ...HAND_TUNED_WEIGHTS } as unknown as Record<string, number>;

const ctxFor = (state: SplendorState, playerID: string): BoardContextView => ({
  currentPlayer: state.initialFirstPlayer,
  playOrder: state.playerOrder,
  playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
});

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

describe('ds-search Expert via shared worker pool', () => {
  it('runs the ds-search engine in one worker and returns a legal move', async () => {
    const pool = new AiWorkerPool({
      workerCount: 1,
      entry: workerEntryFor(),
      queueLimit: 32,
      hardMaxMs: 100,
      expertMaxMs: 2_000,
      workerData: {
        expertSims: 300,
        expertDeterminizations: 2,
        expertMaxMs: 2_000,
      },
    });
    try {
      const { state } = createSeededState(2, 'ds-worker-pool');
      const playerID = state.initialFirstPlayer;
      const observation = createObservation(
        createPlayerView(state, playerID),
        playerID,
        ctxFor(state, playerID),
      );
      const decision = await pool.requestExpertDecision({
        observation,
        ctx: ctxFor(state, playerID),
        seed: 'ds-worker-seed',
        weights,
        budget: {
          deadlineEpochMs: performance.now() + 1_500,
          maxSimulations: 300,
          maxDeterminizations: 2,
        },
      });
      expect(decision.policy).toBe('ds-search-v1');
      expect(decision.move.move).toBeTruthy();
      expect(applyDecision(state, playerID, decision.move)).toBe(true);
      expect(pool.metrics.completedJobs).toBe(1);
    } finally {
      pool.dispose();
    }
  }, 30_000);

  it('splits determinizations across two workers and merges a legal move', async () => {
    const pool = new AiWorkerPool({
      workerCount: 2,
      entry: workerEntryFor(),
      queueLimit: 32,
      hardMaxMs: 100,
      expertMaxMs: 2_000,
      workerData: {
        expertSims: 300,
        expertDeterminizations: 4,
        expertMaxMs: 2_000,
      },
    });
    try {
      const { state } = createSeededState(2, 'ds-worker-split');
      const playerID = state.initialFirstPlayer;
      const observation = createObservation(
        createPlayerView(state, playerID),
        playerID,
        ctxFor(state, playerID),
      );
      const decision = await pool.requestExpertDecision({
        observation,
        ctx: ctxFor(state, playerID),
        seed: 'ds-worker-split-seed',
        weights,
        budget: {
          deadlineEpochMs: performance.now() + 1_500,
          maxSimulations: 600,
          maxDeterminizations: 4,
        },
      });
      expect(decision.policy).toBe('ds-search-v1');
      expect(applyDecision(state, playerID, decision.move)).toBe(true);
      expect(pool.metrics.completedJobs).toBe(2);
    } finally {
      pool.dispose();
    }
  }, 30_000);
});

describe('mergeDsSearchResults', () => {
  it('picks the action with the highest merged mean value', () => {
    const mk = (actionKey: string, visits: number, valueSum: number) => ({
      actionKey,
      visits,
      valueSum,
    });
    const mkDecision = (move: { move: 'chooseNoble'; args: [string] }) => ({
      decision: {
        move,
        modelVersion: 'ai-kernel-ds-v1.0.0',
        policy: 'ds-search-v1' as const,
        seed: 's',
        nodesVisited: 10,
        elapsedMs: 1,
        timedOut: false,
        fallbackLevel: 0 as const,
      },
      stats: [
        mk('a', 10, 5),
        mk('b', 10, 8),
      ],
      movesByKey: {
        a: { move: 'chooseNoble' as const, args: ['n1'] as [string] },
        b: { move: 'chooseNoble' as const, args: ['n2'] as [string] },
      },
    });
    const merged = mergeDsSearchResults(
      [mkDecision({ move: 'chooseNoble', args: ['n1'] }), mkDecision({ move: 'chooseNoble', args: ['n2'] })],
      'merge-seed',
    );
    expect(merged.policy).toBe('ds-search-v1');
    // b has 20 visits / valueSum 16 (mean 0.8) vs a 20 visits / 10 (0.5).
    expect(merged.move).toEqual({ move: 'chooseNoble', args: ['n2'] });
    expect(merged.nodesVisited).toBe(20);
  });
});
