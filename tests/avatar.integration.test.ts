/// <reference types="node" />

import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { safeAvatarPath } from '../src/server/storage/paths.js';
import {
  createTestApplication,
  mutate,
  registerAccount,
  type RegisteredAccount,
  type TestApplication,
} from './server-test-kit.js';

describe('secure avatar pipeline', () => {
  let environment: TestApplication;
  let account: RegisteredAccount;
  let jpeg: Buffer;
  let png: Buffer;
  let webp: Buffer;

  beforeAll(async () => {
    environment = await createTestApplication('avatars');
    account = await registerAccount(environment, 'AvatarUser');
    const source = sharp({ create: { width: 48, height: 32, channels: 3, background: '#235744' } });
    jpeg = await source.clone().jpeg().toBuffer();
    png = await source.clone().png().toBuffer();
    webp = await source.clone().webp().toBuffer();
  });

  afterAll(async () => {
    await environment.cleanup();
  });

  const upload = (buffer: Buffer, filename: string, contentType: string) =>
    account.agent
      .post('/api/profile/avatar')
      .set(mutate(account))
      .attach('avatar', buffer, { filename, contentType });

  it.each([
    ['JPEG', () => jpeg, 'photo.jpg', 'image/jpeg'],
    ['PNG', () => png, 'photo.png', 'image/png'],
    ['WebP', () => webp, 'photo.webp', 'image/webp'],
  ])('accepts %s, emits a fixed 512px metadata-free WebP, and serves it through the controlled route', async (_label, getBuffer, filename, mime) => {
    const result = await upload(getBuffer(), filename, mime).expect(200);
    expect(result.body.user.hasCustomAvatar).toBe(true);
    const served = await account.agent.get(result.body.user.avatarUrl).expect(200).expect('Content-Type', /image\/webp/);
    const metadata = await sharp(served.body as Buffer).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it('rejects oversized, MIME-confused, wrong-magic, SVG, GIF, malformed, and decompression-bomb inputs', async () => {
    await upload(Buffer.alloc(2 * 1024 * 1024 + 1), 'large.png', 'image/png')
      .expect(413, { error: { code: 'AVATAR_TOO_LARGE' } });
    await upload(png, 'wrong.jpg', 'image/jpeg')
      .expect(400, { error: { code: 'AVATAR_INVALID' } });
    await upload(Buffer.from('not an image'), 'fake.png', 'image/png')
      .expect(400, { error: { code: 'AVATAR_INVALID' } });
    await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'), 'vector.svg', 'image/svg+xml')
      .expect(400, { error: { code: 'AVATAR_INVALID' } });
    const animatedGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    await upload(animatedGif, 'animated.gif', 'image/gif')
      .expect(400, { error: { code: 'AVATAR_INVALID' } });
    await upload(png.subarray(0, Math.floor(png.length / 2)), 'truncated.png', 'image/png')
      .expect(400, { error: { code: 'AVATAR_INVALID' } });
    const bomb = await sharp({ create: { width: 4097, height: 4097, channels: 3, background: '#000' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.byteLength).toBeLessThan(2 * 1024 * 1024);
    await upload(bomb, 'bomb.png', 'image/png')
      .expect(400, { error: { code: 'AVATAR_INVALID' } });
  }, 30_000);

  it('ignores a traversal filename, replaces atomically, and deletes idempotently', async () => {
    await upload(jpeg, '../../escape.jpg', 'image/jpeg').expect(200);
    const first = await environment.app.database.prisma.avatarAsset.findUnique({ where: { userId: account.userID } });
    expect(first?.storageKey).toMatch(/^[a-f0-9]{32}\.webp$/);
    await upload(png, 'replacement.png', 'image/png').expect(200);
    const second = await environment.app.database.prisma.avatarAsset.findUnique({ where: { userId: account.userID } });
    expect(second?.storageKey).not.toBe(first?.storageKey);
    await expect(access(join(environment.config.avatarStorageDir, first!.storageKey))).rejects.toThrow();
    expect(await readdir(environment.config.avatarStorageDir)).toEqual([second!.storageKey]);

    await account.agent.delete('/api/profile/avatar').set(mutate(account)).expect(200);
    await account.agent.delete('/api/profile/avatar').set(mutate(account)).expect(200);
    expect(await environment.app.database.prisma.avatarAsset.count({ where: { userId: account.userID } })).toBe(0);
    expect(await readdir(environment.config.avatarStorageDir)).toEqual([]);
  });

  it('prevents storage-key traversal and requires authentication to read avatars', async () => {
    expect(() => safeAvatarPath(environment.config.avatarStorageDir, '../../secret.webp')).toThrow();
    await environment.request.get(`/api/users/${account.userID}/avatar`).expect(401);
  });

  it('rate-limits repeated avatar upload attempts', async () => {
    const limited = await registerAccount(environment, 'AvatarRate');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await limited.agent
        .post('/api/profile/avatar')
        .set(mutate(limited))
        .field('not-avatar', 'x')
        .expect(400, { error: { code: 'AVATAR_INVALID' } });
    }
    await limited.agent
      .post('/api/profile/avatar')
      .set(mutate(limited))
      .field('not-avatar', 'x')
      .expect(429, { error: { code: 'RATE_LIMITED' } });
  });
});
