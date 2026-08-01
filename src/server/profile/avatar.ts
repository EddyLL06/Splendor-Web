import { createHash, randomBytes } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';

import type { File } from 'formidable';
import sharp from 'sharp';

import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AppConfig } from '../config.js';
import { ApiError } from '../errors.js';
import { createID } from '../security/crypto.js';
import { safeAvatarPath } from '../storage/paths.js';

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16_777_216;
const AVATAR_SIZE = 512;
const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const hasStrictContainerEnding = (input: Buffer, format: string): boolean => {
  if (format === 'jpeg') {
    return input.length >= 2 && input.at(-2) === 0xff && input.at(-1) === 0xd9;
  }
  if (format === 'png') {
    const ending = Buffer.from('0000000049454e44ae426082', 'hex');
    return input.subarray(-ending.length).equals(ending);
  }
  if (format === 'webp') {
    return (
      input.length >= 12 &&
      input.subarray(0, 4).toString('ascii') === 'RIFF' &&
      input.subarray(8, 12).toString('ascii') === 'WEBP' &&
      input.readUInt32LE(4) + 8 === input.length
    );
  }
  return false;
};

const keyedLocks = new Map<string, Promise<void>>();
const withUserLock = async <T>(userId: string, operation: () => Promise<T>): Promise<T> => {
  const previous = keyedLocks.get(userId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  keyedLocks.set(userId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (keyedLocks.get(userId) === queued) keyedLocks.delete(userId);
  }
};

export class AvatarService {
  private readonly fallbackCache = new Map<string, Buffer>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
  ) {}

  async upload(userId: string, file: File): Promise<void> {
    await withUserLock(userId, async () => {
      let nextPath: string | undefined;
      try {
        if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
          throw new ApiError(413, 'AVATAR_TOO_LARGE');
        }
        const input = await readFile(file.filepath);
        if (input.byteLength > MAX_UPLOAD_BYTES) {
          throw new ApiError(413, 'AVATAR_TOO_LARGE');
        }
        const source = sharp(input, {
          animated: true,
          failOn: 'error',
          limitInputPixels: MAX_INPUT_PIXELS,
        });
        const metadata = await source.metadata();
        const expectedMime = metadata.format ? MIME_BY_FORMAT[metadata.format] : undefined;
        if (
          !expectedMime ||
          !metadata.width ||
          !metadata.height ||
          metadata.width > 8192 ||
          metadata.height > 8192 ||
          metadata.width * metadata.height > MAX_INPUT_PIXELS ||
          (metadata.pages ?? 1) !== 1 ||
          !hasStrictContainerEnding(input, metadata.format ?? '') ||
          (file.mimetype !== null && file.mimetype !== expectedMime)
        ) {
          throw new ApiError(400, 'AVATAR_INVALID');
        }
        const output = await source
          .rotate()
          .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'attention' })
          .webp({ quality: 86, effort: 5 })
          .toBuffer();
        const storageKey = `${randomBytes(16).toString('hex')}.webp`;
        nextPath = safeAvatarPath(this.config.avatarStorageDir, storageKey);
        await writeFile(nextPath, output, { flag: 'wx', mode: 0o600 });
        const previous = await this.prisma.avatarAsset.findUnique({
          where: { userId },
        });
        const now = new Date();
        try {
          await this.prisma.avatarAsset.upsert({
            where: { userId },
            create: {
              id: createID(),
              userId,
              storageKey,
              mimeType: 'image/webp',
              byteSize: output.byteLength,
              width: AVATAR_SIZE,
              height: AVATAR_SIZE,
              createdAt: now,
              updatedAt: now,
            },
            update: {
              storageKey,
              mimeType: 'image/webp',
              byteSize: output.byteLength,
              width: AVATAR_SIZE,
              height: AVATAR_SIZE,
              updatedAt: now,
            },
          });
        } catch (caught) {
          await unlink(nextPath).catch(() => undefined);
          nextPath = undefined;
          throw caught;
        }
        if (previous && previous.storageKey !== storageKey) {
          await unlink(
            safeAvatarPath(this.config.avatarStorageDir, previous.storageKey),
          ).catch(() => undefined);
        }
      } catch (caught) {
        if (caught instanceof ApiError) throw caught;
        throw new ApiError(400, 'AVATAR_INVALID');
      } finally {
        await unlink(file.filepath).catch(() => undefined);
      }
    });
  }

  async remove(userId: string): Promise<void> {
    await withUserLock(userId, async () => {
      const previous = await this.prisma.avatarAsset.findUnique({ where: { userId } });
      if (!previous) return;
      await this.prisma.avatarAsset.deleteMany({ where: { id: previous.id, userId } });
      await unlink(
        safeAvatarPath(this.config.avatarStorageDir, previous.storageKey),
      ).catch(() => undefined);
    });
  }

  async readForUser(userId: string): Promise<{ body: Buffer; custom: boolean } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, status: true, avatar: true },
    });
    if (!user || user.status !== 'active') return null;
    if (user.avatar) {
      try {
        return {
          body: await readFile(
            safeAvatarPath(this.config.avatarStorageDir, user.avatar.storageKey),
          ),
          custom: true,
        };
      } catch {
        // A missing/corrupt on-disk asset must not break the profile surface.
        // Fall through to the deterministic generated avatar.
      }
    }
    const cacheKey = `${user.id}:${user.username}`;
    const cached = this.fallbackCache.get(cacheKey);
    if (cached) return { body: cached, custom: false };
    const digest = createHash('sha256').update(user.id).digest();
    const hue = digest.readUInt16BE(0) % 360;
    const initial = [...user.username][0] ?? '◆';
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 68% 42%)"/><stop offset="1" stop-color="hsl(${(hue + 55) % 360} 72% 24%)"/></linearGradient></defs><rect width="512" height="512" rx="96" fill="url(#g)"/><circle cx="410" cy="102" r="92" fill="rgba(255,255,255,.12)"/><text x="256" y="302" text-anchor="middle" font-family="system-ui,sans-serif" font-size="210" font-weight="700" fill="white">${initial}</text></svg>`,
    );
    const body = await sharp(svg).webp({ quality: 88 }).toBuffer();
    this.fallbackCache.set(cacheKey, body);
    return { body, custom: false };
  }
}

export const avatarLimits = {
  maxUploadBytes: MAX_UPLOAD_BYTES,
  maxInputPixels: MAX_INPUT_PIXELS,
  outputSize: AVATAR_SIZE,
};
