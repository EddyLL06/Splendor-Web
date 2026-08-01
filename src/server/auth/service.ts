import argon2 from 'argon2';

import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import type { AppConfig } from '../config.js';
import type { EmailService, Locale, VerificationPurpose } from '../email/index.js';
import { ApiError } from '../errors.js';
import {
  constantTimeEqual,
  createID,
  createVerificationCode,
  hashVerificationCode,
} from '../security/crypto.js';
import { RateLimiter } from '../security/rate-limiter.js';
import {
  normalizeEmail,
  normalizeUsername,
  validatePassword,
} from '../validation/auth.js';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
} as const;

let dummyHashPromise: Promise<string> | undefined;
const getDummyHash = (): Promise<string> => {
  dummyHashPromise ??= argon2.hash('dummy-password-not-used', ARGON2_OPTIONS);
  return dummyHashPromise;
};

export interface AuthServiceDependencies {
  prisma: PrismaClient;
  config: AppConfig;
  email: EmailService;
  rateLimiter?: RateLimiter;
  now?: () => Date;
}

export class AuthService {
  private readonly rateLimiter: RateLimiter;
  private readonly now: () => Date;
  private readonly dummyHash: Promise<string>;

  constructor(private readonly dependencies: AuthServiceDependencies) {
    this.rateLimiter = dependencies.rateLimiter ?? new RateLimiter();
    this.now = dependencies.now ?? (() => new Date());
    this.dummyHash = getDummyHash();
  }

  private consumeRateLimits(kind: string, normalizedEmail: string, ip: string): void {
    const now = this.now().getTime();
    this.rateLimiter.consume(`${kind}:ip:${ip}`, { limit: 60, windowMs: 15 * 60_000 }, now);
    this.rateLimiter.consume(`${kind}:email:${normalizedEmail}`, { limit: 6, windowMs: 15 * 60_000 }, now);
  }

  async requestVerificationCode(input: {
    email: string;
    purpose: VerificationPurpose;
    locale: Locale;
    ip: string;
  }): Promise<void> {
    const { email, normalizedEmail } = normalizeEmail(input.email);
    this.consumeRateLimits(`code:${input.purpose}`, normalizedEmail, input.ip);
    const now = this.now();
    const user = await this.dependencies.prisma.user.findUnique({
      where: { normalizedEmail },
      select: { email: true },
    });
    if (
      (input.purpose === 'registration' && user) ||
      (input.purpose === 'password-reset' && !user)
    ) {
      return;
    }
    const latest = await this.dependencies.prisma.emailVerificationChallenge.findFirst({
      where: { normalizedEmail, purpose: input.purpose, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (latest && latest.resendAvailableAt.getTime() > now.getTime()) return;

    const challengeID = createID();
    const code = createVerificationCode();
    const codeHash = hashVerificationCode(
      this.dependencies.config.verificationCodePepper,
      {
        challengeID,
        normalizedEmail,
        purpose: input.purpose,
        code,
      },
    );
    await this.dependencies.prisma.emailVerificationChallenge.create({
      data: {
        id: challengeID,
        normalizedEmail,
        purpose: input.purpose,
        codeHash,
        expiresAt: new Date(
          now.getTime() +
            this.dependencies.config.verificationCodeTtlMinutes * 60_000,
        ),
        resendAvailableAt: new Date(
          now.getTime() +
            this.dependencies.config.verificationCodeResendSeconds * 1000,
        ),
        createdAt: now,
      },
    });
    try {
      await this.dependencies.email.sendVerificationCode({
        to: user?.email ?? email,
        purpose: input.purpose,
        code,
        expiresInMinutes:
          this.dependencies.config.verificationCodeTtlMinutes,
        idempotencyKey: challengeID,
        locale: input.locale,
      });
    } catch {
      await this.dependencies.prisma.emailVerificationChallenge.deleteMany({
        where: { id: challengeID },
      });
      return;
    }
    await this.dependencies.prisma.emailVerificationChallenge.updateMany({
      where: {
        normalizedEmail,
        purpose: input.purpose,
        consumedAt: null,
        id: { not: challengeID },
      },
      data: { consumedAt: now },
    });
  }

  private async verifyChallenge(input: {
    normalizedEmail: string;
    purpose: VerificationPurpose;
    code: string;
  }) {
    const now = this.now();
    const challenge =
      await this.dependencies.prisma.emailVerificationChallenge.findFirst({
        where: {
          normalizedEmail: input.normalizedEmail,
          purpose: input.purpose,
          consumedAt: null,
        },
        orderBy: { createdAt: 'desc' },
      });
    if (
      !challenge ||
      challenge.expiresAt.getTime() <= now.getTime() ||
      challenge.failedAttempts >=
        this.dependencies.config.verificationCodeMaxAttempts
    ) {
      throw new ApiError(400, 'CODE_INVALID');
    }
    const candidate = hashVerificationCode(
      this.dependencies.config.verificationCodePepper,
      {
        challengeID: challenge.id,
        normalizedEmail: input.normalizedEmail,
        purpose: input.purpose,
        code: input.code,
      },
    );
    if (!constantTimeEqual(challenge.codeHash, candidate)) {
      const reachesLimit =
        challenge.failedAttempts + 1 >=
        this.dependencies.config.verificationCodeMaxAttempts;
      await this.dependencies.prisma.emailVerificationChallenge.updateMany({
        where: { id: challenge.id, consumedAt: null },
        data: {
          failedAttempts: { increment: 1 },
          consumedAt: reachesLimit ? now : undefined,
        },
      });
      throw new ApiError(400, 'CODE_INVALID');
    }
    return challenge;
  }

  async register(input: {
    email: string;
    code: string;
    username: string;
    password: string;
    ip: string;
  }): Promise<string> {
    const { email, normalizedEmail } = normalizeEmail(input.email);
    const { username, normalizedUsername } = normalizeUsername(input.username);
    const password = validatePassword(input.password);
    this.consumeRateLimits('verify:registration', normalizedEmail, input.ip);
    const challenge = await this.verifyChallenge({
      normalizedEmail,
      purpose: 'registration',
      code: input.code,
    });
    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
    const now = this.now();
    try {
      const user = await this.dependencies.prisma.$transaction(
        async (transaction: Prisma.TransactionClient) => {
          const consumed = await transaction.emailVerificationChallenge.updateMany({
            where: {
              id: challenge.id,
              consumedAt: null,
              expiresAt: { gt: now },
              failedAttempts: {
                lt: this.dependencies.config.verificationCodeMaxAttempts,
              },
            },
            data: { consumedAt: now },
          });
          if (consumed.count !== 1) throw new ApiError(400, 'CODE_INVALID');
          return transaction.user.create({
            data: {
              id: createID(),
              email,
              normalizedEmail,
              username,
              normalizedUsername,
              passwordHash,
              emailVerifiedAt: now,
              status: 'active',
              createdAt: now,
              updatedAt: now,
            },
          });
        },
      );
      return user.id;
    } catch (caught) {
      const known = caught as { code?: string; meta?: { target?: unknown } };
      if (known.code === 'P2002') {
        const target = Array.isArray(known.meta?.target)
          ? known.meta.target.join(',')
          : String(known.meta?.target ?? '');
        const usernameExists = target.includes('normalizedUsername') || Boolean(
          await this.dependencies.prisma.user.findUnique({
            where: { normalizedUsername },
            select: { id: true },
          }),
        );
        if (usernameExists) {
          throw new ApiError(409, 'USERNAME_UNAVAILABLE');
        }
        throw new ApiError(400, 'CODE_INVALID');
      }
      throw caught;
    }
  }

  async login(input: { email: string; password: string; ip: string }): Promise<string> {
    const { normalizedEmail } = normalizeEmail(input.email);
    const password = validatePassword(input.password);
    this.consumeRateLimits('login', normalizedEmail, input.ip);
    const user = await this.dependencies.prisma.user.findUnique({
      where: { normalizedEmail },
    });
    const hash = user?.passwordHash ?? (await this.dummyHash);
    let valid = false;
    try {
      valid = await argon2.verify(hash, password);
    } catch {
      valid = false;
    }
    if (!user || !valid || user.status !== 'active' || !user.emailVerifiedAt) {
      throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS');
    }
    return user.id;
  }

  async resetPassword(input: {
    email: string;
    code: string;
    password: string;
    ip: string;
  }): Promise<string> {
    const { normalizedEmail } = normalizeEmail(input.email);
    const password = validatePassword(input.password);
    this.consumeRateLimits('verify:password-reset', normalizedEmail, input.ip);
    const challenge = await this.verifyChallenge({
      normalizedEmail,
      purpose: 'password-reset',
      code: input.code,
    });
    const user = await this.dependencies.prisma.user.findUnique({
      where: { normalizedEmail },
    });
    if (!user || user.status !== 'active') {
      throw new ApiError(400, 'CODE_INVALID');
    }
    const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
    const now = this.now();
    await this.dependencies.prisma.$transaction(
      async (transaction: Prisma.TransactionClient) => {
      const consumed = await transaction.emailVerificationChallenge.updateMany({
        where: {
          id: challenge.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new ApiError(400, 'CODE_INVALID');
      await transaction.user.update({
        where: { id: user.id },
        data: { passwordHash, updatedAt: now },
      });
      await transaction.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      },
    );
    return user.id;
  }

  async updateUsername(userId: string, rawUsername: string): Promise<void> {
    const { username, normalizedUsername } = normalizeUsername(rawUsername);
    try {
      await this.dependencies.prisma.user.update({
        where: { id: userId },
        data: { username, normalizedUsername, updatedAt: this.now() },
      });
    } catch (caught) {
      const known = caught as { code?: string };
      if (known.code === 'P2002') {
        throw new ApiError(409, 'USERNAME_UNAVAILABLE');
      }
      throw caught;
    }
  }
}

export const isArgon2idHash = (hash: string): boolean =>
  hash.startsWith('$argon2id$');
