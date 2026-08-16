import { describe, expect, it } from 'vitest';

import {
  BotTraceStore,
  buildBotTraceSnapshot,
} from '../../src/server/ai/bot-trace.js';
import { createSeededState } from './helpers.js';

const entry = (id: number) => ({
  playerID: '1',
  stateID: id,
  move: { move: 'mainAction' as const, args: [{ type: 'pass' }] as [never] },
  policy: 'ds-search-v1',
  modelVersion: 'ai-kernel-ds-v1.0.0',
  sims: 100 + id,
  elapsedMs: 42,
  timedOut: false,
  fallbackLevel: 0 as const,
  determinizations: 9,
  topActions: [],
});

describe('BotTraceStore', () => {
  it('records per match, caps entries and clears on demand', () => {
    const store = new BotTraceStore();
    for (let id = 1; id <= 75; id += 1) {
      store.record('m1', entry(id));
    }
    store.record('m2', entry(1));
    const m1 = store.forMatch('m1');
    expect(m1.length).toBe(60);
    expect(m1[0].id).toBe(16);
    expect(m1[m1.length - 1].id).toBe(75);
    expect(m1[0].createdAt).toBeGreaterThan(0);
    expect(store.forMatch('m2').length).toBe(1);
    store.clear('m1');
    expect(store.forMatch('m1').length).toBe(0);
    expect(store.forMatch('m2').length).toBe(1);
  });
});

describe('buildBotTraceSnapshot', () => {
  it('exposes public game state only', () => {
    const { state } = createSeededState(2, 'trace-snapshot');
    const snapshot = buildBotTraceSnapshot(state, '0', 7);
    expect(snapshot.stateID).toBe(7);
    expect(snapshot.currentPlayer).toBe('0');
    expect(snapshot.gameover).toBe(false);
    expect(snapshot.players['0'].score).toBe(0);
    expect(snapshot.deckCounts[1]).toBe(state.decks[1].length);
    expect(snapshot.bank.white).toBe(state.bank.white);
  });
});
