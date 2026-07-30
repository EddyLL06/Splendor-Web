import { emptyTokenCounts, NORMAL_COLORS } from '../constants/colors.js';
import { cardsForTier, NOBLES } from '../data/gameData.js';
import type {
  GameSetupRandom,
  PlayerState,
  SplendorState,
  Tier,
} from '../types/game.js';

const NORMAL_TOKEN_COUNT: Record<number, number> = {
  2: 4,
  3: 5,
  4: 7,
};

const NOBLE_COUNT: Record<number, number> = {
  2: 3,
  3: 4,
  4: 5,
};

const createPlayer = (): PlayerState => ({
  tokens: emptyTokenCounts(),
  purchasedCardIds: [],
  reservedCards: [],
  nobleIds: [],
});

export const createInitialState = (
  numPlayers: number,
  random: GameSetupRandom,
): SplendorState => {
  if (!Number.isSafeInteger(numPlayers) || numPlayers < 2 || numPlayers > 4) {
    throw new Error('Gem Council supports exactly 2 to 4 players.');
  }

  const playerOrder = Array.from({ length: numPlayers }, (_, index) =>
    String(index),
  );
  const firstPlayerIndex = random.Die(numPlayers) - 1;
  const initialFirstPlayer = playerOrder[firstPlayerIndex];
  const players = Object.fromEntries(
    playerOrder.map((playerID) => [playerID, createPlayer()]),
  );
  const turnCounts = Object.fromEntries(
    playerOrder.map((playerID) => [playerID, 0]),
  );

  const decks = {} as Record<Tier, string[]>;
  const market = {} as Record<Tier, string[]>;
  for (const tier of [1, 2, 3] as const) {
    const shuffled = random.Shuffle(
      cardsForTier(tier).map((card) => card.id),
    );
    market[tier] = shuffled.slice(0, 4);
    decks[tier] = shuffled.slice(4);
  }

  const normalCount = NORMAL_TOKEN_COUNT[numPlayers];
  const bank = emptyTokenCounts();
  for (const color of NORMAL_COLORS) {
    bank[color] = normalCount;
  }
  bank.gold = 5;

  return {
    bank,
    decks,
    market,
    availableNobleIds: random
      .Shuffle(NOBLES.map((noble) => noble.id))
      .slice(0, NOBLE_COUNT[numPlayers]),
    players,
    playerOrder,
    initialFirstPlayer,
    pending: null,
    turnReady: false,
    completedTurns: 0,
    turnCounts,
    finalRound: null,
    actionLog: [],
    nextLogID: 1,
    result: null,
  };
};
