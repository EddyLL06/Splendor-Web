import { describe, expect, it, vi } from 'vitest';

import {
  PLAYER_ABANDON_TIMEOUT_MS,
  PLAYER_CONNECTION_TOLERANCE_MS,
  RoomRegistry,
} from '../src/server/multiplayer/room-registry.js';

describe('spectator capacity and disconnect grace', () => {
  it('counts unique accounts, caps the eleventh, and preserves duplicate tabs', () => {
    vi.useFakeTimers();
    let now = 1_000;
    const rooms = new RoomRegistry(() => now);
    rooms.create({ matchID: 'match', hostUserId: 'host' });
    for (let index = 0; index < 10; index += 1) {
      rooms.addSpectator('match', {
        userId: `user-${index}`,
        username: `Viewer${index}`,
      });
    }
    rooms.addSpectator('match', { userId: 'user-0', username: 'Renamed' });
    expect(rooms.orderedSpectators('match')).toHaveLength(10);
    expect(() =>
      rooms.addSpectator('match', {
        userId: 'user-10',
        username: 'Eleventh',
      }),
    ).toThrowError('SPECTATOR_LIMIT_REACHED');

    rooms.connectSpectator('match', 'user-0', 'tab-a');
    rooms.connectSpectator('match', 'user-0', 'tab-b');
    rooms.disconnectSpectator('match', 'user-0', 'tab-a');
    now += 20_000;
    expect(rooms.expiredSpectatorIDs('match')).not.toContain('user-0');
    rooms.disconnectSpectator('match', 'user-0', 'tab-b');
    now += 9_999;
    expect(rooms.expiredSpectatorIDs('match')).not.toContain('user-0');
    now += 1;
    expect(rooms.expiredSpectatorIDs('match')).toContain('user-0');
    vi.useRealTimers();
  });
});

describe('player connection tolerance and abandonment', () => {
  it('tracks duplicate tabs, tolerates short drops, cancels stale timers, and expires at three minutes', async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const rooms = new RoomRegistry(() => now);
    const expired = vi.fn();
    rooms.setPlayerExpirationHandler(expired);
    rooms.create({ matchID: 'match', hostUserId: 'player-user' });
    rooms.start('match', [{ userId: 'player-user', playerID: '0' }]);

    expect(rooms.playerConnectionStatus('match', '0')).toBe('reconnecting');
    now += PLAYER_CONNECTION_TOLERANCE_MS;
    expect(rooms.playerConnectionStatus('match', '0')).toBe('offline');

    rooms.connectPlayer('match', 'player-user', '0', 'tab-a');
    rooms.connectPlayer('match', 'player-user', '0', 'tab-b');
    rooms.disconnectPlayer('match', '0', 'tab-a');
    expect(rooms.playerConnectionStatus('match', '0')).toBe('online');

    rooms.disconnectPlayer('match', '0', 'tab-b');
    expect(rooms.playerConnectionStatus('match', '0')).toBe('reconnecting');
    now += PLAYER_ABANDON_TIMEOUT_MS - 1;
    await vi.advanceTimersByTimeAsync(PLAYER_ABANDON_TIMEOUT_MS - 1);
    expect(expired).not.toHaveBeenCalled();

    rooms.connectPlayer('match', 'player-user', '0', 'tab-c');
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).not.toHaveBeenCalled();
    rooms.disconnectPlayer('match', '0', 'tab-c');
    now += PLAYER_ABANDON_TIMEOUT_MS;
    await vi.advanceTimersByTimeAsync(PLAYER_ABANDON_TIMEOUT_MS);

    expect(rooms.isPlayerExpired('match', '0')).toBe(true);
    expect(expired).toHaveBeenCalledOnce();
    expect(expired).toHaveBeenCalledWith('match', '0', 'player-user');
    vi.useRealTimers();
  });
});
