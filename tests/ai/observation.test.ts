import { describe, expect, it } from 'vitest';

import { createPlayerView } from '../../src/game/playerView.js';
import {
  ObservationIntegrityError,
  createObservation,
} from '../../src/shared/ai/observation.js';
import type { SplendorState } from '../../src/shared/types/game.js';
import { samePlayerViewStates } from './helpers.js';

const ctxFor = (state: SplendorState, playerID: string) => ({
  currentPlayer: state.initialFirstPlayer,
  playOrder: state.playerOrder,
  playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
});

describe('AI observation', () => {
  it('is deep-equal for identical playerViews with different hidden truths', () => {
    const { first, second } = samePlayerViewStates();
    const firstObservation = createObservation(
      createPlayerView(first, '1'),
      '1',
      ctxFor(first, '1'),
    );
    const secondObservation = createObservation(
      createPlayerView(second, '1'),
      '1',
      ctxFor(second, '1'),
    );
    expect(secondObservation).toEqual(firstObservation);
  });

  it('keeps only deck counts and null opponent blind reservations', () => {
    const { first } = samePlayerViewStates();
    const view = createPlayerView(first, '1');
    const observation = createObservation(view, '1', ctxFor(first, '1'));
    expect(observation.deckCounts).toEqual({
      1: first.decks[1].length,
      2: first.decks[2].length,
      3: first.decks[3].length,
    });
    expect(observation.players['0'].reservedCards[0]).toEqual({
      tier: 1,
      source: 'deck',
      cardId: null,
    });
    expect(JSON.stringify(observation)).not.toContain(first.decks[1][0]);
  });

  it('rejects an unfiltered state containing real deck IDs', () => {
    const { first } = samePlayerViewStates();
    expect(() =>
      createObservation(first, '1', ctxFor(first, '1')),
    ).toThrow(ObservationIntegrityError);
  });

  it('does not mutate the input playerView', () => {
    const { first } = samePlayerViewStates();
    const view = createPlayerView(first, '1');
    const original = structuredClone(view);
    createObservation(view, '1', ctxFor(first, '1'));
    expect(view).toEqual(original);
  });
});
