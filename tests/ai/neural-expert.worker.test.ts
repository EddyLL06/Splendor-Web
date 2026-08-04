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
import { AiWorkerPool, workerEntryFor } from '../../src/server/ai/worker-pool.js';
import type {
  MainAction,
  SplendorState,
  TokenCounts,
} from '../../src/shared/types/game.js';
import type { BoardContextView } from '../../src/shared/ai/types.js';
import { createSeededState } from './helpers.js';

const weights = { ...HAND_TUNED_WEIGHTS } as unknown as Record<string, number>;
const MODEL_PATH = 'ai_bot/models/neural/policy-attn-v3.onnx';

const ctxFor = (state: SplendorState, playerID: string): BoardContextView => ({
  currentPlayer: state.initialFirstPlayer,
  playOrder: state.playerOrder,
  playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
});

describe('neural Expert via shared worker pool', () => {
  it('loads the bundled ONNX model and returns a legal neural-puct move', async () => {
    const pool = new AiWorkerPool({
      workerCount: 1,
      entry: workerEntryFor(),
      queueLimit: 32,
      // Generous watchdog: the worker loads the ONNX model on boot, and
      // this test requests immediately after pool creation (worst case).
      hardMaxMs: 3000,
      workerData: {
        expertEnabled: true,
        neuralModelPath: MODEL_PATH,
        expertSims: 8,
        expertDeterminizations: 1,
        expertMaxMs: 3000,
      },
    });
    try {
      const { state } = createSeededState(2, 'neural-expert-pool');
      const playerID = state.initialFirstPlayer;
      const observation = createObservation(
        createPlayerView(state, playerID),
        playerID,
        ctxFor(state, playerID),
      );
      const decision = await pool.requestExpertDecision({
        observation,
        ctx: ctxFor(state, playerID),
        seed: 'neural-expert-seed',
        weights,
        budget: {
          deadlineEpochMs: performance.now() + 3000,
          maxNodes: 1600,
          beamWidth: 5,
          maxDeterminizations: 1,
          maxSimulations: 0,
        },
      });
      expect(decision.policy).toBe('neural-puct-v1');
      expect(decision.move.move).toBeTruthy();
      const sim = createSimulation(
        structuredClone(state),
        ctxFor(state, playerID),
      );
      const [argument] = decision.move.args;
      const result =
        decision.move.move === 'mainAction'
          ? applySimulationMainAction(sim, playerID, argument as MainAction)
          : decision.move.move === 'discardTokens'
            ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
            : applySimulationNoble(sim, playerID, argument as string);
      expect(result.ok).toBe(true);
      expect(pool.metrics.completedJobs).toBe(1);
    } finally {
      pool.dispose();
    }
  }, 30_000);
});
