/**
 * Bounded information-set PUCT for the neural policy (guide §6).
 *
 * Each simulation selects a root Bot move with UCB using the network prior,
 * plays the Bot's subsequent turns with the Normal policy, lets opponents
 * answer with full Normal turns, and scores the leaf with the network value
 * head. K seeded determinizations are searched and root visit counts are
 * aggregated by canonical action key. Wall-clock + simulation caps return
 * the best-so-far root action.
 */

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
import type { NeuralPolicy } from '../neural/inference.js';
import type { AIObservation } from '../observation.js';
import type {
  BoardContextView,
  BotDecision,
} from '../types.js';
import type {
  MainAction,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../../types/game.js';

const cloneState = (state: SplendorState): SplendorState =>
  JSON.parse(JSON.stringify(state)) as SplendorState;

const ctxOf = (sim: SimulationState): BoardContextView => ({
  currentPlayer: sim.currentPlayer,
  playOrder: sim.playOrder,
  playOrderPos: sim.playOrderPos,
});

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

const applyCandidateFullTurn = (
  sim: SimulationState,
  playerID: PlayerID,
  candidate: AIActionCandidate,
  weights: Record<string, number>,
  seed: string,
  step: number,
): boolean => {
  if (!applyCandidate(sim, playerID, candidate)) return false;
  let guard = 0;
  while (
    sim.G.result === null &&
    sim.G.pending !== null &&
    sim.G.pending.playerID === playerID &&
    guard < 4
  ) {
    guard += 1;
    const reply = chooseNormalMove(
      sim.G,
      playerID,
      ctxOf(sim),
      `${seed}:resolve:${step}:${guard}`,
      weights,
    );
    if (!applyCandidate(sim, playerID, reply)) return false;
  }
  return sim.G.pending === null || sim.G.pending.playerID !== playerID;
};

const playOneFullTurn = (
  sim: SimulationState,
  playerID: PlayerID,
  weights: Record<string, number>,
  seed: string,
  step: number,
): void => {
  let guard = 0;
  while (sim.G.result === null && guard < 8) {
    guard += 1;
    const candidate = chooseNormalMove(
      sim.G,
      playerID,
      ctxOf(sim),
      `${seed}:opp:${step}:${guard}`,
      weights,
    );
    if (!applyCandidate(sim, playerID, candidate)) {
      throw new Error(`PUCT opponent produced an illegal move: ${playerID}`);
    }
    if (sim.currentPlayer !== playerID) return;
    if (sim.G.pending === null && sim.G.turnReady) return;
  }
};

const playOpponentsUntilBot = (
  sim: SimulationState,
  botID: PlayerID,
  weights: Record<string, number>,
  seed: string,
  step: number,
): void => {
  let guard = 0;
  while (
    sim.G.result === null &&
    sim.currentPlayer !== botID &&
    guard < sim.playOrder.length * 4
  ) {
    guard += 1;
    playOneFullTurn(sim, sim.currentPlayer, weights, seed, step);
  }
};

const softmax = (values: number[]): number[] => {
  const maximum = Math.max(...values);
  const exp = values.map((value) => Math.exp(value - maximum));
  const sum = exp.reduce((total, value) => total + value, 0);
  return exp.map((value) => value / sum);
};

const searchOnce = async (
  observation: AIObservation,
  ctx: BoardContextView,
  weights: Record<string, number>,
  seed: string,
  neural: NeuralPolicy,
  rootSim: SimulationState,
  rootActions: AIActionCandidate[],
  budget: { sims: number; deadlineEpochMs: number },
): Promise<{ visits: number; totalValue: number }[]> => {
  const playerID = observation.playerID;
  const rootPrior = await neural.priorOver(rootActions, observation);
  const totals = rootActions.map(() => ({ visits: 0, totalValue: 0 }));

  for (let simulation = 0; simulation < budget.sims; simulation += 1) {
    if (performance.now() >= budget.deadlineEpochMs) break;
    // UCB selection among root actions (network prior as exploration bonus).
    const parentVisits = Math.max(
      1,
      totals.reduce((sum, entry) => sum + entry.visits, 0),
    );
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < rootActions.length; index += 1) {
      const entry = totals[index];
      const q = entry.visits > 0 ? entry.totalValue / entry.visits : 0;
      const exploration =
        1.4 * rootPrior[index] *
        Math.sqrt(parentVisits) / (1 + entry.visits);
      const score = q + exploration;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    // Play the line: root move, opponents, then Normal bot turns up to the
    // depth limit, then the network value at the leaf.
    let lineSim = createSimulation(
      cloneState(rootSim.G),
      ctxOf(rootSim),
    );
    let depth = 0;
    let leafValue = 0;
    if (
      !applyCandidateFullTurn(
        lineSim,
        playerID,
        rootActions[bestIndex],
        weights,
        seed,
        simulation,
      )
    ) {
      continue;
    }
    playOpponentsUntilBot(lineSim, playerID, weights, seed, simulation);
    depth = 1;
    while (
      lineSim.G.result === null &&
      depth < 3 &&
      lineSim.currentPlayer === playerID
    ) {
      const reply = chooseNormalMove(
        lineSim.G,
        playerID,
        ctxOf(lineSim),
        `${seed}:rollout:${simulation}:${depth}`,
        weights,
      );
      if (!applyCandidateFullTurn(lineSim, playerID, reply, weights, seed, depth)) {
        break;
      }
      playOpponentsUntilBot(lineSim, playerID, weights, seed, depth);
      depth += 1;
    }
    if (lineSim.G.result !== null) {
      leafValue = lineSim.G.result.winners.includes(playerID)
        ? 1_000_000
        : -1_000_000;
    } else {
      leafValue = await neural.value(lineSim.G, playerID, ctxOf(lineSim));
    }
    totals[bestIndex].visits += 1;
    totals[bestIndex].totalValue += leafValue;
  }
  return totals;
};

export const computeNeuralPuctDecision = async (
  input: {
    observation: AIObservation;
    ctx: BoardContextView;
    seed: string;
    weights: Record<string, number>;
    neural: NeuralPolicy;
    budget?: {
      deadlineEpochMs?: number;
      simsPerDeterminization?: number;
      determinizations?: number;
    };
  },
): Promise<BotDecision> => {
  const {
    observation,
    ctx,
    seed,
    weights,
    neural,
    budget = {},
  } = input;
  const startedAt = performance.now();
  const deadlineEpochMs = budget.deadlineEpochMs ?? performance.now() + 150;
  const simsPerDeterminization = budget.simsPerDeterminization ?? 96;
  const determinizations = budget.determinizations ?? 2;
  const playerID = observation.playerID;

  const aggregate = new Map<string, { visits: number; totalValue: number }>();
  for (let determinization = 0; determinization < determinizations; determinization += 1) {
    if (performance.now() >= deadlineEpochMs) break;
    const rng = createSeededRNG(`puct:${seed}:${determinization}`);
    const fullState = determinize(observation, rng);
    const rootActions = enumerateLegalActions(
      fullState,
      playerID,
      observation.currentPlayer,
    );
    if (rootActions.length === 0) {
      if (aggregate.size === 0) throw new NoLegalActionError(playerID, 0);
      break;
    }
    const rootSim = createSimulation(cloneState(fullState), ctx);
    const totals = await searchOnce(
      observation,
      ctx,
      weights,
      seed,
      neural,
      rootSim,
      rootActions,
      {
        sims: simsPerDeterminization,
        deadlineEpochMs,
      },
    );
    rootActions.forEach((candidate, index) => {
      const entry = aggregate.get(candidate.actionKey) ?? {
        visits: 0,
        totalValue: 0,
      };
      entry.visits += totals[index].visits;
      entry.totalValue += totals[index].totalValue;
      aggregate.set(candidate.actionKey, entry);
    });
  }
  if (aggregate.size === 0) {
    throw new NoLegalActionError(playerID, 0);
  }

  let bestKey = '';
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestMove = null as unknown as BotDecision['move'];
  for (const [key, entry] of aggregate) {
    if (entry.visits === 0) continue;
    const q = entry.totalValue / entry.visits;
    if (q > bestScore) {
      bestScore = q;
      bestKey = key;
    }
  }
  if (bestKey === '') {
    // No visits (deadline hit immediately): fall back to root prior.
    const rng = createSeededRNG(`puct:${seed}:0`);
    const fullState = determinize(observation, rng);
    const rootActions = enumerateLegalActions(
      fullState,
      playerID,
      observation.currentPlayer,
    );
    const prior = await neural.priorOver(rootActions, observation);
    const bestIndex = prior.indexOf(Math.max(...prior));
    bestMove = rootActions[bestIndex].move;
  } else {
    for (const [key, entry] of aggregate) {
      if (key === bestKey) {
        const rng = createSeededRNG(`puct:${seed}:0`);
        const fullState = determinize(observation, rng);
        const rootActions = enumerateLegalActions(
          fullState,
          playerID,
          observation.currentPlayer,
        );
        bestMove = rootActions.find(
          (candidate) => candidate.actionKey === key,
        )?.move as BotDecision['move'];
        break;
      }
    }
  }
  return {
    move: bestMove,
    modelVersion: 'neural-puct-v1.0.0',
    policy: 'neural-puct-v1',
    seed,
    nodesVisited: aggregate.size,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    timedOut: false,
    fallbackLevel: 0,
  };
};
