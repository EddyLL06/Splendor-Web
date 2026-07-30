import {
  DEVELOPMENT_CARDS,
  NOBLES,
} from '../src/shared/data/gameData.js';
import { createInitialState } from '../src/shared/rules/setup.js';
import type {
  GemColor,
  SplendorState,
  TokenCounts,
} from '../src/shared/types/game.js';
import { emptyTokenCounts } from '../src/shared/constants/colors.js';

export const identityRandom = {
  Shuffle: <T>(items: T[]): T[] => [...items],
  Die: (): number => 1,
};

export const createTestState = (numPlayers = 2): SplendorState =>
  createInitialState(numPlayers, identityRandom);

export const paymentForCost = (
  cost: Record<GemColor, number>,
): TokenCounts => ({
  ...cost,
  gold: 0,
});

export const grantBonuses = (
  state: SplendorState,
  playerID: string,
  requirements: Record<GemColor, number>,
  excludedCardID?: string,
): void => {
  const granted: string[] = [];
  for (const [color, count] of Object.entries(requirements) as [
    GemColor,
    number,
  ][]) {
    const candidates = DEVELOPMENT_CARDS.filter(
      (card) =>
        card.bonus === color &&
        card.id !== excludedCardID &&
        !granted.includes(card.id),
    );
    granted.push(...candidates.slice(0, count).map((card) => card.id));
  }
  state.players[playerID].purchasedCardIds.push(...granted);
};

export const grantAtLeastScore = (
  state: SplendorState,
  playerID: string,
  target: number,
): void => {
  let score = 0;
  for (const card of [...DEVELOPMENT_CARDS].sort(
    (left, right) => right.points - left.points,
  )) {
    if (score >= target) break;
    state.players[playerID].purchasedCardIds.push(card.id);
    score += card.points;
  }
};

export const resetForNextTurn = (state: SplendorState): void => {
  state.turnReady = false;
};

export const zeroPayment = (): TokenCounts => emptyTokenCounts();

export const firstNobles = (count: number) =>
  NOBLES.slice(0, count).map((noble) => noble.id);
