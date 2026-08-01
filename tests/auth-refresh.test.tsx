// @vitest-environment jsdom

import { StrictMode } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from '../src/client/auth.js';

const sessionResponse = {
  user: {
    id: 'user-1',
    email: 'player@example.com',
    username: 'PlayerOne',
    avatarUrl: '/avatar.webp',
    hasCustomAvatar: false,
  },
  csrfToken: 'csrf-token',
  sessionExpiresAt: '2026-08-31T00:00:00.000Z',
};

function AuthProbe() {
  const { loading } = useAuth();
  return <span>{loading ? 'loading' : 'ready'}</span>;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AuthProvider session refresh', () => {
  it('refreshes initially and only revalidates on activation after five minutes', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sessionResponse),
    });
    vi.stubGlobal('fetch', fetchMock);
    const intervalSpy = vi.spyOn(window, 'setInterval');

    const view = render(
      <StrictMode>
        <AuthProvider><AuthProbe /></AuthProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/auth/me',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(intervalSpy.mock.calls.some(([, delay]) => delay === 60_000)).toBe(false);

    act(() => window.dispatchEvent(new Event('focus')));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    now += 5 * 60_000;
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.unmount();
    now += 5 * 60_000;
    act(() => window.dispatchEvent(new Event('focus')));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
