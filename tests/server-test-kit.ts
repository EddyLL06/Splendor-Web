/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import supertest from 'supertest';

import { createConfig, type AppConfig } from '../src/server/config.js';
import { FakeEmailService } from '../src/server/email/fake.js';
import {
  createGemCouncilApplication,
  type GemCouncilApplication,
} from '../src/server/http/app.js';

const projectRoot = resolve(import.meta.dirname, '..');
export const TEST_ORIGIN = 'http://localhost:5173';

export interface TestApplication {
  root: string;
  config: AppConfig;
  email: FakeEmailService;
  app: GemCouncilApplication;
  request: supertest.Agent;
  cleanup: () => Promise<void>;
}

export const createTestConfig = (root: string, overrides: NodeJS.ProcessEnv = {}): AppConfig =>
  createConfig(
    {
      NODE_ENV: 'test',
      APP_BASE_URL: TEST_ORIGIN,
      GAME_ALLOWED_ORIGINS: TEST_ORIGIN,
      GAME_SERVER_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
      APP_DATA_DIR: root,
      DATABASE_URL: `file:${join(root, 'database', 'app.sqlite')}`,
      AVATAR_STORAGE_DIR: join(root, 'avatars'),
      UPLOAD_TEMP_DIR: join(root, 'tmp'),
      EMAIL_PROVIDER: 'fake',
      SESSION_SECRET: 'test-session-secret-material-00000001',
      VERIFICATION_CODE_PEPPER: 'test-verification-pepper-000000001',
      GAME_CREDENTIAL_SECRET: 'test-game-secret-material-000000001',
      SESSION_DURATION_DAYS: '30',
      VERIFICATION_CODE_TTL_MINUTES: '10',
      VERIFICATION_CODE_RESEND_SECONDS: '60',
      VERIFICATION_CODE_MAX_ATTEMPTS: '5',
      ...overrides,
    },
    projectRoot,
  );

export const migrateFreshDatabase = async (config: AppConfig): Promise<void> => {
  await mkdir(join(config.appDataDir, 'database'), { recursive: true });
  await writeFile(config.databasePath, '', { flag: 'wx', mode: 0o600 });
  execFileSync(
    process.execPath,
    [resolve(projectRoot, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
    {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      stdio: 'pipe',
    },
  );
};

export const createTestApplication = async (
  suite: string,
  overrides: NodeJS.ProcessEnv = {},
): Promise<TestApplication> => {
  const root = await mkdtemp(join(tmpdir(), `gem-council-${suite}-`));
  const config = createTestConfig(root, overrides);
  await migrateFreshDatabase(config);
  const email = new FakeEmailService();
  const app = await createGemCouncilApplication({ config, email });
  return {
    root,
    config,
    email,
    app,
    request: supertest.agent(app.app.callback()),
    cleanup: async () => {
      await app.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
};

export interface RegisteredAccount {
  email: string;
  username: string;
  password: string;
  csrfToken: string;
  userID: string;
  agent: supertest.Agent;
  cookie: string;
}

export const requestCode = async (
  environment: TestApplication,
  email: string,
  purpose: 'registration' | 'password-reset' = 'registration',
): Promise<string | undefined> => {
  const prefix = purpose === 'registration' ? 'register' : 'password-reset';
  await environment.request
    .post(`/api/auth/${prefix}/request-code`)
    .set('Origin', TEST_ORIGIN)
    .send({ email, locale: 'en' })
    .expect(200);
  return environment.email.latestCode(email, purpose);
};

export const registerAccount = async (
  environment: TestApplication,
  username: string,
  email = `${username.toLowerCase()}@example.test`,
  password = 'Printable!123',
): Promise<RegisteredAccount> => {
  const agent = supertest.agent(environment.app.app.callback());
  await agent
    .post('/api/auth/register/request-code')
    .set('Origin', TEST_ORIGIN)
    .send({ email, locale: 'en' })
    .expect(200);
  const code = environment.email.latestCode(email, 'registration');
  if (!code) throw new Error('Fake provider did not capture the registration code.');
  const response = await agent
    .post('/api/auth/register/complete')
    .set('Origin', TEST_ORIGIN)
    .send({ email, username, password, code })
    .expect(200);
  const setCookie = response.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? '';
  return {
    email,
    username,
    password,
    csrfToken: response.body.csrfToken as string,
    userID: response.body.user.id as string,
    agent,
    cookie,
  };
};

export const mutate = (account: RegisteredAccount) => ({
  Origin: TEST_ORIGIN,
  'X-CSRF-Token': account.csrfToken,
});
