/**
 * Worker Thread entry: loads only the pure AI search code and answers
 * structured-clone decision requests. No server/DB/socket imports.
 *
 * Expert requests run the ds-search engine (PIMC-MCTS, no neural networks)
 * over this worker's determinization slice; the pool merges slices.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { computeHardDecision } from '../../shared/ai/search/beam.js';
import {
  computeDsSearchDecision,
  type DsSearchDecisionInput,
  type DsSearchResult,
} from '../../shared/ai/search/ds-search.js';
import type { HardDecisionInput } from '../../shared/ai/search/beam.js';

interface WorkerConfig {
  expertSims?: number;
  expertDeterminizations?: number;
  expertMaxMs?: number;
}

const config = (workerData ?? {}) as WorkerConfig;

const post = (id: number, payload: {
  result?: unknown;
  error?: string;
}): void => {
  parentPort?.postMessage({ id, ...payload });
};

parentPort?.on(
  'message',
  async (message: {
    id: number;
    mode?: 'hard' | 'expert';
    input: HardDecisionInput | DsSearchDecisionInput;
  }) => {
  try {
    if (message.mode === 'expert') {
      const input = message.input as DsSearchDecisionInput;
      const expertMaxMs = config.expertMaxMs ?? 5000;
      // The deadline sent by the controller can expire while the worker is
      // under CPU pressure or waiting in the queue. Always give the search a
      // fresh full window measured from when it actually starts.
      const effectiveDeadline = Math.max(
        input.budget?.deadlineEpochMs ?? 0,
        performance.now() + expertMaxMs,
      );
      const result: DsSearchResult = computeDsSearchDecision({
        observation: input.observation,
        ctx: input.ctx,
        seed: input.seed,
        weights: input.weights,
        budget: {
          deadlineEpochMs: effectiveDeadline,
          maxSimulations: input.budget?.maxSimulations ?? 200_000,
          determinizations: input.budget?.determinizations ??
            config.expertDeterminizations ?? 9,
          detIndex: input.budget?.detIndex ?? 0,
          detCount: input.budget?.detCount ??
            input.budget?.determinizations ?? 9,
        },
        memory: input.memory,
      });
      post(message.id, { result });
      return;
    }
    post(message.id, {
      result: computeHardDecision(message.input as HardDecisionInput),
    });
  } catch (error) {
    post(message.id, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  },
);
