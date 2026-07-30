import { describe, expect, it } from 'vitest';

import { emptyTokenCounts, NORMAL_COLORS } from '../src/shared/constants/colors.js';
import { requireCard } from '../src/shared/data/gameData.js';
import { applyMainAction } from '../src/shared/rules/engine.js';
import {
  analyzePayment,
  effectiveCostForCard,
} from '../src/shared/rules/selectors.js';
import {
  createTestState,
  grantBonuses,
  paymentForCost,
  zeroPayment,
} from './helpers.js';

describe('purchasing development cards', () => {
  it('accepts exact colored-token payment and refills the market', () => {
    const state = createTestState();
    const cardID = state.market[1][0];
    const card = requireCard(cardID);
    state.players['0'].tokens = paymentForCost(card.cost);
    const replacement = state.decks[1][0];

    const result = applyMainAction(state, '0', '0', {
      type: 'purchase',
      location: { source: 'market', tier: 1, cardId: cardID },
      payment: paymentForCost(card.cost),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.players['0'].purchasedCardIds).toContain(cardID);
    expect(result.value.market[1]).toContain(replacement);
    expect(result.value.market[1]).toHaveLength(4);
    expect(result.value.decks[1]).toHaveLength(35);
    for (const color of NORMAL_COLORS) {
      expect(result.value.players['0'].tokens[color]).toBe(0);
      expect(result.value.bank[color]).toBe(4 + card.cost[color]);
    }
  });

  it('applies permanent discounts and can make a purchase free', () => {
    const state = createTestState();
    const cardID = state.market[1][0];
    const card = requireCard(cardID);
    grantBonuses(state, '0', card.cost, cardID);
    expect(effectiveCostForCard(state, '0', card)).toEqual({
      white: 0,
      blue: 0,
      green: 0,
      red: 0,
      black: 0,
    });
    const result = applyMainAction(state, '0', '0', {
      type: 'purchase',
      location: { source: 'market', tier: 1, cardId: cardID },
      payment: zeroPayment(),
    });
    expect(result.ok).toBe(true);
  });

  it('uses gold for shortages and permits strategic gold use', () => {
    const state = createTestState();
    const cardID = state.market[1].find((id) =>
      Object.values(requireCard(id).cost).some((value) => value > 0),
    )!;
    const card = requireCard(cardID);
    state.players['0'].tokens = paymentForCost(card.cost);
    state.players['0'].tokens.gold = 1;
    const payment = paymentForCost(card.cost);
    const strategicColor = NORMAL_COLORS.find(
      (color) => payment[color] > 0,
    )!;
    payment[strategicColor] -= 1;
    payment.gold = 1;
    const analysis = analyzePayment(state, '0', card, payment);
    expect(analysis.errors).toEqual([]);

    const result = applyMainAction(state, '0', '0', {
      type: 'purchase',
      location: { source: 'market', tier: 1, cardId: cardID },
      payment,
    });
    expect(result.ok).toBe(true);
  });

  it('computes a normal-first suggested payment', () => {
    const state = createTestState();
    const card = requireCard(state.market[2][0]);
    for (const color of NORMAL_COLORS) {
      state.players['0'].tokens[color] = Math.max(0, card.cost[color] - 1);
    }
    state.players['0'].tokens.gold = 5;
    const analysis = analyzePayment(state, '0', card);
    for (const color of NORMAL_COLORS) {
      expect(analysis.suggestedPayment[color]).toBe(
        Math.min(card.cost[color], state.players['0'].tokens[color]),
      );
    }
    expect(analysis.errors).toEqual([]);
  });

  it('rejects unaffordable, unowned, negative, and overpayments', () => {
    const state = createTestState();
    const cardID = state.market[2][0];
    const card = requireCard(cardID);
    expect(
      applyMainAction(state, '0', '0', {
        type: 'purchase',
        location: { source: 'market', tier: 2, cardId: cardID },
        payment: zeroPayment(),
      }).ok,
    ).toBe(false);

    const unowned = paymentForCost(card.cost);
    expect(analyzePayment(state, '0', card, unowned).errors.length).toBeGreaterThan(0);

    const negative = emptyTokenCounts();
    negative.white = -1;
    expect(analyzePayment(state, '0', card, negative).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PAYMENT_AMOUNT' })]),
    );

    const overpayState = createTestState();
    overpayState.players['0'].tokens.white = 9;
    const overpay = emptyTokenCounts();
    overpay.white = card.cost.white + 1;
    expect(analyzePayment(overpayState, '0', card, overpay).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PAYMENT_OVERPAY' })]),
    );
  });

  it('purchases an owned reserved card but not another player’s card', () => {
    const state = createTestState();
    const cardID = state.decks[1].shift()!;
    const card = requireCard(cardID);
    state.players['0'].reservedCards.push({
      cardId: cardID,
      tier: 1,
      source: 'deck',
    });
    state.players['0'].tokens = paymentForCost(card.cost);
    const purchased = applyMainAction(state, '0', '0', {
      type: 'purchase',
      location: { source: 'reserved', cardId: cardID },
      payment: paymentForCost(card.cost),
    });
    expect(purchased.ok).toBe(true);
    if (purchased.ok) {
      expect(purchased.value.players['0'].reservedCards).toHaveLength(0);
    }

    const other = createTestState();
    other.players['1'].reservedCards.push({
      cardId: cardID,
      tier: 1,
      source: 'deck',
    });
    other.players['0'].tokens = paymentForCost(card.cost);
    expect(
      applyMainAction(other, '0', '0', {
        type: 'purchase',
        location: { source: 'reserved', cardId: cardID },
        payment: paymentForCost(card.cost),
      }).ok,
    ).toBe(false);
  });
});
