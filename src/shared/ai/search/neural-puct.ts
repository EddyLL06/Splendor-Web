/**
 * Bounded information-set PUCT (guide §6) over the Bot's own moves.
 *
 * Each tree node is a position at the Bot's turn. The network supplies the
 * policy prior for every node (inference at expansion) and the leaf value.
 * After each Bot move, opponents answer with full Normal turns. K seeded
 * determinizations are searched; root visit counts are aggregated by
 * canonical action key. Wall-clock + simulation caps return best-so-far.
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
import { createObservation } from '../observation.js';
import { createPlayerView } from '../../../game/playerView.js';
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

interface PuctNode {
  sim: SimulationState;
  actions: AIActionCandidate[];
  priors: number[];
  children: Array<PuctNode | null>;
  visits: number;
  totalValue: number;
  expanded: boolean;
  terminalValue: number | null;
}

const softmax = (values: number[]): number[] => {
  const maximum = Math.max(...values);
  const exp = values.map((value) => Math.exp(value - maximum));
  const sum = exp.reduce((total, value) => total + value, 0);
  return exp.map((value) => value / sum);
};

const selectChild = (node: PuctNode): number => {
  const parentVisits = Math.max(1, node.visits);
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < node.actions.length; index += 1) {
    const child = node.children[index];
    const visits = child?.visits ?? 0;
    const q = child && visits > 0 ? child.totalValue / visits : 0;
    const exploration =
      1.4 * node.priors[index] * Math.sqrt(parentVisits) / (1 + visits);
    const score = q + exploration;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
};

const searchDeterminization = async (
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
  const rootPriors = await neural.priorOver(rootActions, observation);
  const root: PuctNode = {
    sim: rootSim,
    actions: rootActions,
    priors: rootPriors,
    children: rootActions.map(() => null),
    visits: 0,
    totalValue: 0,
    expanded: true,
    terminalValue: rootSim.G.result
      ? rootSim.G.result.winners.includes(playerID)
        ? 1_000_000
        : -1_000_000
      : null,
  };

  for (let simulation = 0; simulation < budget.sims; simulation += 1) {
    if (performance.now() >= budget.deadlineEpochMs) break;
    const path: PuctNode[] = [root];
    let node = root;
    let value = 0;

    while (node.expanded && node.terminalValue === null) {
      const index = selectChild(node);
      let child = node.children[index];
      if (!child) {
        // Expand: apply the Bot move, let opponents answer, then evaluate
        // the new Bot-turn position with the network (policy + value).
        const childSim = createSimulation(
          cloneState(node.sim.G),
          ctxOf(node.sim),
        );
        if (
          !applyCandidateFullTurn(
            childSim,
            playerID,
            node.actions[index],
            weights,
            seed,
            simulation,
          )
        ) {
          node.children[index] = null;
          value = -1_000_000;
          break;
        }
        playOpponentsUntilBot(childSim, playerID, weights, seed, simulation);
        const gameResult = childSim.G.result;
        if (gameResult) {
          value = gameResult.winners.includes(playerID)
            ? 1_000_000
            : -1_000_000;
          node.children[index] = {
            sim: childSim,
            actions: [],
            priors: [],
            children: [],
            visits: 0,
            totalValue: 0,
            expanded: true,
            terminalValue: value,
          };
          break;
        }
        const actions = enumerateLegalActions(
          childSim.G,
          playerID,
          childSim.currentPlayer,
        );
        if (actions.length === 0) {
          value = -1_000_000;
          node.children[index] = {
            sim: childSim,
            actions: [],
            priors: [],
            children: [],
            visits: 0,
            totalValue: 0,
            expanded: true,
            terminalValue: value,
          };
          break;
        }
        const priors = await neural.priorOver(actions, observationWith(
          childSim,
          observation,
        ));
        child = {
          sim: childSim,
          actions,
          priors,
          children: actions.map(() => null),
          visits: 0,
          totalValue: 0,
          expanded: true,
          terminalValue: null,
        };
        node.children[index] = child;
        node = child;
        path.push(node);
        value = await neural.value(childSim.G, playerID, ctxOf(childSim));
        break;
      }
      node = child;
      path.push(node);
    }
    if (node.terminalValue !== null) value = node.terminalValue;

    for (const entry of path) {
      entry.visits += 1;
      entry.totalValue += value;
    }
  }
  return rootActions.map((candidate, index) => {
    const child = root.children[index];
    return { visits: child?.visits ?? 0, totalValue: child?.totalValue ?? 0 };
  });
};

const observationWith = (
  sim: SimulationState,
  source: AIObservation,
): AIObservation => {
  return createObservation(
    createPlayerView(sim.G, source.playerID),
    source.playerID,
    ctxOf(sim),
  );
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
  const { observation, ctx, seed, weights, neural, budget = {} } = input;
  const startedAt = performance.now();
  const deadlineEpochMs = budget.deadlineEpochMs ?? performance.now() + 200;
  const simsPerDeterminization = budget.simsPerDeterminization ?? 96;
  const determinizations = budget.determinizations ?? 2;
  const playerID = observation.playerID;

  const aggregate = new Map<string, { visits: number; totalValue: number }>();
  let fallbackMove: BotDecision['move'] | null = null;
  for (
    let determinization = 0;
    determinization < determinizations;
    determinization += 1
  ) {
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
    fallbackMove = rootActions[0].move;
    const totals = await searchDeterminization(
      observation,
      ctx,
      weights,
      seed,
      neural,
      createSimulation(cloneState(fullState), ctx),
      rootActions,
      { sims: simsPerDeterminization, deadlineEpochMs },
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
  for (const [key, entry] of aggregate) {
    if (entry.visits === 0) continue;
    const q = entry.totalValue / entry.visits;
    if (q > bestScore) {
      bestScore = q;
      bestKey = key;
    }
  }
  let bestMove = fallbackMove as BotDecision['move'];
  if (bestKey !== '') {
    const rng = createSeededRNG(`puct:${seed}:0`);
    const fullState = determinize(observation, rng);
    const rootActions = enumerateLegalActions(
      fullState,
      playerID,
      observation.currentPlayer,
    );
    bestMove = rootActions.find(
      (candidate) => candidate.actionKey === bestKey,
    )?.move as BotDecision['move'];
  }
  return {
    move: bestMove,
    modelVersion: 'neural-puct-tree-v1.0.0',
    policy: 'neural-puct-v1',
    seed,
    nodesVisited: aggregate.size,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    timedOut: false,
    fallbackLevel: 0,
  };
};
