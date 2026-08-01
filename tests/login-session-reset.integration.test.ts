/// <reference types="node" />

import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashSessionToken } from '../src/server/security/crypto.js';
import {
  createTestApplication,
  mutate,
  registerAccount,
  requestCode,
  TEST_ORIGIN,
  type RegisteredAccount,
  type TestApplication,
} from './server-test-kit.js';

const login = (environment: TestApplication, email: string, password: string) =>
  supertest(environment.app.app.callback())
    .post('/api/auth/login')
    .set('Origin', TEST_ORIGIN)
    .send({ email, password });

describe('login, sessions, CSRF, and password reset', () => {
  let environment: TestApplication;
  let account: RegisteredAccount;

  beforeAll(async () => {
    environment = await createTestApplication('sessions');
    account = await registerAccount(environment, 'SessionUser');
  });

  afterAll(async () => {
    await environment.cleanup();
  });

  it('logs in with valid credentials and returns the same generic error for unknown email and wrong password', async () => {
    const valid = await login(environment, account.email, account.password).expect(200);
    expect(valid.body.user.username).toBe(account.username);
    const wrong = await login(environment, account.email, 'WrongPass!123').expect(401);
    const unknown = await login(environment, 'unknown@example.test', 'WrongPass!123').expect(401);
    expect(wrong.body).toEqual({ error: { code: 'AUTH_INVALID_CREDENTIALS' } });
    expect(unknown.body).toEqual(wrong.body);
  });

  it('stores only a keyed session hash, applies cookie flags, and expires in 30 days', async () => {
    environment.config.nodeEnv = 'production';
    environment.app.app.proxy = true;
    let response;
    try {
      response = await supertest(environment.app.app.callback())
        .post('/api/auth/login')
        .set('Origin', TEST_ORIGIN)
        .set('X-Forwarded-Proto', 'https')
        .send({ email: account.email, password: account.password })
        .expect(200);
    } finally {
      environment.config.nodeEnv = 'test';
      environment.app.app.proxy = false;
    }
    const setCookie = response.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const normalizedHeader = header.toLowerCase();
    expect(normalizedHeader).toContain('gem_council_session=');
    expect(normalizedHeader).toContain('httponly');
    expect(normalizedHeader).toContain('samesite=lax');
    expect(normalizedHeader).toContain('secure');
    expect(normalizedHeader).toContain('path=/');
    const raw = header.match(/gem_council_session=([^;]+)/)?.[1];
    expect(raw).toBeTruthy();
    const stored = await environment.app.database.prisma.session.findUnique({
      where: { tokenHash: hashSessionToken(environment.config.sessionSecret, raw!) },
    });
    expect(stored).not.toBeNull();
    expect(stored?.tokenHash).not.toBe(raw);
    expect(Math.abs(stored!.expiresAt.getTime() - stored!.createdAt.getTime() - 30 * 86_400_000)).toBeLessThan(1000);
  });

  it('requires exact Origin and CSRF for authenticated mutations', async () => {
    await account.agent
      .patch('/api/profile')
      .set('X-CSRF-Token', account.csrfToken)
      .send({ username: 'NoOrigin' })
      .expect(403, { error: { code: 'ORIGIN_INVALID' } });
    await account.agent
      .patch('/api/profile')
      .set('Origin', TEST_ORIGIN)
      .set('X-CSRF-Token', 'wrong-token')
      .send({ username: 'WrongCsrf' })
      .expect(403, { error: { code: 'CSRF_INVALID' } });
    const success = await account.agent
      .patch('/api/profile')
      .set(mutate(account))
      .send({ username: 'SessionRenamed' })
      .expect(200);
    expect(success.body.user.username).toBe('SessionRenamed');
    account.username = 'SessionRenamed';
  });

  it('revokes logout sessions and rejects expired or manually revoked sessions', async () => {
    const logoutAccount = await registerAccount(environment, 'LogoutUser');
    const stored = await environment.app.database.prisma.session.findFirst({
      where: { userId: logoutAccount.userID, revokedAt: null },
    });
    await logoutAccount.agent.post('/api/auth/logout').set(mutate(logoutAccount)).expect(200);
    expect((await environment.app.database.prisma.session.findUnique({ where: { id: stored!.id } }))?.revokedAt).not.toBeNull();
    await logoutAccount.agent.get('/games').expect(401, { error: { code: 'UNAUTHENTICATED' } });

    const expired = await registerAccount(environment, 'ExpiredSession');
    await environment.app.database.prisma.session.updateMany({
      where: { userId: expired.userID },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await expired.agent.get('/api/auth/me').expect(200)).body.user).toBeNull();

    const revoked = await registerAccount(environment, 'RevokedSession');
    await environment.app.database.prisma.session.updateMany({
      where: { userId: revoked.userID },
      data: { revokedAt: new Date() },
    });
    await revoked.agent.get('/games').expect(401, { error: { code: 'UNAUTHENTICATED' } });
  });

  it('keeps password-reset requests generic for missing accounts', async () => {
    const count = environment.email.messages.length;
    await supertest(environment.app.app.callback())
      .post('/api/auth/password-reset/request-code')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'missing@example.test', locale: 'en' })
      .expect(200, { ok: true, code: 'EMAIL_REQUEST_ACCEPTED' });
    expect(environment.email.messages).toHaveLength(count);
  });

  it('resets a password, consumes only reset-purpose code, revokes old sessions, and signs in a fresh session', async () => {
    const resetAccount = await registerAccount(environment, 'ResetUser');
    const oldSession = await environment.app.database.prisma.session.findFirst({
      where: { userId: resetAccount.userID, revokedAt: null },
    });
    const code = await requestCode(environment, resetAccount.email, 'password-reset');
    const resetAgent = supertest.agent(environment.app.app.callback());
    const result = await resetAgent
      .post('/api/auth/password-reset/complete')
      .set('Origin', TEST_ORIGIN)
      .send({ email: resetAccount.email, code, password: 'NewPassword!123' })
      .expect(200);
    expect(result.body.user.id).toBe(resetAccount.userID);
    expect((await environment.app.database.prisma.session.findUnique({ where: { id: oldSession!.id } }))?.revokedAt).not.toBeNull();
    await resetAccount.agent.get('/games').expect(401);
    await login(environment, resetAccount.email, resetAccount.password).expect(401, { error: { code: 'AUTH_INVALID_CREDENTIALS' } });
    await login(environment, resetAccount.email, 'NewPassword!123').expect(200);

    await resetAgent
      .post('/api/auth/password-reset/complete')
      .set('Origin', TEST_ORIGIN)
      .send({ email: resetAccount.email, code, password: 'AnotherPass!123' })
      .expect(400, { error: { code: 'CODE_INVALID' } });
  });
});
