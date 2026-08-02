/**
 * Lightweight simulation wrapper around the authoritative rules
 * (DEVELOPMENT_GUIDE.md §7). Every transition calls the same `apply*`
 * functions used by boardgame.io; turn rotation mirrors `SplendorGame`'s
 * `turn.endIf` + `onBegin`. Never calls `Math.random()`.
 */

import {
  applyDiscard,
  applyMainAction,
  applyNobleSelection,
} from '../rules/engine.js';
import type {
  MainAction,
  PlayerID,
  RuleResult,
  SplendorState,
  TokenCounts,
} from '../types/game.js';
import type { BoardContextView } from './types.js';

export interface SimulationState {
  G: SplendorState;
  currentPlayer: PlayerID;
  playOrder: PlayerID[];
  playOrderPos: number;
  stateID: number;
}

export const createSimulation = (
  G: SplendorState,
  ctx: BoardContextView,
  stateID = 0,
): SimulationState => ({
  G,
  currentPlayer: ctx.currentPlayer,
  playOrder: [...ctx.playOrder],
  playOrderPos: ctx.playOrderPos,
  stateID,
});

const advanceIfTurnComplete = (sim: SimulationState): void => {
  if (sim.G.result !== null) return;
  if (!sim.G.turnReady) return;
  if (sim.G.pending !== null) return;
  sim.playOrderPos = (sim.playOrderPos + 1) % sim.playOrder.length;
  sim.currentPlayer = sim.playOrder[sim.playOrderPos];
  sim.G.turnReady = false;
};

const applyResult = (
  sim: SimulationState,
  result: RuleResult<SplendorState>,
): RuleResult<SplendorState> => {
  if (!result.ok) return result;
  sim.G = result.value;
  sim.stateID += 1;
  advanceIfTurnComplete(sim);
  return { ok: true, value: sim.G };
};

export const applySimulationMainAction = (
  sim: SimulationState,
  playerID: PlayerID,
  action: MainAction,
): RuleResult<SplendorState> =>
  applyResult(
    sim,
    applyMainAction(sim.G, playerID, sim.currentPlayer, action),
  );

export const applySimulationDiscard = (
  sim: SimulationState,
  playerID: PlayerID,
  returned: TokenCounts,
): RuleResult<SplendorState> =>
  applyResult(
    sim,
    applyDiscard(sim.G, playerID, sim.currentPlayer, returned),
  );

export const applySimulationNoble = (
  sim: SimulationState,
  playerID: PlayerID,
  nobleID: string,
): RuleResult<SplendorState> =>
  applyResult(
    sim,
    applyNobleSelection(sim.G, playerID, sim.currentPlayer, nobleID),
  );

/** Clone the simulation for candidate evaluation without touching the input. */
export const cloneSimulation = (sim: SimulationState): SimulationState => ({
  G: JSON.parse(JSON.stringify(sim.G)) as SplendorState,
  currentPlayer: sim.currentPlayer,
  playOrder: [...sim.playOrder],
  playOrderPos: sim.playOrderPos,
  stateID: sim.stateID,
});
