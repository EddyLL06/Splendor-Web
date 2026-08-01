import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createServer } from 'vite';

import { createConfig } from '../src/server/config.js';
import { FakeEmailService } from '../src/server/email/fake.js';
import { createGemCouncilApplication } from '../src/server/http/app.js';

const projectRoot = resolve(import.meta.dirname, '..');
const testRoot = await mkdtemp(join(tmpdir(), 'gem-council-e2e-'));
const databasePath = join(testRoot, 'database', 'app.sqlite');
await mkdir(join(testRoot, 'database'), { recursive: true });
await writeFile(databasePath, '', { flag: 'wx', mode: 0o600 });

const config = createConfig({
  NODE_ENV: 'test',
  APP_BASE_URL: 'http://localhost:5173',
  GAME_ALLOWED_ORIGINS: 'http://localhost:5173',
  GAME_SERVER_PORT: '8000',
  APP_DATA_DIR: testRoot,
  DATABASE_URL: `file:${databasePath}`,
  AVATAR_STORAGE_DIR: join(testRoot, 'avatars'),
  UPLOAD_TEMP_DIR: join(testRoot, 'tmp'),
  EMAIL_PROVIDER: 'fake',
  SESSION_SECRET: 'e2e-session-secret-material-000000001',
  VERIFICATION_CODE_PEPPER: 'e2e-code-pepper-material-00000000001',
  GAME_CREDENTIAL_SECRET: 'e2e-game-secret-material-000000000001',
}, projectRoot);

execFileSync(
  process.execPath,
  [resolve(projectRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
  {
    cwd: projectRoot,
    env: { ...process.env, DATABASE_URL: config.databaseUrl },
    stdio: 'pipe',
  },
);

const application = await createGemCouncilApplication({
  config,
  email: new FakeEmailService(),
});
await application.start();
const vite = await createServer({
  root: projectRoot,
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
await vite.listen();

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await vite.close();
  await application.stop();
  await rm(testRoot, { recursive: true, force: true });
};

process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
process.once('SIGHUP', () => void stop().finally(() => process.exit(0)));

await new Promise(() => undefined);
