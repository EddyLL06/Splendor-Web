// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GameBoard, type GameBoardProps } from '../src/client/components/GameBoard.js';
import { SpectatorPopover } from '../src/client/components/SpectatorPopover.js';
import type { AuthenticatedLobbyClient } from '../src/client/lobby-client.js';
import { WaitingRoom } from '../src/client/screens/WaitingRoom.js';
import type { PublicRoomState, RoomMatch } from '../src/shared/types/room.js';
import { createTestState } from './helpers.js';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('../src/client/auth.js', () => ({
  jsonRequest: (body: unknown) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  localizedError: () => 'request failed',
  useAuth: () => ({ request: mocks.request }),
}));

vi.mock('../src/client/components/AccountMenu.js', () => ({
  AccountMenu: () => null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.count === undefined ? key : `${key}:${values.count}`,
  }),
}));

const room: PublicRoomState = {
  allowSpectators: true,
  startedAt: null,
  hostUsername: 'Host',
  spectatorCount: 1,
  spectatorCapacity: 10,
  spectators: [{ username: 'Viewer', isHost: false, isViewer: true }],
  nextMatch: null,
};

const waitingMatch = (startedAt: number | null = null): RoomMatch => ({
  matchID: 'match-1',
  gameName: 'gem-council',
  players: [
    {
      id: 0,
      name: 'Host',
      data: { avatarUrl: '', isHost: true, isViewer: true },
    },
    {
      id: 1,
      name: 'Player',
      data: { avatarUrl: '', isHost: false, isViewer: false },
    },
  ],
  createdAt: 1,
  updatedAt: 1,
  room: { ...room, startedAt },
  viewer: { role: 'player', playerID: '0', isHost: true },
});

beforeEach(() => {
  mocks.request.mockReset();
});

afterEach(() => cleanup());

describe('manual waiting-room start', () => {
  it('does not enter merely because every seat is full and enters after host start', async () => {
    let startedAt: number | null = null;
    const lobby = {
      getRoomMatch: vi.fn(() => Promise.resolve(waitingMatch(startedAt))),
    } as unknown as AuthenticatedLobbyClient;
    mocks.request.mockImplementation((path: string) => {
      if (path.endsWith('/start')) startedAt = 123;
      return Promise.resolve({ startedAt });
    });
    const onReady = vi.fn(() => Promise.resolve());
    render(
      <WaitingRoom
        lobby={lobby}
        session={{
          mode: 'player',
          matchID: 'match-1',
          playerID: '0',
          playerCredentials: 'seat',
          playerName: 'Host',
        }}
        onSession={vi.fn()}
        onReady={onReady}
        onLeave={vi.fn(() => Promise.resolve())}
        onRemoved={vi.fn()}
      />,
    );
    await waitFor(() => expect(lobby.getRoomMatch).toHaveBeenCalled());
    expect(onReady).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole('button', { name: 'waiting.startGame' }),
    );
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });
});

describe('spectator UI boundaries', () => {
  it('opens the spectator list with keyboard support and restores trigger focus on Escape', async () => {
    render(<SpectatorPopover room={room} />);
    const trigger = screen.getByRole('button', { name: /1 \/ 10/ });
    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'spectators.title' })).toBeTruthy();
    expect(screen.getByText('Viewer')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('renders the live board without player action, private-hand, or turn-notification controls', () => {
    const state = createTestState();
    render(
      <GameBoard
        {...({
          G: state,
          ctx: { currentPlayer: '0' },
          moves: {
            mainAction: vi.fn(),
            discardTokens: vi.fn(),
            chooseNoble: vi.fn(),
          },
          matchID: 'match-1',
          playerID: null,
          isConnected: true,
          playerNames: { '0': 'Host', '1': 'Player' },
          playerAvatars: { '0': '', '1': '' },
          playerConnections: { '0': 'online', '1': 'reconnecting' },
          accountMenu: null,
          sessionMode: 'spectator',
          room: { ...room, startedAt: 123 },
          onLeaveMatch: vi.fn(),
          onReturnToLobby: vi.fn(),
        } as unknown as GameBoardProps)}
      />,
    );
    expect(screen.getAllByText('game.spectating').length).toBeGreaterThan(0);
    expect(screen.queryByText('game.yourReserved')).toBeNull();
    expect(screen.queryByRole('button', { name: 'game.buy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'game.reserve' })).toBeNull();
    expect(screen.queryByText('game.takeTokens')).toBeNull();
    expect(screen.getByText('game.connection.online')).toBeTruthy();
    expect(screen.getByText('game.connection.reconnecting')).toBeTruthy();
    expect(document.querySelector('.spectator-play-area')).toBeTruthy();
    expect(document.querySelector('.spectator-workspace')).toBeTruthy();
    expect(document.querySelector('.reserved-column')).toBeNull();
    expect(document.querySelector('.your-turn-popup')).toBeNull();
    expect(document.querySelector('.local-turn-active')).toBeNull();
  });
});
