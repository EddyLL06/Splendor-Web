// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LobbyClient } from 'boardgame.io/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LobbyScreen } from '../src/client/screens/LobbyScreen.js';

vi.mock('../src/client/auth.js', () => ({
  localizedError: () => 'request failed',
  useAuth: () => ({
    user: {
      id: 'user-1',
      email: 'player@example.com',
      username: 'PlayerOne',
      avatarUrl: '/avatar.webp',
      hasCustomAvatar: false,
    },
    request: vi.fn(),
  }),
}));

vi.mock('../src/client/components/AccountMenu.js', () => ({
  AccountMenu: () => null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LobbyScreen match refresh', () => {
  it('loads once, supports manual refresh, and refreshes stale data on activation', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const listMatches = vi.fn().mockResolvedValue({ matches: [] });
    const lobby = { listMatches } as unknown as LobbyClient;
    const intervalSpy = vi.spyOn(window, 'setInterval');

    const view = render(
      <LobbyScreen lobby={lobby} inviteMatchID={null} onSession={vi.fn()} />,
    );

    await waitFor(() => expect(listMatches).toHaveBeenCalledTimes(1));
    expect(intervalSpy.mock.calls.some(([, delay]) => delay === 5000)).toBe(false);

    act(() => window.dispatchEvent(new Event('focus')));
    expect(listMatches).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'common.refresh' }));
    await waitFor(() => expect(listMatches).toHaveBeenCalledTimes(2));

    now += 15_000;
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(listMatches).toHaveBeenCalledTimes(3));

    view.unmount();
    now += 15_000;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(listMatches).toHaveBeenCalledTimes(3);
  });
});
