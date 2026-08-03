import { existsSync } from 'node:fs';
import { availableParallelism, homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import type { Locale } from './email/types.js';

export type EmailProviderName = 'resend' | 'fake';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  projectRoot: string;
  appBaseUrl: string;
  allowedOrigins: string[];
  port: number;
  appDataDir: string;
  databaseUrl: string;
  databasePath: string;
  avatarStorageDir: string;
  uploadTempDir: string;
  emailProvider: EmailProviderName;
  resendApiKey: string;
  emailFrom: string;
  emailReplyTo?: string;
  sessionSecret: string;
  verificationCodePepper: string;
  gameCredentialSecret: string;
  sessionDurationDays: number;
  verificationCodeTtlMinutes: number;
  verificationCodeResendSeconds: number;
  verificationCodeMaxAttempts: number;
  defaultLocale: Locale;
  aiBotEnabled: boolean;
  aiBotWorkers: number;
  aiBotQueueLimit: number;
  aiBotHardMaxMs: number;
  aiBotExpertEnabled: boolean;
  aiBotNeuralModel: string;
  aiBotExpertSims: number;
  aiBotExpertDeterminizations: number;
  aiBotExpertMaxMs: number;
}

const parseInteger = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const raw = env[key];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
};

const parseAiBotWorkers = (env: NodeJS.ProcessEnv): number => {
  const raw = env.AI_BOT_WORKERS?.trim() ?? 'auto';
  if (raw === 'auto') {
    const logical = availableParallelism();
    return Math.max(1, Math.min(4, logical <= 2 ? 1 : 2));
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 4) {
    throw new Error('AI_BOT_WORKERS must be auto or an integer from 0 to 4.');
  }
  return value;
};

const parseBoolean = (
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean,
): boolean => {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${key} must be true or false.`);
};

const resolvePath = (
  projectRoot: string,
  raw: string | undefined,
  fallback: string,
): string => {
  const value = raw?.trim() || fallback;
  return resolve(isAbsolute(value) ? value : resolve(projectRoot, value));
};

const assertSafeStoragePath = (
  path: string,
  projectRoot: string,
  label: string,
): void => {
  const blockedRoots = new Set([resolve('/'), resolve(projectRoot), resolve(homedir())]);
  if (blockedRoots.has(path)) {
    throw new Error(`${label} points to a dangerously broad directory.`);
  }
  for (const blockedName of ['public', 'dist', 'dist-server']) {
    const blocked = resolve(projectRoot, blockedName);
    const pathFromBlocked = relative(blocked, path);
    if (path === blocked || (!pathFromBlocked.startsWith('..') && !isAbsolute(pathFromBlocked))) {
      throw new Error(`${label} must not be inside ${blockedName}/.`);
    }
  }
};

const normalizeDatabaseUrl = (
  projectRoot: string,
  raw: string | undefined,
  appDataDir: string,
): { databaseUrl: string; databasePath: string } => {
  const value = raw?.trim() || `file:${resolve(appDataDir, 'database/app.sqlite')}`;
  if (!value.startsWith('file:')) {
    throw new Error('DATABASE_URL must use the file: SQLite URL scheme.');
  }
  const withoutScheme = value.slice('file:'.length);
  if (withoutScheme.length === 0 || withoutScheme.includes('?') || withoutScheme.includes('#')) {
    throw new Error('DATABASE_URL must contain one SQLite file path without query or fragment data.');
  }
  const decoded = decodeURIComponent(withoutScheme);
  const databasePath = resolve(
    isAbsolute(decoded) ? decoded : resolve(projectRoot, decoded),
  );
  assertSafeStoragePath(dirname(databasePath), projectRoot, 'DATABASE_URL');
  return { databaseUrl: `file:${databasePath}`, databasePath };
};

const parseOrigin = (raw: string, label: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'null') {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`${label} must contain only an origin without a path or credentials.`);
  }
  return url.origin;
};

const requireSecret = (
  env: NodeJS.ProcessEnv,
  key: string,
  nodeEnv: AppConfig['nodeEnv'],
): string => {
  const value = env[key] ?? '';
  if (nodeEnv !== 'test' && value.length < 43) {
    throw new Error(
      `${key} must contain at least 256 bits of random secret material. Run npm run config:local for local development.`,
    );
  }
  if (nodeEnv === 'test' && value.length < 16) {
    throw new Error(`${key} is missing from the isolated test configuration.`);
  }
  return value;
};

export const loadLocalEnvironment = (projectRoot = process.cwd()): void => {
  const envPath = resolve(projectRoot, '.env');
  if (existsSync(envPath)) loadEnvFile(envPath);
};

export const createConfig = (
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
): AppConfig => {
  const rawNodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(rawNodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }
  const nodeEnv = rawNodeEnv as AppConfig['nodeEnv'];
  const appBaseUrl = parseOrigin(
    env.APP_BASE_URL ?? 'http://localhost:5173',
    'APP_BASE_URL',
  );
  const appDataDir = resolvePath(projectRoot, env.APP_DATA_DIR, '.local-data');
  assertSafeStoragePath(appDataDir, projectRoot, 'APP_DATA_DIR');
  const { databaseUrl, databasePath } = normalizeDatabaseUrl(
    projectRoot,
    env.DATABASE_URL,
    appDataDir,
  );
  const avatarStorageDir = resolvePath(
    projectRoot,
    env.AVATAR_STORAGE_DIR,
    resolve(appDataDir, 'avatars'),
  );
  const uploadTempDir = resolvePath(
    projectRoot,
    env.UPLOAD_TEMP_DIR,
    resolve(appDataDir, 'tmp'),
  );
  assertSafeStoragePath(avatarStorageDir, projectRoot, 'AVATAR_STORAGE_DIR');
  assertSafeStoragePath(uploadTempDir, projectRoot, 'UPLOAD_TEMP_DIR');

  const rawOrigins = env.GAME_ALLOWED_ORIGINS ?? appBaseUrl;
  const allowedOrigins = [...new Set(
    rawOrigins
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
      .map((origin, index) => parseOrigin(origin, `GAME_ALLOWED_ORIGINS[${index}]`)),
  )];
  if (allowedOrigins.length === 0) {
    throw new Error('GAME_ALLOWED_ORIGINS must contain at least one exact origin.');
  }

  const rawProvider = env.EMAIL_PROVIDER ?? (nodeEnv === 'test' ? 'fake' : 'resend');
  if (!['resend', 'fake'].includes(rawProvider)) {
    throw new Error('EMAIL_PROVIDER must be resend or fake.');
  }
  if (rawProvider === 'fake' && nodeEnv !== 'test') {
    throw new Error('The fake email provider is allowed only when NODE_ENV=test.');
  }
  const resendApiKey = env.RESEND_API_KEY ?? '';
  if (rawProvider === 'resend' && resendApiKey.length === 0) {
    throw new Error('RESEND_API_KEY is required when EMAIL_PROVIDER=resend.');
  }

  return {
    nodeEnv,
    projectRoot: resolve(projectRoot),
    appBaseUrl,
    allowedOrigins,
    port: parseInteger(env, 'GAME_SERVER_PORT', 8000, 1, 65_535),
    appDataDir,
    databaseUrl,
    databasePath,
    avatarStorageDir,
    uploadTempDir,
    emailProvider: rawProvider as EmailProviderName,
    resendApiKey,
    emailFrom: env.EMAIL_FROM?.trim() || 'Gem Council <no-reply@auth.example.com>',
    emailReplyTo: env.EMAIL_REPLY_TO?.trim() || undefined,
    sessionSecret: requireSecret(env, 'SESSION_SECRET', nodeEnv),
    verificationCodePepper: requireSecret(
      env,
      'VERIFICATION_CODE_PEPPER',
      nodeEnv,
    ),
    gameCredentialSecret: requireSecret(env, 'GAME_CREDENTIAL_SECRET', nodeEnv),
    sessionDurationDays: parseInteger(env, 'SESSION_DURATION_DAYS', 30, 1, 365),
    verificationCodeTtlMinutes: parseInteger(
      env,
      'VERIFICATION_CODE_TTL_MINUTES',
      10,
      1,
      60,
    ),
    verificationCodeResendSeconds: parseInteger(
      env,
      'VERIFICATION_CODE_RESEND_SECONDS',
      60,
      1,
      3600,
    ),
    verificationCodeMaxAttempts: parseInteger(
      env,
      'VERIFICATION_CODE_MAX_ATTEMPTS',
      5,
      1,
      20,
    ),
    aiBotEnabled: parseBoolean(env, 'AI_BOT_ENABLED', true),
    aiBotWorkers: parseAiBotWorkers(env),
    aiBotQueueLimit: parseInteger(env, 'AI_BOT_QUEUE_LIMIT', 256, 1, 10_000),
    aiBotHardMaxMs: parseInteger(env, 'AI_BOT_HARD_MAX_MS', 80, 1, 1000),
    aiBotExpertEnabled: parseBoolean(env, 'AI_BOT_EXPERT_ENABLED', true),
    aiBotNeuralModel: resolve(
      projectRoot,
      env.AI_BOT_NEURAL_MODEL?.trim() ||
        'ai_bot/models/neural/policy-attn-s6.onnx',
    ),
    aiBotExpertSims: parseInteger(env, 'AI_BOT_EXPERT_SIMS', 96, 1, 10_000),
    aiBotExpertDeterminizations: parseInteger(
      env,
      'AI_BOT_EXPERT_DETERMINIZATIONS',
      2,
      1,
      8,
    ),
    aiBotExpertMaxMs: parseInteger(
      env,
      'AI_BOT_EXPERT_MAX_MS',
      500,
      100,
      5000,
    ),
    defaultLocale: 'en',
  };
};
