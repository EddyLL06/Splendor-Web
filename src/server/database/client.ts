import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';

import { PrismaClient } from '../../generated/prisma/client.js';
import type { AppConfig } from '../config.js';

export interface Database {
  prisma: PrismaClient;
  close: () => Promise<void>;
}

export const createDatabase = async (config: AppConfig): Promise<Database> => {
  const adapter = new PrismaBetterSqlite3({ url: config.databaseUrl });
  const prisma = new PrismaClient({ adapter });
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON');
  await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL');
  await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000');
  const integrity = await prisma.$queryRawUnsafe<Array<{ foreign_keys: bigint }>>(
    'PRAGMA foreign_keys',
  );
  if (Number(integrity[0]?.foreign_keys) !== 1) {
    await prisma.$disconnect();
    throw new Error('SQLite foreign-key enforcement could not be enabled.');
  }
  return {
    prisma,
    close: () => prisma.$disconnect(),
  };
};
