/**
 * AI-visible observation constructed from the filtered `playerView`
 * (DEVELOPMENT_GUIDE.md §5). The observation must never contain real deck
 * order or opponent blind-reservation card IDs.
 */

import type {
  FinalRoundState,
  GameResult,
  PendingResolution,
  PlayerID,
  SplendorState,
  Tier,
  TokenCounts,
} from '../types/game.js';
import type { BoardContextView } from './types.js';

export const HIDDEN_CARD_ID = '__hidden__';

export interface ReservedCardInfo {
  tier: Tier;
  source: 'market' | 'deck';
  cardId: string | null;
}

export interface PlayerObservation {
  tokens: TokenCounts;
  purchasedCardIds: string[];
  reservedCards: ReservedCardInfo[];
  nobleIds: string[];
}

export interface AIObservation {
  version: 1;
  playerID: PlayerID;
  bank: TokenCounts;
  market: Record<Tier, Array<string | null>>;
  deckCounts: Record<Tier, number>;
  availableNobleIds: string[];
  players: Record<PlayerID, PlayerObservation>;
  playerOrder: PlayerID[];
  currentPlayer: PlayerID;
  playOrderPos: number;
  turnReady: boolean;
  pending: PendingResolution | null;
  completedTurns: number;
  turnCounts: Record<PlayerID, number>;
  finalRound: FinalRoundState | null;
  result: GameResult | null;
}

export class ObservationIntegrityError extends Error {
  constructor(message: string) {
    super(`AI observation integrity failure: ${message}`);
    this.name = 'ObservationIntegrityError';
  }
}

export const assertObservationIntegrity = (
  observation: AIObservation,
): void => {
  for (const tier of [1, 2, 3] as const) {
    if (
      !Array.isArray(observation.market[tier]) ||
      observation.market[tier].length !== 4
    ) {
      throw new ObservationIntegrityError(`market tier ${tier} is malformed.`);
    }
  }
  if (!observation.playerOrder.includes(observation.playerID)) {
    throw new ObservationIntegrityError('player is not part of the player order.');
  }
  for (const [ownerID, player] of Object.entries(observation.players)) {
    if (ownerID === observation.playerID) continue;
    for (const reserved of player.reservedCards) {
      if (reserved.source === 'deck' && reserved.cardId !== null) {
        throw new ObservationIntegrityError(
          `opponent ${ownerID} blind reservation leaked a card ID.`,
        );
      }
    }
  }
};

/**
 * Structured, deep-copied observation from an already-filtered playerView.
 * Deck order is reduced to per-tier counts; anything else real is rejected.
 */
export const createObservation = (
  playerView: SplendorState,
  playerID: PlayerID,
  ctx: BoardContextView,
): AIObservation => {
  for (const tier of [1, 2, 3] as const) {
    if (!playerView.decks[tier]?.every((cardID) => cardID === HIDDEN_CARD_ID)) {
      throw new ObservationIntegrityError(
        `deck tier ${tier} contains real card IDs; feed the filtered playerView.`,
      );
    }
  }

  const observation: AIObservation = {
    version: 1,
    playerID,
    bank: { ...playerView.bank },
    market: {
      1: [...playerView.market[1]],
      2: [...playerView.market[2]],
      3: [...playerView.market[3]],
    },
    deckCounts: {
      1: playerView.decks[1].length,
      2: playerView.decks[2].length,
      3: playerView.decks[3].length,
    },
    availableNobleIds: [...playerView.availableNobleIds],
    players: Object.fromEntries(
      playerView.playerOrder.map((ownerID) => {
        const source = playerView.players[ownerID];
        return [
          ownerID,
          {
            tokens: { ...source.tokens },
            purchasedCardIds: [...source.purchasedCardIds],
            reservedCards: source.reservedCards.map((reserved) => ({
              tier: reserved.tier,
              source: reserved.source,
              cardId: reserved.cardId,
            })),
            nobleIds: [...source.nobleIds],
          },
        ];
      }),
    ) as Record<PlayerID, PlayerObservation>,
    playerOrder: [...playerView.playerOrder],
    currentPlayer: ctx.currentPlayer,
    playOrderPos: ctx.playOrderPos,
    turnReady: playerView.turnReady,
    pending: playerView.pending ? JSON.parse(JSON.stringify(playerView.pending)) : null,
    completedTurns: playerView.completedTurns,
    turnCounts: { ...playerView.turnCounts },
    finalRound: playerView.finalRound
      ? JSON.parse(JSON.stringify(playerView.finalRound))
      : null,
    result: playerView.result
      ? JSON.parse(JSON.stringify(playerView.result))
      : null,
  };
  assertObservationIntegrity(observation);
  return observation;
};
