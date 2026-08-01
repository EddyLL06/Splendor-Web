import { useTranslation } from 'react-i18next';

import { COLOR_SHORT_LABELS } from '../../shared/constants/colors.js';
import type { TokenColor } from '../../shared/types/game.js';

interface TokenBadgeProps {
  color: TokenColor;
  count: number;
  compact?: boolean;
}

export function TokenBadge({
  color,
  count,
  compact = false,
}: TokenBadgeProps) {
  const { t } = useTranslation();
  const label = t(`colors.${color}`);
  return (
    <span
      className={`token-badge token-${color}${compact ? ' token-compact' : ''}`}
      aria-label={`${count} ${label}`}
      title={label}
    >
      <span className="token-symbol" aria-hidden="true">
        {COLOR_SHORT_LABELS[color]}
      </span>
      <span className="token-count">{count}</span>
    </span>
  );
}
