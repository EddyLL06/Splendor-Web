import type { TFunction } from 'i18next';

import type { ActionLogEntry, TokenCounts } from '../shared/types/game.js';

export type CardActionMode = 'buy' | 'reserve' | null;

export type CardActionModeEvent =
  | { type: 'toggle'; mode: Exclude<CardActionMode, null> }
  | { type: 'cancel' }
  | { type: 'reset' };

export const reduceCardActionMode = (
  current: CardActionMode,
  event: CardActionModeEvent,
  enabled = true,
): CardActionMode => {
  if (!enabled || event.type === 'cancel' || event.type === 'reset') return null;
  return current === event.mode ? null : event.mode;
};

export const shouldNotifyLocalTurn = (
  previous: { currentPlayer: string | null; localPlayer: string | null },
  currentPlayer: string,
  localPlayer: string | null,
  gameOver: boolean,
): boolean =>
  !gameOver &&
  localPlayer !== null &&
  currentPlayer === localPlayer &&
  (previous.currentPlayer !== currentPlayer || previous.localPlayer !== localPlayer);

export const canShowReservedCardDetails = (cardId: string | null): boolean =>
  cardId !== null;

export interface ActionAnimationCursor {
  processedThrough: number;
  entry: ActionLogEntry | null;
}

export const detectActionAnimation = (
  entries: ActionLogEntry[],
  processedThrough: number,
): ActionAnimationCursor => {
  const latestID = entries.at(-1)?.id ?? processedThrough;
  if (latestID <= processedThrough) {
    return { processedThrough, entry: null };
  }
  const entry = [...entries]
    .reverse()
    .find((candidate) => candidate.id > processedThrough && candidate.animation);
  return { processedThrough: latestID, entry: entry ?? null };
};

export interface DiscardUiState {
  hidden: boolean;
  returned: TokenCounts | null;
}

export type DiscardUiEvent =
  | { type: 'start'; returned: TokenCounts }
  | { type: 'change'; returned: TokenCounts }
  | { type: 'hide' }
  | { type: 'show' }
  | { type: 'reset' };

export const reduceDiscardUi = (
  state: DiscardUiState,
  event: DiscardUiEvent,
): DiscardUiState => {
  if (event.type === 'reset') return { hidden: false, returned: null };
  if (event.type === 'start') return { hidden: false, returned: event.returned };
  if (event.type === 'change') return { ...state, returned: event.returned };
  return { ...state, hidden: event.type === 'hide' };
};

export const TURN_SOUND_STORAGE_KEY = 'gem-council:turn-sound';
export const TURN_SOUND_CHANGE_EVENT = 'gem-council:turn-sound-change';

export const readTurnSoundPreference = (
  storage?: Pick<Storage, 'getItem'> | null,
): boolean => {
  try {
    const target = storage === undefined
      ? (typeof window === 'undefined' ? null : window.localStorage)
      : storage;
    return target?.getItem(TURN_SOUND_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
};

export const writeTurnSoundPreference = (
  enabled: boolean,
  storage?: Pick<Storage, 'setItem'> | null,
): void => {
  try {
    const target = storage === undefined
      ? (typeof window === 'undefined' ? null : window.localStorage)
      : storage;
    target?.setItem(TURN_SOUND_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<boolean>(TURN_SOUND_CHANGE_EVENT, { detail: enabled }),
    );
  }
};

const fallbackPlayerName = (
  playerID: string,
  names: Record<string, string>,
  t: TFunction,
): string =>
  names[playerID] || t('common.player', { number: Number(playerID) + 1 });

const legacyPlayerID = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value - 1);
  if (typeof value === 'string' && /^\d+$/.test(value)) return String(Number(value) - 1);
  return null;
};

export const formatActionLog = (
  entry: ActionLogEntry,
  t: TFunction,
  names: Record<string, string>,
): string => {
  if (!entry.i18n) return entry.message;
  const values = { ...entry.i18n.values } as Record<string, unknown>;

  if (typeof values.playerID === 'string') {
    values.player = fallbackPlayerName(values.playerID, names, t);
  } else {
    const playerID = legacyPlayerID(values.player);
    if (playerID !== null) values.player = fallbackPlayerName(playerID, names, t);
  }

  if (Array.isArray(values.playerIDs)) {
    values.players = values.playerIDs
      .map((playerID) => fallbackPlayerName(String(playerID), names, t))
      .join(t('logs.playerJoiner'));
  } else if (typeof values.players === 'string') {
    const legacyIDs = values.players.match(/\d+/g)?.map((value) => String(Number(value) - 1));
    if (legacyIDs?.length) {
      values.players = legacyIDs
        .map((playerID) => fallbackPlayerName(playerID, names, t))
        .join(t('logs.playerJoiner'));
    }
  }

  if (Array.isArray(values.colors)) {
    values.colors = values.colors
      .map((color) => t(`colors.${String(color)}`))
      .join(', ');
  }
  if (typeof values.color === 'string') values.color = t(`colors.${values.color}`);
  if (values.tokens && typeof values.tokens === 'object') {
    values.tokens = Object.entries(values.tokens as Record<string, number>)
      .filter(([, count]) => count > 0)
      .map(([color, count]) => `${count} ${t(`colors.${color}`)}`)
      .join(', ');
  }
  return t(`logs.${entry.i18n.key}`, values);
};

export const playTurnSound = (): void => {
  if (typeof window === 'undefined') return;
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return;

  try {
    const context = new AudioContextClass();
    const play = () => {
      const now = context.currentTime;
      const gain = context.createGain();
      const first = context.createOscillator();
      const second = context.createOscillator();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.055, now + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
      first.type = 'sine';
      second.type = 'sine';
      first.frequency.setValueAtTime(659.25, now);
      second.frequency.setValueAtTime(783.99, now + 0.1);
      first.connect(gain);
      second.connect(gain);
      gain.connect(context.destination);
      first.start(now);
      first.stop(now + 0.26);
      second.start(now + 0.1);
      second.stop(now + 0.42);
      window.setTimeout(() => void context.close().catch(() => undefined), 500);
    };
    if (context.state === 'suspended') {
      void context.resume().then(play).catch(() => void context.close().catch(() => undefined));
    } else {
      play();
    }
  } catch {
    // Audio is an optional enhancement; autoplay and device failures are harmless.
  }
};
