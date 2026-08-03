/**
 * Shared headless match runner for self-play, benchmarks, tuning and
 * validation. Deterministic per (game seed, agent seeds); never starts the
 * server or touches the database.
 */

import { createPlayerView } from '../../../src/game/playerView.js';
import {
  NoLegalActionError,
  chooseBotMove,
} from '../../../src/shared/ai/policy.js';
import type { BotDecision } from '../../../src/shared/ai/types.js';
import { createObservation, type AIObservation } from '../../../src/shared/ai/observation.js';
import {
  seedMemoryFromObservation,
  updateMemory,
  type ExpertMemorySnapshot,
} from '../../../src/shared/ai/memory.js';
import { createSeededRNG } from '../../../src/shared/ai/seeded-rng.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
  type SimulationState,
} from '../../../src/shared/ai/simulate.js';
import { createStandings } from '../../../src/shared/rules/selectors.js';
import { createInitialState } from '../../../src/shared/rules/setup.js';
import type { AgentPolicyID, BoardContextView } from '../../../src/shared/ai/types.js';
import type {
  MainAction,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../../../src/shared/types/game.js';

export interface DecisionStats {
  decisions: number;
  totalElapsedMs: number;
  totalNodes: number;
  elapsedValuesMs: number[];
}

export interface GameOutcome {
  index: number;
  seed: string;
  numPlayers: number;
  agents: Record<PlayerID, AgentPolicyID>;
  winners: PlayerID[];
  standings: { playerID: string; score: number; purchasedCardCount: number }[];
  actions: number;
  completedTurns: number;
  illegal: number;
  deadlocked: boolean;
  noLegalAction: boolean;
  decisionStats: Record<AgentPolicyID, DecisionStats>;
  failure?: {
    actionIndex: number;
    error: string;
    state: SplendorState;
    observation: AIObservation;
    move?: unknown;
  };
}

export const createDecisionStats = (): DecisionStats => ({
  decisions: 0,
  totalElapsedMs: 0,
  totalNodes: 0,
  elapsedValuesMs: [],
});

export const ctxOf = (sim: SimulationState): BoardContextView => ({
  currentPlayer: sim.currentPlayer,
  playOrder: sim.playOrder,
  playOrderPos: sim.playOrderPos,
});

export const runGame = (
  index: number,
  numPlayers: number,
  agentOrder: AgentPolicyID[],
  seed: string,
  maxActions: number,
  weightsByAgent: Partial<Record<AgentPolicyID, Record<string, number>>> = {},
): GameOutcome => {
  const rng = createSeededRNG(`game:${seed}:${index}`);
  const initialState = createInitialState(numPlayers, {
    Shuffle: (items) => rng.shuffle(items),
    Die: (sides) => rng.int(sides) + 1,
  });
  const sim = createSimulation(
    initialState,
    {
      currentPlayer: initialState.initialFirstPlayer,
      playOrder: initialState.playerOrder,
      playOrderPos: initialState.playerOrder.indexOf(
        initialState.initialFirstPlayer,
      ),
    },
    0,
  );
  const agentsBySeat = Object.fromEntries(
    initialState.playerOrder.map((playerID, seat) => [
      playerID,
      agentOrder[seat % agentOrder.length],
    ]),
  ) as Record<PlayerID, AgentPolicyID>;
  let memory: ExpertMemorySnapshot | undefined;
  let memorySeeded = false;
  const outcome: GameOutcome = {
    index,
    seed,
    numPlayers,
    agents: agentsBySeat,
    winners: [],
    standings: [],
    actions: 0,
    completedTurns: 0,
    illegal: 0,
    deadlocked: false,
    noLegalAction: false,
    decisionStats: {
      'uniform-random-v1': createDecisionStats(),
      'cheap-greedy-v1': createDecisionStats(),
      'normal-v1': createDecisionStats(),
      'hard-v1': createDecisionStats(),
      'expert-v1': createDecisionStats(),
    },
  };

  while (outcome.actions < maxActions && sim.G.result === null) {
    const actionIndex = outcome.actions;
    const playerID = sim.currentPlayer;
    const agent = agentsBySeat[playerID];
    const playerView = createPlayerView(sim.G, playerID);
    const observation = createObservation(playerView, playerID, ctxOf(sim));
    if (!memorySeeded) {
      memory = seedMemoryFromObservation(observation);
      memorySeeded = true;
    } else {
      memory = updateMemory(memory!, observation);
    }
    const decisionSeed = `${seed}:${index}:${actionIndex}`;
    const startedAt = performance.now();
    let decision: BotDecision;
    try {
      decision = chooseBotMove(observation, ctxOf(sim), {
        policy: agent,
        seed: decisionSeed,
        weights: weightsByAgent[agent],
        memory,
      });
    } catch (caught) {
      if (caught instanceof NoLegalActionError) {
        outcome.noLegalAction = true;
        outcome.failure = {
          actionIndex,
          error: 'NO_LEGAL_ACTION',
          state: sim.G,
          observation,
        };
        break;
      }
      throw caught;
    }
    const stats = outcome.decisionStats[agent];
    stats.decisions += 1;
    stats.totalElapsedMs += decision.elapsedMs;
    stats.totalNodes += decision.nodesVisited;
    stats.elapsedValuesMs.push(decision.elapsedMs);

    const [argument] = decision.move.args;
    const result =
      decision.move.move === 'mainAction'
        ? applySimulationMainAction(sim, playerID, argument as MainAction)
        : decision.move.move === 'discardTokens'
          ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
          : applySimulationNoble(sim, playerID, argument as string);
    if (!result.ok) {
      outcome.illegal += 1;
      outcome.failure = {
        actionIndex,
        error: result.errors.map((error) => error.code).join(', '),
        state: sim.G,
        observation,
        move: decision.move,
      };
      break;
    }
    outcome.actions += 1;
  }

  if (sim.G.result === null && outcome.actions >= maxActions) {
    outcome.deadlocked = true;
    outcome.failure ??= {
      actionIndex: outcome.actions - 1,
      error: `DEADLOCK: no result after ${maxActions} actions`,
      state: sim.G,
      observation: createObservation(
        createPlayerView(sim.G, sim.currentPlayer),
        sim.currentPlayer,
        ctxOf(sim),
      ),
    };
  }

  outcome.completedTurns = sim.G.completedTurns;
  outcome.standings = createStandings(sim.G);
  if (sim.G.result) outcome.winners = sim.G.result.winners;
  return outcome;
};
