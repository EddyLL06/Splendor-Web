import { describe, expect, it } from 'vitest';

import { createPlayerView } from '../../src/game/playerView.js';
import { chooseBotMove } from '../../src/shared/ai/policy.js';
import { createObservation } from '../../src/shared/ai/observation.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from '../../src/shared/ai/simulate.js';
import type {
  MainAction,
  SplendorState,
  TokenCounts,
} from '../../src/shared/types/game.js';
import type { BoardContextView } from '../../src/shared/ai/types.js';
import { createTestState, grantBonuses } from '../helpers.js';
import {
  createSeededState,
  removePurchasedFromWorld,
  samePlayerViewStates,
} from './helpers.js';
import { HAND_TUNED_WEIGHTS } from '../../src/shared/ai/models/default.js';

const ctxFor = (state: SplendorState, playerID: string): BoardContextView => ({
  currentPlayer: state.initialFirstPlayer,
  playOrder: state.playerOrder,
  playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
});

const decideNormal = (
  state: SplendorState,
  playerID: string,
  seed = 'normal-seed',
) => {
  const observation = createObservation(
    createPlayerView(state, playerID),
    playerID,
    ctxFor(state, playerID),
  );
  return chooseBotMove(observation, ctxFor(state, playerID), {
    policy: 'normal-v1',
    seed,
    weights: { ...HAND_TUNED_WEIGHTS } as unknown as Record<string, number>,
  });
};

describe('Normal 1-ply policy', () => {
  it('is deterministic per observation and seed', () => {
    const { state } = createSeededState(2, 'normal-det');
    const actor = state.initialFirstPlayer;
    const first = decideNormal(state, actor);
    const second = decideNormal(state, actor);
    expect(second.move).toEqual(first.move);
    expect(second.policy).toBe('normal-v1');
    expect(second.modelVersion).toBe('ai-kernel-v0.1.0');
  });

  it('is invariant to hidden truth', () => {
    const { first, second } = samePlayerViewStates();
    expect(decideNormal(second, '1', 'fair').move).toEqual(
      decideNormal(first, '1', 'fair').move,
    );
  });

  it('only produces moves the authoritative rules accept', () => {
    for (const numPlayers of [2, 3, 4] as const) {
      for (let index = 0; index < 3; index += 1) {
        const { state } = createSeededState(
          numPlayers,
          `normal-legal-${numPlayers}-${index}`,
        );
        const actor = state.initialFirstPlayer;
        const decision = decideNormal(state, actor, `seed-${index}`);
        const sim = createSimulation(
          structuredClone(state),
          ctxFor(state, actor),
        );
        const [argument] = decision.move.args;
        const result =
          decision.move.move === 'mainAction'
            ? applySimulationMainAction(sim, actor, argument as MainAction)
            : decision.move.move === 'discardTokens'
              ? applySimulationDiscard(sim, actor, argument as TokenCounts)
              : applySimulationNoble(sim, actor, argument as string);
        expect(result.ok).toBe(true);
      }
    }
  });

  it('handles discard and noble phases', () => {
    const state = createTestState();
    state.initialFirstPlayer = '0';
    state.players['0'].tokens = {
      white: 2,
      blue: 2,
      green: 2,
      red: 2,
      black: 2,
      gold: 1,
    };
    state.pending = { type: 'discard', playerID: '0', count: 2 };
    expect(decideNormal(state, '0').move.move).toBe('discardTokens');

    state.pending = {
      type: 'noble',
      playerID: '0',
      eligibleNobleIds: [...state.availableNobleIds],
    };
    // Nobles require matching bonuses; without them no noble is eligible and
    // the policy must fail loudly rather than invent a move.
    expect(() => decideNormal(state, '0')).toThrow();
    grantBonuses(state, '0', {
      white: 4,
      blue: 4,
      green: 4,
      red: 4,
      black: 4,
    });
    removePurchasedFromWorld(state);
    expect(decideNormal(state, '0').move.move).toBe('chooseNoble');
  });
});
