import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import { defineConfig } from 'prisma/config';

const projectRoot = process.cwd();
const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) loadEnvFile(envPath);

const rawDatabaseUrl =
  process.env.DATABASE_URL ?? 'file:./.local-data/database/app.sqlite';
const databaseUrl = rawDatabaseUrl.startsWith('file:./')
  ? `file:${resolve(projectRoot, rawDatabaseUrl.slice('file:'.length))}`
  : rawDatabaseUrl;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: databaseUrl,
  },
});
