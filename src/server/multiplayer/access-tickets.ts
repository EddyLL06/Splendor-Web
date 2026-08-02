import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AppConfig } from '../config.js';
import { constantTimeEqual, createOpaqueToken, hmac } from '../security/crypto.js';
import type { AuthenticatedSession } from '../auth/session.js';

export type GameAccessRole = 'player' | 'spectator' | 'bot';

export interface GameAccessTicketPayload {
  v: 1;
  uid?: string;
  sid?: string;
  bid?: string;
  mid: string;
  role: GameAccessRole;
  pid?: string;
  exp: number;
  nonce: string;
}

const ACCESS_TICKET_TTL_MS = 8 * 60_000;

const parsePayload = (encoded: string): GameAccessTicketPayload | null => {
  try {
    const value = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<GameAccessTicketPayload>;
    if (
      value.v !== 1 ||
      typeof value.mid !== 'string' ||
      typeof value.exp !== 'number' ||
      !Number.isSafeInteger(value.exp) ||
      typeof value.nonce !== 'string' ||
      (value.role !== 'player' &&
        value.role !== 'spectator' &&
        value.role !== 'bot')
    ) {
      return null;
    }
    if (value.role === 'bot') {
      if (
        typeof value.bid !== 'string' ||
        typeof value.pid !== 'string' ||
        value.uid !== undefined ||
        value.sid !== undefined
      ) {
        return null;
      }
      return value as GameAccessTicketPayload;
    }
    if (
      typeof value.uid !== 'string' ||
      typeof value.sid !== 'string' ||
      (value.role === 'player' && typeof value.pid !== 'string') ||
      (value.role === 'spectator' && value.pid !== undefined)
    ) {
      return null;
    }
    return value as GameAccessTicketPayload;
  } catch {
    return null;
  }
};

export class GameAccessTicketService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  issue(
    session: AuthenticatedSession,
    input: { matchID: string; role: GameAccessRole; playerID?: string },
  ): { accessTicket: string; expiresAt: number } {
    const expiresAt = Math.min(
      session.expiresAt.getTime(),
      this.now().getTime() + ACCESS_TICKET_TTL_MS,
    );
    const payload: GameAccessTicketPayload = {
      v: 1,
      uid: session.user.id,
      sid: session.id,
      mid: input.matchID,
      role: input.role,
      ...(input.role === 'player' ? { pid: input.playerID } : {}),
      exp: expiresAt,
      nonce: createOpaqueToken(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = hmac(this.config.gameCredentialSecret, `access:${encoded}`);
    return { accessTicket: `${encoded}.${signature}`, expiresAt };
  }

  /**
   * Loopback-only ticket for a Bot seat. No User/Session is involved; the
   * socket middleware must additionally verify the seat is a Bot seat.
   */
  issueBotTicket(input: {
    botId: string;
    matchID: string;
    playerID: string;
    ttlMs?: number;
  }): { accessTicket: string; expiresAt: number } {
    const expiresAt =
      this.now().getTime() + (input.ttlMs ?? ACCESS_TICKET_TTL_MS);
    const payload: GameAccessTicketPayload = {
      v: 1,
      role: 'bot',
      bid: input.botId,
      mid: input.matchID,
      pid: input.playerID,
      exp: expiresAt,
      nonce: createOpaqueToken(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = hmac(this.config.gameCredentialSecret, `access:${encoded}`);
    return { accessTicket: `${encoded}.${signature}`, expiresAt };
  }

  async verify(ticket: unknown): Promise<GameAccessTicketPayload | null> {
    if (typeof ticket !== 'string' || ticket.length > 4096) return null;
    const parts = ticket.split('.');
    if (parts.length !== 2) return null;
    const expected = hmac(this.config.gameCredentialSecret, `access:${parts[0]}`);
    if (!constantTimeEqual(parts[1], expected)) return null;
    const payload = parsePayload(parts[0]);
    if (!payload || payload.exp <= this.now().getTime()) return null;
    if (payload.role === 'bot') return payload;
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: {
        userId: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: { status: true, emailVerifiedAt: true } },
      },
    });
    if (
      !session ||
      session.userId !== payload.uid ||
      session.revokedAt ||
      session.expiresAt.getTime() <= this.now().getTime() ||
      session.user.status !== 'active' ||
      !session.user.emailVerifiedAt
    ) {
      return null;
    }
    return payload;
  }
}
