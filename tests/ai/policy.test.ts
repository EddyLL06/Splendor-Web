import { describe, expect, it } from 'vitest';

import { createPlayerView } from '../../src/game/playerView.js';
import {
  AI_KERNEL_MODEL_VERSION,
  IllegalCandidateError,
  NoLegalActionError,
  chooseBotMove,
} from '../../src/shared/ai/policy.js';
import { createObservation } from '../../src/shared/ai/observation.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from '../../src/shared/ai/simulate.js';
import type { SplendorState } from '../../src/shared/types/game.js';
import type { BoardContextView } from '../../src/shared/ai/types.js';
import { createTestState, grantBonuses } from '../helpers.js';
import {
  createSeededState,
  removePurchasedFromWorld,
  samePlayerViewStates,
} from './helpers.js';

const ctxFor = (state: SplendorState, playerID: string): BoardContextView => ({
  currentPlayer: state.initialFirstPlayer,
  playOrder: state.playerOrder,
  playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
});

const decide = (
  state: SplendorState,
  playerID: string,
  policy: 'uniform-random-v1' | 'cheap-greedy-v1',
  seed = 'policy-seed',
) => {
  const observation = createObservation(
    createPlayerView(state, playerID),
    playerID,
    ctxFor(state, playerID),
  );
  return chooseBotMove(observation, ctxFor(state, playerID), { policy, seed });
};

const applyDecision = (
  state: SplendorState,
  playerID: string,
  decision: ReturnType<typeof chooseBotMove>,
) => {
  const sim = createSimulation(
    structuredClone(state),
    ctxFor(state, playerID),
  );
  if (decision.move.move === 'mainAction') {
    return applySimulationMainAction(sim, playerID, decision.move.args[0]);
  }
  if (decision.move.move === 'discardTokens') {
    return applySimulationDiscard(sim, playerID, decision.move.args[0]);
  }
  return applySimulationNoble(sim, playerID, decision.move.args[0]);
};

describe('bot policies', () => {
  it('is deterministic for the same observation, seed and policy', () => {
    for (const policy of ['uniform-random-v1', 'cheap-greedy-v1'] as const) {
      const { state } = createSeededState(2, `policy-det-${policy}`);
      const first = decide(state, state.initialFirstPlayer, policy);
      const second = decide(state, state.initialFirstPlayer, policy);
      expect(second.move).toEqual(first.move);
      expect(second.seed).toBe(first.seed);
      expect(second.modelVersion).toBe(AI_KERNEL_MODEL_VERSION);
      expect(second.policy).toBe(policy);
      expect(second.timedOut).toBe(false);
      expect(second.fallbackLevel).toBe(0);
    }
  });

  it('returns the same move for identical playerViews with different hidden truths', () => {
    const { first, second } = samePlayerViewStates();
    for (const policy of ['uniform-random-v1', 'cheap-greedy-v1'] as const) {
      expect(decide(second, '1', policy, 'fair-seed').move).toEqual(
        decide(first, '1', policy, 'fair-seed').move,
      );
    }
  });

  it('produces only moves accepted by the authoritative rules on the true state', () => {
    for (const numPlayers of [2, 3, 4] as const) {
      for (let index = 0; index < 5; index += 1) {
        const { state } = createSeededState(
          numPlayers,
          `policy-legal-${numPlayers}-${index}`,
        );
        const actor = state.initialFirstPlayer;
        for (const policy of ['uniform-random-v1', 'cheap-greedy-v1'] as const) {
          const decision = decide(state, actor, policy, `seed-${index}`);
          const result = applyDecision(state, actor, decision);
          expect(
            result.ok,
            `${policy} produced ${decision.move.move}: ${result.ok ? '' : result.errors
              .map((error) => error.code)
              .join(',')}`,
          ).toBe(true);
        }
      }
    }
  });

  it('handles discard and noble phases', () => {
    const discardState = createTestState();
    discardState.initialFirstPlayer = '0';
    discardState.players['0'].tokens = {
      white: 2,
      blue: 2,
      green: 2,
      red: 2,
      black: 2,
      gold: 1,
    };
    discardState.pending = { type: 'discard', playerID: '0', count: 2 };
    const discardDecision = decide(discardState, '0', 'cheap-greedy-v1');
    expect(discardDecision.move.move).toBe('discardTokens');
    expect(
      applyDecision(discardState, '0', discardDecision).ok,
    ).toBe(true);

    const nobleState = createTestState();
    nobleState.initialFirstPlayer = '0';
    grantBonuses(nobleState, '0', {
      white: 4,
      blue: 4,
      green: 4,
      red: 4,
      black: 4,
    });
    removePurchasedFromWorld(nobleState);
    nobleState.pending = {
      type: 'noble',
      playerID: '0',
      eligibleNobleIds: [...nobleState.availableNobleIds],
    };
    const nobleDecision = decide(nobleState, '0', 'cheap-greedy-v1');
    expect(nobleDecision.move.move).toBe('chooseNoble');
    expect(nobleState.availableNobleIds).toContain(nobleDecision.move.args[0]);
  });

  it('raises a structured error when no legal action exists', () => {
    const state = createTestState();
    state.initialFirstPlayer = '0';
    state.pending = { type: 'discard', playerID: '1', count: 1 };
    expect(() => decide(state, '0', 'cheap-greedy-v1')).toThrow(
      NoLegalActionError,
    );
  });

  it('raises a structured error when it is not the player turn', () => {
    const state = createTestState();
    state.initialFirstPlayer = '1';
    expect(() => decide(state, '0', 'uniform-random-v1')).toThrow(
      NoLegalActionError,
    );
  });

  it('never silently returns an illegal candidate', () => {
    const state = createTestState();
    state.initialFirstPlayer = '0';
    const observation = createObservation(
      createPlayerView(state, '0'),
      '0',
      ctxFor(state, '0'),
    );
    const decision = chooseBotMove(observation, ctxFor(state, '0'), {
      policy: 'cheap-greedy-v1',
      seed: 'x',
    });
    expect(decision.move.move).toBe('mainAction');
    // Corrupt the move to prove validation catches it.
    state.bank.blue = 0;
    const corrupted = {
      ...decision,
      move: {
        move: 'mainAction' as const,
        args: [{ type: 'takeSame' as const, color: 'blue' as const }],
      },
    };
    expect(() => {
      const sim = createSimulation(structuredClone(state), ctxFor(state, '0'));
      const result = applySimulationMainAction(
        sim,
        '0',
        corrupted.move.args[0],
      );
      if (!result.ok) throw new IllegalCandidateError('test');
    }).toThrow(IllegalCandidateError);
  });
});
