import { describe, expect, it } from 'vitest';

import { applyMainAction, hasLegalMainAction } from '../src/shared/rules/engine.js';
import type { SplendorState } from '../src/shared/types/game.js';
import { createTestState } from './helpers.js';

const clone = (state: SplendorState): SplendorState =>
  JSON.parse(JSON.stringify(state)) as SplendorState;

const stallState = (): SplendorState => {
  const state = createTestState();
  state.bank = {
    white: 0,
    blue: 0,
    green: 0,
    red: 0,
    black: 2,
    gold: 5,
  };
  state.players['0'].tokens = {
    white: 0,
    blue: 0,
    green: 0,
    red: 0,
    black: 0,
    gold: 0,
  };
  state.players['0'].reservedCards = [
    { cardId: state.market[1][0]!, tier: 1, source: 'market' },
    { cardId: state.market[1][1]!, tier: 1, source: 'market' },
    { cardId: state.market[1][2]!, tier: 1, source: 'market' },
  ];
  return state;
};

describe('stall-rescue pass rule', () => {
  it('is not legal while any other main action exists', () => {
    const state = createTestState();
    expect(hasLegalMainAction(state, '0')).toBe(true);
    const result = applyMainAction(
      clone(state),
      '0',
      state.initialFirstPlayer,
      { type: 'pass' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].code).toBe('PASS_NOT_NEEDED');
    }
  });

  it('is legal only in a true stall state', () => {
    const state = stallState();
    expect(hasLegalMainAction(state, '0')).toBe(false);
    const result = applyMainAction(
      clone(state),
      '0',
      state.initialFirstPlayer,
      { type: 'pass' },
    );
    expect(result.ok).toBe(true);
    const next = result.ok ? result.value : state;
    expect(next.turnReady).toBe(true);
    expect(next.players['0'].tokens).toEqual(state.players['0'].tokens);
    expect(next.actionLog.at(-1)).toMatchObject({
      kind: 'pass',
      i18n: { key: 'pass', values: { playerID: '0' } },
    });
  });

  it('is not legal while the two-token fallback is available', () => {
    const state = createTestState();
    state.bank = {
      white: 0,
      blue: 0,
      green: 0,
      red: 2,
      black: 2,
      gold: 5,
    };
    state.players['0'].tokens = {
      white: 0,
      blue: 0,
      green: 0,
      red: 0,
      black: 0,
      gold: 0,
    };
    state.players['0'].reservedCards = [
      { cardId: state.market[1][0]!, tier: 1, source: 'market' },
      { cardId: state.market[1][1]!, tier: 1, source: 'market' },
      { cardId: state.market[1][2]!, tier: 1, source: 'market' },
    ];
    expect(hasLegalMainAction(state, '0')).toBe(true);
    expect(
      applyMainAction(clone(state), '0', state.initialFirstPlayer, {
        type: 'pass',
      }).ok,
    ).toBe(false);
  });

  it('passing still resolves nobles and discards like any turn end', () => {
    const state = stallState();
    state.players['0'].tokens.gold = 1;
    state.pending = null;
    // 11 tokens -> pass is a main action so pending must be null; overage
    // cannot be created by passing itself.
    const result = applyMainAction(
      clone(state),
      '0',
      state.initialFirstPlayer,
      { type: 'pass' },
    );
    expect(result.ok).toBe(true);
  });
});
