import { Client } from 'boardgame.io/client';
import { describe, expect, it } from 'vitest';

import { SplendorGame } from '../../src/game/SplendorGame.js';
import { createPlayerView } from '../../src/game/playerView.js';
import { enumerateLegalActions } from '../../src/shared/ai/legal-actions.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from '../../src/shared/ai/simulate.js';
import type { SplendorState } from '../../src/shared/types/game.js';
import { createTestState, grantBonuses } from '../helpers.js';
import { createSeededState } from './helpers.js';

type GameClient = ReturnType<typeof Client<SplendorState>>;

const lockstep = (
  state: SplendorState,
  numPlayers: number,
  maxSteps: number,
): { client: GameClient; comparisons: number } => {
  const client = Client({
    game: { ...SplendorGame, setup: () => structuredClone(state) },
    numPlayers,
  });
  client.start();
  const sim = createSimulation(
    structuredClone(state),
    {
      currentPlayer: state.initialFirstPlayer,
      playOrder: state.playerOrder,
      playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
    },
    0,
  );
  let steps = 0;
  while (steps < maxSteps && sim.G.result === null) {
    const actor = sim.currentPlayer;
    const candidates = enumerateLegalActions(sim.G, actor, actor);
    // A reachable no-legal-action state is a rules-layer gap (guide §6.5),
    // not a differential mismatch; stop and let the caller decide.
    if (candidates.length === 0) break;
    const candidate = candidates[0];
    const move = candidate.move;
    client.updatePlayerID(actor);
    if (move.move === 'mainAction') {
      applySimulationMainAction(sim, actor, move.args[0]);
      client.moves.mainAction(move.args[0]);
    } else if (move.move === 'discardTokens') {
      applySimulationDiscard(sim, actor, move.args[0]);
      client.moves.discardTokens(move.args[0]);
    } else {
      applySimulationNoble(sim, actor, move.args[0]);
      client.moves.chooseNoble(move.args[0]);
    }

    const clientState = client.getState()!;
    const simView = createPlayerView(sim.G, actor);
    expect(simView).toEqual(clientState.G);
    expect(sim.currentPlayer).toBe(clientState.ctx.currentPlayer);
    expect(sim.playOrderPos).toBe(clientState.ctx.playOrderPos);
    expect(sim.stateID).toBe(clientState._stateID);
    expect(sim.G.pending).toEqual(clientState.G.pending);
    expect(sim.G.turnReady).toBe(clientState.G.turnReady);
    expect(sim.G.result).toEqual(clientState.G.result);
    steps += 1;
  }
  client.stop();
  return { client, comparisons: steps };
};

describe('simulator differential vs boardgame.io reducer', () => {
  it('matches the real reducer across a complete 2-player game', () => {
    const { state } = createSeededState(2, 'diff-full');
    state.initialFirstPlayer = '0';
    const { comparisons } = lockstep(state, 2, 400);
    expect(comparisons).toBeGreaterThan(50);
  });

  it('matches across randomized 3- and 4-player openings', () => {
    for (const numPlayers of [3, 4] as const) {
      const { state } = createSeededState(numPlayers, `diff-${numPlayers}`);
      state.initialFirstPlayer = '0';
      const { comparisons } = lockstep(state, numPlayers, 60);
      expect(comparisons).toBeGreaterThan(0);
    }
  });

  it('matches discard and noble pending resolutions', () => {
    const state = createTestState();
    state.initialFirstPlayer = '0';
    state.players['0'].tokens = {
      white: 4,
      blue: 4,
      green: 4,
      red: 4,
      black: 4,
      gold: 0,
    };
    state.pending = { type: 'discard', playerID: '0', count: 1 };
    const { comparisons } = lockstep(state, 2, 3);
    expect(comparisons).toBe(3);

    const nobleState = createTestState();
    nobleState.initialFirstPlayer = '0';
    grantBonuses(nobleState, '0', {
      white: 4,
      blue: 4,
      green: 4,
      red: 4,
      black: 4,
    });
    nobleState.pending = {
      type: 'noble',
      playerID: '0',
      eligibleNobleIds: [...nobleState.availableNobleIds],
    };
    const nobleClient = Client({
      game: {
        ...SplendorGame,
        setup: () => structuredClone(nobleState),
      },
      numPlayers: 2,
    });
    nobleClient.start();
    nobleClient.updatePlayerID('0');
    const candidate = enumerateLegalActions(nobleState, '0', '0')[0];
    nobleClient.moves.chooseNoble(candidate.move.args[0] as string);
    const clientState = nobleClient.getState()!;
    const sim = createSimulation(
      structuredClone(nobleState),
      {
        currentPlayer: '0',
        playOrder: ['0', '1'],
        playOrderPos: 0,
      },
      0,
    );
    applySimulationNoble(sim, '0', candidate.move.args[0] as string);
    expect(createPlayerView(sim.G, '0')).toEqual(clientState.G);
    expect(sim.currentPlayer).toBe(clientState.ctx.currentPlayer);
    expect(sim.stateID).toBe(clientState._stateID);
    nobleClient.stop();
  });
});
