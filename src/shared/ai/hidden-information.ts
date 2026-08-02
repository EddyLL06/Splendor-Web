/**
 * Unknown card pool derivation and determinization (DEVELOPMENT_GUIDE.md
 * §5.2). The unknown pool is rebuilt from static card data and the public
 * observation only; the true state is never read here.
 */

import { cardsForTier } from '../data/gameData.js';
import type {
  PlayerID,
  SplendorState,
  Tier,
} from '../types/game.js';
import type { AIObservation } from './observation.js';
import type { SeededRNG } from './seeded-rng.js';

export const unknownPoolForTier = (
  observation: AIObservation,
  tier: Tier,
): string[] => {
  const known = new Set<string>();
  for (const cardID of observation.market[tier]) {
    if (cardID !== null) known.add(cardID);
  }
  for (const player of Object.values(observation.players)) {
    for (const cardID of player.purchasedCardIds) known.add(cardID);
    for (const reserved of player.reservedCards) {
      if (reserved.tier === tier && reserved.cardId !== null) {
        known.add(reserved.cardId);
      }
    }
  }
  return cardsForTier(tier)
    .map((card) => card.id)
    .filter((cardID) => !known.has(cardID));
};

interface OpponentBlindSlot {
  playerID: PlayerID;
  tier: Tier;
}

const collectOpponentBlindSlots = (
  observation: AIObservation,
): OpponentBlindSlot[] => {
  const slots: OpponentBlindSlot[] = [];
  for (const playerID of observation.playerOrder) {
    if (playerID === observation.playerID) continue;
    for (const reserved of observation.players[playerID].reservedCards) {
      if (reserved.source === 'deck' && reserved.cardId === null) {
        slots.push({ playerID, tier: reserved.tier });
      }
    }
  }
  return slots;
};

/**
 * Reconstructs a complete, legal `SplendorState` consistent with the
 * observation: opponent blind reservations and decks are filled from the
 * unknown pool with the injected seeded RNG. The same (observation, seed)
 * always yields the same reconstruction.
 */
export const determinize = (
  observation: AIObservation,
  rng: SeededRNG,
): SplendorState => {
  const blindSlots = collectOpponentBlindSlots(observation);
  const assignedBlind: Record<PlayerID, Record<Tier, string[]>> = {};

  const decks = {} as Record<Tier, string[]>;
  for (const tier of [1, 2, 3] as const) {
    const pool = rng.shuffle(unknownPoolForTier(observation, tier));
    const tierSlots = blindSlots.filter((slot) => slot.tier === tier);
    const deckCards = [...pool];
    for (const slot of tierSlots) {
      const cardID = deckCards.shift();
      if (!cardID) {
        throw new Error(
          `Unknown pool for tier ${tier} is too small for determinization.`,
        );
      }
      (assignedBlind[slot.playerID] ??= { 1: [], 2: [], 3: [] })[tier].push(cardID);
    }
    decks[tier] = deckCards;
  }

  const players = Object.fromEntries(
    observation.playerOrder.map((playerID) => {
      const source = observation.players[playerID];
      return [
        playerID,
        {
          tokens: { ...source.tokens },
          purchasedCardIds: [...source.purchasedCardIds],
          reservedCards: source.reservedCards.map((reserved) => {
            let cardId = reserved.cardId;
            if (
              reserved.cardId === null &&
              reserved.source === 'deck' &&
              playerID !== observation.playerID
            ) {
              cardId = assignedBlind[playerID]?.[reserved.tier].shift() ?? null;
            }
            return { tier: reserved.tier, source: reserved.source, cardId };
          }),
          nobleIds: [...source.nobleIds],
        },
      ];
    }),
  );

  const deckCounts = observation.deckCounts;
  if (
    decks[1].length !== deckCounts[1] ||
    decks[2].length !== deckCounts[2] ||
    decks[3].length !== deckCounts[3]
  ) {
    throw new Error('Determinization produced deck counts inconsistent with observation.');
  }

  return {
    bank: { ...observation.bank },
    decks,
    market: {
      1: [...observation.market[1]],
      2: [...observation.market[2]],
      3: [...observation.market[3]],
    } as SplendorState['market'],
    availableNobleIds: [...observation.availableNobleIds],
    players,
    playerOrder: [...observation.playerOrder],
    initialFirstPlayer: observation.playerOrder[0],
    pending: observation.pending
      ? JSON.parse(JSON.stringify(observation.pending))
      : null,
    turnReady: observation.turnReady,
    completedTurns: observation.completedTurns,
    turnCounts: { ...observation.turnCounts },
    finalRound: observation.finalRound
      ? JSON.parse(JSON.stringify(observation.finalRound))
      : null,
    actionLog: [],
    nextLogID: 1,
    result: observation.result
      ? JSON.parse(JSON.stringify(observation.result))
      : null,
  };
};

/** Alias kept for tests and future Hard/Expert search modules. */
export const unknownPool = (
  observation: AIObservation,
): Record<Tier, string[]> => ({
  1: unknownPoolForTier(observation, 1),
  2: unknownPoolForTier(observation, 2),
  3: unknownPoolForTier(observation, 3),
});

export const determinizeState = determinize;
