import { useCallback, useEffect, useState } from 'react';
import type { LobbyAPI } from 'boardgame.io';
import type { LobbyClient } from 'boardgame.io/client';

import { GAME_NAME, GAME_SERVER_URL } from '../config.js';
import {
  matchShareURL,
  saveMatchSession,
  type MatchSession,
} from '../session.js';

interface LobbyScreenProps {
  lobby: LobbyClient;
  inviteMatchID: string | null;
  onSession: (session: MatchSession) => void;
}

const occupiedSeats = (match: LobbyAPI.Match): number =>
  match.players.filter((player) => Boolean(player.name)).length;

export function LobbyScreen({
  lobby,
  inviteMatchID,
  onSession,
}: LobbyScreenProps) {
  const [displayName, setDisplayName] = useState(
    () => window.localStorage.getItem('gem-council-display-name') ?? '',
  );
  const [playerCount, setPlayerCount] = useState(3);
  const [matches, setMatches] = useState<LobbyAPI.Match[]>([]);
  const [inviteMatch, setInviteMatch] = useState<LobbyAPI.Match | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const refresh = useCallback(async () => {
    try {
      const response = await lobby.listMatches(GAME_NAME, {
        isGameover: false,
      });
      setMatches(response.matches);
      if (inviteMatchID) {
        setInviteMatch(
          response.matches.find((match) => match.matchID === inviteMatchID) ??
            (await lobby.getMatch(GAME_NAME, inviteMatchID)),
        );
      } else {
        setInviteMatch(null);
      }
      setError('');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : `Cannot reach the game server at ${GAME_SERVER_URL}.`,
      );
    }
  }, [inviteMatchID, lobby]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const validName = displayName.trim().length > 0;

  const rememberName = (): string => {
    const name = displayName.trim().slice(0, 30);
    window.localStorage.setItem('gem-council-display-name', name);
    return name;
  };

  const joinMatch = async (match: LobbyAPI.Match) => {
    if (!validName) {
      setError('Enter a display name before joining.');
      return;
    }
    const openSeat = match.players.find((player) => !player.name);
    if (!openSeat) {
      setError('That match no longer has an open seat.');
      await refresh();
      return;
    }
    setBusy(match.matchID);
    setError('');
    try {
      const playerName = rememberName();
      const joined = await lobby.joinMatch(GAME_NAME, match.matchID, {
        playerID: String(openSeat.id),
        playerName,
      });
      const session: MatchSession = {
        matchID: match.matchID,
        playerID: joined.playerID,
        playerCredentials: joined.playerCredentials,
        playerName,
      };
      saveMatchSession(session);
      onSession(session);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not join the match.',
      );
      setBusy('');
      await refresh();
    }
  };

  const createMatch = async () => {
    if (!validName) {
      setError('Enter a display name before creating a match.');
      return;
    }
    setBusy('create');
    setError('');
    try {
      const created = await lobby.createMatch(GAME_NAME, {
        numPlayers: playerCount,
      });
      const playerName = rememberName();
      const joined = await lobby.joinMatch(GAME_NAME, created.matchID, {
        playerID: '0',
        playerName,
      });
      const session: MatchSession = {
        matchID: created.matchID,
        playerID: joined.playerID,
        playerCredentials: joined.playerCredentials,
        playerName,
      };
      saveMatchSession(session);
      onSession(session);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not create the match.',
      );
      setBusy('');
    }
  };

  const copyInvite = async (matchID: string) => {
    await navigator.clipboard.writeText(matchShareURL(matchID));
    setCopied(matchID);
    window.setTimeout(() => setCopied(''), 1800);
  };

  const openMatches = matches.filter(
    (match) => occupiedSeats(match) < match.players.length,
  );

  return (
    <div className="lobby-shell">
      <header className="lobby-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            ◆
          </div>
          <div>
            <strong>Gem Council</strong>
            <span>Browser multiplayer · Version 0</span>
          </div>
        </div>
        <span className="server-chip">
          <span className="connection-dot online" />
          In-memory matches
        </span>
      </header>

      <main className="lobby-main">
        <section className="lobby-hero">
          <span className="eyebrow">Trade wisely. Build permanently.</span>
          <h1>Turn raw gems into prestige.</h1>
          <p>
            Gather tokens, secure development cards, and earn noble visits in a
            focused two-to-four-player strategy game.
          </p>
          <div className="hero-rule-row" aria-label="Game highlights">
            <span>2–4 players</span>
            <span>15 prestige wins</span>
            <span>No account needed</span>
          </div>
        </section>

        <section className="lobby-card create-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Your seat</span>
              <h2>Start at the table</h2>
            </div>
            <span className="step-number">01</span>
          </div>
          <label className="field">
            <span>Display name</span>
            <input
              value={displayName}
              maxLength={30}
              autoComplete="nickname"
              placeholder="How should the table know you?"
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <fieldset className="player-count-field">
            <legend>Seats in a new match</legend>
            <div className="segmented-control">
              {[2, 3, 4].map((count) => (
                <button
                  type="button"
                  key={count}
                  className={playerCount === count ? 'selected' : ''}
                  aria-pressed={playerCount === count}
                  onClick={() => setPlayerCount(count)}
                >
                  {count}
                  <span>players</span>
                </button>
              ))}
            </div>
          </fieldset>
          <button
            type="button"
            className="button button-primary button-full"
            disabled={busy !== '' || !validName}
            onClick={() => void createMatch()}
          >
            {busy === 'create' ? 'Creating match…' : 'Create a private match'}
          </button>
          <p className="form-note">
            You will receive a shareable link after the room is created.
            Credentials stay only in this browser tab.
          </p>
        </section>

        {inviteMatchID && (
          <section className="lobby-card invite-card">
            <div className="section-heading">
              <div>
                <span className="eyebrow">Invitation</span>
                <h2>Join shared match</h2>
              </div>
              <span className="step-number">02</span>
            </div>
            {inviteMatch ? (
              <>
                <div className="match-id-line">
                  <span>Match</span>
                  <strong>{inviteMatch.matchID}</strong>
                </div>
                <div className="seat-meter">
                  <div>
                    <strong>{occupiedSeats(inviteMatch)}</strong>
                    <span>joined</span>
                  </div>
                  <div className="meter-track">
                    <span
                      style={{
                        width: `${
                          (occupiedSeats(inviteMatch) /
                            inviteMatch.players.length) *
                          100
                        }%`,
                      }}
                    />
                  </div>
                  <div>
                    <strong>{inviteMatch.players.length}</strong>
                    <span>seats</span>
                  </div>
                </div>
                <button
                  type="button"
                  className="button button-primary button-full"
                  disabled={
                    busy !== '' ||
                    !validName ||
                    occupiedSeats(inviteMatch) === inviteMatch.players.length
                  }
                  onClick={() => void joinMatch(inviteMatch)}
                >
                  {busy === inviteMatch.matchID
                    ? 'Joining…'
                    : 'Claim an open seat'}
                </button>
              </>
            ) : (
              <p className="empty-copy">Looking up the shared match…</p>
            )}
          </section>
        )}

        <section className="lobby-card matches-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Open tables</span>
              <h2>Join a waiting match</h2>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => void refresh()}
            >
              Refresh
            </button>
          </div>
          <div className="match-list">
            {openMatches.map((match) => (
              <article className="match-row" key={match.matchID}>
                <div className="match-emblem" aria-hidden="true">
                  {match.players.length}
                </div>
                <div className="match-info">
                  <strong>{match.matchID}</strong>
                  <span>
                    {occupiedSeats(match)} of {match.players.length} seats
                    claimed
                  </span>
                </div>
                <div className="match-row-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Copy invite link for ${match.matchID}`}
                    onClick={() => void copyInvite(match.matchID)}
                  >
                    {copied === match.matchID ? '✓' : '↗'}
                  </button>
                  <button
                    type="button"
                    className="button button-ghost button-small"
                    disabled={busy !== '' || !validName}
                    onClick={() => void joinMatch(match)}
                  >
                    Join
                  </button>
                </div>
              </article>
            ))}
            {openMatches.length === 0 && (
              <div className="empty-state">
                <span aria-hidden="true">◇</span>
                <strong>No open matches yet</strong>
                <p>Create one above and invite friends with the share link.</p>
              </div>
            )}
          </div>
        </section>

        {error && (
          <div className="lobby-error" role="alert">
            <strong>Couldn’t complete that request</strong>
            <span>{error}</span>
          </div>
        )}
      </main>
      <footer className="lobby-footer">
        <span>Matches disappear when the server restarts.</span>
        <span>No official artwork is included.</span>
      </footer>
    </div>
  );
}
