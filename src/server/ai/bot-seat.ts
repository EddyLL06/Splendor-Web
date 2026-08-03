/**
 * Round 0 contract draft: tagged Bot/human seat identity and public
 * serialization.
 *
 * This module defines the shape that later rounds will wire into
 * `SeatMetadata`, `LobbyService`, `RoomRegistry` and the public `RoomMatch`
 * serializer. Nothing here is consumed by the lobby yet: changing the seat
 * model is a round-2 integration task (see ai_bot/DEVELOPMENT_GUIDE.md §4.1).
 */

import type { PlayerID } from '../../shared/types/game.js';
import {
  BOT_DIFFICULTIES,
  isBotDifficulty,
  type BotDifficulty,
} from '../../shared/ai/types.js';

export { BOT_DIFFICULTIES, isBotDifficulty, type BotDifficulty };

export interface HumanSeatIdentity {
  kind: 'human';
  userId: string;
  sessionId: string;
  avatarStorageKey?: string;
}

export interface BotSeatIdentity {
  kind: 'bot';
  botId: string;
  difficulty: BotDifficulty;
  modelVersion: string;
}

/**
 * Tagged union replacing the current implicit "every occupied seat is a
 * logged-in human" assumption. Bot seats must never be identified by a
 * `userId.startsWith('bot:')` convention.
 */
export type SeatIdentity = HumanSeatIdentity | BotSeatIdentity;

/**
 * Draft persisted seat metadata for a Bot seat (the round-2 shape of
 * `player.data`). A Bot has no User or Session row.
 */
export interface BotSeatMetadata {
  kind: 'bot';
  botId: string;
  matchId: string;
  playerId: PlayerID;
  difficulty: BotDifficulty;
  modelVersion: string;
}

/** Fields safe to expose on the public `RoomMatch` payload. */
export interface PublicBotSeat {
  kind: 'bot';
  botId: string;
  name: string;
  difficulty: BotDifficulty;
}

/**
 * Server-generated display name for a Bot seat. Any client-supplied name is
 * ignored by the future Bot seat API.
 */
export const botSeatName = (playerID: PlayerID): string =>
  `Bot ${Number(playerID) + 1}`;

/**
 * Public serialization draft. Deliberately excludes model version (diagnostic
 * only), credentials, tickets and any server-side secrets.
 */
export const toPublicBotSeat = (
  metadata: BotSeatMetadata,
): PublicBotSeat => ({
  kind: 'bot',
  botId: metadata.botId,
  name: botSeatName(metadata.playerId),
  difficulty: metadata.difficulty,
});

/** Narrowing guard for the future tagged seat metadata union. */
export const isBotSeatMetadata = (value: unknown): value is BotSeatMetadata => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BotSeatMetadata>;
  return (
    candidate.kind === 'bot' &&
    typeof candidate.botId === 'string' &&
    typeof candidate.matchId === 'string' &&
    typeof candidate.playerId === 'string' &&
    isBotDifficulty(candidate.difficulty) &&
    typeof candidate.modelVersion === 'string'
  );
};
