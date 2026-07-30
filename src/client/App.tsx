import { useCallback, useMemo, useState } from 'react';
import type { LobbyAPI } from 'boardgame.io';
import { LobbyClient } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { Client } from 'boardgame.io/react';

import { SplendorGame } from '../game/SplendorGame.js';
import type { SplendorState } from '../shared/types/game.js';
import {
  GameBoard,
  type GameBoardProps,
} from './components/GameBoard.js';
import { GAME_NAME, GAME_SERVER_URL } from './config.js';
import {
  getSharedMatchID,
  loadMatchSession,
  removeMatchSession,
  saveMatchSession,
  setSharedMatchID,
  type MatchSession,
} from './session.js';
import { LobbyScreen } from './screens/LobbyScreen.js';
import { WaitingRoom } from './screens/WaitingRoom.js';

const MultiplayerGame = Client<SplendorState, GameBoardProps>({
  game: SplendorGame,
  board: GameBoard,
  multiplayer: SocketIO({ server: GAME_SERVER_URL }),
  debug: false,
  loading: () => (
    <div className="loading-screen">
      <div className="brand-mark large-mark">◆</div>
      <strong>Connecting to the table…</strong>
    </div>
  ),
});

export default function App() {
  const lobby = useMemo(
    () => new LobbyClient({ server: GAME_SERVER_URL }),
    [],
  );
  const [inviteMatchID, setInviteMatchID] = useState(getSharedMatchID);
  const [session, setSession] = useState<MatchSession | null>(() =>
    loadMatchSession(getSharedMatchID()),
  );
  const [readyMatch, setReadyMatch] = useState<LobbyAPI.Match | null>(null);

  const acceptSession = useCallback((next: MatchSession) => {
    setSession(next);
    setReadyMatch(null);
    setInviteMatchID(next.matchID);
    setSharedMatchID(next.matchID);
  }, []);

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
    if (!session) throw new Error('No current match session.');
    const next = await lobby.playAgain(GAME_NAME, session.matchID, {
      playerID: session.playerID,
      credentials: session.playerCredentials,
    });
    const joined = await lobby.joinMatch(GAME_NAME, next.nextMatchID, {
      playerID: session.playerID,
      playerName: session.playerName,
    });
    const nextSession: MatchSession = {
      matchID: next.nextMatchID,
      playerID: joined.playerID,
      playerCredentials: joined.playerCredentials,
      playerName: session.playerName,
    };
    saveMatchSession(nextSession);
    removeMatchSession(session.matchID);
    acceptSession(nextSession);
  }, [acceptSession, lobby, session]);

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
      player.name ?? `Player ${Number(player.id) + 1}`,
    ]),
  );

  return (
    <MultiplayerGame
      matchID={session.matchID}
      playerID={session.playerID}
      credentials={session.playerCredentials}
      playerNames={playerNames}
      onLeaveMatch={() => void leaveMatch()}
      onReturnToLobby={returnToLobby}
      onPlayAgain={playAgain}
    />
  );
}
