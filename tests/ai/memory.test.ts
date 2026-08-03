import { describe, expect, it } from 'vitest';

import { createPlayerView } from '../../src/game/playerView.js';
import { createObservation } from '../../src/shared/ai/observation.js';
import {
  seedMemoryFromObservation,
  updateMemory,
  type ExpertMemorySnapshot,
} from '../../src/shared/ai/memory.js';
import { analyzePayment } from '../../src/shared/rules/selectors.js';
import { getCard } from '../../src/shared/data/gameData.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  createSimulation,
} from '../../src/shared/ai/simulate.js';
import type { SplendorState } from '../../src/shared/types/game.js';
import type { BoardContextView } from '../../src/shared/ai/types.js';
import { createSeededState, samePlayerViewStates } from './helpers.js';

const ctxFor = (state: SplendorState, playerID: string): BoardContextView => ({
  currentPlayer: state.initialFirstPlayer,
  playOrder: state.playerOrder,
  playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
});

const observe = (state: SplendorState, playerID: string) =>
  createObservation(
    createPlayerView(state, playerID),
    playerID,
    ctxFor(state, playerID),
  );

describe('Expert match memory', () => {
  it('baselines from the first observation without inventing actions', () => {
    const { state } = createSeededState(2, 'memory-baseline');
    const memory = seedMemoryFromObservation(
      observe(state, state.initialFirstPlayer),
    );
    expect(memory.completedTurns).toBe(0);
    for (const entry of Object.values(memory.players)) {
      expect(entry.lastAction).toBe('unknown');
      expect(entry.lastActionTurnsAgo).toBe(0);
      expect(entry.purchases).toBe(0);
    }
  });

  it('detects a take action, records colors, and ages other players', () => {
    const { state } = createSeededState(2, 'memory-take');
    const actor = state.initialFirstPlayer;
    let memory = seedMemoryFromObservation(observe(state, actor));
    const sim = createSimulation(structuredClone(state), ctxFor(state, actor));
    const colors = ['white', 'blue', 'green'] as const;
    const result = applySimulationMainAction(sim, actor, {
      type: 'takeDifferent',
      colors: [...colors],
    });
    expect(result.ok).toBe(true);
    memory = updateMemory(memory, observe(sim.G, actor));
    expect(memory.players[actor].lastAction).toBe('take');
    expect(memory.players[actor].lastActionTurnsAgo).toBe(0);
    expect([...memory.players[actor].recentTakeQueue].sort()).toEqual([
      'blue',
      'green',
      'white',
    ]);
    expect(memory.players[actor].turnCount).toBe(1);
    const opponent = state.playerOrder.find(
      (playerID) => playerID !== actor,
    )!;
    expect(memory.players[opponent].lastActionTurnsAgo).toBe(1);
  });

  it('detects a purchase and a reserve from public deltas', () => {
    const { state } = createSeededState(2, 'memory-purchase');
    const actor = state.initialFirstPlayer;
    const cardId = state.market[1].find((cardID) => cardID !== null)!;
    const card = getCard(cardId)!;
    // Exactly the card's cost + 10 tokens so the purchase completes cleanly.
    state.players[actor].tokens = {
      white: card.cost.white + 2,
      blue: card.cost.blue + 2,
      green: card.cost.green + 2,
      red: card.cost.red + 2,
      black: card.cost.black + 2,
      gold: 0,
    };
    const paymentInfo = analyzePayment(state, actor, card);
    expect(paymentInfo.errors).toHaveLength(0);
    const payment = paymentInfo.suggestedPayment;
    let memory = seedMemoryFromObservation(observe(state, actor));
    const sim = createSimulation(structuredClone(state), ctxFor(state, actor));
    const purchase = applySimulationMainAction(sim, actor, {
      type: 'purchase',
      location: { source: 'market', tier: 1, cardId },
      payment,
    });
    expect(purchase.ok).toBe(true);
    expect(sim.G.pending).toBeNull();
    memory = updateMemory(memory, observe(sim.G, actor));
    expect(memory.players[actor].lastAction).toBe('purchase');
    expect(memory.players[actor].purchases).toBe(1);

    // Play one opponent turn so it is the actor's turn again, then reserve.
    const opponent = state.playerOrder.find(
      (playerID) => playerID !== actor,
    )!;
    const opponentTake = applySimulationMainAction(sim, opponent, {
      type: 'takeDifferent',
      colors: ['white', 'blue', 'green'],
    });
    expect(opponentTake.ok).toBe(true);
    memory = updateMemory(memory, observe(sim.G, actor));
    expect(sim.currentPlayer).toBe(actor);
    sim.G.players[actor].tokens = {
      white: 0,
      blue: 0,
      green: 0,
      red: 0,
      black: 0,
      gold: 0,
    };
    const marketCard = sim.G.market[1].find(
      (cardID) => cardID !== null,
    )!;
    const reserve = applySimulationMainAction(sim, actor, {
      type: 'reserveMarket',
      tier: 1,
      cardId: marketCard,
    });
    expect(reserve.ok).toBe(true);
    memory = updateMemory(memory, observe(sim.G, actor));
    expect(memory.players[actor].lastAction).toBe('reserve');
    expect(memory.players[actor].reservesByTier[0]).toBe(1);
  });

  it('detects a discard when tokens decrease', () => {
    const { state } = createSeededState(2, 'memory-discard');
    const actor = state.initialFirstPlayer;
    state.players[actor].tokens = {
      white: 3,
      blue: 3,
      green: 3,
      red: 3,
      black: 3,
      gold: 0,
    };
    state.pending = { type: 'discard', playerID: actor, count: 1 };
    const before = seedMemoryFromObservation(observe(state, actor));
    const sim = createSimulation(structuredClone(state), ctxFor(state, actor));
    const discard = applySimulationDiscard(sim, actor, {
      white: 1,
      blue: 0,
      green: 0,
      red: 0,
      black: 0,
      gold: 0,
    });
    expect(discard.ok).toBe(true);
    const memory = updateMemory(before, observe(sim.G, actor));
    expect(memory.players[actor].lastAction).toBe('discard');
  });

  it('keeps the take queue bounded and public-only', () => {
    const { state } = createSeededState(2, 'memory-queue');
    const actor = state.initialFirstPlayer;
    const opponent = state.playerOrder.find(
      (playerID) => playerID !== actor,
    )!;
    const colors = ['white', 'blue', 'green'] as const;
    const sim = createSimulation(structuredClone(state), ctxFor(state, actor));
    const take = () => {
      const result = applySimulationMainAction(sim, sim.currentPlayer, {
        type: 'takeDifferent',
        colors: [...colors],
      });
      expect(result.ok).toBe(true);
    };
    let memory = seedMemoryFromObservation(observe(state, actor));
    // Actor takes 3 tokens, opponent takes 3 tokens, actor takes 3 again.
    take();
    memory = updateMemory(memory, observe(sim.G, actor));
    expect(sim.currentPlayer).toBe(opponent);
    take();
    memory = updateMemory(memory, observe(sim.G, actor));
    expect(sim.currentPlayer).toBe(actor);
    take();
    memory = updateMemory(memory, observe(sim.G, actor));
    expect(memory.players[actor].recentTakeQueue).toHaveLength(4);
    expect(new Set(memory.players[actor].recentTakeQueue).size).toBeGreaterThan(
      0,
    );
  });

  it('is invariant to hidden truth (same playerViews, same memory)', () => {
    const { first, second } = samePlayerViewStates();
    const memoryA = seedMemoryFromObservation(observe(first, '1'));
    const memoryB = seedMemoryFromObservation(observe(second, '1'));
    expect(memoryB).toEqual(memoryA);

    const advancedA = updateMemory(memoryA, observe(first, '1'));
    const advancedB = updateMemory(memoryB, observe(second, '1'));
    expect(advancedB).toEqual(advancedA);
    const snapshots: ExpertMemorySnapshot[] = [advancedA, advancedB];
    expect(snapshots[0].players['0'].reservesByTier).toEqual(
      snapshots[1].players['0'].reservesByTier,
    );
  });
});
