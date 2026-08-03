import { useTranslation } from 'react-i18next';

import type { BotDifficulty } from '../../shared/ai/types.js';

export function BotDifficultySelect({
  value,
  onChange,
  disabled,
}: {
  value: BotDifficulty;
  onChange: (difficulty: BotDifficulty) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <label className="bot-difficulty-control">
      <span>{t('waiting.difficulty')}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as BotDifficulty)}
        aria-label={t('waiting.difficulty')}
      >
        <option value="easy">{t('waiting.botEasy')}</option>
        <option value="normal">{t('waiting.botNormal')}</option>
        <option value="hard">{t('waiting.botHard')}</option>
        <option value="expert">{t('waiting.botExpert')}</option>
      </select>
    </label>
  );
}
