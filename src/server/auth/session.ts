import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { AppConfig } from '../config.js';
import { ApiError } from '../errors.js';
import {
  constantTimeEqual,
  createCsrfSecret,
  createID,
  createOpaqueToken,
  hashSessionToken,
} from '../security/crypto.js';

export const SESSION_COOKIE_NAME = 'gem_council_session';

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  avatarUrl: string;
  hasCustomAvatar: boolean;
}

export interface AuthenticatedSession {
  id: string;
  user: PublicUser;
  csrfToken: string;
  expiresAt: Date;
}

export interface CreatedSession extends AuthenticatedSession {
  rawToken: string;
}

const toPublicUser = (user: {
  id: string;
  email: string;
  username: string;
  avatar: { id: string; updatedAt: Date } | null;
}): PublicUser => ({
  id: user.id,
  email: user.email,
  username: user.username,
  avatarUrl: `/api/users/${encodeURIComponent(user.id)}/avatar?v=${
    user.avatar?.updatedAt.getTime() ?? 'fallback'
  }`,
  hasCustomAvatar: Boolean(user.avatar),
});

export const createSession = async (
  prisma: PrismaClient,
  config: AppConfig,
  userId: string,
  options: { revokeSessionID?: string; now?: Date } = {},
): Promise<CreatedSession> => {
  const now = options.now ?? new Date();
  const rawToken = createOpaqueToken();
  const csrfSecret = createCsrfSecret();
  const expiresAt = new Date(
    now.getTime() + config.sessionDurationDays * 24 * 60 * 60 * 1000,
  );
  const session = await prisma.$transaction(
    async (transaction: Prisma.TransactionClient) => {
    if (options.revokeSessionID) {
      await transaction.session.updateMany({
        where: { id: options.revokeSessionID, revokedAt: null },
        data: { revokedAt: now },
      });
    }
    return transaction.session.create({
      data: {
        id: createID(),
        userId,
        tokenHash: hashSessionToken(config.sessionSecret, rawToken),
        csrfSecret,
        expiresAt,
        lastActivityAt: now,
      },
      include: { user: { include: { avatar: { select: { id: true, updatedAt: true } } } } },
    });
    },
  );
  return {
    id: session.id,
    rawToken,
    csrfToken: session.csrfSecret,
    expiresAt: session.expiresAt,
    user: toPublicUser(session.user),
  };
};

export const resolveSession = async (
  prisma: PrismaClient,
  config: AppConfig,
  rawToken: string | undefined,
  now = new Date(),
): Promise<AuthenticatedSession | null> => {
  if (!rawToken || rawToken.length > 256) return null;
  const tokenHash = hashSessionToken(config.sessionSecret, rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: { include: { avatar: { select: { id: true, updatedAt: true } } } } },
  });
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt.getTime() <= now.getTime() ||
    session.user.status !== 'active' ||
    !session.user.emailVerifiedAt
  ) {
    return null;
  }
  if (now.getTime() - session.lastActivityAt.getTime() >= 15 * 60 * 1000) {
    await prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { lastActivityAt: now },
    });
  }
  return {
    id: session.id,
    csrfToken: session.csrfSecret,
    expiresAt: session.expiresAt,
    user: toPublicUser(session.user),
  };
};

export const requireSession = (
  session: AuthenticatedSession | null,
): AuthenticatedSession => {
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED');
  return session;
};

export const assertCsrf = (
  session: AuthenticatedSession,
  supplied: string | undefined,
): void => {
  if (!supplied || !constantTimeEqual(session.csrfToken, supplied)) {
    throw new ApiError(403, 'CSRF_INVALID');
  }
};

export const revokeSession = async (
  prisma: PrismaClient,
  sessionID: string,
  now = new Date(),
): Promise<void> => {
  await prisma.session.updateMany({
    where: { id: sessionID, revokedAt: null },
    data: { revokedAt: now },
  });
};
