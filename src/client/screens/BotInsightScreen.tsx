/**
 * /bot/?match=<room code> — human-readable insight into the Expert bot's
 * thinking process: one card per decision with the chosen move, the ranked
 * candidate actions (visits + mean value), a plain-language "why" summary
 * and a compact live game snapshot. Polls the trace endpoint; read-only.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../auth.js';
import { AuthScreen } from './AuthScreen.js';
import { getCard, getNoble } from '../../shared/data/gameData.js';
import type {
  BotTraceDecision,
  BotTraceResponse,
  BotTraceSnapshot,
} from '../../shared/ai/bot-trace-types.js';
import type { BotMove } from '../../shared/ai/types.js';
import type { MainAction, TokenCounts } from '../../shared/types/game.js';

const POLL_INTERVAL_MS = 2_500;

const formatCount = (value: number): string => {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
};

const colorKeyOf = (color: string): string => `colors.${color}`;

/** Human-readable move description from the structured move. */
const describeMove = (
  move: BotMove,
  t: (key: string, options?: Record<string, unknown>) => string,
): string => {
  if (move.move === 'chooseNoble') {
    const noble = getNoble(move.args[0]);
    return t('botInsight.moveNoble', {
      noble: move.args[0],
      points: noble?.points ?? 0,
    });
  }
  if (move.move === 'discardTokens') {
    const returned = move.args[0] as TokenCounts;
    const parts = Object.entries(returned)
      .filter(([, count]) => count > 0)
      .map(([color, count]) => `${count} ${t(colorKeyOf(color))}`);
    return t('botInsight.moveDiscard', { tokens: parts.join(', ') });
  }
  const action = move.args[0] as MainAction;
  switch (action.type) {
    case 'purchase': {
      const card = getCard(action.location.cardId);
      const base = t(
        action.location.source === 'reserved'
          ? 'botInsight.movePurchaseReserved'
          : 'botInsight.movePurchase',
        {
          card: action.location.cardId,
          points: card?.points ?? 0,
        },
      );
      return action.payment.gold > 0
        ? `${base} · ${t('botInsight.goldNote', { count: action.payment.gold })}`
        : base;
    }
    case 'reserveMarket': {
      const card = getCard(action.cardId);
      return `${t('botInsight.moveReserveMarket', {
        card: action.cardId,
        points: card?.points ?? 0,
      })} · ${t('botInsight.goldGain')}`;
    }
    case 'reserveDeck':
      return `${t('botInsight.moveReserveDeck', { tier: action.tier })} · ${t(
        'botInsight.goldGain',
      )}`;
    case 'takeSame':
      return t('botInsight.moveTakeSame', {
        color: t(colorKeyOf(action.color)),
      });
    case 'takeDifferent':
      return t('botInsight.moveTakeDifferent', {
        colors: action.colors.map((color) => t(colorKeyOf(color))).join(', '),
      });
    case 'pass':
      return t('botInsight.movePass');
    default:
      return String((action as { type?: string }).type ?? 'action');
  }
};

const labelOf = (
  move: BotMove,
  t: (key: string, options?: Record<string, unknown>) => string,
): string => describeMove(move, t);

interface DecisionCardProps {
  entry: BotTraceDecision;
  selected: boolean;
  onSelect: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function DecisionCard({ entry, selected, onSelect, t }: DecisionCardProps) {
  return (
    <button
      type="button"
      className={`bi-card${selected ? ' bi-card-selected' : ''}`}
      onClick={onSelect}
    >
      <div className="bi-card-head">
        <span className="bi-card-index">#{entry.id}</span>
        <span className="bi-card-move">{describeMove(entry.move, t)}</span>
      </div>
      <div className="bi-card-meta">
        <span title={t('botInsight.simulations')}>
          {formatCount(entry.sims)} {t('botInsight.simShort')}
        </span>
        <span>{Math.round(entry.elapsedMs)}ms</span>
        <span>
          {entry.determinizations} {t('botInsight.detsShort')}
        </span>
        {entry.timedOut && (
          <span className="bi-badge bi-badge-warn">{t('botInsight.timedOut')}</span>
        )}
        {entry.fallbackLevel > 0 && (
          <span className="bi-badge bi-badge-warn">
            {t('botInsight.fallback')} L{entry.fallbackLevel}
          </span>
        )}
      </div>
    </button>
  );
}

function SnapshotPanel({
  snapshot,
  botPlayerID,
  t,
}: {
  snapshot: BotTraceSnapshot | null;
  botPlayerID: string | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (!snapshot) {
    return (
      <div className="bi-snapshot bi-muted">{t('botInsight.noSnapshot')}</div>
    );
  }
  return (
    <div className="bi-snapshot">
      {snapshot.finalRound && (
        <span className="bi-badge bi-badge-accent">{t('botInsight.finalRound')}</span>
      )}
      {snapshot.gameover && (
        <span className="bi-badge bi-badge-accent">
          {t('botInsight.gameOver')}:{' '}
          {snapshot.winners.map((player) => t('common.player', { number: Number(player) + 1 })).join(', ')}
        </span>
      )}
      {Object.entries(snapshot.players).map(([playerID, player]) => (
        <div className="bi-player" key={playerID}>
          <div className="bi-player-head">
            <strong>{t('common.player', { number: Number(playerID) + 1 })}</strong>
            {botPlayerID === playerID && (
              <span className="bi-badge bi-badge-turn">{t('botInsight.expertBot')}</span>
            )}
            {snapshot.currentPlayer === playerID && !snapshot.gameover && (
              <span className="bi-badge bi-badge-warn">{t('botInsight.thinking')}</span>
            )}
            <span className="bi-score">
              {player.score} / 15
            </span>
          </div>
          <div className="bi-score-bar">
            <div
              className="bi-score-fill"
              style={{ width: `${Math.min(100, (player.score / 15) * 100)}%` }}
            />
          </div>
          <div className="bi-chips">
            {Object.entries(player.tokens).map(([color, count]) =>
              count > 0 ? (
                <span className={`bi-chip bi-chip-${color}`} key={color}>
                  {t(colorKeyOf(color))} {count}
                </span>
              ) : null,
            )}
          </div>
          <div className="bi-chips">
            {Object.entries(player.bonuses).map(([color, count]) =>
              count > 0 ? (
                <span className={`bi-chip bi-bonus bi-bonus-${color}`} key={color}>
                  {t(colorKeyOf(color))} ×{count}
                </span>
              ) : null,
            )}
          </div>
          <div className="bi-player-meta">
            {t('botInsight.purchased', { count: player.purchasedCount })} ·{' '}
            {t('botInsight.reservedCount', { count: player.reservedCount })} ·{' '}
            {t('botInsight.noblesCount', { count: player.nobleCount })}
          </div>
        </div>
      ))}
      <div className="bi-snapshot-foot">
        <span>
          {t('botInsight.turn')}: {snapshot.completedTurns}
        </span>
        <span>
          {t('botInsight.deckLeft', {
            one: snapshot.deckCounts[1],
            two: snapshot.deckCounts[2],
            three: snapshot.deckCounts[3],
          })}
        </span>
        {snapshot.pending?.type === 'discard' && (
          <span className="bi-badge bi-badge-warn">
            {t('botInsight.pendingDiscard', { count: snapshot.pending.count })}
          </span>
        )}
        {snapshot.pending?.type === 'noble' && (
          <span className="bi-badge bi-badge-warn">{t('botInsight.pendingNoble')}</span>
        )}
      </div>
      <div className="bi-snapshot-foot">
        <span>
          {t('botInsight.bank')}:{' '}
          {Object.entries(snapshot.bank)
            .filter(([, count]) => count > 0)
            .map(([color, count]) => `${t(colorKeyOf(color))} ${count}`)
            .join(' · ') || '—'}
        </span>
      </div>
      <div className="bi-muted bi-snapshot-foot-note">
        {t('botInsight.snapshotNote')}
      </div>
    </div>
  );
}

function DetailPanel({
  entry,
  t,
}: {
  entry: BotTraceDecision | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (!entry) {
    return (
      <div className="bi-detail bi-muted">
        {t('botInsight.pickDecision')}
      </div>
    );
  }
  const top = entry.topActions[0];
  const second = entry.topActions[1];
  const secondLabel = second ? describeMoveLabel(second.actionKey, t) : '';
  const maxVisits = Math.max(1, ...entry.topActions.map((action) => action.visits));
  const bestMean = entry.topActions.reduce(
    (max, action) => Math.max(max, action.mean),
    -1,
  );
  const worstMean = entry.topActions.reduce(
    (min, action) => Math.min(min, action.mean),
    1,
  );
  return (
    <div className="bi-detail">
      <h3 className="bi-detail-title">#{entry.id} · {describeMove(entry.move, t)}</h3>
      <div className="bi-meta-row">
        <span>
          {formatCount(entry.sims)} {t('botInsight.simulations')}
        </span>
        <span>
          {entry.elapsedMs}ms
        </span>
        <span>
          {entry.determinizations} {t('botInsight.determinizations')}
        </span>
      </div>
      <div className="bi-why">
        <strong>{t('botInsight.why')}</strong>
        <p>
          {top
            ? t('botInsight.whyChosen', {
                move: labelOf(entry.move, t),
                mean: top.mean.toFixed(3),
                sims: formatCount(entry.sims),
                dets: entry.determinizations,
              })
            : ''}
        </p>
        {second && (
          <p>
            {t('botInsight.whyRunnerUp', {
              move: secondLabel,
              mean: second.mean.toFixed(3),
              visits: formatCount(second.visits),
            })}
          </p>
        )}
        {entry.timedOut && <p>{t('botInsight.whyTimedOut')}</p>}
        {entry.fallbackLevel > 0 && (
          <p>{t('botInsight.whyFallback', { level: entry.fallbackLevel })}</p>
        )}
      </div>
      <div className="bi-bars">
        {entry.topActions.map((action, index) => {
          const isChosen = index === 0;
          const meanT = (action.mean - worstMean) / Math.max(0.0001, bestMean - worstMean);
          return (
            <div
              className={`bi-bar-row${isChosen ? ' bi-bar-chosen' : ''}`}
              key={action.actionKey}
            >
              <div className="bi-bar-label">
                <span>{isChosen ? '★ ' : ''}{describeMoveLabel(action.actionKey, t)}</span>
                <span className="bi-bar-stats">
                  {formatCount(action.visits)} v · {action.mean.toFixed(3)}
                </span>
              </div>
              <div className="bi-bar-track">
                <div
                  className={`bi-bar-visits${isChosen ? ' bi-bar-chosen-fill' : ''}`}
                  style={{ width: `${(action.visits / maxVisits) * 100}%` }}
                />
              </div>
              <div className="bi-bar-mean-track">
                <div
                  className="bi-bar-mean"
                  style={{ width: `${meanT * 100}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="bi-muted bi-note">{t('botInsight.barsNote')}</div>
    </div>
  );
}

/** Compact candidate label from an actionKey (for the bar chart). */
const describeMoveLabel = (
  actionKey: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string => {
  if (actionKey.startsWith('purchase:')) {
    const cardId = actionKey.split(':').pop() ?? '';
    const card = getCard(cardId);
    return t('botInsight.shortPurchase', {
      card: cardId,
      points: card?.points ?? 0,
    });
  }
  if (actionKey.startsWith('reserveMarket:')) {
    const cardId = actionKey.split(':').pop() ?? '';
    const card = getCard(cardId);
    return t('botInsight.shortReserve', {
      card: cardId,
      points: card?.points ?? 0,
    });
  }
  if (actionKey.startsWith('reserveDeck:')) {
    const tier = actionKey.split(':').pop() ?? '';
    return t('botInsight.shortReserveDeck', { tier });
  }
  if (actionKey.startsWith('takeSame:')) {
    const color = actionKey.split(':').pop() ?? '';
    return t('botInsight.shortTakeSame', { color: t(colorKeyOf(color)) });
  }
  if (actionKey.startsWith('takeDifferent:')) {
    const colors = (actionKey.split(':').pop() ?? '')
      .split(',')
      .map((color) => t(colorKeyOf(color)))
      .join(',');
    return t('botInsight.shortTakeDifferent', { colors });
  }
  if (actionKey.startsWith('discard:')) return t('botInsight.shortDiscard');
  if (actionKey.startsWith('noble:')) return t('botInsight.shortNoble');
  return actionKey;
};

export default function BotInsightScreen() {
  const { t } = useTranslation();
  const { user, loading, request } = useAuth();
  const [roomCode, setRoomCode] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('match') ?? '';
  });
  const [data, setData] = useState<BotTraceResponse | null>(null);
  const [selectedID, setSelectedID] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const pollInFlight = useRef(false);

  const applyRoomCode = useCallback((next: string) => {
    const clean = next.trim();
    setRoomCode(clean);
    const url = new URL(window.location.href);
    if (clean) url.searchParams.set('match', clean);
    else url.searchParams.delete('match');
    window.history.replaceState(null, '', url);
  }, []);

  const poll = useCallback(async () => {
    if (!roomCode || pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      const response = await request<BotTraceResponse>(
        `/api/matches/${encodeURIComponent(roomCode)}/bot-trace`,
      );
      setData(response);
      setError('');
      setLastUpdated(Date.now());
      setSelectedID((current) => {
        if (current === null && response.entries.length > 0) {
          return response.entries[response.entries.length - 1].id;
        }
        return current;
      });
    } catch (caught) {
      const status = (caught as { status?: number }).status;
      const code = (caught as { code?: string }).code;
      if (status === 404 || code === 'MATCH_NOT_FOUND') {
        setError(t('botInsight.notFound'));
      } else if (status === 403 || code === 'FORBIDDEN') {
        setError(t('botInsight.forbidden'));
      } else {
        setError(t('errors.NETWORK_ERROR'));
      }
    } finally {
      pollInFlight.current = false;
    }
  }, [request, roomCode, t]);

  useEffect(() => {
    if (!user || loading) return;
    setData(null);
    setSelectedID(null);
    setError('');
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // Re-poll whenever the room code changes; poll is stable per code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, user, loading, roomCode]);

  const entries = useMemo(
    () => (data ? [...data.entries].sort((a, b) => b.id - a.id) : []),
    [data],
  );
  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedID) ?? entries[0] ?? null,
    [entries, selectedID],
  );

  if (loading) return <div className="loading-screen">{t('common.loading')}</div>;
  if (!user) return <AuthScreen />;

  return (
    <div className="bi-page">
      <header className="bi-header">
        <a className="brand-mark" href="/" title={t('botInsight.backToGame')}>◆</a>
        <div className="bi-header-title">
          <h1>{t('botInsight.title')}</h1>
          <p>{t('botInsight.subtitle')}</p>
        </div>
        <div className="bi-room-form">
          <input
            value={roomCode}
            onChange={(event) => applyRoomCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void poll();
            }}
            placeholder={t('botInsight.roomCodePlaceholder')}
            aria-label={t('botInsight.roomCode')}
          />
          <button type="button" className="bi-button" onClick={() => void poll()}>
            {t('botInsight.load')}
          </button>
          <a className="bi-button bi-button-ghost" href="/">
            {t('botInsight.backToGame')}
          </a>
        </div>
      </header>
      {lastUpdated && (
        <div className="bi-status">
          {t('botInsight.liveUpdated', {
            time: new Date(lastUpdated).toLocaleTimeString(),
          })}
        </div>
      )}
      {error && <div className="bi-error">{error}</div>}
      {!error && (
        <main className="bi-main">
          <section className="bi-snapshot-col">
            <SnapshotPanel
              snapshot={data?.snapshot ?? null}
              botPlayerID={data?.botPlayerID ?? null}
              t={t}
            />
          </section>
          <section className="bi-feed-col">
            <div className="bi-feed-head">
              <strong>{t('botInsight.decisions')}</strong>
              <span>
                {t('botInsight.decisionCount', { count: entries.length })}
              </span>
            </div>
            {entries.length === 0 ? (
              <div className="bi-muted bi-empty">{t('botInsight.noTrace')}</div>
            ) : (
              entries.map((entry) => (
                <DecisionCard
                  key={entry.id}
                  entry={entry}
                  selected={entry.id === selected?.id}
                  onSelect={() => setSelectedID(entry.id)}
                  t={t}
                />
              ))
            )}
          </section>
          <section className="bi-detail-col">
            <DetailPanel entry={selected} t={t} />
          </section>
        </main>
      )}
    </div>
  );
}
