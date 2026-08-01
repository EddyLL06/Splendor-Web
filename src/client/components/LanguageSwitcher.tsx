import { useTranslation } from 'react-i18next';

import { setLanguage, type SupportedLanguage } from '../i18n.js';

export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current: SupportedLanguage = i18n.language === 'zh-CN' ? 'zh-CN' : 'en';
  return (
    <div className="language-switcher" aria-label="Language / 语言">
      <button
        type="button"
        className={current === 'en' ? 'selected' : ''}
        aria-pressed={current === 'en'}
        onClick={() => void setLanguage('en')}
      >
        {t('common.english')}
      </button>
      <button
        type="button"
        className={current === 'zh-CN' ? 'selected' : ''}
        aria-pressed={current === 'zh-CN'}
        onClick={() => void setLanguage('zh-CN')}
      >
        {t('common.chinese')}
      </button>
    </div>
  );
}
