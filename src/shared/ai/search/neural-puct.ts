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
import type { NeuralPolicyLike } from '../neural/inference.js';
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
  playerToMove: PlayerID;
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

/**
 * Negamax-aware child selection for alternating trees: every node stores
 * values in its own player's perspective, so the Q term for a child (which
 * is the opponent's node) must be negated at selection time.
 */
const selectChildNegamax = (node: PuctNode): number => {
  const parentVisits = Math.max(1, node.visits);
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < node.actions.length; index += 1) {
    const child = node.children[index];
    const visits = child?.visits ?? 0;
    const q = child && visits > 0 ? -child.totalValue / visits : 0;
    const exploration =
      2.0 * node.priors[index] * Math.sqrt(parentVisits) / (1 + visits);
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
  neural: NeuralPolicyLike,
  rootSim: SimulationState,
  rootActions: AIActionCandidate[],
  budget: { sims: number; deadlineEpochMs: number },
): Promise<{ visits: number; totalValue: number }[]> => {
  const playerID = observation.playerID;
  const rootPriors = await neural.priorOver(rootActions, observation);
  const root: PuctNode = {
    sim: rootSim,
    playerToMove: playerID,
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
            playerToMove: playerID,
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
            playerToMove: playerID,
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
          playerToMove: playerID,
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

const observationFor = (
  sim: SimulationState,
  playerID: PlayerID,
): AIObservation =>
  createObservation(
    createPlayerView(sim.G, playerID),
    playerID,
    ctxOf(sim),
  );

/**
 * Network value after a short Normal-policy rollout (up to two extra full
 * turns), so the undertrained value head sees a deeper, more informative
 * position. The final value is taken from the resulting state's current
 * player's perspective (negamax backup converts it).
 */
const rolloutValue = async (
  sim: SimulationState,
  weights: Record<string, number>,
  seed: string,
  neural: NeuralPolicyLike,
): Promise<number> => {
  let valueSim = createSimulation(cloneState(sim.G), ctxOf(sim));
  for (let roll = 0; roll < 2; roll += 1) {
    if (valueSim.G.result !== null) break;
    const mover = valueSim.currentPlayer;
    const reply = chooseNormalMove(
      valueSim.G,
      mover,
      ctxOf(valueSim),
      `${seed}:roll:${roll}`,
      weights,
    );
    if (!applyCandidateFullTurn(valueSim, mover, reply, weights, seed, roll)) {
      break;
    }
  }
  const gameResult = valueSim.G.result;
  if (gameResult) {
    return gameResult.winners.includes(valueSim.currentPlayer)
      ? 1_000_000
      : -1_000_000;
  }
  const leafPlayer = valueSim.currentPlayer;
  return neural.value(valueSim.G, leafPlayer, ctxOf(valueSim));
};

/**
 * Two-player alternating PUCT: both sides use the network policy as prior
 * and the network value at leaves; backups use negamax sign conversion so
 * every node keeps values in its own player's perspective.
 */
const searchAlternating = async (
  observation: AIObservation,
  ctx: BoardContextView,
  weights: Record<string, number>,
  seed: string,
  neural: NeuralPolicyLike,
  rootSim: SimulationState,
  rootActions: AIActionCandidate[],
  budget: { sims: number; deadlineEpochMs: number },
): Promise<{ visits: number; totalValue: number }[]> => {
  const botID = observation.playerID;
  const rootPriors = await neural.priorOver(rootActions, observation);
  const root: PuctNode = {
    sim: rootSim,
    playerToMove: botID,
    actions: rootActions,
    priors: rootPriors,
    children: rootActions.map(() => null),
    visits: 0,
    totalValue: 0,
    expanded: true,
    terminalValue: rootSim.G.result
      ? rootSim.G.result.winners.includes(botID)
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
      const index = selectChildNegamax(node);
      let child = node.children[index];
      if (!child) {
        const childSim = createSimulation(
          cloneState(node.sim.G),
          ctxOf(node.sim),
        );
        if (
          !applyCandidateFullTurn(
            childSim,
            node.playerToMove,
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
        const gameResult = childSim.G.result;
        if (gameResult) {
          const currentPlayer = childSim.currentPlayer;
          value = gameResult.winners.includes(currentPlayer)
            ? 1_000_000
            : -1_000_000;
          const terminalChild: PuctNode = {
            sim: childSim,
            playerToMove: currentPlayer,
            actions: [],
            priors: [],
            children: [],
            visits: 0,
            totalValue: 0,
            expanded: true,
            terminalValue: value,
          };
          node.children[index] = terminalChild;
          node = terminalChild;
          path.push(node);
          break;
        }
        const nextPlayer = childSim.currentPlayer;
        const actions = enumerateLegalActions(
          childSim.G,
          nextPlayer,
          childSim.currentPlayer,
        );
        if (actions.length === 0) {
          value = -1_000_000;
          const terminalChild: PuctNode = {
            sim: childSim,
            playerToMove: nextPlayer,
            actions: [],
            priors: [],
            children: [],
            visits: 0,
            totalValue: 0,
            expanded: true,
            terminalValue: value,
          };
          node.children[index] = terminalChild;
          node = terminalChild;
          path.push(node);
          break;
        }
        const nextObservation = observationFor(childSim, nextPlayer);
        const priors = await neural.priorOver(actions, nextObservation);
        child = {
          sim: childSim,
          playerToMove: nextPlayer,
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
        value = await rolloutValue(childSim, weights, seed, neural);
        break;
      }
      node = child;
      path.push(node);
    }
    if (node.terminalValue !== null) value = node.terminalValue;

    // Negamax backup: convert the leaf value into each ancestor's
    // perspective as we walk up.
    let currentPlayer = node.playerToMove;
    for (let pathIndex = path.length - 1; pathIndex >= 0; pathIndex -= 1) {
      const entry = path[pathIndex];
      if (entry.playerToMove !== currentPlayer) {
        value = -value;
        currentPlayer = entry.playerToMove;
      }
      entry.visits += 1;
      entry.totalValue += value;
    }
  }
  return rootActions.map((candidate, index) => {
    const child = root.children[index];
    // Children are opponent nodes storing values in the opponent's
    // perspective; convert to the root (Bot) perspective for aggregation.
    return {
      visits: child?.visits ?? 0,
      totalValue: child ? -child.totalValue : 0,
    };
  });
};

export const computeNeuralPuctDecision = async (
  input: {
    observation: AIObservation;
    ctx: BoardContextView;
    seed: string;
    weights: Record<string, number>;
    neural: NeuralPolicyLike;
    budget?: {
      deadlineEpochMs?: number;
      simsPerDeterminization?: number;
      determinizations?: number;
    };
    mode?: 'auto' | 'alternating' | 'bot-tree';
    onDebug?: (rows: Array<{ key: string; visits: number; q: number }>) => void;
  },
): Promise<BotDecision> => {
  const {
    observation,
    ctx,
    seed,
    weights,
    neural,
    budget = {},
    mode = 'auto',
    onDebug,
  } = input;
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
    const useAlternating =
      mode === 'alternating' || (mode === 'auto' && observation.playerOrder.length === 2);
    const totals = useAlternating
        ? await searchAlternating(
            observation,
            ctx,
            weights,
            seed,
            neural,
            createSimulation(cloneState(fullState), ctx),
            rootActions,
            { sims: simsPerDeterminization, deadlineEpochMs },
          )
        : await searchDeterminization(
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
  if (onDebug) {
    onDebug(
      [...aggregate.entries()].map(([key, entry]) => ({
        key,
        visits: entry.visits,
        q: entry.visits > 0 ? entry.totalValue / entry.visits : 0,
      })),
    );
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
