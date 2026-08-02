import { z } from 'zod';

import { invalidInput } from '../errors.js';
import type { Locale, VerificationPurpose } from '../email/types.js';

const emailValidator = z.string().max(254).email();
const localeValidator = z.enum(['en', 'zh-CN']);
const purposeValidator = z.enum(['registration', 'password-reset']);

export const codeRequestSchema = z
  .object({
    email: z.string(),
    locale: localeValidator.default('en'),
  })
  .strict();

export const registrationSchema = z
  .object({
    email: z.string(),
    code: z.string().regex(/^\d{6}$/),
    username: z.string(),
    password: z.string(),
  })
  .strict();

export const loginSchema = z
  .object({ email: z.string(), password: z.string() })
  .strict();

export const passwordResetSchema = z
  .object({
    email: z.string(),
    code: z.string().regex(/^\d{6}$/),
    password: z.string(),
  })
  .strict();

export const usernameUpdateSchema = z
  .object({ username: z.string() })
  .strict();

export const createMatchSchema = z
  .object({
    numPlayers: z.number().int().min(2).max(4),
    unlisted: z.boolean().default(false),
  })
  .strict();

export const joinMatchSchema = z
  .object({
    playerID: z.string().regex(/^[0-3]$/).optional(),
    playerName: z.string().optional(),
    data: z.unknown().optional(),
  })
  .strict();

export const credentialSchema = z
  .object({
    playerID: z.string().regex(/^[0-3]$/),
    credentials: z.string().min(1).max(4096),
  })
  .passthrough();

export const roomSettingsSchema = z
  .object({
    allowSpectators: z.boolean(),
    confirmRemoval: z.boolean().optional(),
  })
  .strict();

export const spectatorJoinSchema = z
  .object({
    previousMatchID: z.string().min(1).max(128).optional(),
  })
  .strict();

export const switchToPlayerSchema = z
  .object({
    playerID: z.string().regex(/^[0-3]$/).optional(),
  })
  .strict();

export const gameAccessSchema = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('player'),
      playerID: z.string().regex(/^[0-3]$/),
      credentials: z.string().min(1).max(4096),
    })
    .strict(),
  z.object({ role: z.literal('spectator') }).strict(),
]);

export const botSeatSchema = z
  .object({
    playerID: z.string().regex(/^[0-3]$/),
    difficulty: z.enum(['easy', 'normal', 'hard', 'expert']),
  })
  .strict();

export const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
};

export interface NormalizedEmail {
  email: string;
  normalizedEmail: string;
}

export const normalizeEmail = (raw: string): NormalizedEmail => {
  const email = raw.trim();
  if (!emailValidator.safeParse(email).success) throw invalidInput();
  return { email, normalizedEmail: email.toLowerCase() };
};

export interface NormalizedUsername {
  username: string;
  normalizedUsername: string;
}

const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'gemcouncil',
  'moderator',
  'null',
  'root',
  'server',
  'support',
  'system',
]);

export const normalizeUsername = (raw: string): NormalizedUsername => {
  const username = raw.normalize('NFKC');
  const length = [...username].length;
  if (
    length < 2 ||
    length > 20 ||
    !/^[\p{L}\p{N}_]+$/u.test(username)
  ) {
    throw invalidInput();
  }
  const normalizedUsername = username.toLowerCase();
  if (RESERVED_USERNAMES.has(normalizedUsername)) throw invalidInput();
  return { username, normalizedUsername };
};

export const validatePassword = (password: string): string => {
  if (!/^[\x21-\x7E]{10,128}$/.test(password)) throw invalidInput();
  return password;
};

export const parseLocale = (raw: unknown): Locale => {
  const result = localeValidator.safeParse(raw);
  if (!result.success) throw invalidInput();
  return result.data;
};

export const parsePurpose = (raw: unknown): VerificationPurpose => {
  const result = purposeValidator.safeParse(raw);
  if (!result.success) throw invalidInput();
  return result.data;
};
