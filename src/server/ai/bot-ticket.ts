/**
 * Round 0 spike: minimal loopback-only Bot access ticket and seat credential.
 *
 * These tokens are signed with the same `gameCredentialSecret` used by the
 * human ticket path but carry `role: 'bot'` and are bound to a Bot seat
 * (botId/matchId/playerId) instead of a User session. They are NOT yet wired
 * into `AuthenticatedSocketIO`: production middleware must additionally
 * enforce loopback-only connections and `SeatIdentity.kind === 'bot'` before
 * accepting them (round 2). Verification here never touches the database, so
 * a Bot seat does not need a User/Session row.
 */

import { constantTimeEqual, createOpaqueToken, hmac } from '../security/crypto.js';
import type { AppConfig } from '../config.js';

export const BOT_TICKET_TTL_MS = 5 * 60_000;

export interface BotTicketPayload {
  v: 1;
  role: 'bot';
  bid: string;
  mid: string;
  pid: string;
  exp: number;
  nonce: string;
}

export interface BotTicket {
  ticket: string;
  expiresAt: number;
}

interface BotCredentialPayload {
  v: 1;
  role: 'bot';
  bid: string;
  mid: string;
  pid: string;
  exp: number;
  nonce: string;
}

const parseTicketPayload = (encoded: string): BotTicketPayload | null => {
  try {
    const value = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<BotTicketPayload>;
    if (
      value.v !== 1 ||
      value.role !== 'bot' ||
      typeof value.bid !== 'string' ||
      typeof value.mid !== 'string' ||
      typeof value.pid !== 'string' ||
      typeof value.exp !== 'number' ||
      !Number.isSafeInteger(value.exp) ||
      typeof value.nonce !== 'string'
    ) {
      return null;
    }
    return value as BotTicketPayload;
  } catch {
    return null;
  }
};

const parseCredentialPayload = (encoded: string): BotCredentialPayload | null =>
  parseTicketPayload(encoded);

export class BotTicketService {
  constructor(
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  issueBotTicket(input: {
    botId: string;
    matchId: string;
    playerId: string;
    ttlMs?: number;
  }): BotTicket {
    const expiresAt = this.now().getTime() + (input.ttlMs ?? BOT_TICKET_TTL_MS);
    const payload: BotTicketPayload = {
      v: 1,
      role: 'bot',
      bid: input.botId,
      mid: input.matchId,
      pid: input.playerId,
      exp: expiresAt,
      nonce: createOpaqueToken(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = hmac(this.config.gameCredentialSecret, `bot-access:${encoded}`);
    return { ticket: `${encoded}.${signature}`, expiresAt };
  }

  verify(ticket: unknown): BotTicketPayload | null {
    if (typeof ticket !== 'string' || ticket.length > 4096) return null;
    const parts = ticket.split('.');
    if (parts.length !== 2) return null;
    const expected = hmac(this.config.gameCredentialSecret, `bot-access:${parts[0]}`);
    if (!constantTimeEqual(parts[1], expected)) return null;
    const payload = parseTicketPayload(parts[0]);
    if (!payload || payload.exp <= this.now().getTime()) return null;
    return payload;
  }

  issueBotCredential(input: {
    botId: string;
    matchId: string;
    playerId: string;
    ttlMs?: number;
  }): string {
    const expiresAt = this.now().getTime() + (input.ttlMs ?? BOT_TICKET_TTL_MS);
    const payload: BotCredentialPayload = {
      v: 1,
      role: 'bot',
      bid: input.botId,
      mid: input.matchId,
      pid: input.playerId,
      exp: expiresAt,
      nonce: createOpaqueToken(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = hmac(this.config.gameCredentialSecret, `bot-seat:${encoded}`);
    return `${encoded}.${signature}`;
  }

  authenticateBotCredential(
    credential: string | undefined,
    metadata: {
      kind: 'bot';
      botId: string;
      matchId: string;
      playerId: string;
    } | undefined,
  ): boolean {
    if (!credential || !metadata || metadata.kind !== 'bot') return false;
    const parts = credential.split('.');
    if (parts.length !== 2) return false;
    const expected = hmac(this.config.gameCredentialSecret, `bot-seat:${parts[0]}`);
    if (!constantTimeEqual(parts[1], expected)) return false;
    const payload = parseCredentialPayload(parts[0]);
    if (!payload || payload.exp <= this.now().getTime()) return false;
    return (
      payload.role === 'bot' &&
      payload.bid === metadata.botId &&
      payload.mid === metadata.matchId &&
      payload.pid === metadata.playerId
    );
  }
}
