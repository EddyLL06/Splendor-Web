/**
 * Normal 1-ply move selection shared by the Normal policy and Hard search
 * (opponent model). Pure function of (state, playerID, ctx, seed, weights).
 */

import { evaluateWithWeights } from './evaluate.js';
import {
  enumerateLegalActions,
  type AIActionCandidate,
} from './legal-actions.js';
import { createSeededRNG } from './seeded-rng.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from './simulate.js';
import type { BoardContextView } from './types.js';
import type {
  MainAction,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../types/game.js';

export const chooseNormalMove = (
  state: SplendorState,
  playerID: PlayerID,
  ctx: BoardContextView,
  seed: string,
  weights: Record<string, number> | undefined,
): AIActionCandidate => {
  const candidates = enumerateLegalActions(state, playerID, ctx.currentPlayer);
  const rng = createSeededRNG(`policy:${seed}`);
  let bestScore = Number.NEGATIVE_INFINITY;
  let best: AIActionCandidate[] = [];
  for (const candidate of candidates) {
    const [argument] = candidate.move.args;
    const sim = createSimulation(
      JSON.parse(JSON.stringify(state)) as SplendorState,
      ctx,
    );
    const result =
      candidate.move.move === 'mainAction'
        ? applySimulationMainAction(sim, playerID, argument as MainAction)
        : candidate.move.move === 'discardTokens'
          ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
          : applySimulationNoble(sim, playerID, argument as string);
    const score = result.ok
      ? evaluateWithWeights(sim.G, playerID, weights ?? {})
      : Number.NEGATIVE_INFINITY;
    if (score > bestScore) {
      bestScore = score;
      best = [candidate];
    } else if (score === bestScore) {
      best.push(candidate);
    }
  }
  return rng.choice(best);
};
