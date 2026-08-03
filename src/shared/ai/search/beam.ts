/**
 * Hard difficulty: top-5 one-round beam with one determinization
 * (DEVELOPMENT_GUIDE.md §9/§9.1). The Bot completes its turn including
 * pending resolutions; each opponent then plays one full Normal turn; the
 * leaf is scored with the linear model. Deadline and node caps return
 * best-so-far instead of blocking.
 */

import { evaluateWithWeights } from '../evaluate.js';
import { determinize } from '../hidden-information.js';
import { enumerateLegalActions } from '../legal-actions.js';
import { NoLegalActionError } from '../errors.js';
import { chooseNormalMove } from '../policy-normal.js';
import type { BotDecision } from '../types.js';
import { createSeededRNG } from '../seeded-rng.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
  type SimulationState,
} from '../simulate.js';
import type {
  BoardContextView,
  SearchBudget,
} from '../types.js';
import type {
  AIObservation,
} from '../observation.js';
import type {
  MainAction,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../../types/game.js';

export interface HardDecisionInput {
  observation: AIObservation;
  ctx: BoardContextView;
  seed: string;
  weights: Record<string, number>;
  budget: SearchBudget;
}

const cloneState = (state: SplendorState): SplendorState =>
  JSON.parse(JSON.stringify(state)) as SplendorState;

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
    const ctx: BoardContextView = {
      currentPlayer: playerID,
      playOrder: sim.playOrder,
      playOrderPos: sim.playOrderPos,
    };
    const candidate = chooseNormalMove(
      sim.G,
      playerID,
      ctx,
      `${seed}:${step}:${guard}`,
      weights,
    );
    const [argument] = candidate.move.args;
    const result =
      candidate.move.move === 'mainAction'
        ? applySimulationMainAction(sim, playerID, argument as MainAction)
        : candidate.move.move === 'discardTokens'
          ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
          : applySimulationNoble(sim, playerID, argument as string);
    if (!result.ok) {
      throw new Error(`Hard search opponent produced illegal move: ${result.errors.map((e) => e.code).join(',')}`);
    }
    if (sim.currentPlayer !== playerID) return;
    if (sim.G.pending === null && sim.G.turnReady) return;
  }
};

export const computeHardDecision = (
  input: HardDecisionInput,
): BotDecision => {
  const { observation, ctx, seed, weights, budget } = input;
  const startedAt = performance.now();
  const rng = createSeededRNG(`hard:${seed}`);
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

  const deadline = budget.deadlineEpochMs;
  let nodesVisited = 0;
  let timedOut = false;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestCandidate = candidates[0];

  const scored = candidates
    .map((candidate, index) => {
      const sim = createSimulation(cloneState(fullState), ctx);
      const [argument] = candidate.move.args;
      const result =
        candidate.move.move === 'mainAction'
          ? applySimulationMainAction(sim, playerID, argument as MainAction)
          : candidate.move.move === 'discardTokens'
            ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
            : applySimulationNoble(sim, playerID, argument as string);
      nodesVisited += 1;
      return {
        candidate,
        index,
        score: result.ok
          ? evaluateWithWeights(sim.G, playerID, weights)
          : Number.NEGATIVE_INFINITY,
      };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  for (const entry of scored) {
    if (performance.now() >= deadline || nodesVisited >= budget.maxNodes) {
      timedOut = true;
      break;
    }
    const sim = createSimulation(cloneState(fullState), ctx);
    const [argument] = entry.candidate.move.args;
    let result =
      entry.candidate.move.move === 'mainAction'
        ? applySimulationMainAction(sim, playerID, argument as MainAction)
        : entry.candidate.move.move === 'discardTokens'
          ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
          : applySimulationNoble(sim, playerID, argument as string);
    nodesVisited += 1;
    if (!result.ok) continue;

    // Complete the Bot's own pending resolution chain.
    let guard = 0;
    while (
      sim.G.result === null &&
      sim.G.pending !== null &&
      sim.G.pending.playerID === playerID &&
      guard < 4
    ) {
      guard += 1;
      const subCtx: BoardContextView = {
        currentPlayer: playerID,
        playOrder: sim.playOrder,
        playOrderPos: sim.playOrderPos,
      };
      const candidate = chooseNormalMove(
        sim.G,
        playerID,
        subCtx,
        `${seed}:resolve:${entry.index}:${guard}`,
        weights,
      );
      const [subArgument] = candidate.move.args;
      result =
        candidate.move.move === 'mainAction'
          ? applySimulationMainAction(sim, playerID, subArgument as MainAction)
          : candidate.move.move === 'discardTokens'
            ? applySimulationDiscard(sim, playerID, subArgument as TokenCounts)
            : applySimulationNoble(sim, playerID, subArgument as string);
      nodesVisited += 1;
      if (!result.ok) break;
    }
    if (sim.G.pending?.playerID === playerID) continue;

    // Opponents play one full turn each until the Bot's next turn.
    let opponentGuard = 0;
    while (sim.G.result === null && sim.currentPlayer !== playerID && opponentGuard < 6) {
      opponentGuard += 1;
      playOneFullTurn(sim, sim.currentPlayer, weights, seed, entry.index);
      nodesVisited += 1;
      if (performance.now() >= deadline || nodesVisited >= budget.maxNodes) {
        timedOut = true;
        break;
      }
    }

    // Evaluate after the Bot's own reply so tempo/gold effects of the line
    // are visible (2-ply leaf), still inside the one-round horizon.
    if (
      sim.G.result === null &&
      sim.currentPlayer === playerID &&
      performance.now() < deadline &&
      nodesVisited < budget.maxNodes
    ) {
      const reply = chooseNormalMove(
        sim.G,
        playerID,
        {
          currentPlayer: playerID,
          playOrder: sim.playOrder,
          playOrderPos: sim.playOrderPos,
        },
        `${seed}:reply:${entry.index}`,
        weights,
      );
      const [replyArgument] = reply.move.args;
      const replyResult =
        reply.move.move === 'mainAction'
          ? applySimulationMainAction(
              sim,
              playerID,
              replyArgument as MainAction,
            )
          : reply.move.move === 'discardTokens'
            ? applySimulationDiscard(sim, playerID, replyArgument as TokenCounts)
            : applySimulationNoble(sim, playerID, replyArgument as string);
      nodesVisited += 1;
      if (!replyResult.ok) {
        throw new Error('Hard search reply produced an illegal move.');
      }
    }

    const score = evaluateWithWeights(sim.G, playerID, weights);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = entry.candidate;
    }
  }

  return {
    move: bestCandidate.move,
    modelVersion: 'ai-kernel-v0.1.0',
    policy: 'hard-v1',
    seed,
    nodesVisited,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    timedOut,
    fallbackLevel: timedOut ? 1 : 0,
  };
};
