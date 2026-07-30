import type {
  GemColor,
  GemCounts,
  TokenColor,
  TokenCounts,
} from '../types/game.js';

export const NORMAL_COLORS: readonly GemColor[] = [
  'white',
  'blue',
  'green',
  'red',
  'black',
];

export const TOKEN_COLORS: readonly TokenColor[] = [
  ...NORMAL_COLORS,
  'gold',
];

export const COLOR_LABELS: Record<TokenColor, string> = {
  white: 'Diamond',
  blue: 'Sapphire',
  green: 'Emerald',
  red: 'Ruby',
  black: 'Onyx',
  gold: 'Gold joker',
};

export const COLOR_SHORT_LABELS: Record<TokenColor, string> = {
  white: 'W',
  blue: 'B',
  green: 'G',
  red: 'R',
  black: 'K',
  gold: '★',
};

export const emptyGemCounts = (): GemCounts => ({
  white: 0,
  blue: 0,
  green: 0,
  red: 0,
  black: 0,
});

export const emptyTokenCounts = (): TokenCounts => ({
  ...emptyGemCounts(),
  gold: 0,
});

export const isGemColor = (value: string): value is GemColor =>
  (NORMAL_COLORS as readonly string[]).includes(value);

export const isTokenColor = (value: string): value is TokenColor =>
  (TOKEN_COLORS as readonly string[]).includes(value);
