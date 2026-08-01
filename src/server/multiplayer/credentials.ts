import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AppConfig } from '../config.js';
import {
  constantTimeEqual,
  createOpaqueToken,
  hmac,
} from '../security/crypto.js';

interface SeatCredentialPayload {
  v: 1;
  uid: string;
  sid: string;
  mid: string;
  pid: string;
  exp: number;
  nonce: string;
}

export interface SeatMetadata {
  userId: string;
  matchId: string;
  playerId: string;
  avatarUrl: string;
}

const parsePayload = (encoded: string): SeatCredentialPayload | null => {
  try {
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SeatCredentialPayload>;
    if (
      value.v !== 1 ||
      typeof value.uid !== 'string' ||
      typeof value.sid !== 'string' ||
      typeof value.mid !== 'string' ||
      typeof value.pid !== 'string' ||
      typeof value.exp !== 'number' ||
      !Number.isSafeInteger(value.exp) ||
      typeof value.nonce !== 'string'
    ) {
      return null;
    }
    return value as SeatCredentialPayload;
  } catch {
    return null;
  }
};

export class SeatCredentialService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  issue(input: {
    userId: string;
    sessionId: string;
    matchId: string;
    playerId: string;
    sessionExpiresAt: Date;
  }): string {
    const payload: SeatCredentialPayload = {
      v: 1,
      uid: input.userId,
      sid: input.sessionId,
      mid: input.matchId,
      pid: input.playerId,
      exp: input.sessionExpiresAt.getTime(),
      nonce: createOpaqueToken(),
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = hmac(this.config.gameCredentialSecret, `seat:${encoded}`);
    return `${encoded}.${signature}`;
  }

  authenticate = async (
    credential: string | undefined,
    playerMetadata: {
      id: number;
      credentials?: string;
      data?: SeatMetadata;
    } | undefined,
  ): Promise<boolean> => {
    if (!credential || !playerMetadata?.credentials || !playerMetadata.data) return false;
    if (!constantTimeEqual(credential, playerMetadata.credentials)) return false;
    const parts = credential.split('.');
    if (parts.length !== 2) return false;
    const expected = hmac(this.config.gameCredentialSecret, `seat:${parts[0]}`);
    if (!constantTimeEqual(parts[1], expected)) return false;
    const payload = parsePayload(parts[0]);
    if (!payload || payload.exp <= this.now().getTime()) return false;
    const data = playerMetadata.data;
    if (
      payload.uid !== data.userId ||
      payload.mid !== data.matchId ||
      payload.pid !== data.playerId ||
      payload.pid !== String(playerMetadata.id)
    ) {
      return false;
    }
    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: { userId: true, expiresAt: true, revokedAt: true },
    });
    return Boolean(
      session &&
        session.userId === payload.uid &&
        !session.revokedAt &&
        session.expiresAt.getTime() > this.now().getTime() &&
        session.expiresAt.getTime() === payload.exp,
    );
  };
}
