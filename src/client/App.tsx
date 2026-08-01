import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LobbyAPI } from 'boardgame.io';
import { SocketIO } from 'boardgame.io/multiplayer';
import { Client } from 'boardgame.io/react';
import { useTranslation } from 'react-i18next';

import { SplendorGame } from '../game/SplendorGame.js';
import type { SplendorState } from '../shared/types/game.js';
import { useAuth } from './auth.js';
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

const MultiplayerGame = Client<SplendorState, GameBoardProps>({
  game: SplendorGame,
  board: GameBoard,
  multiplayer: SocketIO({ server: GAME_SERVER_URL }),
  debug: false,
  loading: () => <GameLoading />,
});

function GameLoading() {
  const { t } = useTranslation();
  return (
    <div className="loading-screen">
      <div className="brand-mark large-mark">◆</div>
      <strong>{t('game.connecting')}</strong>
    </div>
  );
}

export default function App() {
  const { t } = useTranslation();
  const { user, csrfToken, loading, request } = useAuth();
  const lobby = useMemo(
    () => new AuthenticatedLobbyClient(GAME_SERVER_URL, () => csrfToken),
    [csrfToken],
  );
  const [inviteMatchID, setInviteMatchID] = useState(getSharedMatchID);
  const [session, setSession] = useState<MatchSession | null>(() =>
    loadMatchSession(getSharedMatchID()),
  );
  const [readyMatch, setReadyMatch] = useState<LobbyAPI.Match | null>(null);
  const [restoring, setRestoring] = useState(false);

  const acceptSession = useCallback((next: MatchSession) => {
    saveMatchSession(next);
    setSession(next);
    setReadyMatch(null);
    setInviteMatchID(next.matchID);
    setSharedMatchID(next.matchID);
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      if (session) removeMatchSession(session.matchID);
      setSession(null);
      setReadyMatch(null);
      return;
    }
    if (!session) return;
    let active = true;
    setRestoring(true);
    void request<{ playerID: string; playerCredentials: string; playerName: string }>(
      `/api/matches/${encodeURIComponent(session.matchID)}/reclaim`,
      { method: 'POST' },
    )
      .then((restored) => {
        if (!active) return;
        acceptSession({ matchID: session.matchID, ...restored });
      })
      .catch(() => {
        if (!active) return;
        removeMatchSession(session.matchID);
        setSession(null);
        setReadyMatch(null);
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => { active = false; };
    // Reclaim once when account identity or the match changes. Rotating on every
    // session object update would invalidate the credential just issued.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user?.id, session?.matchID]);

  const returnToLobby = useCallback(() => {
    if (session) removeMatchSession(session.matchID);
    setSession(null);
    setReadyMatch(null);
    setInviteMatchID(null);
    setSharedMatchID(null);
  }, [session]);

  const leaveMatch = useCallback(async () => {
    if (!session) return;
    try {
      await lobby.leaveMatch(GAME_NAME, session.matchID, {
        playerID: session.playerID,
        credentials: session.playerCredentials,
      });
    } finally {
      returnToLobby();
    }
  }, [lobby, returnToLobby, session]);

  const playAgain = useCallback(async () => {
    if (!session || !user) throw new Error(t('game.rematchFailed'));
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
      matchID: next.nextMatchID,
      playerID: joined.playerID,
      playerCredentials: joined.playerCredentials,
      playerName: user.username,
    });
  }, [acceptSession, lobby, session, t, user]);

  if (loading || restoring) {
    return <GameLoading />;
  }
  if (!user) return <AuthScreen />;

  if (!session) {
    return (
      <LobbyScreen
        lobby={lobby}
        inviteMatchID={inviteMatchID}
        onSession={acceptSession}
      />
    );
  }

  if (!readyMatch) {
    return (
      <WaitingRoom
        lobby={lobby}
        session={session}
        onReady={setReadyMatch}
        onLeave={leaveMatch}
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
      (player.data as { avatarUrl?: string } | undefined)?.avatarUrl ?? '',
    ]),
  );

  return (
    <MultiplayerGame
      matchID={session.matchID}
      playerID={session.playerID}
      credentials={session.playerCredentials}
      playerNames={playerNames}
      playerAvatars={playerAvatars}
      accountMenu={<AccountMenu />}
      onLeaveMatch={() => void leaveMatch()}
      onReturnToLobby={returnToLobby}
      onPlayAgain={playAgain}
    />
  );
}
