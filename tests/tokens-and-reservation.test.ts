import { describe, expect, it } from 'vitest';

import {
  applyDiscard,
  applyMainAction,
} from '../src/shared/rules/engine.js';
import { emptyTokenCounts } from '../src/shared/constants/colors.js';
import { createTestState } from './helpers.js';

describe('token actions', () => {
  it('takes three distinct available normal colors', () => {
    const state = createTestState();
    const result = applyMainAction(state, '0', '0', {
      type: 'takeDifferent',
      colors: ['white', 'blue', 'green'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.players['0'].tokens).toMatchObject({
      white: 1,
      blue: 1,
      green: 1,
    });
    expect(result.value.bank).toMatchObject({ white: 3, blue: 3, green: 3 });
    expect(result.value.turnReady).toBe(true);
  });

  it('rejects duplicates, gold, unavailable colors, and out-of-turn actions', () => {
    const state = createTestState();
    expect(
      applyMainAction(state, '0', '0', {
        type: 'takeDifferent',
        colors: ['white', 'white', 'blue'],
      }).ok,
    ).toBe(false);
    expect(
      applyMainAction(state, '0', '0', {
        type: 'takeDifferent',
        colors: ['white', 'blue', 'gold'],
      }).ok,
    ).toBe(false);
    state.bank.green = 0;
    expect(
      applyMainAction(state, '0', '0', {
        type: 'takeDifferent',
        colors: ['white', 'blue', 'green'],
      }).ok,
    ).toBe(false);
    expect(
      applyMainAction(state, '1', '0', {
        type: 'takeSame',
        color: 'white',
      }).ok,
    ).toBe(false);
  });

  it('falls back to two tokens when only two colors remain in the bank', () => {
    const state = createTestState();
    state.bank.white = 0;
    state.bank.blue = 0;
    state.bank.green = 0;
    state.bank.red = 2;
    state.bank.black = 3;

    const result = applyMainAction(state, '0', '0', {
      type: 'takeDifferent',
      colors: ['red', 'black'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.players['0'].tokens).toMatchObject({
      red: 1,
      black: 1,
    });
    expect(result.value.bank).toMatchObject({ red: 1, black: 2 });
    expect(result.value.turnReady).toBe(true);
  });

  it('keeps the three-token rule while three or more colors remain', () => {
    const state = createTestState();
    state.bank.green = 0;
    expect(
      applyMainAction(state, '0', '0', {
        type: 'takeDifferent',
        colors: ['white', 'blue'],
      }).ok,
    ).toBe(false);
    expect(
      applyMainAction(state, '0', '0', {
        type: 'takeDifferent',
        colors: ['white', 'blue', 'red'],
      }).ok,
    ).toBe(true);
  });

  it('rejects a three-token take when only two colors remain', () => {
    const state = createTestState();
    state.bank.white = 0;
    state.bank.blue = 0;
    state.bank.green = 0;
    expect(
      applyMainAction(state, '0', '0', {
        type: 'takeDifferent',
        colors: ['red', 'black', 'white'],
      }).ok,
    ).toBe(false);
  });

  it('takes two only when at least four matching tokens remain', () => {
    const state = createTestState();
    const result = applyMainAction(state, '0', '0', {
      type: 'takeSame',
      color: 'red',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.players['0'].tokens.red).toBe(2);
    expect(result.value.bank.red).toBe(2);

    const lowBank = createTestState();
    lowBank.bank.red = 3;
    expect(
      applyMainAction(lowBank, '0', '0', {
        type: 'takeSame',
        color: 'red',
      }).ok,
    ).toBe(false);
    expect(
      applyMainAction(lowBank, '0', '0', {
        type: 'takeSame',
        color: 'gold',
      }).ok,
    ).toBe(false);
  });
});

describe('ten-token limit', () => {
  it('requires an exact discard and blocks other actions', () => {
    const state = createTestState();
    state.players['0'].tokens.white = 3;
    state.players['0'].tokens.blue = 3;
    state.players['0'].tokens.green = 3;

    const taken = applyMainAction(state, '0', '0', {
      type: 'takeDifferent',
      colors: ['white', 'blue', 'green'],
    });
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.value.pending).toEqual({
      type: 'discard',
      playerID: '0',
      count: 2,
    });
    expect(taken.value.turnReady).toBe(false);
    expect(
      applyMainAction(taken.value, '0', '0', {
        type: 'takeSame',
        color: 'red',
      }).ok,
    ).toBe(false);

    const tooFew = emptyTokenCounts();
    tooFew.white = 1;
    expect(applyDiscard(taken.value, '0', '0', tooFew).ok).toBe(false);

    const returned = emptyTokenCounts();
    returned.white = 1;
    returned.gold = 1;
    taken.value.players['0'].tokens.gold = 1;
    const discarded = applyDiscard(taken.value, '0', '0', returned);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(discarded.value.players['0'].tokens.white).toBe(3);
    expect(discarded.value.players['0'].tokens.gold).toBe(0);
    expect(discarded.value.turnReady).toBe(true);
  });

  it('allows different valid return combinations and rejects unowned tokens', () => {
    const state = createTestState();
    state.players['0'].tokens.white = 6;
    state.players['0'].tokens.blue = 5;
    state.pending = { type: 'discard', playerID: '0', count: 1 };
    const invalid = emptyTokenCounts();
    invalid.red = 1;
    expect(applyDiscard(state, '0', '0', invalid).ok).toBe(false);

    const valid = emptyTokenCounts();
    valid.blue = 1;
    const result = applyDiscard(state, '0', '0', valid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.players['0'].tokens.blue).toBe(4);
    }
  });
});

describe('reservation', () => {
  it('reserves a public card, refills its tier, and awards gold', () => {
    const state = createTestState();
    const cardID = state.market[1][0]!;
    const replacement = state.decks[1][0];
    const result = applyMainAction(state, '0', '0', {
      type: 'reserveMarket',
      tier: 1,
      cardId: cardID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.players['0'].reservedCards[0]).toEqual({
      cardId: cardID,
      tier: 1,
      source: 'market',
    });
    expect(result.value.market[1]).toContain(replacement);
    expect(result.value.market[1]).toHaveLength(4);
    expect(result.value.decks[1]).toHaveLength(35);
    expect(result.value.players['0'].tokens.gold).toBe(1);
    expect(result.value.bank.gold).toBe(4);
  });

  it('reserves blindly without logging identity and works without gold', () => {
    const state = createTestState();
    state.bank.gold = 0;
    const hiddenCard = state.decks[2][0];
    const result = applyMainAction(state, '0', '0', {
      type: 'reserveDeck',
      tier: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.players['0'].reservedCards[0].cardId).toBe(hiddenCard);
    expect(result.value.players['0'].tokens.gold).toBe(0);
    expect(result.value.actionLog.at(-1)?.message).not.toContain(hiddenCard);
  });

  it('rejects a fourth reservation, an empty deck, and a stale market ID', () => {
    const state = createTestState();
    state.players['0'].reservedCards = [1, 2, 3].map((tier) => ({
      cardId: state.market[tier as 1 | 2 | 3][0]!,
      tier: tier as 1 | 2 | 3,
      source: 'market' as const,
    }));
    expect(
      applyMainAction(state, '0', '0', {
        type: 'reserveDeck',
        tier: 1,
      }).ok,
    ).toBe(false);

    const empty = createTestState();
    empty.decks[3] = [];
    expect(
      applyMainAction(empty, '0', '0', {
        type: 'reserveDeck',
        tier: 3,
      }).ok,
    ).toBe(false);
    expect(
      applyMainAction(empty, '0', '0', {
        type: 'reserveMarket',
        tier: 1,
        cardId: 'not-a-card',
      }).ok,
    ).toBe(false);
  });
});
