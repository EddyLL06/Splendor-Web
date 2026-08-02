/**
 * Expert difficulty: conditional micro-MCTS (DEVELOPMENT_GUIDE.md §9/§15
 * round 5). Runs only when Hard prescores are close: up to 4 seeded
 * determinizations × bounded rollouts, capped at 150 simulations and
 * 120ms. Deterministic per (observation, seed).
 */

import { evaluateWithWeights } from '../evaluate.js';
import { determinize } from '../hidden-information.js';
import { enumerateLegalActions, type AIActionCandidate } from '../legal-actions.js';
import { NoLegalActionError } from '../errors.js';
import { createSeededRNG } from '../seeded-rng.js';
import { chooseNormalMove } from '../policy-normal.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
  type SimulationState,
} from '../simulate.js';
import type { HardDecisionInput } from './beam.js';
import type { BotDecision, SearchBudget } from '../types.js';
import type { PlayerID, SplendorState, MainAction, TokenCounts } from '../../types/game.js';

const cloneState = (state: SplendorState): SplendorState =>
  JSON.parse(JSON.stringify(state)) as SplendorState;

const applyCandidate = (
  sim: SimulationState,
  playerID: PlayerID,
  candidate: AIActionCandidate,
): boolean => {
  const [argument] = candidate.move.args;
  const result =
    candidate.move.move === 'mainAction'
      ? applySimulationMainAction(sim, playerID, argument as MainAction)
      : candidate.move.move === 'discardTokens'
        ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
        : applySimulationNoble(sim, playerID, argument as string);
  return result.ok;
};

const rollout = (
  observation: Parameters<typeof determinize>[0],
  ctx: HardDecisionInput['ctx'],
  playerID: PlayerID,
  candidate: AIActionCandidate,
  weights: Record<string, number>,
  seed: string,
  determinizationIndex: number,
  rolloutIndex: number,
): number => {
  const fullState = determinize(
    observation,
    createSeededRNG(`expert-det:${seed}:${determinizationIndex}`),
  );
  const sim = createSimulation(cloneState(fullState), ctx);
  if (!applyCandidate(sim, playerID, candidate)) {
    return Number.NEGATIVE_INFINITY;
  }
  let guard = 0;
  while (sim.G.result === null && guard < 24) {
    guard += 1;
    const current = sim.currentPlayer;
    const subCtx = {
      currentPlayer: current,
      playOrder: sim.playOrder,
      playOrderPos: sim.playOrderPos,
    };
    const reply = chooseNormalMove(
      sim.G,
      current,
      subCtx,
      `${seed}:${determinizationIndex}:${rolloutIndex}:${guard}`,
      weights,
    );
    if (!applyCandidate(sim, current, reply)) break;
    if (sim.G.result !== null) break;
    // Stop after the Bot's next turn begins.
    if (current === playerID && sim.currentPlayer !== playerID) break;
  }
  return evaluateWithWeights(sim.G, playerID, weights);
};

export const computeExpertDecision = (
  input: HardDecisionInput & {
    maxSimulations?: number;
    maxDeterminizations?: number;
  },
): BotDecision => {
  const {
    observation,
    ctx,
    seed,
    weights,
    budget,
    maxSimulations = 150,
    maxDeterminizations = 4,
  } = input;
  const startedAt = performance.now();
  const rng = createSeededRNG(`expert:${seed}`);
  const fullState = determinize(observation, rng);
  const playerID = observation.playerID;
  const candidates = enumerateLegalActions(
    fullState,
    playerID,
    observation.currentPlayer,
  );
  if (candidates.length === 0) {
    throw new NoLegalActionError(playerID, 0);
  }

  const scored = candidates
    .map((candidate) => {
      const sim = createSimulation(cloneState(fullState), ctx);
      return {
        candidate,
        score: applyCandidate(sim, playerID, candidate)
          ? evaluateWithWeights(sim.G, playerID, weights)
          : Number.NEGATIVE_INFINITY,
      };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);
  if (scored.length === 0) {
    throw new NoLegalActionError(playerID, 0);
  }
  const best = scored[0].score;
  const closeGap = Math.max(1, Math.abs(best) * 0.01);
  const closeCandidates = scored
    .filter((entry) => best - entry.score <= closeGap)
    .slice(0, 3)
    .map((entry) => entry.candidate);
  const effectiveCandidates =
    closeCandidates.length > 1 ? closeCandidates : [scored[0].candidate];

  const determinizations = Math.min(
    maxDeterminizations,
    Math.max(1, Math.floor(maxSimulations / Math.max(1, effectiveCandidates.length))),
  );
  const totals = new Map<string, { sum: number; count: number }>();
  let simulations = 0;
  let timedOut = false;
  for (let determinization = 0; determinization < determinizations; determinization += 1) {
    for (const candidate of effectiveCandidates) {
      if (
        simulations >= maxSimulations ||
        performance.now() >= budget.deadlineEpochMs
      ) {
        timedOut = true;
        break;
      }
      const score = rollout(
        observation,
        ctx,
        playerID,
        candidate,
        weights,
        seed,
        determinization,
        simulations,
      );
      simulations += 1;
      const entry = totals.get(candidate.actionKey) ?? { sum: 0, count: 0 };
      if (Number.isFinite(score)) {
        entry.sum += score;
        entry.count += 1;
      }
      totals.set(candidate.actionKey, entry);
    }
    if (timedOut) break;
  }

  let bestKey = effectiveCandidates[0].actionKey;
  let bestMean = Number.NEGATIVE_INFINITY;
  for (const candidate of effectiveCandidates) {
    const entry = totals.get(candidate.actionKey);
    if (!entry || entry.count === 0) continue;
    const mean = entry.sum / entry.count;
    if (mean > bestMean) {
      bestMean = mean;
      bestKey = candidate.actionKey;
    }
  }
  const bestCandidate =
    effectiveCandidates.find((candidate) => candidate.actionKey === bestKey) ??
    effectiveCandidates[0];

  return {
    move: bestCandidate.move,
    modelVersion: 'ai-kernel-v0.1.0',
    policy: 'expert-v1',
    seed,
    nodesVisited: simulations,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    timedOut,
    fallbackLevel: 0,
  };
};

export type { SearchBudget };
