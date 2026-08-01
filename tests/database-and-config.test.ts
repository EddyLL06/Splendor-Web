/// <reference types="node" />

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createConfig } from '../src/server/config.js';
import { createDatabase } from '../src/server/database/client.js';
import {
  createTestConfig,
  migrateFreshDatabase,
} from './server-test-kit.js';

describe('database migrations and configuration', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'gem-council-database-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('applies committed migrations to a fresh isolated SQLite database', async () => {
    const config = createTestConfig(join(root, 'migrated'));
    await migrateFreshDatabase(config);
    const database = await createDatabase(config);
    const tables = (await database.prisma.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    )).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining([
      'User', 'EmailVerificationChallenge', 'Session', 'AvatarAsset', '_prisma_migrations',
    ]));
    await database.close();
  });

  it('enforces unique identities and foreign keys at database level', async () => {
    const config = createTestConfig(join(root, 'constraints'));
    await migrateFreshDatabase(config);
    const database = await createDatabase(config);
    const now = new Date();
    const base = {
      passwordHash: '$argon2id$test',
      emailVerifiedAt: now,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await database.prisma.user.create({
      data: { id: 'u1', email: 'one@example.test', normalizedEmail: 'one@example.test', username: 'One', normalizedUsername: 'one', ...base },
    });
    await expect(database.prisma.user.create({
      data: { id: 'u2', email: 'ONE@example.test', normalizedEmail: 'one@example.test', username: 'Two', normalizedUsername: 'two', ...base },
    })).rejects.toThrow();
    await expect(database.prisma.session.create({
      data: { id: 's1', userId: 'missing', tokenHash: 'hash', csrfSecret: 'csrf', expiresAt: now, lastActivityAt: now },
    })).rejects.toThrow();
    await database.close();
  });

  it('resolves external absolute paths and rejects production/public paths and malformed values', () => {
    const external = join(root, 'external-volume');
    const config = createTestConfig(external);
    expect(config.databasePath).toBe(join(external, 'database', 'app.sqlite'));
    expect(config.databasePath).not.toContain('.local-data');
    expect(() => createConfig({
      NODE_ENV: 'production',
      APP_DATA_DIR: resolve('public/runtime'),
      DATABASE_URL: `file:${resolve('public/runtime/app.sqlite')}`,
      AVATAR_STORAGE_DIR: resolve('public/avatars'),
      UPLOAD_TEMP_DIR: resolve('public/tmp'),
      APP_BASE_URL: 'http://localhost:5173',
      GAME_SERVER_PORT: 'invalid',
      GAME_ALLOWED_ORIGINS: '*',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 'placeholder',
      SESSION_SECRET: 'short',
      VERIFICATION_CODE_PEPPER: 'short',
      GAME_CREDENTIAL_SECRET: 'short',
    }, resolve('.'))).toThrow();
  });
});
