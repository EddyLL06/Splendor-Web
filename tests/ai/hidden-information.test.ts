import { describe, expect, it } from 'vitest';

import { createPlayerView } from '../../src/game/playerView.js';
import { cardsForTier } from '../../src/shared/data/gameData.js';
import {
  determinize,
  unknownPool,
} from '../../src/shared/ai/hidden-information.js';
import { createObservation } from '../../src/shared/ai/observation.js';
import { createSeededRNG } from '../../src/shared/ai/seeded-rng.js';
import type { SplendorState, Tier } from '../../src/shared/types/game.js';
import { samePlayerViewStates } from './helpers.js';

const ctxFor = (state: SplendorState, playerID: string) => ({
  currentPlayer: state.initialFirstPlayer,
  playOrder: state.playerOrder,
  playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
});

describe('unknown pool and determinization', () => {
  it('subtracts every publicly known card from the static data', () => {
    const { first } = samePlayerViewStates();
    const observation = createObservation(
      createPlayerView(first, '1'),
      '1',
      ctxFor(first, '1'),
    );
    const pool = unknownPool(observation);
    for (const tier of [1, 2, 3] as const) {
      const tierCardIDs = new Set(
        cardsForTier(tier).map((card) => card.id),
      );
      const known = new Set([
        ...observation.market[tier].filter((id): id is string => id !== null),
        ...Object.values(observation.players).flatMap((player) =>
          player.purchasedCardIds.filter((id) => tierCardIDs.has(id)),
        ),
        ...Object.values(observation.players).flatMap((player) =>
          player.reservedCards
            .filter((reserved) => reserved.tier === tier && reserved.cardId !== null)
            .map((reserved) => reserved.cardId as string),
        ),
      ]);
      expect(pool[tier]).toHaveLength(cardsForTier(tier).length - known.size);
      expect(new Set(pool[tier]).size).toBe(pool[tier].length);
      expect(
        pool[tier].every((cardID) => !known.has(cardID)),
      ).toBe(true);
    }
  });

  it('is deterministic and preserves every public field', () => {
    const { first } = samePlayerViewStates();
    const observation = createObservation(
      createPlayerView(first, '1'),
      '1',
      ctxFor(first, '1'),
    );
    const once = determinize(observation, createSeededRNG('det-v1'));
    const twice = determinize(observation, createSeededRNG('det-v1'));
    expect(twice).toEqual(once);
    expect(once.bank).toEqual(observation.bank);
    expect(once.market).toEqual(observation.market);
    expect(once.availableNobleIds).toEqual(observation.availableNobleIds);
    for (const tier of [1, 2, 3] as const) {
      expect(once.decks[tier]).toHaveLength(observation.deckCounts[tier]);
      expect(once.players['0'].reservedCards[0]).toMatchObject({
        tier: 1,
        source: 'deck',
      });
      expect(typeof once.players['0'].reservedCards[0].cardId).toBe('string');
    }
  });

  it('assigns opponent blind cards from the pool, never from known cards', () => {
    const { first } = samePlayerViewStates();
    const observation = createObservation(
      createPlayerView(first, '1'),
      '1',
      ctxFor(first, '1'),
    );
    const pool = new Set(
      Object.values(unknownPool(observation)).flat(),
    );
    const state = determinize(observation, createSeededRNG('det-v2'));
    const known = new Set([
      ...Object.values(observation.market).flat().filter((id): id is string => id !== null),
      ...Object.values(observation.players).flatMap((player) => [
        ...player.purchasedCardIds,
        ...player.reservedCards
          .filter((reserved) => reserved.cardId !== null)
          .map((reserved) => reserved.cardId as string),
      ]),
    ]);
    for (const cardID of state.players['0'].reservedCards.map(
      (reserved) => reserved.cardId,
    )) {
      expect(cardID).not.toBeNull();
      expect(pool.has(cardID as string)).toBe(true);
      expect(known.has(cardID as string)).toBe(false);
    }
    for (const tier of [1, 2, 3] as const) {
      for (const cardID of state.decks[tier]) {
        expect(known.has(cardID)).toBe(false);
      }
    }
  });

  it('determinization does not depend on the hidden truth', () => {
    const { first, second } = samePlayerViewStates();
    const observation = createObservation(
      createPlayerView(first, '1'),
      '1',
      ctxFor(first, '1'),
    );
    const fromSecond = createObservation(
      createPlayerView(second, '1'),
      '1',
      ctxFor(second, '1'),
    );
    expect(fromSecond).toEqual(observation);
    const rng = createSeededRNG('det-v3');
    const rng2 = createSeededRNG('det-v3');
    expect(determinize(fromSecond, rng2)).toEqual(determinize(observation, rng));
  });
});
