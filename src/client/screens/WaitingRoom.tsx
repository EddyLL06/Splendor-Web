import { useCallback, useEffect, useState } from 'react';
import type { LobbyAPI } from 'boardgame.io';
import type { LobbyClient } from 'boardgame.io/client';

import { GAME_NAME } from '../config.js';
import { matchShareURL, type MatchSession } from '../session.js';

interface WaitingRoomProps {
  lobby: LobbyClient;
  session: MatchSession;
  onReady: (match: LobbyAPI.Match) => void;
  onLeave: () => Promise<void>;
}

export function WaitingRoom({
  lobby,
  session,
  onReady,
  onLeave,
}: WaitingRoomProps) {
  const [match, setMatch] = useState<LobbyAPI.Match | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await lobby.getMatch(GAME_NAME, session.matchID);
      setMatch(next);
      setError('');
      if (next.players.every((player) => Boolean(player.name))) {
        onReady(next);
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not refresh the waiting room.',
      );
    }
  }, [lobby, onReady, session.matchID]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const occupied = match?.players.filter((player) => player.name).length ?? 1;
  const seats = match?.players.length ?? 0;

  return (
    <div className="waiting-shell">
      <div className="waiting-glow" />
      <main className="waiting-card">
        <div className="brand-mark large-mark" aria-hidden="true">
          ◆
        </div>
        <span className="eyebrow">Waiting room</span>
        <h1>Your table is ready.</h1>
        <p>
          The match begins automatically when every seat has a player. Share
          the link below with your group.
        </p>
        <div className="waiting-match-id">
          <span>Match ID</span>
          <strong>{session.matchID}</strong>
          <button
            type="button"
            className="button button-ghost button-small"
            onClick={async () => {
              await navigator.clipboard.writeText(
                matchShareURL(session.matchID),
              );
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1800);
            }}
          >
            {copied ? 'Copied' : 'Copy invite link'}
          </button>
        </div>
        <div className="waiting-progress">
          <div>
            <span>Players joined</span>
            <strong>
              {occupied} / {seats || '…'}
            </strong>
          </div>
          <div className="meter-track">
            <span
              style={{
                width: seats ? `${(occupied / seats) * 100}%` : '10%',
              }}
            />
          </div>
        </div>
        <div className="seat-list">
          {match?.players.map((player) => (
            <div
              className={`seat-row${player.name ? ' seat-filled' : ''}`}
              key={player.id}
            >
              <span className="seat-number">{Number(player.id) + 1}</span>
              <div>
                <strong>{player.name || 'Open seat'}</strong>
                <span>
                  {String(player.id) === session.playerID
                    ? 'You'
                    : player.name
                      ? 'Ready'
                      : 'Waiting for a player'}
                </span>
              </div>
              <span className="seat-status">{player.name ? '✓' : '…'}</span>
            </div>
          ))}
        </div>
        {error && <div className="inline-error">{error}</div>}
        <button
          type="button"
          className="button button-quiet"
          disabled={leaving}
          onClick={async () => {
            setLeaving(true);
            await onLeave();
          }}
        >
          {leaving ? 'Leaving…' : 'Leave this match'}
        </button>
      </main>
    </div>
  );
}
