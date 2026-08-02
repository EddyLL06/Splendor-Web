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
import { evaluateWithWeights } from './evaluate.js';
import { computeHardDecision } from './search/beam.js';
import { computeExpertDecision } from './search/micro-mcts.js';
import { chooseNormalMove } from './policy-normal.js';
import {
  IllegalCandidateError,
  NoLegalActionError,
} from './errors.js';
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
export { IllegalCandidateError, NoLegalActionError } from './errors.js';

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
  options: {
    policy: AgentPolicyID;
    seed: string;
    weights?: Record<string, number>;
    budgetMs?: number;
  },
): BotDecision => {
  const startedAt = performance.now();
  assertObservationIntegrity(observation);

  const rng = createSeededRNG(`kernel:${options.seed}`);
  const fullState = determinize(observation, rng);
  if (options.policy === 'hard-v1') {
    const decision = computeHardDecision({
      observation,
      ctx,
      seed: options.seed,
      weights: options.weights ?? {},
      budget: {
        deadlineEpochMs: performance.now() + (options.budgetMs ?? 80),
        maxNodes: 800,
        beamWidth: 5,
        maxDeterminizations: 1,
        maxSimulations: 0,
      },
    });
    validateMove(fullState, observation.playerID, ctx, decision);
    return decision;
  }
  if (options.policy === 'expert-v1') {
    const decision = computeExpertDecision({
      observation,
      ctx,
      seed: options.seed,
      weights: options.weights ?? {},
      budget: {
        deadlineEpochMs: performance.now() + (options.budgetMs ?? 120),
        maxNodes: 800,
        beamWidth: 3,
        maxDeterminizations: 4,
        maxSimulations: 150,
      },
    });
    validateMove(fullState, observation.playerID, ctx, decision);
    return decision;
  }
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
      : options.policy === 'cheap-greedy-v1'
        ? chooseCheapGreedy(
            fullState,
            candidates,
            observation.playerID,
            ctx,
            options.seed,
          )
        : chooseNormalMove(
            fullState,
            observation.playerID,
            ctx,
            options.seed,
            options.weights,
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
