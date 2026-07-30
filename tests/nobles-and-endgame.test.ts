import { describe, expect, it } from 'vitest';

import {
  DEVELOPMENT_CARDS,
  NOBLES,
} from '../src/shared/data/gameData.js';
import {
  applyMainAction,
  applyNobleSelection,
} from '../src/shared/rules/engine.js';
import { getEligibleNobleIDs, getScore } from '../src/shared/rules/selectors.js';
import {
  createTestState,
  grantAtLeastScore,
  grantBonuses,
  resetForNextTurn,
} from './helpers.js';

const quietAction = (state: ReturnType<typeof createTestState>, playerID: string) =>
  applyMainAction(state, playerID, playerID, {
    type: 'takeDifferent',
    colors: ['white', 'blue', 'green'],
  });

const cardIDsForPoints = (points: number[]): string[] => {
  const used = new Set<string>();
  return points.map((point) => {
    const card = DEVELOPMENT_CARDS.find(
      (candidate) => candidate.points === point && !used.has(candidate.id),
    );
    if (!card) throw new Error(`No unused ${point}-point card in test data.`);
    used.add(card.id);
    return card.id;
  });
};

const completeFinalRound = (
  playerZeroPoints: number[],
  playerOnePoints: number[],
) => {
  const state = createTestState();
  state.availableNobleIds = [];
  state.players['0'].purchasedCardIds = cardIDsForPoints(playerZeroPoints);
  state.players['1'].purchasedCardIds = cardIDsForPoints(playerOnePoints);
  state.finalRound = { triggeredBy: '0', triggeredAtCompletedTurn: 1 };
  state.turnCounts['0'] = 1;
  state.completedTurns = 1;
  const completed = quietAction(state, '1');
  if (!completed.ok) throw new Error(completed.errors[0].message);
  return completed.value.result!;
};

describe('nobles', () => {
  it('uses only permanent bonuses and automatically awards exactly one', () => {
    const state = createTestState();
    const noble = NOBLES[0];
    state.availableNobleIds = [noble.id];
    state.players['0'].tokens.white = 7;
    state.players['0'].tokens.blue = 7;
    expect(getEligibleNobleIDs(state, '0')).toEqual([]);

    state.players['0'].tokens.white = 0;
    state.players['0'].tokens.blue = 0;
    grantBonuses(state, '0', noble.requirement);
    const result = quietAction(state, '0');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.players['0'].nobleIds).toEqual([noble.id]);
    expect(result.value.availableNobleIds).not.toContain(noble.id);
    expect(getScore(result.value, '0')).toBeGreaterThanOrEqual(3);
  });

  it('requires a choice among multiple eligible nobles and awards at most one', () => {
    const state = createTestState();
    const nobles = NOBLES.slice(0, 2);
    state.availableNobleIds = nobles.map((noble) => noble.id);
    const maximumRequirements = { white: 0, blue: 0, green: 0, red: 0, black: 0 };
    for (const noble of nobles) {
      for (const color of Object.keys(maximumRequirements) as Array<
        keyof typeof maximumRequirements
      >) {
        maximumRequirements[color] = Math.max(
          maximumRequirements[color],
          noble.requirement[color],
        );
      }
    }
    grantBonuses(state, '0', maximumRequirements);
    const action = quietAction(state, '0');
    expect(action.ok).toBe(true);
    if (!action.ok) return;
    expect(action.value.pending?.type).toBe('noble');
    expect(action.value.turnReady).toBe(false);
    expect(quietAction(action.value, '0').ok).toBe(false);

    expect(
      applyNobleSelection(action.value, '0', '0', 'N-999').ok,
    ).toBe(false);
    const selected = applyNobleSelection(
      action.value,
      '0',
      '0',
      nobles[1].id,
    );
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.value.players['0'].nobleIds).toEqual([nobles[1].id]);
    expect(selected.value.turnReady).toBe(true);
  });
});

describe('end game', () => {
  it('does not trigger below 15 and triggers at 15 or more', () => {
    const below = createTestState();
    grantAtLeastScore(below, '0', 14);
    while (getScore(below, '0') >= 15) {
      below.players['0'].purchasedCardIds.pop();
    }
    const normal = quietAction(below, '0');
    expect(normal.ok).toBe(true);
    if (normal.ok) expect(normal.value.finalRound).toBeNull();

    const threshold = createTestState();
    grantAtLeastScore(threshold, '0', 15);
    const triggered = quietAction(threshold, '0');
    expect(triggered.ok).toBe(true);
    if (triggered.ok) {
      expect(triggered.value.finalRound?.triggeredBy).toBe('0');
    }
  });

  it('finishes after equal turns when the first player triggers', () => {
    const state = createTestState(3);
    grantAtLeastScore(state, '0', 15);
    const first = quietAction(state, '0');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.result).toBeNull();

    resetForNextTurn(first.value);
    const middle = quietAction(first.value, '1');
    expect(middle.ok).toBe(true);
    if (!middle.ok) return;
    expect(middle.value.result).toBeNull();

    resetForNextTurn(middle.value);
    const last = quietAction(middle.value, '2');
    expect(last.ok).toBe(true);
    if (last.ok) {
      expect(last.value.result).not.toBeNull();
      expect(new Set(Object.values(last.value.turnCounts)).size).toBe(1);
    }
  });

  it('finishes correctly when a middle or last player triggers', () => {
    const middleState = createTestState(3);
    middleState.turnCounts['0'] = 1;
    middleState.completedTurns = 1;
    grantAtLeastScore(middleState, '1', 15);
    const middle = quietAction(middleState, '1');
    expect(middle.ok).toBe(true);
    if (!middle.ok) return;
    expect(middle.value.result).toBeNull();
    resetForNextTurn(middle.value);
    const afterMiddle = quietAction(middle.value, '2');
    expect(afterMiddle.ok).toBe(true);
    if (afterMiddle.ok) expect(afterMiddle.value.result).not.toBeNull();

    const lastState = createTestState(3);
    lastState.turnCounts['0'] = 1;
    lastState.turnCounts['1'] = 1;
    lastState.completedTurns = 2;
    grantAtLeastScore(lastState, '2', 15);
    const last = quietAction(lastState, '2');
    expect(last.ok).toBe(true);
    if (last.ok) expect(last.value.result).not.toBeNull();
  });

  it('awards the highest score', () => {
    const result = completeFinalRound([5, 5, 3, 3], [5, 5, 5]);
    expect(result.standings.map((entry) => entry.score)).toEqual([16, 15]);
    expect(result.winners).toEqual(['0']);
  });

  it('breaks a score tie in favor of fewer purchased cards', () => {
    const result = completeFinalRound([5, 5, 5], [5, 4, 3, 3]);
    expect(result.standings[0]).toMatchObject({
      playerID: '0',
      score: 15,
      purchasedCardCount: 3,
    });
    expect(result.winners).toEqual(['0']);
  });

  it('declares shared winners when score and card count remain tied', () => {
    const result = completeFinalRound([5, 5, 5], [5, 5, 5]);
    expect(result.winners).toEqual(['0', '1']);
  });
});
