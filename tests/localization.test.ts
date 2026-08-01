// @vitest-environment jsdom

import { afterAll, describe, expect, it } from 'vitest';

import { ClientApiError, localizedError } from '../src/client/auth.js';
import i18n, {
  LANGUAGE_STORAGE_KEY,
  setLanguage,
  translations,
} from '../src/client/i18n.js';

const flattenKeys = (value: object, prefix = ''): string[] =>
  Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return nested && typeof nested === 'object'
      ? flattenKeys(nested as object, path)
      : [path];
  });

describe('English and Simplified Chinese localization', () => {
  afterAll(async () => {
    await setLanguage('en');
  });

  it('defaults to English on a first visit regardless of browser language', () => {
    expect(i18n.language).toBe('en');
    expect(translations.en.translation.auth.signIn).toBe('Sign in');
  });

  it('persists only the explicit language preference', async () => {
    localStorage.clear();
    await setLanguage('zh-CN');
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-CN');
    expect(Object.keys(localStorage)).toEqual([LANGUAGE_STORAGE_KEY]);
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('keeps English and Chinese translation key sets exactly aligned', () => {
    const english = flattenKeys(translations.en.translation).sort();
    const chinese = flattenKeys(translations['zh-CN'].translation).sort();
    expect(chinese).toEqual(english);
  });

  it('contains representative auth, lobby, profile, waiting-room, and game text in both languages', () => {
    expect(translations.en.translation.auth.createAccount).toBeTruthy();
    expect(translations.en.translation.account.upload).toBeTruthy();
    expect(translations.en.translation.lobby.visibility).toBeTruthy();
    expect(translations.en.translation.waiting.playersJoined).toBeTruthy();
    expect(translations.en.translation.game.confirmPurchase).toBeTruthy();
    expect(translations['zh-CN'].translation.auth.createAccount).toContain('账户');
    expect(translations['zh-CN'].translation.account.upload).toContain('头像');
    expect(translations['zh-CN'].translation.lobby.visibility).toContain('可见');
    expect(translations['zh-CN'].translation.waiting.playersJoined).toContain('玩家');
    expect(translations['zh-CN'].translation.game.confirmPurchase).toContain('购买');
  });

  it('maps stable server error codes without exposing raw response text', async () => {
    await setLanguage('en');
    expect(localizedError(new ClientApiError('AUTH_INVALID_CREDENTIALS', 401))).toBe(
      'The email or password is incorrect.',
    );
    expect(localizedError({ details: { error: { code: 'MATCH_FULL' }, raw: 'SQL secret' } })).toBe(
      'That match no longer has an open seat.',
    );
  });
});
