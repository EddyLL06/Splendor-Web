import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  NORMAL_COLORS,
  TOKEN_COLORS,
} from '../../shared/constants/colors.js';
import {
  applyDiscard,
  suggestedDiscard,
} from '../../shared/rules/engine.js';
import { requireNoble } from '../../shared/data/gameData.js';
import type {
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../../shared/types/game.js';
import { TokenBadge } from './TokenBadge.js';

interface DiscardPanelProps {
  state: SplendorState;
  playerID: PlayerID;
  currentPlayerID: PlayerID;
  onConfirm: (tokens: TokenCounts) => void;
}

export function DiscardPanel({
  state,
  playerID,
  currentPlayerID,
  onConfirm,
}: DiscardPanelProps) {
  const { t } = useTranslation();
  const [returned, setReturned] = useState(() =>
    suggestedDiscard(state, playerID),
  );
  useEffect(() => {
    setReturned(suggestedDiscard(state, playerID));
  }, [playerID, state]);
  const validation = applyDiscard(
    state,
    playerID,
    currentPlayerID,
    returned,
  );
  const required = state.pending?.type === 'discard' ? state.pending.count : 0;
  const selected = Object.values(returned).reduce(
    (total, count) => total + count,
    0,
  );

  const adjust = (color: (typeof TOKEN_COLORS)[number], delta: number) => {
    setReturned((current) => ({
      ...current,
      [color]: Math.max(
        0,
        Math.min(
          state.players[playerID].tokens[color],
          current[color] + delta,
        ),
      ),
    }));
  };

  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discard-title"
      >
        <span className="eyebrow">{t('game.mandatory')}</span>
        <h2 id="discard-title">{t('game.returnExactly', { count: required })}</h2>
        <p className="modal-copy">{t('game.returnHelp')}</p>
        <div className="discard-grid">
          {TOKEN_COLORS.map((color) => (
            <div className="discard-control" key={color}>
              <TokenBadge
                color={color}
                count={state.players[playerID].tokens[color]}
              />
              <div className="stepper">
                <button
                  type="button"
                  onClick={() => adjust(color, -1)}
                  disabled={returned[color] === 0}
                  aria-label={t('game.returnFewer', { color: t(`colors.${color}`) })}
                >
                  −
                </button>
                <strong>{returned[color]}</strong>
                <button
                  type="button"
                  onClick={() => adjust(color, 1)}
                  disabled={
                    returned[color] >= state.players[playerID].tokens[color]
                  }
                  aria-label={t('game.returnMore', { color: t(`colors.${color}`) })}
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="resolution-total">
          {t('game.selected', { selected, required })}
        </div>
        {!validation.ok && (
          <div className="inline-error">{t('errors.INVALID_INPUT')}</div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={!validation.ok}
            onClick={() => onConfirm(returned)}
          >
            {t('game.returnTokens')}
          </button>
        </div>
      </section>
    </div>
  );
}

interface NoblePanelProps {
  nobleIDs: string[];
  onChoose: (nobleID: string) => void;
}

export function NoblePanel({ nobleIDs, onChoose }: NoblePanelProps) {
  const { t } = useTranslation();
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="noble-title"
      >
        <span className="eyebrow">{t('game.nobleVisits')}</span>
        <h2 id="noble-title">{t('game.chooseNoble')}</h2>
        <p className="modal-copy">{t('game.nobleHelp')}</p>
        <div className="noble-choice-grid">
          {nobleIDs.map((nobleID) => {
            const noble = requireNoble(nobleID);
            return (
              <button
                type="button"
                className="noble-tile noble-choice"
                key={nobleID}
                onClick={() => onChoose(nobleID)}
              >
                <strong>{noble.points} ◆</strong>
                <span>{noble.id}</span>
                <div className="noble-requirements">
                  {NORMAL_COLORS.filter(
                    (color) => noble.requirement[color] > 0,
                  ).map((color) => (
                    <TokenBadge
                      key={color}
                      color={color}
                      count={noble.requirement[color]}
                      compact
                    />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
