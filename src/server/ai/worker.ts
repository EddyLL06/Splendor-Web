/**
 * Worker Thread entry: loads only the pure AI search code and answers
 * structured-clone Hard decision requests. No server/DB/socket imports.
 */

import { parentPort } from 'node:worker_threads';

import { computeHardDecision } from '../../shared/ai/search/beam.js';
import { computeExpertDecision } from '../../shared/ai/search/micro-mcts.js';
import type { HardDecisionInput } from '../../shared/ai/search/beam.js';
import type { ExpertMemorySnapshot } from '../../shared/ai/memory.js';

parentPort?.on(
  'message',
  (message: {
    id: number;
    mode?: 'hard' | 'expert';
    input: HardDecisionInput & { memory?: ExpertMemorySnapshot };
  }) => {
  try {
    const decision =
      message.mode === 'expert'
        ? computeExpertDecision(message.input)
        : computeHardDecision(message.input);
    parentPort?.postMessage({ id: message.id, result: decision });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  },
);
