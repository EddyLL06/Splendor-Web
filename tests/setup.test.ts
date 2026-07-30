import { describe, expect, it } from 'vitest';

import { NORMAL_COLORS } from '../src/shared/constants/colors.js';
import { createInitialState } from '../src/shared/rules/setup.js';
import { identityRandom } from './helpers.js';

describe('game setup', () => {
  it.each([
    [2, 4, 3],
    [3, 5, 4],
    [4, 7, 5],
  ])(
    'sets up %i players with correct tokens and nobles',
    (players, tokenCount, nobleCount) => {
      const state = createInitialState(players, identityRandom);
      expect(Object.keys(state.players)).toHaveLength(players);
      expect(state.availableNobleIds).toHaveLength(nobleCount);
      expect(state.bank.gold).toBe(5);
      for (const color of NORMAL_COLORS) {
        expect(state.bank[color]).toBe(tokenCount);
      }
      expect(state.initialFirstPlayer).toBe('0');
      expect(state.playerOrder).toEqual(
        Array.from({ length: players }, (_, index) => String(index)),
      );
    },
  );

  it('reveals four cards from each independently prepared tier', () => {
    const state = createInitialState(4, identityRandom);
    expect(state.market[1]).toHaveLength(4);
    expect(state.market[2]).toHaveLength(4);
    expect(state.market[3]).toHaveLength(4);
    expect(state.decks[1]).toHaveLength(36);
    expect(state.decks[2]).toHaveLength(26);
    expect(state.decks[3]).toHaveLength(16);
  });

  it('uses the supported random API for the first player and shuffles', () => {
    const shuffleCalls: number[] = [];
    const state = createInitialState(3, {
      Shuffle: <T>(items: T[]): T[] => {
        shuffleCalls.push(items.length);
        return [...items].reverse();
      },
      Die: (sides) => sides,
    });
    expect(state.initialFirstPlayer).toBe('2');
    expect(shuffleCalls).toEqual([40, 30, 20, 10]);
  });

  it('rejects unsupported player counts', () => {
    expect(() => createInitialState(1, identityRandom)).toThrow(/2 to 4/);
    expect(() => createInitialState(5, identityRandom)).toThrow(/2 to 4/);
  });
});
