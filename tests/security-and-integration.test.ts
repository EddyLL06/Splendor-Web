import { Client } from 'boardgame.io/client';
import { describe, expect, it } from 'vitest';

import { SplendorGame } from '../src/game/SplendorGame.js';
import { createPlayerView } from '../src/game/playerView.js';
import { createTestState } from './helpers.js';

describe('hidden information', () => {
  it('hides deck order and opponents’ blind reservations', () => {
    const state = createTestState();
    const blindID = state.decks[1].shift()!;
    const publicID = state.market[2][0];
    state.players['0'].reservedCards.push({
      cardId: blindID,
      tier: 1,
      source: 'deck',
    });
    state.players['0'].reservedCards.push({
      cardId: publicID,
      tier: 2,
      source: 'market',
    });

    const ownerView = createPlayerView(state, '0');
    expect(ownerView.players['0'].reservedCards[0].cardId).toBe(blindID);
    expect(ownerView.decks[1]).not.toContain(state.decks[1][0]);

    const opponentView = createPlayerView(state, '1');
    expect(opponentView.players['0'].reservedCards[0].cardId).toBeNull();
    expect(opponentView.players['0'].reservedCards[1].cardId).toBe(publicID);
    expect(opponentView.decks[1]).toHaveLength(state.decks[1].length);
    expect(new Set(opponentView.decks[1])).toEqual(new Set(['__hidden__']));
  });

  it('does not mutate authoritative state while filtering', () => {
    const state = createTestState();
    const original = structuredClone(state);
    createPlayerView(state, null);
    expect(state).toEqual(original);
  });
});

describe('boardgame.io integration', () => {
  it('uses deterministic setup, advances after one action, and rejects stale actors', () => {
    const game = { ...SplendorGame, seed: 'integration-seed' };
    const client = Client({ game, numPlayers: 2 });
    client.start();
    const initial = client.getState()!;
    const actor = initial.ctx.currentPlayer;
    client.updatePlayerID(actor);
    client.moves.mainAction({
      type: 'takeDifferent',
      colors: ['white', 'blue', 'green'],
    });
    const after = client.getState()!;
    expect(after.ctx.currentPlayer).not.toBe(actor);
    expect(after.G.players[actor].tokens.white).toBe(1);

    const stateID = after._stateID;
    client.moves.mainAction({ type: 'takeSame', color: 'red' });
    expect(client.getState()!._stateID).toBe(stateID);
    client.stop();
  });

  it('rejects invalid moves without changing state', () => {
    const client = Client({
      game: { ...SplendorGame, seed: 'invalid-seed' },
      numPlayers: 2,
    });
    client.start();
    const actor = client.getState()!.ctx.currentPlayer;
    client.updatePlayerID(actor);
    const before = client.getState()!;
    client.moves.mainAction({
      type: 'takeDifferent',
      colors: ['white', 'white', 'gold'],
    });
    const after = client.getState()!;
    expect(after.G).toEqual(before.G);
    expect(after.ctx).toEqual(before.ctx);
    expect(after._stateID).toBe(before._stateID);
    client.stop();
  });
});
