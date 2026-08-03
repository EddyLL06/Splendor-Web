import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RoomMatch } from '../../shared/types/room.js';
import type { BotDifficulty } from '../../shared/ai/types.js';
import { jsonRequest, localizedError, useAuth } from '../auth.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { BotDifficultySelect } from '../components/BotDifficultySelect.js';
import { SpectatorPopover } from '../components/SpectatorPopover.js';
import { GAME_NAME } from '../config.js';
import type { AuthenticatedLobbyClient } from '../lobby-client.js';
import { matchShareURL, type MatchSession } from '../session.js';

interface WaitingRoomProps {
  lobby: AuthenticatedLobbyClient;
  session: MatchSession;
  liveMatch?: RoomMatch | null;
  onSession: (session: MatchSession) => void;
  onReady: (match: RoomMatch) => Promise<void>;
  onLeave: () => Promise<void>;
  onRemoved: (reason?: 'spectating-disabled') => void;
}

export function WaitingRoom({
  lobby,
  session,
  liveMatch,
  onSession,
  onReady,
  onLeave,
  onRemoved,
}: WaitingRoomProps) {
  const { t } = useTranslation();
  const { request } = useAuth();
  const [match, setMatch] = useState<RoomMatch | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [botDifficulty, setBotDifficulty] = useState<BotDifficulty>('easy');
  const enteringRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await lobby.getRoomMatch(GAME_NAME, session.matchID);
      if (session.mode === 'spectator' && next.viewer.role !== 'spectator') {
        onRemoved(next.viewer.removalReason);
        return;
      }
      setMatch(next);
      setError('');
      if (next.room.startedAt !== null && !enteringRef.current) {
        enteringRef.current = true;
        try {
          await onReady(next);
        } catch (caught) {
          enteringRef.current = false;
          setError(localizedError(caught));
        }
      }
    } catch (caught) {
      setError(localizedError(caught));
    }
  }, [lobby, onReady, onRemoved, session.matchID, session.mode]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!liveMatch) return;
    setMatch(liveMatch);
    setError('');
    if (liveMatch.room.startedAt !== null && !enteringRef.current) {
      enteringRef.current = true;
      onReady(liveMatch).catch((caught) => {
        enteringRef.current = false;
        setError(localizedError(caught));
      });
    }
  }, [liveMatch, onReady]);

  const occupied = match?.players.filter((player) => player.name).length ?? 0;
  const seats = match?.players.length ?? 0;
  const allSeatsFilled = seats > 0 && occupied === seats;
  const isHost = match?.viewer.isHost ?? false;
  const isStarted = match?.room.startedAt !== null && match !== null;

  const toggleSpectators = async (allowSpectators: boolean) => {
    if (!match) return;
    const removing = allowSpectators ? 0 : match.room.spectatorCount;
    if (
      removing > 0 &&
      !window.confirm(t('waiting.disableSpectatorsConfirm', { count: removing }))
    ) {
      return;
    }
    setBusy('settings');
    setError('');
    try {
      const result = await request<{ deleted: boolean }>(
        `/api/matches/${encodeURIComponent(session.matchID)}/room`,
        {
          ...jsonRequest({
            allowSpectators,
            confirmRemoval: removing > 0,
          }),
          method: 'PATCH',
        },
      );
      if (result.deleted) {
        onRemoved('spectating-disabled');
        return;
      }
      await refresh();
    } catch (caught) {
      setError(localizedError(caught));
    } finally {
      setBusy('');
    }
  };

  const startGame = async () => {
    setBusy('start');
    setError('');
    try {
      await request(
        `/api/matches/${encodeURIComponent(session.matchID)}/start`,
        { method: 'POST' },
      );
      await refresh();
    } catch (caught) {
      setError(localizedError(caught));
      setBusy('');
    }
  };

  const addBot = async (playerID: string) => {
    if (!match) return;
    setBusy(`add-${playerID}`);
    setError('');
    try {
      await request(
        `/api/matches/${encodeURIComponent(session.matchID)}/bots`,
        jsonRequest({ playerID, difficulty: botDifficulty }),
      );
      await refresh();
    } catch (caught) {
      setError(localizedError(caught));
    } finally {
      setBusy('');
    }
  };

  const updateBot = async (playerID: string, difficulty: BotDifficulty) => {
    if (!match) return;
    setBusy(`update-${playerID}`);
    setError('');
    try {
      await request(
        `/api/matches/${encodeURIComponent(session.matchID)}/bots/${playerID}`,
        {
          ...jsonRequest({ playerID, difficulty }),
          method: 'PATCH',
        },
      );
      await refresh();
    } catch (caught) {
      setError(localizedError(caught));
    } finally {
      setBusy('');
    }
  };

  const removeBot = async (playerID: string) => {
    if (!match) return;
    setBusy(`remove-${playerID}`);
    setError('');
    try {
      await request(
        `/api/matches/${encodeURIComponent(session.matchID)}/bots/${playerID}`,
        { method: 'DELETE' },
      );
      await refresh();
    } catch (caught) {
      setError(localizedError(caught));
    } finally {
      setBusy('');
    }
  };

  const switchRole = async () => {
    setBusy('role');
    setError('');
    try {
      if (session.mode === 'player') {
        const changed = await request<{ viewerName: string }>(
          `/api/matches/${encodeURIComponent(session.matchID)}/roles/spectator`,
          jsonRequest({
            playerID: session.playerID,
            credentials: session.playerCredentials,
          }),
        );
        onSession({
          mode: 'spectator',
          matchID: session.matchID,
          viewerName: changed.viewerName,
        });
      } else {
        const changed = await request<{
          playerID: string;
          playerCredentials: string;
          playerName: string;
        }>(
          `/api/matches/${encodeURIComponent(session.matchID)}/roles/player`,
          jsonRequest({}),
        );
        onSession({ mode: 'player', matchID: session.matchID, ...changed });
      }
      setBusy('');
    } catch (caught) {
      setError(localizedError(caught));
      setBusy('');
    }
  };

  return (
    <div className="waiting-shell">
      <div className="waiting-account"><AccountMenu /></div>
      <div className="waiting-glow" />
      <main className="waiting-card">
        <div className="brand-mark large-mark" aria-hidden="true">◆</div>
        <span className="eyebrow">{t('waiting.eyebrow')}</span>
        <h1>{t('waiting.title')}</h1>
        <p>{t('waiting.intro')}</p>
        <div className="waiting-status-row">
          <span className="visibility-badge">{t('waiting.visibility', { visibility: t(match?.unlisted ? 'lobby.private' : 'lobby.public') })}</span>
          {isHost && <span className="host-badge">{t('waiting.host')}</span>}
          {match && <SpectatorPopover room={match.room} />}
        </div>
        <div className="waiting-match-id"><span>{t('waiting.matchID')}</span><strong>{session.matchID}</strong><button type="button" className="button button-ghost button-small" onClick={async () => { await navigator.clipboard.writeText(matchShareURL(session.matchID)); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }}>{copied ? t('waiting.copied') : t('waiting.copy')}</button></div>
        <div className="waiting-progress"><div><span>{t('waiting.playersJoined')}</span><strong>{occupied} / {seats || '…'}</strong></div><div className="meter-track"><span style={{ width: seats ? `${(occupied / seats) * 100}%` : '10%' }} /></div></div>
        <div className="seat-list">
          {match?.players.map((player) => {
            const avatarUrl = player.data?.avatarUrl;
            return <div className={`seat-row${player.name ? ' seat-filled' : ''}`} key={player.id}>
              {avatarUrl ? <img className="seat-avatar" src={avatarUrl} alt="" /> : <span className="seat-number">{Number(player.id) + 1}</span>}
              <div className="seat-identity">
                <strong>{player.name || t('waiting.openSeat')}</strong>
                <span>{player.data?.isViewer ? t('common.you') : player.name ? t('common.ready') : t('waiting.waitingPlayer')}</span>
              </div>
              <div className="seat-actions">
                <div className="seat-labels">
                  {player.kind === 'bot' && (
                    <span className="host-badge compact-host">
                      {t('waiting.botBadge')} · {t(`waiting.bot${player.difficulty === 'easy' ? 'Easy' : player.difficulty === 'normal' ? 'Normal' : player.difficulty === 'hard' ? 'Hard' : 'Expert'}`)}
                    </span>
                  )}
                  {player.data?.isHost && <span className="host-badge compact-host">{t('waiting.host')}</span>}
                  <span className="seat-status">{player.name ? '✓' : '…'}</span>
                </div>
                {player.kind === 'bot' && isHost && !isStarted ? (
                  <div className="bot-controls">
                    <BotDifficultySelect
                      value={player.difficulty ?? 'easy'}
                      disabled={busy !== ''}
                      onChange={(difficulty) => void updateBot(String(player.id), difficulty)}
                    />
                    <button
                      type="button"
                      className="button button-ghost button-small"
                      disabled={busy !== ''}
                      onClick={() => void removeBot(String(player.id))}
                    >
                      {t('waiting.removeBot')}
                    </button>
                  </div>
                ) : !player.name && isHost && !isStarted ? (
                  <div className="bot-controls">
                    <BotDifficultySelect
                      value={botDifficulty}
                      disabled={busy !== ''}
                      onChange={setBotDifficulty}
                    />
                    <button
                      type="button"
                      className="button button-ghost button-small"
                      disabled={busy !== ''}
                      onClick={() => void addBot(String(player.id))}
                    >
                      {t('waiting.addBot')}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>;
          })}
        </div>

        <section className="waiting-controls" aria-label={t('waiting.roomControls')}>
          <label className={`spectator-setting${isHost ? '' : ' read-only'}`}>
            <input
              type="checkbox"
              checked={match?.room.allowSpectators ?? true}
              disabled={!isHost || isStarted || busy !== ''}
              onChange={(event) => void toggleSpectators(event.target.checked)}
            />
            <span><strong>{t('waiting.allowSpectators')}</strong><small>{match?.room.allowSpectators ? t('waiting.spectatingAllowed') : t('waiting.spectatingDisabled')}</small></span>
          </label>

          {!isStarted && session.mode === 'player' && (
            <button type="button" className="button button-ghost button-full" disabled={busy !== '' || !match?.room.allowSpectators || (match?.room.spectatorCount ?? 0) >= (match?.room.spectatorCapacity ?? 10)} onClick={() => void switchRole()}>
              {t('waiting.switchSpectator')}
            </button>
          )}
          {!isStarted && session.mode === 'spectator' && (
            <button type="button" className="button button-ghost button-full" disabled={busy !== '' || allSeatsFilled} onClick={() => void switchRole()}>
              {t('waiting.switchPlayer')}
            </button>
          )}

          {isHost ? (
            <div className="start-game-control">
              <button type="button" className="button button-primary button-full" disabled={busy !== '' || !allSeatsFilled || isStarted} onClick={() => void startGame()}>
                {busy === 'start' ? t('waiting.starting') : t('waiting.startGame')}
              </button>
              {!allSeatsFilled && <small>{t('waiting.fillSeats')}</small>}
            </div>
          ) : (
            <p className="waiting-host-message">{t('waiting.waitingHost')}</p>
          )}
        </section>

        {session.mode === 'spectator' && <p className="spectating-status">{t('game.spectating')}</p>}
        {error && <div className="inline-error" role="alert">{error}</div>}
        <button type="button" className="button button-quiet" disabled={busy !== ''} onClick={async () => { setBusy('leave'); await onLeave(); }}>
          {busy === 'leave' ? t('waiting.leaving') : session.mode === 'spectator' ? t('waiting.leaveSpectator') : t('waiting.leave')}
        </button>
      </main>
    </div>
  );
}
