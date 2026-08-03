import { describe, expect, it } from 'vitest';

import {
  botSeatName,
  isBotDifficulty,
  isBotSeatMetadata,
  toPublicBotSeat,
  type BotSeatMetadata,
} from '../../src/server/ai/bot-seat.js';

describe('bot seat contract draft', () => {
  const metadata: BotSeatMetadata = {
    kind: 'bot',
    botId: 'bot-1',
    matchId: 'match-1',
    playerId: '1',
    difficulty: 'normal',
    modelVersion: 'ai-kernel-v0.1.0',
  };

  it('generates a deterministic server-side seat name', () => {
    expect(botSeatName('0')).toBe('Bot 1');
    expect(botSeatName('3')).toBe('Bot 4');
  });

  it('serializes only public fields', () => {
    const serialized = toPublicBotSeat(metadata);
    expect(serialized).toEqual({
      kind: 'bot',
      botId: 'bot-1',
      name: 'Bot 2',
      difficulty: 'normal',
    });
    expect(JSON.stringify(serialized)).not.toContain('modelVersion');
    expect(JSON.stringify(serialized)).not.toContain('credential');
    expect(JSON.stringify(serialized)).not.toContain('matchId');
  });

  it('recognizes only the fixed difficulty enum', () => {
    expect(isBotDifficulty('easy')).toBe(true);
    expect(isBotDifficulty('expert')).toBe(true);
    expect(isBotDifficulty('insane')).toBe(false);
    expect(isBotDifficulty(undefined)).toBe(false);
  });

  it('validates bot seat metadata shapes', () => {
    expect(isBotSeatMetadata(metadata)).toBe(true);
    expect(isBotSeatMetadata({ ...metadata, kind: 'human' })).toBe(false);
    expect(isBotSeatMetadata({ ...metadata, modelVersion: 42 })).toBe(false);
    expect(isBotSeatMetadata({ ...metadata, difficulty: 'hard' })).toBe(true);
    expect(isBotSeatMetadata(null)).toBe(false);
  });
});
