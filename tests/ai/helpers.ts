import { createInitialState } from '../../src/shared/rules/setup.js';
import { createSeededRNG, type SeededRNG } from '../../src/shared/ai/seeded-rng.js';
import type { GameSetupRandom, SplendorState } from '../../src/shared/types/game.js';

export const createSeededState = (
  numPlayers: number,
  seed: string,
): { state: SplendorState; rng: SeededRNG } => {
  const rng = createSeededRNG(seed);
  const setupRandom: GameSetupRandom = {
    Shuffle: (items) => rng.shuffle(items),
    Die: (sides) => rng.int(sides) + 1,
  };
  return { state: createInitialState(numPlayers, setupRandom), rng };
};

/**
 * Two authoritative states with identical playerViews but different hidden
 * truths (deck order and one opponent blind reservation).
 */
export const samePlayerViewStates = (): {
  first: SplendorState;
  second: SplendorState;
} => {
  const first = createSeededState(2, 'fairness-a').state;
  first.initialFirstPlayer = '1';
  const blindID = first.decks[1][0];
  first.players['0'].reservedCards.push({
    cardId: blindID,
    tier: 1,
    source: 'deck',
  });
  first.decks[1] = first.decks[1].slice(1);

  const second = structuredClone(first);
  second.initialFirstPlayer = '1';
  const fullDeck = createSeededRNG('fairness-b').shuffle([
    ...second.decks[1],
    blindID,
  ]);
  second.players['0'].reservedCards[0] = {
    cardId: fullDeck[0],
    tier: 1,
    source: 'deck',
  };
  second.decks[1] = fullDeck.slice(1);
  return { first, second };
};

/**
 * Makes a fixture state internally consistent: every purchased card is
 * removed from the market/decks, matching what the engine guarantees.
 */
export const removePurchasedFromWorld = (state: SplendorState): void => {
  const purchased = new Set(
    Object.values(state.players).flatMap((player) => player.purchasedCardIds),
  );
  for (const tier of [1, 2, 3] as const) {
    state.market[tier] = state.market[tier].map((cardID) =>
      cardID !== null && purchased.has(cardID) ? null : cardID,
    ) as SplendorState['market'][1];
    state.decks[tier] = state.decks[tier].filter(
      (cardID) => !purchased.has(cardID),
    );
  }
};
