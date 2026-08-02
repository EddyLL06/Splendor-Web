import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BotTicketService } from '../../src/server/ai/bot-ticket.js';
import { createTestConfig } from '../server-test-kit.js';

describe('loopback bot ticket spike', () => {
  let root: string;
  let service: BotTicketService;
  let clock: { now: Date };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gem-council-bot-ticket-'));
    const config = createTestConfig(root);
    clock = { now: new Date('2026-08-03T00:00:00.000Z') };
    service = new BotTicketService(config, () => clock.now);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const input = {
    botId: 'bot-1',
    matchId: 'match-1',
    playerId: '2',
  };

  it('issues and verifies a short-lived bot access ticket', () => {
    const issued = service.issueBotTicket(input);
    const payload = service.verify(issued.ticket);
    expect(payload).toMatchObject({
      role: 'bot',
      bid: input.botId,
      mid: input.matchId,
      pid: input.playerId,
    });
    expect(issued.expiresAt).toBe(
      clock.now.getTime() + 5 * 60_000,
    );
  });

  it('rejects tampered, expired, and foreign-secret tickets', () => {
    const issued = service.issueBotTicket(input);
    const [encoded] = issued.ticket.split('.');
    const tampered = `${encoded.slice(0, -2)}AA.${issued.ticket.split('.')[1]}`;
    expect(service.verify(tampered)).toBeNull();
    expect(service.verify(`${encoded}.not-a-signature`)).toBeNull();
    expect(service.verify(undefined)).toBeNull();
    expect(service.verify({ ticket: issued.ticket })).toBeNull();

    clock.now = new Date(issued.expiresAt + 1);
    expect(service.verify(issued.ticket)).toBeNull();
    clock.now = new Date('2026-08-03T00:00:00.000Z');

    const otherConfig = createTestConfig(root, {
      GAME_CREDENTIAL_SECRET: 'another-secret-material-000000000001',
    });
    const other = new BotTicketService(otherConfig, () => clock.now);
    expect(other.verify(issued.ticket)).toBeNull();
  });

  it('issues a bot seat credential that authenticates only its own seat', () => {
    const credential = service.issueBotCredential(input);
    expect(
      service.authenticateBotCredential(credential, {
        kind: 'bot',
        botId: 'bot-1',
        matchId: 'match-1',
        playerId: '2',
      }),
    ).toBe(true);
    expect(
      service.authenticateBotCredential(credential, {
        kind: 'bot',
        botId: 'bot-1',
        matchId: 'match-1',
        playerId: '3',
      }),
    ).toBe(false);
    expect(
      service.authenticateBotCredential(credential, undefined),
    ).toBe(false);
    expect(
      service.authenticateBotCredential('forged', {
        kind: 'bot',
        botId: 'bot-1',
        matchId: 'match-1',
        playerId: '2',
      }),
    ).toBe(false);
  });
});
