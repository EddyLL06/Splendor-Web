/**
 * Differential test: the fast in-place simulator used by ds-search must
 * evolve game states identically to the authoritative rules engine.
 *
 * For randomized playouts (and for every enumerated candidate at sampled
 * states) we apply the same move through both paths and compare the full
 * gameplay state (the action log and its counter are intentionally
 * excluded; the search never reads them).
 */

import { describe, expect, it } from 'vitest';

import { createSeededRNG } from '../../src/shared/ai/seeded-rng.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
  type SimulationState,
} from '../../src/shared/ai/simulate.js';
import {
  applyFastMove,
  cloneStateFast,
  createFastSimulation,
} from '../../src/shared/ai/search/fast-sim.js';
import { enumerateLegalActions } from '../../src/shared/ai/legal-actions.js';
import { chooseNormalMove } from '../../src/shared/ai/policy-normal.js';
import { HAND_TUNED_WEIGHTS } from '../../src/shared/ai/models/default.js';
import { createInitialState } from '../../src/shared/rules/setup.js';
import type { BoardContextView, BotMove } from '../../src/shared/ai/types.js';
import type { SplendorState } from '../../src/shared/types/game.js';

const weights = { ...HAND_TUNED_WEIGHTS } as unknown as Record<string, number>;

const gameplayFieldsEqual = (a: SplendorState, b: SplendorState): boolean => {
  const strip = (state: SplendorState) =>
    JSON.parse(
      JSON.stringify({
        bank: state.bank,
        decks: state.decks,
        market: state.market,
        availableNobleIds: state.availableNobleIds,
        players: state.players,
        playerOrder: state.playerOrder,
        initialFirstPlayer: state.initialFirstPlayer,
        pending: state.pending,
        turnReady: state.turnReady,
        completedTurns: state.completedTurns,
        turnCounts: state.turnCounts,
        finalRound: state.finalRound,
        result: state.result,
      }),
    );
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

const applyAuthoritative = (
  sim: SimulationState,
  playerID: string,
  move: BotMove,
): boolean => {
  const [argument] = move.args;
  const result =
    move.move === 'mainAction'
      ? applySimulationMainAction(sim, playerID, argument as never)
      : move.move === 'discardTokens'
        ? applySimulationDiscard(sim, playerID, argument as never)
        : applySimulationNoble(sim, playerID, argument as string);
  return result.ok;
};

describe('fast-sim vs authoritative engine', () => {
  it('evolves states identically over randomized full playouts', () => {
    for (let game = 0; game < 20; game += 1) {
      const rng = createSeededRNG(`fast-sim-playout-${game}`);
      const state = createInitialState(2, {
        Shuffle: (items) => rng.shuffle(items),
        Die: (sides) => rng.int(sides) + 1,
      });
      const ctx: BoardContextView = {
        currentPlayer: state.initialFirstPlayer,
        playOrder: state.playerOrder,
        playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
      };
      const authoritative = createSimulation(structuredClone(state), ctx);
      const fast = createFastSimulation(cloneStateFast(state), ctx);
      for (let action = 0; action < 90 && authoritative.G.result === null; action += 1) {
        const playerID = authoritative.currentPlayer;
        expect(fast.currentPlayer).toBe(playerID);
        const ctxNow: BoardContextView = {
          currentPlayer: playerID,
          playOrder: authoritative.playOrder,
          playOrderPos: authoritative.playOrderPos,
        };
        const candidate = chooseNormalMove(
          authoritative.G,
          playerID,
          ctxNow,
          `fast-sim-play:${game}:${action}`,
          weights,
        );
        const okA = applyAuthoritative(authoritative, playerID, candidate.move);
        const okF = applyFastMove(fast, playerID, candidate.move);
        expect(okF).toBe(okA);
        if (!okA) break;
        expect(fast.currentPlayer).toBe(authoritative.currentPlayer);
        expect(fast.playOrderPos).toBe(authoritative.playOrderPos);
        expect(gameplayFieldsEqual(fast.G, authoritative.G)).toBe(true);
      }
    }
  }, 20_000);

  it('applies every enumerated candidate identically at sampled states', () => {
    for (let game = 0; game < 30; game += 1) {
      const rng = createSeededRNG(`fast-sim-candidates-${game}`);
      const state = createInitialState(2, {
        Shuffle: (items) => rng.shuffle(items),
        Die: (sides) => rng.int(sides) + 1,
      });
      const ctx: BoardContextView = {
        currentPlayer: state.initialFirstPlayer,
        playOrder: state.playerOrder,
        playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
      };
      const walk = createSimulation(structuredClone(state), ctx);
      // Walk 0..20 normal-policy actions to reach varied states.
      const steps = game % 20;
      for (let action = 0; action < steps && walk.G.result === null; action += 1) {
        const playerID = walk.currentPlayer;
        const ctxNow: BoardContextView = {
          currentPlayer: playerID,
          playOrder: walk.playOrder,
          playOrderPos: walk.playOrderPos,
        };
        const candidate = chooseNormalMove(
          walk.G,
          playerID,
          ctxNow,
          `fast-sim-walk:${game}:${action}`,
          weights,
        );
        if (!applyAuthoritative(walk, playerID, candidate.move)) break;
      }
      if (walk.G.result !== null) continue;
      const playerID = walk.currentPlayer;
      const ctxNow: BoardContextView = {
        currentPlayer: playerID,
        playOrder: walk.playOrder,
        playOrderPos: walk.playOrderPos,
      };
      for (const candidate of enumerateLegalActions(walk.G, playerID, playerID)) {
        const authoritative = createSimulation(structuredClone(walk.G), ctxNow);
        const fast = createFastSimulation(cloneStateFast(walk.G), ctxNow);
        const okA = applyAuthoritative(authoritative, playerID, candidate.move);
        const okF = applyFastMove(fast, playerID, candidate.move);
        expect(okF).toBe(okA);
        if (!okA) continue;
        expect(fast.currentPlayer).toBe(authoritative.currentPlayer);
        expect(gameplayFieldsEqual(fast.G, authoritative.G)).toBe(true);
      }
    }
  });

  it('cloneStateFast matches structuredClone on gameplay fields', () => {
    const rng = createSeededRNG('fast-sim-clone');
    const state = createInitialState(4, {
      Shuffle: (items) => rng.shuffle(items),
      Die: (sides) => rng.int(sides) + 1,
    });
    const cloned = cloneStateFast(state);
    expect(gameplayFieldsEqual(cloned, structuredClone(state))).toBe(true);
    // Clones must not share mutable structures.
    cloned.bank.white = 99;
    expect(state.bank.white).not.toBe(99);
    cloned.market[1][0] = 'mutated';
    expect(state.market[1][0]).not.toBe('mutated');
  });
});
