import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RoomMatch } from '../../shared/types/room.js';
import { jsonRequest, localizedError, useAuth } from '../auth.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { SpectatorPopover } from '../components/SpectatorPopover.js';
import { GAME_NAME } from '../config.js';
import type { AuthenticatedLobbyClient } from '../lobby-client.js';
import { matchShareURL, type MatchSession } from '../session.js';

const LOBBY_REVALIDATION_INTERVAL_MS = 15_000;

interface LobbyScreenProps {
  lobby: AuthenticatedLobbyClient;
  inviteMatchID: string | null;
  onSession: (session: MatchSession) => void;
  notice?: string;
  autoEnterInvite?: boolean;
}

const occupiedSeats = (match: RoomMatch): number =>
  match.players.filter((player) => Boolean(player.name)).length;

export function LobbyScreen({
  lobby,
  inviteMatchID,
  onSession,
  notice = '',
  autoEnterInvite = true,
}: LobbyScreenProps) {
  const { t } = useTranslation();
  const { user, request } = useAuth();
  const [playerCount, setPlayerCount] = useState(3);
  const [isPrivate, setIsPrivate] = useState(false);
  const [matches, setMatches] = useState<RoomMatch[]>([]);
  const [inviteMatch, setInviteMatch] = useState<RoomMatch | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const lastRefreshAt = useRef(0);
  const autoEnteredInvite = useRef('');

  const refresh = useCallback(async () => {
    lastRefreshAt.current = Date.now();
    try {
      const response = await lobby.listRoomMatches(GAME_NAME, {
        isGameover: false,
      });
      setMatches(response.matches);
      if (inviteMatchID) {
        setInviteMatch(
          response.matches.find((match) => match.matchID === inviteMatchID) ??
            (await lobby.getRoomMatch(GAME_NAME, inviteMatchID)),
        );
      } else {
        setInviteMatch(null);
      }
      setError('');
    } catch (caught) {
      setError(localizedError(caught));
    }
  }, [inviteMatchID, lobby]);

  useEffect(() => {
    const refreshIfStale = () => {
      if (
        lastRefreshAt.current > 0 &&
        (document.visibilityState === 'hidden' ||
          Date.now() - lastRefreshAt.current < LOBBY_REVALIDATION_INTERVAL_MS)
      ) {
        return;
      }
      void refresh();
    };
    refreshIfStale();
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', refreshIfStale);
    return () => {
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', refreshIfStale);
    };
  }, [refresh]);

  const enterMatch = useCallback(
    async (match: RoomMatch) => {
      if (!user) return;
      setBusy(match.matchID);
      setError('');
      try {
        if (match.viewer.role === 'player') {
          const restored = await request<{
            playerID: string;
            playerCredentials: string;
            playerName: string;
          }>(`/api/matches/${encodeURIComponent(match.matchID)}/reclaim`, {
            method: 'POST',
          });
          onSession({ mode: 'player', matchID: match.matchID, ...restored });
          return;
        }
        if (match.room.startedAt !== null) {
          const joined = await request<{ viewerName: string }>(
            `/api/matches/${encodeURIComponent(match.matchID)}/spectators/join`,
            jsonRequest({}),
          );
          onSession({
            mode: 'spectator',
            matchID: match.matchID,
            viewerName: joined.viewerName,
          });
          return;
        }
        const openSeat = match.players.find((player) => !player.name);
        if (!openSeat) throw new Error('MATCH_FULL');
        const joined = await lobby.joinMatch(GAME_NAME, match.matchID, {
          playerID: String(openSeat.id),
          playerName: user.username,
        });
        onSession({
          mode: 'player',
          matchID: match.matchID,
          playerID: joined.playerID,
          playerCredentials: joined.playerCredentials,
          playerName: user.username,
        });
      } catch (caught) {
        setError(
          caught instanceof Error && caught.message === 'MATCH_FULL'
            ? t('errors.MATCH_FULL')
            : localizedError(caught),
        );
        setBusy('');
        await refresh();
      }
    },
    [lobby, onSession, refresh, request, t, user],
  );

  useEffect(() => {
    if (
      !inviteMatch ||
      !autoEnterInvite ||
      inviteMatch.room.startedAt === null ||
      autoEnteredInvite.current === inviteMatch.matchID
    ) {
      return;
    }
    autoEnteredInvite.current = inviteMatch.matchID;
    void enterMatch(inviteMatch);
  }, [autoEnterInvite, enterMatch, inviteMatch]);

  const createMatch = async () => {
    if (!user) return;
    setBusy('create');
    setError('');
    try {
      const created = await lobby.createMatch(GAME_NAME, {
        numPlayers: playerCount,
        unlisted: isPrivate,
      });
      const joined = await lobby.joinMatch(GAME_NAME, created.matchID, {
        playerID: '0',
        playerName: user.username,
      });
      onSession({
        mode: 'player',
        matchID: created.matchID,
        playerID: joined.playerID,
        playerCredentials: joined.playerCredentials,
        playerName: user.username,
      });
    } catch (caught) {
      setError(localizedError(caught));
      setBusy('');
    }
  };

  const copyInvite = async (matchID: string) => {
    await navigator.clipboard.writeText(matchShareURL(matchID));
    setCopied(matchID);
    window.setTimeout(() => setCopied(''), 1800);
  };

  const waitingMatches = matches.filter(
    (match) => match.room.startedAt === null,
  );
  const liveMatches = matches.filter(
    (match) => match.room.startedAt !== null,
  );

  const liveAction = (match: RoomMatch) => {
    if (match.viewer.role === 'player') {
      return { label: t('lobby.rejoin'), disabled: false, reason: '' };
    }
    if (!match.room.allowSpectators) {
      return {
        label: t('lobby.watch'),
        disabled: true,
        reason: t('errors.SPECTATING_DISABLED'),
      };
    }
    if (match.room.spectatorCount >= match.room.spectatorCapacity) {
      return {
        label: t('lobby.watch'),
        disabled: true,
        reason: t('errors.SPECTATOR_LIMIT_REACHED'),
      };
    }
    return { label: t('lobby.watch'), disabled: false, reason: '' };
  };

  return (
    <div className="lobby-shell">
      <header className="lobby-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">◆</div>
          <div><strong>{t('common.appName')}</strong><span>{t('lobby.browserMultiplayer')}</span></div>
        </div>
        <div className="header-account-row">
          <span className="server-chip"><span className="connection-dot online" />{t('lobby.inMemory')}</span>
          <AccountMenu />
        </div>
      </header>
      <main className="lobby-main">
        {notice && <div className="lobby-notice" role="status">{notice}</div>}
        <section className="lobby-hero">
          <span className="eyebrow">{t('lobby.eyebrow')}</span>
          <h1>{t('lobby.title')}</h1>
          <p>{t('lobby.intro')}</p>
          <div className="hero-rule-row" aria-label={t('lobby.players24')}>
            <span>{t('lobby.players24')}</span><span>{t('lobby.prestige15')}</span><span>{t('lobby.verifiedAccounts')}</span>
          </div>
        </section>
        <section className="lobby-card create-card">
          <div className="section-heading"><div><span className="eyebrow">{t('lobby.newTable')}</span><h2>{t('lobby.start')}</h2></div><span className="step-number">01</span></div>
          <fieldset className="player-count-field">
            <legend>{t('lobby.seats')}</legend>
            <div className="segmented-control">
              {[2, 3, 4].map((count) => (
                <button type="button" key={count} className={playerCount === count ? 'selected' : ''} aria-pressed={playerCount === count} onClick={() => setPlayerCount(count)}>
                  {count}<span>{t('lobby.players', { count })}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="visibility-field">
            <legend>{t('lobby.visibility')}</legend>
            {[false, true].map((privateRoom) => (
              <label key={String(privateRoom)} className={isPrivate === privateRoom ? 'visibility-option selected' : 'visibility-option'}>
                <input type="radio" name="visibility" checked={isPrivate === privateRoom} onChange={() => setIsPrivate(privateRoom)} />
                <span><strong>{t(privateRoom ? 'lobby.private' : 'lobby.public')}</strong><small>{t(privateRoom ? 'lobby.privateHelp' : 'lobby.publicHelp')}</small></span>
              </label>
            ))}
          </fieldset>
          <button type="button" className="button button-primary button-full" disabled={busy !== ''} onClick={() => void createMatch()}>
            {busy === 'create' ? t('lobby.creating') : t('lobby.create')}
          </button>
          <p className="form-note">{t('lobby.createNote')}</p>
        </section>
        {inviteMatchID && (
          <section className="lobby-card invite-card">
            <div className="section-heading"><div><span className="eyebrow">{t('lobby.invitation')}</span><h2>{t('lobby.joinShared')}</h2></div><span className="step-number">02</span></div>
            {inviteMatch ? <>
              <div className="match-id-line"><span>{t('lobby.matchID')}</span><strong>{inviteMatch.matchID}</strong></div>
              <div className="seat-meter"><div><strong>{occupiedSeats(inviteMatch)}</strong><span>{t('lobby.joined')}</span></div><div className="meter-track"><span style={{ width: `${(occupiedSeats(inviteMatch) / inviteMatch.players.length) * 100}%` }} /></div><div><strong>{inviteMatch.players.length}</strong><span>{t('lobby.seatCount')}</span></div></div>
              {inviteMatch.room.startedAt === null ? (
                <button type="button" className="button button-primary button-full" disabled={busy !== '' || (!inviteMatch.players.some((player) => !player.name) && inviteMatch.viewer.role !== 'player')} onClick={() => void enterMatch(inviteMatch)}>
                  {busy === inviteMatch.matchID ? t('lobby.joining') : inviteMatch.viewer.role === 'player' ? t('lobby.rejoin') : t('lobby.claim')}
                </button>
              ) : (
                <p className="form-note">{busy === inviteMatch.matchID ? t('lobby.joining') : t('lobby.enteringLive')}</p>
              )}
            </> : <p className="empty-copy">{t('lobby.lookup')}</p>}
          </section>
        )}
        <section className="lobby-card matches-card">
          <div className="section-heading"><div><span className="eyebrow">{t('lobby.openTables')}</span><h2>{t('lobby.joinWaiting')}</h2></div><button type="button" className="text-button" onClick={() => void refresh()}>{t('common.refresh')}</button></div>
          <div className="match-list">
            {waitingMatches.map((match) => (
              <article className="match-row" key={match.matchID}>
                <div className="match-emblem" aria-hidden="true">{match.players.length}</div>
                <div className="match-info"><strong>{match.matchID}</strong><span>{t('lobby.seatsClaimed', { occupied: occupiedSeats(match), total: match.players.length })}</span></div>
                <div className="match-row-actions">
                  <button type="button" className="icon-button" aria-label={t('lobby.copyInviteFor', { id: match.matchID })} onClick={() => void copyInvite(match.matchID)}>{copied === match.matchID ? '✓' : '↗'}</button>
                  <button type="button" className="button button-ghost button-small" disabled={busy !== '' || (!match.players.some((player) => !player.name) && match.viewer.role !== 'player')} onClick={() => void enterMatch(match)}>{match.viewer.role === 'player' ? t('lobby.rejoin') : t('lobby.join')}</button>
                </div>
              </article>
            ))}
            {waitingMatches.length === 0 && <div className="empty-state"><span aria-hidden="true">◇</span><strong>{t('lobby.noMatches')}</strong><p>{t('lobby.noMatchesHelp')}</p></div>}
          </div>
        </section>
        <section className="lobby-card matches-card live-matches-card">
          <div className="section-heading"><div><span className="eyebrow">{t('lobby.live')}</span><h2>{t('lobby.inProgress')}</h2></div></div>
          <div className="match-list">
            {liveMatches.map((match) => {
              const action = liveAction(match);
              return (
                <article className="match-row live-match-row" key={match.matchID}>
                  <div className="match-emblem live-emblem" aria-hidden="true">●</div>
                  <div className="match-info"><strong>{match.matchID}</strong><span>{action.reason || t('lobby.liveHelp')}</span></div>
                  <div className="match-row-actions">
                    <SpectatorPopover room={match.room} />
                    <button type="button" className="button button-primary button-small" disabled={busy !== '' || action.disabled} onClick={() => void enterMatch(match)}>{action.label}</button>
                  </div>
                </article>
              );
            })}
            {liveMatches.length === 0 && <div className="empty-state compact-empty"><span aria-hidden="true">◉</span><strong>{t('lobby.noLiveMatches')}</strong></div>}
          </div>
        </section>
        {error && <div className="lobby-error" role="alert"><strong>{t('lobby.requestFailed')}</strong><span>{error}</span></div>}
      </main>
      <footer className="lobby-footer"><span>{t('lobby.disappears')}</span><span>{t('lobby.noArtwork')}</span></footer>
    </div>
  );
}
