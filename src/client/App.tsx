import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SocketIO } from 'boardgame.io/multiplayer';
import { Client } from 'boardgame.io/react';
import { useTranslation } from 'react-i18next';

import { SplendorGame } from '../game/SplendorGame.js';
import type { SplendorState } from '../shared/types/game.js';
import type { RoomMatch } from '../shared/types/room.js';
import { jsonRequest, localizedError, useAuth } from './auth.js';
import { AccountMenu } from './components/AccountMenu.js';
import { GameBoard, type GameBoardProps } from './components/GameBoard.js';
import { GAME_NAME, GAME_SERVER_URL } from './config.js';
import { AuthenticatedLobbyClient } from './lobby-client.js';
import {
  getSharedMatchID,
  loadMatchSession,
  removeMatchSession,
  saveMatchSession,
  setSharedMatchID,
  type MatchSession,
} from './session.js';
import { AuthScreen } from './screens/AuthScreen.js';
import { LobbyScreen } from './screens/LobbyScreen.js';
import { WaitingRoom } from './screens/WaitingRoom.js';
import type { BotDifficulty } from '../shared/ai/types.js';

function GameLoading() {
  const { t } = useTranslation();
  return (
    <div className="loading-screen">
      <div className="brand-mark large-mark">◆</div>
      <strong>{t('game.connecting')}</strong>
    </div>
  );
}

const authenticatedSocketTransport = (
  accessTicket: string,
  onAccessInvalid: () => void,
) => {
  const createTransport = SocketIO({
    server: GAME_SERVER_URL,
    socketOpts: { auth: { accessTicket }, transports: ['websocket'] },
  });
  return (options: Parameters<typeof createTransport>[0]) => {
    const transport = createTransport(options);
    const connect = transport.connect.bind(transport);
    transport.connect = () => {
      connect();
      transport.socket.on('connect_error', (error: Error) => {
        if (error.message === 'GAME_ACCESS_INVALID') onAccessInvalid();
      });
    };
    return transport;
  };
};

export default function App() {
  const { t } = useTranslation();
  const { user, csrfToken, loading, request } = useAuth();
  const lobby = useMemo(
    () => new AuthenticatedLobbyClient(GAME_SERVER_URL, () => csrfToken),
    [csrfToken],
  );
  const [inviteMatchID, setInviteMatchID] = useState(getSharedMatchID);
  const [autoEnterInvite, setAutoEnterInvite] = useState(true);
  const [session, setSession] = useState<MatchSession | null>(() =>
    loadMatchSession(getSharedMatchID()),
  );
  const [readyMatch, setReadyMatch] = useState<RoomMatch | null>(null);
  const [accessTicket, setAccessTicket] = useState<string | null>(null);
  const accessRefreshInFlight = useRef(false);
  const lastAccessRefreshAt = useRef(0);
  const [restoring, setRestoring] = useState(false);
  const [lobbyNotice, setLobbyNotice] = useState('');

  const acceptSession = useCallback((next: MatchSession) => {
    saveMatchSession(next);
    setSession(next);
    setReadyMatch(null);
    setAccessTicket(null);
    setInviteMatchID(next.matchID);
    setAutoEnterInvite(true);
    setLobbyNotice('');
    setSharedMatchID(next.matchID);
  }, []);

  const clearToLobby = useCallback(
    (options: { keepInvite?: boolean; notice?: string } = {}) => {
      if (session) removeMatchSession(session.matchID);
      const retainedMatchID = options.keepInvite ? session?.matchID ?? null : null;
      setSession(null);
      setReadyMatch(null);
      setAccessTicket(null);
      setInviteMatchID(retainedMatchID);
      setAutoEnterInvite(false);
      setLobbyNotice(options.notice ?? '');
      setSharedMatchID(retainedMatchID);
    },
    [session],
  );

  useEffect(() => {
    if (loading) return;
    if (!user) {
      if (session) removeMatchSession(session.matchID);
      setSession(null);
      setReadyMatch(null);
      setAccessTicket(null);
      return;
    }
    if (!session) return;
    let active = true;
    setRestoring(true);
    const restore =
      session.mode === 'player'
        ? request<{
            playerID: string;
            playerCredentials: string;
            playerName: string;
          }>(`/api/matches/${encodeURIComponent(session.matchID)}/reclaim`, {
            method: 'POST',
          }).then((restored) => ({
            mode: 'player' as const,
            matchID: session.matchID,
            ...restored,
          }))
        : request<{ viewerName: string }>(
            `/api/matches/${encodeURIComponent(session.matchID)}/spectators/join`,
            jsonRequest({}),
          ).then((restored) => ({
            mode: 'spectator' as const,
            matchID: session.matchID,
            viewerName: restored.viewerName,
          }));
    void restore
      .then((restored) => {
        if (!active) return;
        saveMatchSession(restored);
        setSession(restored);
      })
      .catch((caught) => {
        if (!active) return;
        removeMatchSession(session.matchID);
        setSession(null);
        setReadyMatch(null);
        setAccessTicket(null);
        setLobbyNotice(localizedError(caught));
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
    // Restore once when the account or match changes. Reissuing on every
    // credential update would invalidate the credential just returned.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user?.id, session?.matchID]);

  const leaveWaitingRoom = useCallback(async () => {
    if (!session) return;
    try {
      if (session.mode === 'player') {
        await lobby.leaveMatch(GAME_NAME, session.matchID, {
          playerID: session.playerID,
          credentials: session.playerCredentials,
        });
      } else {
        await request(
          `/api/matches/${encodeURIComponent(session.matchID)}/spectators`,
          { method: 'DELETE' },
        );
      }
    } finally {
      clearToLobby({ keepInvite: false });
    }
  }, [clearToLobby, lobby, request, session]);

  const issueAccessTicket = useCallback(
    async (activeSession: MatchSession): Promise<string> => {
      const body =
        activeSession.mode === 'player'
          ? {
              role: 'player' as const,
              playerID: activeSession.playerID,
              credentials: activeSession.playerCredentials,
            }
          : { role: 'spectator' as const };
      const issued = await request<{ accessTicket: string; expiresAt: number }>(
        `/api/matches/${encodeURIComponent(activeSession.matchID)}/access-ticket`,
        jsonRequest(body),
      );
      return issued.accessTicket;
    },
    [request],
  );

  const refreshGameAccess = useCallback(
    async (force = false) => {
      if (!session || accessRefreshInFlight.current) return;
      if (!force && Date.now() - lastAccessRefreshAt.current < 60_000) return;
      accessRefreshInFlight.current = true;
      try {
        const ticket = await issueAccessTicket(session);
        lastAccessRefreshAt.current = Date.now();
        setAccessTicket(ticket);
      } catch (caught) {
        clearToLobby({
          keepInvite: true,
          notice: localizedError(caught),
        });
      } finally {
        accessRefreshInFlight.current = false;
      }
    },
    [clearToLobby, issueAccessTicket, session],
  );

  const enterStartedMatch = useCallback(
    async (match: RoomMatch) => {
      if (!session) return;
      const ticket = await issueAccessTicket(session);
      lastAccessRefreshAt.current = Date.now();
      setReadyMatch(match);
      setAccessTicket(ticket);
    },
    [issueAccessTicket, session],
  );

  useEffect(() => {
    if (!readyMatch || !session) return;
    const refreshIfNeeded = () => {
      if (document.visibilityState === 'visible') void refreshGameAccess(false);
    };
    const refreshNow = () => void refreshGameAccess(true);
    const timer = window.setInterval(refreshNow, 4 * 60_000);
    window.addEventListener('focus', refreshIfNeeded);
    window.addEventListener('online', refreshNow);
    document.addEventListener('visibilitychange', refreshIfNeeded);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshIfNeeded);
      window.removeEventListener('online', refreshNow);
      document.removeEventListener('visibilitychange', refreshIfNeeded);
    };
  }, [readyMatch, refreshGameAccess, session]);

  useEffect(() => {
    if (!readyMatch || !session) return;
    const refreshRoom = async () => {
      try {
        const next = await lobby.getRoomMatch(GAME_NAME, session.matchID);
        if (session.mode === 'spectator' && next.viewer.role !== 'spectator') {
          clearToLobby({
            keepInvite: false,
            notice: t('errors.NOT_A_SPECTATOR'),
          });
          return;
        }
        setReadyMatch(next);
      } catch (caught) {
        clearToLobby({ keepInvite: true, notice: localizedError(caught) });
      }
    };
    const timer = window.setInterval(() => void refreshRoom(), 5_000);
    return () => window.clearInterval(timer);
  }, [clearToLobby, lobby, readyMatch?.matchID, session, t]);

  const playAgain = useCallback(async () => {
    if (!session || session.mode !== 'player' || !user) {
      throw new Error(t('game.rematchFailed'));
    }
    const next = await lobby.playAgain(GAME_NAME, session.matchID, {
      playerID: session.playerID,
      credentials: session.playerCredentials,
    });
    const joined = await lobby.joinMatch(GAME_NAME, next.nextMatchID, {
      playerID: session.playerID,
      playerName: user.username,
    });
    removeMatchSession(session.matchID);
    acceptSession({
      mode: 'player',
      matchID: next.nextMatchID,
      playerID: joined.playerID,
      playerCredentials: joined.playerCredentials,
      playerName: user.username,
    });
  }, [acceptSession, lobby, session, t, user]);

  const watchRematch = useCallback(async () => {
    if (!session || session.mode !== 'spectator' || !readyMatch?.room.nextMatch) {
      throw new Error(t('game.rematchFailed'));
    }
    const nextMatchID = readyMatch.room.nextMatch.matchID;
    const admitted = await request<{ viewerName: string }>(
      `/api/matches/${encodeURIComponent(nextMatchID)}/spectators/join`,
      jsonRequest({ previousMatchID: session.matchID }),
    );
    removeMatchSession(session.matchID);
    acceptSession({
      mode: 'spectator',
      matchID: nextMatchID,
      viewerName: admitted.viewerName,
    });
  }, [acceptSession, readyMatch?.room.nextMatch, request, session, t]);

  const MultiplayerGame = useMemo(
    () =>
      accessTicket
        ? Client<SplendorState, GameBoardProps>({
            game: SplendorGame,
            board: GameBoard,
            multiplayer: authenticatedSocketTransport(accessTicket, () => {
              void refreshGameAccess(true);
            }),
            debug: false,
            loading: () => <GameLoading />,
          })
        : null,
    [accessTicket, refreshGameAccess],
  );

  if (loading || restoring) return <GameLoading />;
  if (!user) return <AuthScreen />;

  if (!session) {
    return (
      <LobbyScreen
        lobby={lobby}
        inviteMatchID={inviteMatchID}
        onSession={acceptSession}
        notice={lobbyNotice}
        autoEnterInvite={autoEnterInvite}
      />
    );
  }

  if (!readyMatch || !accessTicket || !MultiplayerGame) {
    return (
      <WaitingRoom
        lobby={lobby}
        session={session}
        onSession={acceptSession}
        onReady={enterStartedMatch}
        onLeave={leaveWaitingRoom}
        onRemoved={(reason) =>
          clearToLobby({
            keepInvite: false,
            notice:
              reason === 'spectating-disabled'
                ? t('errors.REMOVED_SPECTATING_DISABLED')
                : t('errors.NOT_A_SPECTATOR'),
          })
        }
      />
    );
  }

  const playerNames = Object.fromEntries(
    readyMatch.players.map((player) => [
      String(player.id),
      player.name ?? t('common.player', { number: Number(player.id) + 1 }),
    ]),
  );
  const playerAvatars = Object.fromEntries(
    readyMatch.players.map((player) => [
      String(player.id),
      player.data?.avatarUrl ?? '',
    ]),
  );
  const playerConnections = Object.fromEntries(
    readyMatch.players.map((player) => [
      String(player.id),
      player.connectionStatus ?? 'reconnecting',
    ]),
  );
  const playerDifficulties = Object.fromEntries(
    readyMatch.players
      .filter((player) => player.difficulty !== undefined)
      .map((player) => [String(player.id), player.difficulty as BotDifficulty]),
  );

  return (
    <MultiplayerGame
      key={`${session.matchID}:${session.mode}:${accessTicket}`}
      matchID={session.matchID}
      playerID={session.mode === 'player' ? session.playerID : undefined}
      credentials={
        session.mode === 'player' ? session.playerCredentials : undefined
      }
      playerNames={playerNames}
      playerAvatars={playerAvatars}
      playerConnections={playerConnections}
      playerDifficulties={playerDifficulties}
      accountMenu={<AccountMenu />}
      sessionMode={session.mode}
      room={readyMatch.room}
      onLeaveMatch={() => clearToLobby({ keepInvite: true })}
      onReturnToLobby={() => clearToLobby({ keepInvite: true })}
      onPlayAgain={session.mode === 'player' ? playAgain : undefined}
      onWatchRematch={
        session.mode === 'spectator' && readyMatch.room.nextMatch?.allowSpectators
          ? watchRematch
          : undefined
      }
    />
  );
}
