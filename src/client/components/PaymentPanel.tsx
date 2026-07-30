import { useMemo, useState } from 'react';

import { NORMAL_COLORS } from '../../shared/constants/colors.js';
import {
  analyzePayment,
  getBonuses,
} from '../../shared/rules/selectors.js';
import type {
  CardLocation,
  DevelopmentCard,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../../shared/types/game.js';
import { TokenBadge } from './TokenBadge.js';

interface PaymentPanelProps {
  state: SplendorState;
  playerID: PlayerID;
  card: DevelopmentCard;
  location: CardLocation;
  onCancel: () => void;
  onConfirm: (location: CardLocation, payment: TokenCounts) => void;
}

export function PaymentPanel({
  state,
  playerID,
  card,
  location,
  onCancel,
  onConfirm,
}: PaymentPanelProps) {
  const initial = useMemo(
    () => analyzePayment(state, playerID, card).suggestedPayment,
    [card, playerID, state],
  );
  const [coloredPayment, setColoredPayment] = useState<TokenCounts>(initial);
  const bonuses = getBonuses(state, playerID);
  const remainingGold = NORMAL_COLORS.reduce(
    (total, color) =>
      total +
      Math.max(
        0,
        Math.max(0, card.cost[color] - bonuses[color]) -
          coloredPayment[color],
      ),
    0,
  );
  const payment = { ...coloredPayment, gold: remainingGold };
  const analysis = analyzePayment(state, playerID, card, payment);

  const adjust = (color: (typeof NORMAL_COLORS)[number], delta: number) => {
    const max = Math.min(
      analysis.effectiveCost[color],
      state.players[playerID].tokens[color],
    );
    setColoredPayment((current) => ({
      ...current,
      [color]: Math.max(0, Math.min(max, current[color] + delta)),
    }));
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal payment-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-title"
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">Purchase {card.id}</span>
            <h2 id="payment-title">Choose your payment</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close payment panel"
            onClick={onCancel}
          >
            ×
          </button>
        </div>

        <div className="payment-summary">
          <div>
            <span>Prestige</span>
            <strong>{card.points} ◆</strong>
          </div>
          <div>
            <span>Bonus</span>
            <TokenBadge color={card.bonus} count={1} compact />
          </div>
          <div>
            <span>Gold available</span>
            <strong>{state.players[playerID].tokens.gold}</strong>
          </div>
        </div>

        <div className="payment-table">
          <div className="payment-row payment-header" aria-hidden="true">
            <span>Gem</span>
            <span>Printed</span>
            <span>Bonus</span>
            <span>Effective</span>
            <span>Pay</span>
          </div>
          {NORMAL_COLORS.map((color) => (
            <div className="payment-row" key={color}>
              <TokenBadge color={color} count={state.players[playerID].tokens[color]} compact />
              <span>{card.cost[color]}</span>
              <span>−{bonuses[color]}</span>
              <strong>{analysis.effectiveCost[color]}</strong>
              <span className="stepper">
                <button
                  type="button"
                  aria-label={`Use one fewer ${color} token`}
                  onClick={() => adjust(color, -1)}
                  disabled={coloredPayment[color] === 0}
                >
                  −
                </button>
                <strong>{coloredPayment[color]}</strong>
                <button
                  type="button"
                  aria-label={`Use one more ${color} token`}
                  onClick={() => adjust(color, 1)}
                  disabled={
                    coloredPayment[color] >=
                    Math.min(
                      analysis.effectiveCost[color],
                      state.players[playerID].tokens[color],
                    )
                  }
                >
                  +
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="gold-payment">
          <TokenBadge color="gold" count={payment.gold} />
          <div>
            <strong>Gold jokers in this payment</strong>
            <p>
              Reduce a colored payment above to substitute gold strategically.
            </p>
          </div>
        </div>

        {analysis.errors.length > 0 && (
          <div className="inline-error" role="alert">
            {analysis.errors[0].message}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={analysis.errors.length > 0}
            onClick={() => onConfirm(location, payment)}
          >
            Confirm purchase
          </button>
        </div>
      </section>
    </div>
  );
}
