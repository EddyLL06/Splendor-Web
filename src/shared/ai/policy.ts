/**
 * Round-1 policies: uniform random and cheap greedy
 * (DEVELOPMENT_GUIDE.md §13.2 baselines). Decisions depend only on the
 * observation, the board context, the policy id and the injected seed, so
 * identical playerViews with different hidden truths yield identical moves.
 */

import {
  enumerateLegalActions,
  type AIActionCandidate,
} from './legal-actions.js';
import { scoreCandidate } from './evaluate.js';
import { determinize } from './hidden-information.js';
import {
  assertObservationIntegrity,
  type AIObservation,
} from './observation.js';
import { createSeededRNG } from './seeded-rng.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from './simulate.js';
import type {
  MainAction,
  SplendorState,
  TokenCounts,
} from '../types/game.js';
import type {
  AgentPolicyID,
  BoardContextView,
  BotDecision,
} from './types.js';

export const AI_KERNEL_MODEL_VERSION = 'ai-kernel-v0.1.0';

export class NoLegalActionError extends Error {
  readonly playerID: string;
  readonly stateID: number;

  constructor(playerID: string, stateID: number) {
    super('NO_LEGAL_ACTION');
    this.name = 'NoLegalActionError';
    this.playerID = playerID;
    this.stateID = stateID;
  }
}

export class IllegalCandidateError extends Error {
  constructor(details: string) {
    super(`AI produced an illegal action: ${details}`);
    this.name = 'IllegalCandidateError';
  }
}

const chooseUniformRandom = (
  candidates: AIActionCandidate[],
  seed: string,
): AIActionCandidate => {
  const rng = createSeededRNG(`policy:${seed}`);
  return rng.choice(candidates);
};

const chooseCheapGreedy = (
  state: SplendorState,
  candidates: AIActionCandidate[],
  playerID: string,
  ctx: BoardContextView,
  seed: string,
): AIActionCandidate => {
  const rng = createSeededRNG(`policy:${seed}`);
  let bestScore = Number.NEGATIVE_INFINITY;
  let best: AIActionCandidate[] = [];
  for (const candidate of candidates) {
    const score = scoreCandidate(state, playerID, ctx, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = [candidate];
    } else if (score === bestScore) {
      best.push(candidate);
    }
  }
  return rng.choice(best);
};

const validateMove = (
  state: SplendorState,
  playerID: string,
  ctx: BoardContextView,
  decision: BotDecision,
): void => {
  const [argument] = decision.move.args;
  const sim = createSimulation(
    JSON.parse(JSON.stringify(state)) as SplendorState,
    ctx,
  );
  const result =
    decision.move.move === 'mainAction'
      ? applySimulationMainAction(sim, playerID, argument as MainAction)
      : decision.move.move === 'discardTokens'
        ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
        : applySimulationNoble(sim, playerID, argument as string);
  if (!result.ok) {
    throw new IllegalCandidateError(
      `${decision.move.move}: ${result.errors
        .map((error) => error.code)
        .join(', ')}`,
    );
  }
};

export const chooseBotMove = (
  observation: AIObservation,
  ctx: BoardContextView,
  options: { policy: AgentPolicyID; seed: string },
): BotDecision => {
  const startedAt = performance.now();
  assertObservationIntegrity(observation);

  const rng = createSeededRNG(`kernel:${options.seed}`);
  const fullState = determinize(observation, rng);
  const candidates = enumerateLegalActions(
    fullState,
    observation.playerID,
    observation.currentPlayer,
  );
  if (candidates.length === 0) {
    throw new NoLegalActionError(observation.playerID, 0);
  }

  const selected =
    options.policy === 'uniform-random-v1'
      ? chooseUniformRandom(candidates, options.seed)
      : chooseCheapGreedy(
          fullState,
          candidates,
          observation.playerID,
          ctx,
          options.seed,
        );

  const decision: BotDecision = {
    move: selected.move,
    modelVersion: AI_KERNEL_MODEL_VERSION,
    policy: options.policy,
    seed: options.seed,
    nodesVisited: options.policy === 'uniform-random-v1' ? 1 : candidates.length,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    timedOut: false,
    fallbackLevel: 0,
  };
  validateMove(fullState, observation.playerID, ctx, decision);
  return decision;
};

/**
 * Easy difficulty: score every candidate cheaply, keep the top 8, and pick
 * one with seeded weighted randomness. Deterministic per (observation, seed).
 */
export const chooseEasyBotMove = (
  observation: AIObservation,
  ctx: BoardContextView,
  options: { seed: string },
): BotDecision => {
  const startedAt = performance.now();
  assertObservationIntegrity(observation);

  const rng = createSeededRNG(`kernel:${options.seed}`);
  const fullState = determinize(observation, rng);
  const candidates = enumerateLegalActions(
    fullState,
    observation.playerID,
    observation.currentPlayer,
  );
  if (candidates.length === 0) {
    throw new NoLegalActionError(observation.playerID, 0);
  }

  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(fullState, observation.playerID, ctx, candidate),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
  const pickRng = createSeededRNG(`easy:${options.seed}`);
  const total = scored.reduce(
    (sum, entry) => sum + Math.max(1, entry.score + 200),
    0,
  );
  let roll = pickRng.next() * total;
  let selected = scored[scored.length - 1].candidate;
  for (const entry of scored) {
    roll -= Math.max(1, entry.score + 200);
    if (roll <= 0) {
      selected = entry.candidate;
      break;
    }
  }

  const decision: BotDecision = {
    move: selected.move,
    modelVersion: AI_KERNEL_MODEL_VERSION,
    policy: 'easy-v1',
    seed: options.seed,
    nodesVisited: candidates.length,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    timedOut: false,
    fallbackLevel: 0,
  };
  validateMove(fullState, observation.playerID, ctx, decision);
  return decision;
};
