/**
 * Normalized feature vector (DEVELOPMENT_GUIDE.md §8.2). All features are
 * clamped to bounded ranges so no single feature can dominate early engine
 * building. Feature version is part of the model contract.
 */

import { analyzePayment, getBonuses, getScore } from '../rules/selectors.js';
import { getCard, getNoble } from '../data/gameData.js';
import type { PlayerID, SplendorState, TokenColor } from '../types/game.js';

export const FEATURE_NAMES = [
  'score',
  'leaderGap',
  'distanceTo15',
  'bonusWhite',
  'bonusBlue',
  'bonusGreen',
  'bonusRed',
  'bonusBlack',
  'bonusBalance',
  'purchasedCount',
  'nobleProgress',
  'nobleCount',
  'tokensTotal',
  'gold',
  'affordableCount',
  'waste',
  'reservedSlots',
  'opponentMaxScore',
  'opponentNobleThreat',
  'blockingValue',
  'tempo',
  'tiebreakCards',
  'marketValue1',
  'marketValue2',
  'marketValue3',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureVector = Record<FeatureName, number>;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const nobleCloseness = (state: SplendorState, playerID: PlayerID): number => {
  const bonuses = getBonuses(state, playerID);
  const scores: number[] = [];
  for (const nobleID of state.availableNobleIds) {
    const noble = getNoble(nobleID);
    if (!noble) continue;
    let achieved = 0;
    let required = 0;
    for (const [color, count] of Object.entries(noble.requirement) as [
      'white' | 'blue' | 'green' | 'red' | 'black',
      number,
    ][]) {
      required += count;
      achieved += Math.min(bonuses[color], count);
    }
    if (required > 0) scores.push(achieved / required);
  }
  return scores.length === 0
    ? 0
    : scores.reduce((sum, value) => sum + value, 0) / scores.length;
};

const affordableCards = (state: SplendorState, playerID: PlayerID): number => {
  let count = 0;
  for (const tier of [1, 2, 3] as const) {
    for (const cardID of state.market[tier]) {
      if (cardID === null) continue;
      const card = getCard(cardID);
      if (card && analyzePayment(state, playerID, card).errors.length === 0) {
        count += 1;
      }
    }
  }
  for (const reserved of state.players[playerID]?.reservedCards ?? []) {
    if (reserved.cardId === null) continue;
    const card = getCard(reserved.cardId);
    if (card && analyzePayment(state, playerID, card).errors.length === 0) {
      count += 1;
    }
  }
  return count;
};

const marketValue = (state: SplendorState, tier: 1 | 2 | 3): number => {
  let points = 0;
  for (const cardID of state.market[tier]) {
    if (cardID !== null) points += getCard(cardID)?.points ?? 0;
  }
  return points;
};

export const extractFeatures = (
  state: SplendorState,
  playerID: PlayerID,
): FeatureVector => {
  const player = state.players[playerID];
  const ownScore = getScore(state, playerID);
  const opponentScores = state.playerOrder
    .filter((other) => other !== playerID)
    .map((other) => getScore(state, other));
  const leaderGap = ownScore - Math.max(0, ...opponentScores);
  const bonuses = getBonuses(state, playerID);
  const bonusValues = Object.values(bonuses);
  const bonusMean =
    bonusValues.reduce((sum, value) => sum + value, 0) / bonusValues.length;
  const bonusStdDev = Math.sqrt(
    bonusValues.reduce(
      (sum, value) => sum + (value - bonusMean) ** 2,
      0,
    ) / bonusValues.length,
  );
  const affordable = player ? affordableCards(state, playerID) : 0;
  const strongestOpponent = state.playerOrder
    .filter((other) => other !== playerID)
    .sort((left, right) => getScore(state, right) - getScore(state, left))[0];
  const opponentNobleThreat = strongestOpponent
    ? nobleCloseness(state, strongestOpponent)
    : 0;
  let blockingValue = 0;
  if (strongestOpponent) {
    for (const tier of [1, 2, 3] as const) {
      for (const cardID of state.market[tier]) {
        if (cardID === null) continue;
        const card = getCard(cardID);
        if (
          card &&
          analyzePayment(state, strongestOpponent, card).errors.length === 0
        ) {
          blockingValue += card.points;
        }
      }
    }
  }

  return {
    score: clamp(ownScore / 15, 0, 1),
    leaderGap: clamp(leaderGap / 15, -1, 1),
    distanceTo15: clamp((15 - ownScore) / 15, 0, 1),
    bonusWhite: clamp(bonuses.white / 10, 0, 1),
    bonusBlue: clamp(bonuses.blue / 10, 0, 1),
    bonusGreen: clamp(bonuses.green / 10, 0, 1),
    bonusRed: clamp(bonuses.red / 10, 0, 1),
    bonusBlack: clamp(bonuses.black / 10, 0, 1),
    bonusBalance: clamp(1 - bonusStdDev / 5, 0, 1),
    purchasedCount: clamp((player?.purchasedCardIds.length ?? 0) / 25, 0, 1),
    nobleProgress: clamp(nobleCloseness(state, playerID), 0, 1),
    nobleCount: clamp((player?.nobleIds.length ?? 0) / 5, 0, 1),
    tokensTotal: clamp(
      Object.values(player?.tokens ?? {}).reduce(
        (sum, count) => sum + count,
        0,
      ) / 10,
      0,
      1,
    ),
    gold: clamp((player?.tokens.gold ?? 0) / 5, 0, 1),
    affordableCount: clamp(affordable / 15, 0, 1),
    waste:
      state.pending?.type === 'discard' && state.pending.playerID === playerID
        ? clamp(state.pending.count / 5, 0, 1)
        : 0,
    reservedSlots: clamp((player?.reservedCards.length ?? 0) / 3, 0, 1),
    opponentMaxScore: clamp(Math.max(0, ...opponentScores) / 15, 0, 1),
    opponentNobleThreat: clamp(opponentNobleThreat, 0, 1),
    blockingValue: clamp(blockingValue / 10, 0, 1),
    tempo: clamp(1 / (1 + affordable), 0, 1),
    tiebreakCards: clamp((player?.purchasedCardIds.length ?? 0) / 25, 0, 1),
    marketValue1: clamp(marketValue(state, 1) / 20, 0, 1),
    marketValue2: clamp(marketValue(state, 2) / 20, 0, 1),
    marketValue3: clamp(marketValue(state, 3) / 20, 0, 1),
  };
};

export const emptyFeatureVector = (): FeatureVector =>
  Object.fromEntries(FEATURE_NAMES.map((name) => [name, 0])) as FeatureVector;
