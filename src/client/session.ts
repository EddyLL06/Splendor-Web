import type { MatchSession } from '../shared/types/room.js';

export type { MatchSession } from '../shared/types/room.js';

const storageKey = (matchID: string): string =>
  `gem-council-session:${matchID}`;

export const loadMatchSession = (
  matchID: string | null,
): MatchSession | null => {
  if (!matchID || typeof window === 'undefined') return null;
  const raw = window.sessionStorage.getItem(storageKey(matchID));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MatchSession> & {
      playerID?: unknown;
      playerCredentials?: unknown;
      playerName?: unknown;
    };
    if (
      value.matchID === matchID &&
      value.mode === 'spectator' &&
      typeof value.viewerName === 'string'
    ) {
      return value as MatchSession;
    }
    if (
      value.matchID === matchID &&
      (value.mode === 'player' || value.mode === undefined) &&
      typeof value.playerID === 'string' &&
      typeof value.playerCredentials === 'string' &&
      typeof value.playerName === 'string'
    ) {
      return {
        mode: 'player',
        matchID,
        playerID: value.playerID,
        playerCredentials: value.playerCredentials,
        playerName: value.playerName,
      };
    }
  } catch {
    window.sessionStorage.removeItem(storageKey(matchID));
  }
  return null;
};

export const saveMatchSession = (session: MatchSession): void => {
  window.sessionStorage.setItem(
    storageKey(session.matchID),
    JSON.stringify(session),
  );
};

export const removeMatchSession = (matchID: string): void => {
  window.sessionStorage.removeItem(storageKey(matchID));
};

export const getSharedMatchID = (): string | null => {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('match');
};

export const setSharedMatchID = (matchID: string | null): void => {
  const url = new URL(window.location.href);
  if (matchID) {
    url.searchParams.set('match', matchID);
  } else {
    url.searchParams.delete('match');
  }
  window.history.replaceState({}, '', url);
};

export const matchShareURL = (matchID: string): string => {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('match', matchID);
  return url.toString();
};
