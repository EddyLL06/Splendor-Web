/**
 * Worker Thread entry: loads only the pure AI search code and answers
 * structured-clone Hard decision requests. No server/DB/socket imports.
 */

import { parentPort } from 'node:worker_threads';

import { computeHardDecision } from '../../shared/ai/search/beam.js';
import type { HardDecisionInput } from '../../shared/ai/search/beam.js';

parentPort?.on('message', (message: { id: number; input: HardDecisionInput }) => {
  try {
    const decision = computeHardDecision(message.input);
    parentPort?.postMessage({ id: message.id, result: decision });
  } catch (error) {
    parentPort?.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
