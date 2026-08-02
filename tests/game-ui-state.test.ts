// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import i18n, { translations } from '../src/client/i18n.js';
import {
  TURN_SOUND_STORAGE_KEY,
  canShowReservedCardDetails,
  detectActionAnimation,
  formatActionLog,
  readTurnSoundPreference,
  reduceCardActionMode,
  reduceDiscardUi,
  shouldNotifyLocalTurn,
  writeTurnSoundPreference,
} from '../src/client/gameUiState.js';
import { emptyTokenCounts } from '../src/shared/constants/colors.js';
import type { ActionLogEntry } from '../src/shared/types/game.js';

const logEntry = (key: string, values: Record<string, unknown>): ActionLogEntry => ({
  id: 1,
  kind: key.includes('Win') || key === 'win' ? 'game-over' : 'tokens',
  message: 'legacy fallback',
  i18n: { key, values },
});

describe('game UI state helpers', () => {
  it('toggles and resets Buy and Reserve modes deterministically', () => {
    expect(reduceCardActionMode(null, { type: 'toggle', mode: 'buy' })).toBe('buy');
    expect(reduceCardActionMode('buy', { type: 'toggle', mode: 'buy' })).toBeNull();
    expect(reduceCardActionMode('buy', { type: 'toggle', mode: 'reserve' })).toBe('reserve');
    expect(reduceCardActionMode('reserve', { type: 'reset' })).toBeNull();
    expect(reduceCardActionMode(null, { type: 'toggle', mode: 'buy' }, false)).toBeNull();
  });

  it('notifies once for a genuine transition to the local player', () => {
    expect(shouldNotifyLocalTurn({ currentPlayer: '1', localPlayer: '0' }, '0', '0', false)).toBe(true);
    expect(shouldNotifyLocalTurn({ currentPlayer: '0', localPlayer: '0' }, '0', '0', false)).toBe(false);
    expect(shouldNotifyLocalTurn({ currentPlayer: null, localPlayer: null }, '0', '0', false)).toBe(true);
    expect(shouldNotifyLocalTurn({ currentPlayer: '1', localPlayer: '0' }, '0', '0', true)).toBe(false);
  });

  it('defaults turn sound on and persists both preference values', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(readTurnSoundPreference(storage)).toBe(true);
    writeTurnSoundPreference(false, storage);
    expect(values.get(TURN_SOUND_STORAGE_KEY)).toBe('off');
    expect(readTurnSoundPreference(storage)).toBe(false);
    writeTurnSoundPreference(true, storage);
    expect(readTurnSoundPreference(storage)).toBe(true);
  });

  it('preserves the discard selection while hiding and reopening the panel', () => {
    const returned = emptyTokenCounts();
    returned.white = 2;
    const started = reduceDiscardUi({ hidden: false, returned: null }, { type: 'start', returned });
    const hidden = reduceDiscardUi(started, { type: 'hide' });
    const reopened = reduceDiscardUi(hidden, { type: 'show' });
    expect(hidden.hidden).toBe(true);
    expect(hidden.returned).toEqual(returned);
    expect(reopened).toEqual({ hidden: false, returned });
  });

  it('never exposes details for a hidden blind reservation', () => {
    expect(canShowReservedCardDetails(null)).toBe(false);
    expect(canShowReservedCardDetails('T1-W-01')).toBe(true);
  });

  it('detects each authoritative animation event exactly once', () => {
    const entries: ActionLogEntry[] = [
      logEntry('same', { playerID: '0', color: 'red' }),
      {
        id: 2,
        kind: 'reserve',
        message: 'reserved',
        animation: { type: 'reserve-deck', playerID: '0', tier: 2 },
      },
      { id: 3, kind: 'final-round', message: 'final round' },
    ];
    const first = detectActionAnimation(entries, 0);
    expect(first.processedThrough).toBe(3);
    expect(first.entry?.id).toBe(2);
    expect(first.entry?.animation).toEqual({ type: 'reserve-deck', playerID: '0', tier: 2 });
    expect(detectActionAnimation(entries, first.processedThrough)).toEqual({
      processedThrough: 3,
      entry: null,
    });
  });
});

describe('localized username action logs', () => {
  it('resolves a single username and shared winners', () => {
    const t = i18n.getFixedT('en');
    expect(formatActionLog(logEntry('same', { playerID: '0', color: 'red' }), t, { '0': 'Alice' }))
      .toBe('Alice took two Ruby tokens.');
    expect(formatActionLog(logEntry('sharedWin', { playerIDs: ['0', '1'] }), t, { '0': 'Alice', '1': 'Bob' }))
      .toBe('Alice and Bob shared the victory.');
  });

  it('uses localized seat fallback only when a username is missing', () => {
    const english = i18n.getFixedT('en');
    const chinese = i18n.getFixedT('zh-CN');
    const entry = logEntry('purchase', { playerID: '1', card: 'T1-W-01' });
    expect(formatActionLog(entry, english, {})).toBe('Player 2 purchased T1-W-01.');
    expect(formatActionLog(entry, chinese, {})).toBe('玩家 2购买了 T1-W-01。');
  });

  it('keeps all new English and Simplified Chinese keys in sync', () => {
    const english = translations.en.translation;
    const chinese = translations['zh-CN'].translation;
    for (const key of [
      'yourTurnAnnouncement',
      'goldJokerRemaining',
      'viewTable',
      'continueReturning',
      'emptySlot',
      'buyModeGuidance',
      'reserveModeGuidance',
      'reservedDetail',
    ] as const) {
      expect(english.game[key]).toBeTruthy();
      expect(chinese.game[key]).toBeTruthy();
    }
    expect(english.account.turnSound).toBeTruthy();
    expect(chinese.account.turnSound).toBeTruthy();
  });
});
