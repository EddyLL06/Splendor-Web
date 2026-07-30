import { useEffect, useState } from 'react';

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
        <span className="eyebrow">Mandatory resolution</span>
        <h2 id="discard-title">Return exactly {required} tokens</h2>
        <p className="modal-copy">
          You have more than ten tokens. Gold counts toward the limit and may
          also be returned.
        </p>
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
                  aria-label={`Return one fewer ${color} token`}
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
                  aria-label={`Return one more ${color} token`}
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="resolution-total">
          Selected <strong>{selected}</strong> of <strong>{required}</strong>
        </div>
        {!validation.ok && (
          <div className="inline-error">{validation.errors[0].message}</div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={!validation.ok}
            onClick={() => onConfirm(returned)}
          >
            Return tokens
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
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="noble-title"
      >
        <span className="eyebrow">A noble visits</span>
        <h2 id="noble-title">Choose one noble</h2>
        <p className="modal-copy">
          You qualify for more than one. Select the single noble you will
          receive this turn.
        </p>
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
