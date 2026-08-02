import { describe, expect, it } from 'vitest';

import { applyMainAction } from '../../src/shared/rules/engine.js';
import { analyzePayment } from '../../src/shared/rules/selectors.js';
import {
  enumerateDiscardCandidates,
  enumerateLegalActions,
  enumerateMainActions,
  enumerateNobleCandidates,
} from '../../src/shared/ai/legal-actions.js';
import type { SplendorState, TokenCounts } from '../../src/shared/types/game.js';
import { createTestState } from '../helpers.js';
import { createSeededState } from './helpers.js';

const clone = (state: SplendorState): SplendorState =>
  JSON.parse(JSON.stringify(state)) as SplendorState;

describe('legal action enumeration', () => {
  it('generates only actions accepted by the authoritative rules across seeded states', () => {
    for (const numPlayers of [2, 3, 4] as const) {
      for (let index = 0; index < 10; index += 1) {
        const { state } = createSeededState(numPlayers, `legal:${numPlayers}:${index}`);
        const actor = state.initialFirstPlayer;
        const candidates = enumerateMainActions(state, actor, actor, true);
        expect(candidates.length).toBeGreaterThan(0);
        const keys = new Set(candidates.map((candidate) => candidate.actionKey));
        expect(keys.size).toBe(candidates.length);
        for (const candidate of candidates) {
          const result = applyMainAction(
            clone(state),
            actor,
            actor,
            candidate.move.args[0] as Parameters<typeof applyMainAction>[3],
          );
          expect(result.ok, `${candidate.actionKey} was rejected`).toBe(true);
        }
      }
    }
  });

  it('covers all takeDifferent combinations with bank availability', () => {
    const state = createTestState();
    state.bank = {
      white: 4,
      blue: 4,
      green: 4,
      red: 0,
      black: 4,
      gold: 0,
    };
    const candidates = enumerateMainActions(state, '0', '0');
    const different = candidates.filter((candidate) =>
      candidate.actionKey.startsWith('takeDifferent:'),
    );
    expect(different).toHaveLength(4); // C(4,3) without red
    expect(different.map((candidate) => candidate.actionKey).sort()).toEqual([
      'takeDifferent:blue,green,black',
      'takeDifferent:white,blue,black',
      'takeDifferent:white,blue,green',
      'takeDifferent:white,green,black',
    ]);
    const same = candidates.filter((candidate) =>
      candidate.actionKey.startsWith('takeSame:'),
    );
    expect(same).toHaveLength(4);
  });

  it('generates the two-color fallback when exactly two colors remain', () => {
    const state = createTestState();
    state.bank = {
      white: 0,
      blue: 0,
      green: 0,
      red: 2,
      black: 3,
      gold: 5,
    };
    const candidates = enumerateMainActions(state, '0', '0');
    const different = candidates.filter((candidate) =>
      candidate.actionKey.startsWith('takeDifferent:'),
    );
    expect(different).toHaveLength(1);
    expect(different[0].move.args[0]).toEqual({
      type: 'takeDifferent',
      colors: ['red', 'black'],
    });
  });

  it('stops reserving at the 3-card limit and skips empty decks', () => {
    const state = createTestState();
    const actor = '0';
    state.players[actor].reservedCards = [
      { cardId: 'c1', tier: 1, source: 'market' },
      { cardId: 'c2', tier: 1, source: 'market' },
      { cardId: 'c3', tier: 1, source: 'market' },
    ];
    state.decks[1] = [];
    const candidates = enumerateMainActions(state, actor, actor);
    expect(
      candidates.some((candidate) =>
        candidate.actionKey.startsWith('reserve'),
      ),
    ).toBe(false);
  });

  it('generates exactly one canonical payment per affordable card', () => {
    const state = createTestState();
    const actor = '0';
    const cardID = state.market[1].find((id) => id !== null)!;
    state.players[actor].tokens = {
      white: 5,
      blue: 5,
      green: 5,
      red: 5,
      black: 5,
      gold: 3,
    };
    const candidates = enumerateMainActions(state, actor, actor);
    const purchases = candidates.filter((candidate) =>
      candidate.actionKey.startsWith('purchase:'),
    );
    const forCard = purchases.filter((candidate) =>
      candidate.actionKey.includes(cardID),
    );
    expect(forCard).toHaveLength(1);
    const action = forCard[0].move.args[0];
    expect(action).toMatchObject({ type: 'purchase' });
    // The canonical payment must be accepted by the rules.
    expect(
      applyMainAction(
        clone(state),
        actor,
        actor,
        action as Parameters<typeof applyMainAction>[3],
      ).ok,
    ).toBe(true);
  });

  it('enumerates discard vectors exactly for small overage', () => {
    const state = createTestState();
    state.players['0'].tokens = {
      white: 2,
      blue: 1,
      green: 0,
      red: 1,
      black: 0,
      gold: 1,
    };
    state.pending = { type: 'discard', playerID: '0', count: 2 };
    const candidates = enumerateDiscardCandidates(state, '0');
    const vectors = candidates.map(
      (candidate) => candidate.move.args[0] as TokenCounts,
    );
    const bruteForce: TokenCounts[] = [];
    for (let white = 0; white <= 2; white += 1) {
      for (let blue = 0; blue <= 1; blue += 1) {
        for (let green = 0; green <= 0; green += 1) {
          for (let red = 0; red <= 1; red += 1) {
            for (let black = 0; black <= 0; black += 1) {
              for (let gold = 0; gold <= 1; gold += 1) {
                if (white + blue + green + red + black + gold === 2) {
                  bruteForce.push({ white, blue, green, red, black, gold });
                }
              }
            }
          }
        }
      }
    }
    expect(vectors).toHaveLength(bruteForce.length);
    expect(new Set(vectors.map((value) => JSON.stringify(value)))).toEqual(
      new Set(bruteForce.map((value) => JSON.stringify(value))),
    );
  });

  it('generates only still-eligible noble candidates', () => {
    const state = createTestState();
    // Without matching bonuses no noble is eligible.
    state.pending = {
      type: 'noble',
      playerID: '0',
      eligibleNobleIds: ['noble-1', 'noble-2'],
    };
    expect(enumerateNobleCandidates(state, '0')).toEqual([]);
  });

  it('dispatches by phase and returns nothing for foreign pending', () => {
    const state = createTestState();
    state.pending = { type: 'discard', playerID: '1', count: 1 };
    expect(enumerateLegalActions(state, '0', '0')).toEqual([]);
    expect(enumerateLegalActions(state, '1', '0')).toHaveLength(0);
  });
});
