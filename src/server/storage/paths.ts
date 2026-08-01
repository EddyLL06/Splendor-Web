import {
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import type { AppConfig } from '../config.js';

const verifyDirectory = async (directory: string, label: string): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a file or symbolic link.`);
  }
  const marker = resolve(
    directory,
    `.gem-council-write-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  const handle = await open(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  await handle.close();
  await unlink(marker);
};

export const prepareStorage = async (config: AppConfig): Promise<void> => {
  await verifyDirectory(config.appDataDir, 'APP_DATA_DIR');
  await verifyDirectory(resolve(config.databasePath, '..'), 'Database directory');
  await verifyDirectory(config.avatarStorageDir, 'AVATAR_STORAGE_DIR');
  await verifyDirectory(config.uploadTempDir, 'UPLOAD_TEMP_DIR');
  const databaseHandle = await open(config.databasePath, 'a', 0o600);
  await databaseHandle.close();
};

export const cleanupTemporaryUploads = async (
  config: AppConfig,
  olderThanMs = 24 * 60 * 60 * 1000,
): Promise<void> => {
  const now = Date.now();
  for (const entry of await readdir(config.uploadTempDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('upload_')) continue;
    const path = resolve(config.uploadTempDir, entry.name);
    const stats = await lstat(path);
    if (!stats.isSymbolicLink() && now - stats.mtimeMs > olderThanMs) {
      await unlink(path).catch(() => undefined);
    }
  }
};

export const safeAvatarPath = (directory: string, storageKey: string): string => {
  if (!/^[a-f0-9]{32}\.webp$/.test(storageKey) || basename(storageKey) !== storageKey) {
    throw new Error('Invalid avatar storage key.');
  }
  const path = resolve(directory, storageKey);
  if (!path.startsWith(`${resolve(directory)}/`)) {
    throw new Error('Avatar path escaped its storage directory.');
  }
  return path;
};
