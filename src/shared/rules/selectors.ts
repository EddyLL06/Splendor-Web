import { NORMAL_COLORS, emptyGemCounts, emptyTokenCounts } from '../constants/colors.js';
import { getCard, getNoble, requireCard, requireNoble } from '../data/gameData.js';
import type {
  CardLocation,
  DevelopmentCard,
  FinalStanding,
  GemCounts,
  PaymentAnalysis,
  PlayerID,
  RuleError,
  RuleResult,
  SplendorState,
  TokenColor,
  TokenCounts,
} from '../types/game.js';

export const playerLabel = (playerID: PlayerID): string =>
  `Player ${Number(playerID) + 1}`;

export const totalTokens = (tokens: TokenCounts): number =>
  Object.values(tokens).reduce((total, count) => total + count, 0);

export const getBonuses = (
  state: SplendorState,
  playerID: PlayerID,
): GemCounts => {
  const bonuses = emptyGemCounts();
  for (const cardID of state.players[playerID]?.purchasedCardIds ?? []) {
    const card = getCard(cardID);
    if (card) {
      bonuses[card.bonus] += 1;
    }
  }
  return bonuses;
};

export const getScore = (
  state: SplendorState,
  playerID: PlayerID,
): number => {
  const player = state.players[playerID];
  if (!player) return 0;
  const cardPoints = player.purchasedCardIds.reduce(
    (total, cardID) => total + (getCard(cardID)?.points ?? 0),
    0,
  );
  const noblePoints = player.nobleIds.reduce(
    (total, nobleID) => total + (getNoble(nobleID)?.points ?? 0),
    0,
  );
  return cardPoints + noblePoints;
};

export const getEligibleNobleIDs = (
  state: SplendorState,
  playerID: PlayerID,
): string[] => {
  const bonuses = getBonuses(state, playerID);
  return state.availableNobleIds.filter((nobleID) => {
    const noble = getNoble(nobleID);
    return (
      noble !== undefined &&
      NORMAL_COLORS.every(
        (color) => bonuses[color] >= noble.requirement[color],
      )
    );
  });
};

export const effectiveCostForCard = (
  state: SplendorState,
  playerID: PlayerID,
  card: DevelopmentCard,
): GemCounts => {
  const bonuses = getBonuses(state, playerID);
  const effective = emptyGemCounts();
  for (const color of NORMAL_COLORS) {
    effective[color] = Math.max(0, card.cost[color] - bonuses[color]);
  }
  return effective;
};

const paymentShapeErrors = (payment: TokenCounts): RuleError[] => {
  if (!payment || typeof payment !== 'object') {
    return [{ code: 'PAYMENT_SHAPE', message: 'Payment is missing.' }];
  }
  const errors: RuleError[] = [];
  for (const color of [...NORMAL_COLORS, 'gold'] as const) {
    const amount = payment[color];
    if (!Number.isSafeInteger(amount) || amount < 0) {
      errors.push({
        code: 'PAYMENT_AMOUNT',
        message: `${color} payment must be a non-negative integer.`,
      });
    }
  }
  return errors;
};

export const analyzePayment = (
  state: SplendorState,
  playerID: PlayerID,
  card: DevelopmentCard,
  proposedPayment?: TokenCounts,
): PaymentAnalysis => {
  const player = state.players[playerID];
  const effectiveCost = effectiveCostForCard(state, playerID, card);
  const suggestedPayment = emptyTokenCounts();
  let suggestedGold = 0;

  if (player) {
    for (const color of NORMAL_COLORS) {
      suggestedPayment[color] = Math.min(
        effectiveCost[color],
        player.tokens[color],
      );
      suggestedGold += effectiveCost[color] - suggestedPayment[color];
    }
  }
  suggestedPayment.gold = suggestedGold;

  const errors: RuleError[] = [];
  if (!player) {
    errors.push({ code: 'PLAYER_NOT_FOUND', message: 'Player was not found.' });
    return { effectiveCost, suggestedPayment, errors };
  }

  const payment = proposedPayment ?? suggestedPayment;
  const shapeErrors = paymentShapeErrors(payment);
  if (shapeErrors.length > 0) {
    return { effectiveCost, suggestedPayment, errors: shapeErrors };
  }

  let remainingCost = 0;
  for (const color of NORMAL_COLORS) {
    const amount = payment[color];
    if (amount > player.tokens[color]) {
      errors.push({
        code: 'PAYMENT_NOT_OWNED',
        message: `You do not own ${amount} ${color} tokens.`,
      });
    }
    if (amount > effectiveCost[color]) {
      errors.push({
        code: 'PAYMENT_OVERPAY',
        message: `${color} payment exceeds the effective cost.`,
      });
    }
    remainingCost += Math.max(0, effectiveCost[color] - amount);
  }

  if (payment.gold !== remainingCost) {
    errors.push({
      code: 'PAYMENT_GOLD_MISMATCH',
      message: `Gold payment must be exactly ${remainingCost}.`,
    });
  }
  if (payment.gold > player.tokens.gold) {
    errors.push({
      code: 'PAYMENT_NOT_ENOUGH_GOLD',
      message: `You need ${payment.gold} gold but own ${player.tokens.gold}.`,
    });
  }

  return { effectiveCost, suggestedPayment, errors };
};

export const findPurchasableCard = (
  state: SplendorState,
  playerID: PlayerID,
  location: CardLocation,
): RuleResult<DevelopmentCard> => {
  if (!location || typeof location !== 'object') {
    return {
      ok: false,
      errors: [{ code: 'CARD_LOCATION', message: 'Card location is missing.' }],
    };
  }

  if (location.source === 'market') {
    if (
      ![1, 2, 3].includes(location.tier) ||
      typeof location.cardId !== 'string' ||
      !state.market[location.tier]?.includes(location.cardId)
    ) {
      return {
        ok: false,
        errors: [
          {
            code: 'CARD_NOT_IN_MARKET',
            message: 'That card is no longer in the market.',
          },
        ],
      };
    }
    const card = getCard(location.cardId);
    if (!card || card.tier !== location.tier) {
      return {
        ok: false,
        errors: [{ code: 'CARD_UNKNOWN', message: 'Card data is invalid.' }],
      };
    }
    return { ok: true, value: card };
  }

  if (location.source === 'reserved') {
    if (typeof location.cardId !== 'string') {
      return {
        ok: false,
        errors: [{ code: 'CARD_UNKNOWN', message: 'Card data is invalid.' }],
      };
    }
    const reserved = state.players[playerID]?.reservedCards.find(
      (entry) => entry.cardId === location.cardId,
    );
    const card = reserved ? getCard(location.cardId) : undefined;
    if (!reserved || !card) {
      return {
        ok: false,
        errors: [
          {
            code: 'CARD_NOT_RESERVED',
            message: 'That card is not in your reserved cards.',
          },
        ],
      };
    }
    return { ok: true, value: card };
  }

  return {
    ok: false,
    errors: [{ code: 'CARD_LOCATION', message: 'Card location is invalid.' }],
  };
};

export const createStandings = (state: SplendorState): FinalStanding[] =>
  state.playerOrder
    .map((playerID) => ({
      playerID,
      score: getScore(state, playerID),
      purchasedCardCount: state.players[playerID].purchasedCardIds.length,
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.purchasedCardCount - right.purchasedCardCount ||
        state.playerOrder.indexOf(left.playerID) -
          state.playerOrder.indexOf(right.playerID),
    );

export const validateStateReferences = (state: SplendorState): void => {
  for (const tier of [1, 2, 3] as const) {
    for (const cardID of [...state.decks[tier], ...state.market[tier]]) {
      requireCard(cardID);
    }
  }
  for (const nobleID of state.availableNobleIds) {
    requireNoble(nobleID);
  }
};

export const formatTokenSelection = (counts: Partial<TokenCounts>): string =>
  ([...NORMAL_COLORS, 'gold'] as TokenColor[])
    .filter((color) => (counts[color] ?? 0) > 0)
    .map((color) => `${counts[color]} ${color}`)
    .join(', ');
