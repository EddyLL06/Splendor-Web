/**
 * Worker Thread entry: loads only the pure AI search code and answers
 * structured-clone Hard decision requests. No server/DB/socket imports.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { computeHardDecision } from '../../shared/ai/search/beam.js';
import { computeExpertDecision } from '../../shared/ai/search/micro-mcts.js';
import { computeNeuralPuctDecision } from '../../shared/ai/search/neural-puct.js';
import { NeuralPolicy } from '../../shared/ai/neural/inference.js';
import type { HardDecisionInput } from '../../shared/ai/search/beam.js';
import type { ExpertMemorySnapshot } from '../../shared/ai/memory.js';

interface WorkerConfig {
  expertEnabled?: boolean;
  neuralModelPath?: string;
  expertSims?: number;
  expertDeterminizations?: number;
  expertMaxMs?: number;
}

const config = (workerData ?? {}) as WorkerConfig;

let neuralPromise: Promise<NeuralPolicy | undefined> | undefined;
let neuralLoadError: string | undefined;
let neuralLoadLogged = false;

// Start loading the model as soon as the worker boots so the first Expert
// move does not pay the load latency inside its search deadline.
if (config.expertEnabled && config.neuralModelPath) {
  neuralPromise = NeuralPolicy.load(config.neuralModelPath)
    .then((policy) => policy)
    .catch((error: unknown) => {
      neuralLoadError = error instanceof Error ? error.message : String(error);
      if (!neuralLoadLogged) {
        neuralLoadLogged = true;
        console.error(`[ai-worker] neural expert model unavailable: ${neuralLoadError}`);
      }
      return undefined;
    });
}

const getNeuralPolicy = (): Promise<NeuralPolicy | undefined> =>
  neuralPromise ?? Promise.resolve(undefined);

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
    input: HardDecisionInput & { memory?: ExpertMemorySnapshot };
  }) => {
  try {
    if (message.mode === 'expert') {
      const neural = await getNeuralPolicy();
      const expertMaxMs = config.expertMaxMs ?? 3000;
      // The deadline sent by the controller can expire while the model is
      // loading or under CPU pressure. Always give the search a fresh full
      // window measured from when it actually starts.
      const effectiveDeadline = Math.max(
        message.input.budget?.deadlineEpochMs ?? 0,
        performance.now() + expertMaxMs,
      );
      if (neural) {
        try {
          const decision = await computeNeuralPuctDecision({
            observation: message.input.observation,
            ctx: message.input.ctx,
            seed: message.input.seed,
            weights: message.input.weights,
            neural,
            mode: 'bot-tree',
            budget: {
              deadlineEpochMs: effectiveDeadline,
              simsPerDeterminization: config.expertSims ?? 96,
              determinizations: config.expertDeterminizations ?? 2,
            },
          });
          post(message.id, { result: decision });
          return;
        } catch {
          // Neural search failed: fall back to the heuristic Expert below.
        }
      }
      const decision = {
        ...computeExpertDecision({
          ...message.input,
          budget: {
            ...message.input.budget,
            deadlineEpochMs: effectiveDeadline,
          },
        }),
        fallbackLevel: 2 as const,
      };
      post(message.id, { result: decision });
      return;
    }
    post(message.id, { result: computeHardDecision(message.input) });
  } catch (error) {
    post(message.id, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  },
);
