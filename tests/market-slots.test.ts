import { describe, expect, it } from 'vitest';

import { requireCard } from '../src/shared/data/gameData.js';
import { applyMainAction } from '../src/shared/rules/engine.js';
import { createTestState, paymentForCost } from './helpers.js';

describe('stable market slots', () => {
  it.each([0, 1, 2, 3])('replaces purchased slot %i without moving another card', (slotIndex) => {
    const state = createTestState();
    const cardID = state.market[1][slotIndex]!;
    const card = requireCard(cardID);
    const beforeSlots = [...state.market[1]];
    const beforeDeck = [...state.decks[1]];
    state.players['0'].tokens = paymentForCost(card.cost);

    const result = applyMainAction(state, '0', '0', {
      type: 'purchase',
      location: { source: 'market', tier: 1, cardId: cardID },
      payment: paymentForCost(card.cost),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.market[1][slotIndex]).toBe(beforeDeck[0]);
    expect(result.value.decks[1]).toEqual(beforeDeck.slice(1));
    for (const otherIndex of [0, 1, 2, 3]) {
      if (otherIndex !== slotIndex) {
        expect(result.value.market[1][otherIndex]).toBe(beforeSlots[otherIndex]);
      }
    }
    expect(result.value.actionLog.at(-1)?.animation).toMatchObject({
      type: 'market-card',
      action: 'purchase',
      tier: 1,
      slotIndex,
      cardId: cardID,
      replacementCardId: beforeDeck[0],
    });
  });

  it('replaces a visibly reserved card in the same slot and preserves deck order', () => {
    const state = createTestState();
    const slotIndex = 2;
    const cardID = state.market[2][slotIndex]!;
    const beforeSlots = [...state.market[2]];
    const beforeDeck = [...state.decks[2]];

    const result = applyMainAction(state, '0', '0', {
      type: 'reserveMarket',
      tier: 2,
      cardId: cardID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.market[2][slotIndex]).toBe(beforeDeck[0]);
    expect(result.value.decks[2]).toEqual(beforeDeck.slice(1));
    expect(result.value.market[2].filter((_, index) => index !== slotIndex)).toEqual(
      beforeSlots.filter((_, index) => index !== slotIndex),
    );
    expect(result.value.actionLog.at(-1)?.animation).toEqual({
      type: 'market-card',
      action: 'reserve',
      playerID: '0',
      tier: 2,
      slotIndex,
      cardId: cardID,
      replacementCardId: beforeDeck[0],
    });
  });

  it('leaves an explicit empty slot when the tier deck is exhausted', () => {
    const state = createTestState();
    const slotIndex = 1;
    const cardID = state.market[3][slotIndex]!;
    const card = requireCard(cardID);
    state.decks[3] = [];
    state.players['0'].tokens = paymentForCost(card.cost);

    const result = applyMainAction(state, '0', '0', {
      type: 'purchase',
      location: { source: 'market', tier: 3, cardId: cardID },
      payment: paymentForCost(card.cost),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.market[3]).toHaveLength(4);
    expect(result.value.market[3][slotIndex]).toBeNull();
    expect(result.value.actionLog.at(-1)?.animation).toMatchObject({
      slotIndex,
      replacementCardId: null,
    });
  });

  it('rejects purchase and reservation attempts against an empty slot', () => {
    const state = createTestState();
    const removedCardID = state.market[1][1]!;
    const card = requireCard(removedCardID);
    state.market[1][1] = null;
    state.players['0'].tokens = paymentForCost(card.cost);

    expect(
      applyMainAction(state, '0', '0', {
        type: 'purchase',
        location: { source: 'market', tier: 1, cardId: removedCardID },
        payment: paymentForCost(card.cost),
      }).ok,
    ).toBe(false);
    expect(
      applyMainAction(state, '0', '0', {
        type: 'reserveMarket',
        tier: 1,
        cardId: removedCardID,
      }).ok,
    ).toBe(false);
  });

  it('publishes a reserved-purchase animation only after the card is bought', () => {
    const state = createTestState();
    const cardID = state.decks[1].shift()!;
    const card = requireCard(cardID);
    state.players['0'].reservedCards.push({ cardId: cardID, tier: 1, source: 'deck' });
    state.players['0'].tokens = paymentForCost(card.cost);

    const result = applyMainAction(state, '0', '0', {
      type: 'purchase',
      location: { source: 'reserved', cardId: cardID },
      payment: paymentForCost(card.cost),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.actionLog.at(-1)?.animation).toEqual({
      type: 'reserved-purchase',
      playerID: '0',
      cardId: cardID,
    });
  });
});
