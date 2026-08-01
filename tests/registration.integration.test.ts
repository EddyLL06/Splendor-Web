/// <reference types="node" />

import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validatePassword } from '../src/server/validation/auth.js';
import {
  createTestApplication,
  registerAccount,
  requestCode,
  TEST_ORIGIN,
  type TestApplication,
} from './server-test-kit.js';

describe('registration and verification challenges', () => {
  let environment: TestApplication;

  beforeAll(async () => {
    environment = await createTestApplication('registration');
  });

  afterAll(async () => {
    await environment.cleanup();
  });

  it('registers a verified account with Argon2id and never stores the plaintext code', async () => {
    const email = 'valid@example.test';
    const code = await requestCode(environment, email);
    expect(code).toMatch(/^\d{6}$/);
    const challenge = await environment.app.database.prisma.emailVerificationChallenge.findFirst({
      where: { normalizedEmail: email },
    });
    expect(challenge?.codeHash).not.toContain(code!);
    expect(JSON.stringify(challenge)).not.toContain(code!);

    const response = await supertest(environment.app.app.callback())
      .post('/api/auth/register/complete')
      .set('Origin', TEST_ORIGIN)
      .send({ email, code, username: 'Valid_User', password: 'Printable!123' })
      .expect(200);
    expect(response.body.user).toMatchObject({ email, username: 'Valid_User' });
    const user = await environment.app.database.prisma.user.findUnique({ where: { normalizedEmail: email } });
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user?.passwordHash).not.toContain('Printable!123');
  });

  it('sets a secure session cookie behind the trusted production proxy', async () => {
    const origin = 'https://game.example.test';
    const proxiedEnvironment = await createTestApplication('production-proxy', {
      NODE_ENV: 'production',
      APP_BASE_URL: origin,
      GAME_ALLOWED_ORIGINS: origin,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_only',
      SESSION_SECRET: 's'.repeat(43),
      VERIFICATION_CODE_PEPPER: 'v'.repeat(43),
      GAME_CREDENTIAL_SECRET: 'g'.repeat(43),
    });
    try {
      const email = 'production-proxy@example.test';
      await proxiedEnvironment.request
        .post('/api/auth/register/request-code')
        .set('Origin', origin)
        .set('X-Forwarded-Proto', 'https')
        .send({ email, locale: 'en' })
        .expect(200);
      const code = proxiedEnvironment.email.latestCode(email, 'registration');
      expect(code).toMatch(/^\d{6}$/);

      const response = await proxiedEnvironment.request
        .post('/api/auth/register/complete')
        .set('Origin', origin)
        .set('X-Forwarded-Proto', 'https')
        .send({
          email,
          code,
          username: 'ProductionProxy',
          password: 'Printable!123',
        })
        .expect(200);
      const setCookie = response.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? '';
      expect(cookie).toContain('gem_council_session=');
      expect(cookie).toContain('httponly');
      expect(cookie).toContain('secure');
      expect(cookie).toContain('samesite=lax');
    } finally {
      await proxiedEnvironment.cleanup();
    }
  });

  it('rejects invalid email without creating a challenge', async () => {
    await supertest(environment.app.app.callback())
      .post('/api/auth/register/request-code')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'not-an-email', locale: 'en' })
      .expect(400, { error: { code: 'INVALID_INPUT' } });
  });

  it('keeps duplicate-email requests generic and rejects reuse', async () => {
    const account = await registerAccount(environment, 'DuplicateEmail');
    const messageCount = environment.email.messages.length;
    await supertest(environment.app.app.callback())
      .post('/api/auth/register/request-code')
      .set('Origin', TEST_ORIGIN)
      .send({ email: account.email, locale: 'en' })
      .expect(200, { ok: true, code: 'EMAIL_REQUEST_ACCEPTED' });
    expect(environment.email.messages).toHaveLength(messageCount);
  });

  it('rejects username collisions across case and Unicode normalization', async () => {
    await registerAccount(environment, 'CaseName');
    for (const [email, username] of [
      ['case-two@example.test', 'casename'],
      ['case-three@example.test', 'ＣａｓｅＮａｍｅ'],
    ]) {
      const code = await requestCode(environment, email);
      await supertest(environment.app.app.callback())
        .post('/api/auth/register/complete')
        .set('Origin', TEST_ORIGIN)
        .send({ email, code, username, password: 'Printable!123' })
        .expect(409, { error: { code: 'USERNAME_UNAVAILABLE' } });
    }
  });

  it('rejects expired, wrong-purpose, and reused codes', async () => {
    const expiredEmail = 'expired@example.test';
    const expiredCode = await requestCode(environment, expiredEmail);
    await environment.app.database.prisma.emailVerificationChallenge.updateMany({
      where: { normalizedEmail: expiredEmail },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await supertest(environment.app.app.callback())
      .post('/api/auth/register/complete')
      .set('Origin', TEST_ORIGIN)
      .send({ email: expiredEmail, code: expiredCode, username: 'Expired', password: 'Printable!123' })
      .expect(400, { error: { code: 'CODE_INVALID' } });

    const purposeEmail = 'purpose@example.test';
    const purposeCode = await requestCode(environment, purposeEmail);
    await supertest(environment.app.app.callback())
      .post('/api/auth/password-reset/complete')
      .set('Origin', TEST_ORIGIN)
      .send({ email: purposeEmail, code: purposeCode, password: 'Different!123' })
      .expect(400, { error: { code: 'CODE_INVALID' } });

    const reusedEmail = 'reused@example.test';
    const reusedCode = await requestCode(environment, reusedEmail);
    const body = { email: reusedEmail, code: reusedCode, username: 'Reused', password: 'Printable!123' };
    await supertest(environment.app.app.callback()).post('/api/auth/register/complete').set('Origin', TEST_ORIGIN).send(body).expect(200);
    await supertest(environment.app.app.callback()).post('/api/auth/register/complete').set('Origin', TEST_ORIGIN).send(body).expect(400, { error: { code: 'CODE_INVALID' } });
  });

  it('enforces the durable wrong-code attempt limit', async () => {
    const email = 'attempts@example.test';
    const code = await requestCode(environment, email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await supertest(environment.app.app.callback())
        .post('/api/auth/register/complete')
        .set('Origin', TEST_ORIGIN)
        .send({ email, code: wrong, username: 'Attempts', password: 'Printable!123' })
        .expect(400, { error: { code: 'CODE_INVALID' } });
    }
    await supertest(environment.app.app.callback())
      .post('/api/auth/register/complete')
      .set('Origin', TEST_ORIGIN)
      .send({ email, code, username: 'Attempts', password: 'Printable!123' })
      .expect(400, { error: { code: 'CODE_INVALID' } });
    const challenge = await environment.app.database.prisma.emailVerificationChallenge.findFirst({ where: { normalizedEmail: email } });
    expect(challenge?.failedAttempts).toBe(5);
    expect(challenge?.consumedAt).not.toBeNull();
  });

  it('honors resend cooldown and deletes a challenge if the provider fails', async () => {
    const email = 'cooldown@example.test';
    await requestCode(environment, email);
    const count = environment.email.messages.length;
    await requestCode(environment, email);
    expect(environment.email.messages).toHaveLength(count);

    const failedEmail = 'provider-failure@example.test';
    environment.email.failNext = true;
    await requestCode(environment, failedEmail);
    expect(await environment.app.database.prisma.emailVerificationChallenge.count({ where: { normalizedEmail: failedEmail } })).toBe(0);
  });

  it('allows only one winner in concurrent registration with one challenge', async () => {
    const email = 'concurrent@example.test';
    const code = await requestCode(environment, email);
    const body = { email, code, username: 'Concurrent', password: 'Printable!123' };
    const results = await Promise.all([
      supertest(environment.app.app.callback()).post('/api/auth/register/complete').set('Origin', TEST_ORIGIN).send(body),
      supertest(environment.app.app.callback()).post('/api/auth/register/complete').set('Origin', TEST_ORIGIN).send(body),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(await environment.app.database.prisma.user.count({ where: { normalizedEmail: email } })).toBe(1);
  });

  it('rate-limits repeated registration-code, reset-code, and login attempts per identity', async () => {
    const registrationEmail = 'registration-rate@example.test';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await supertest(environment.app.app.callback())
        .post('/api/auth/register/request-code')
        .set('Origin', TEST_ORIGIN)
        .send({ email: registrationEmail, locale: 'en' })
        .expect(200);
    }
    await supertest(environment.app.app.callback())
      .post('/api/auth/register/request-code')
      .set('Origin', TEST_ORIGIN)
      .send({ email: registrationEmail, locale: 'en' })
      .expect(429, { error: { code: 'RATE_LIMITED' } });

    const resetAccount = await registerAccount(environment, 'RateReset');
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await supertest(environment.app.app.callback())
        .post('/api/auth/password-reset/request-code')
        .set('Origin', TEST_ORIGIN)
        .send({ email: resetAccount.email, locale: 'en' })
        .expect(200);
    }
    await supertest(environment.app.app.callback())
      .post('/api/auth/password-reset/request-code')
      .set('Origin', TEST_ORIGIN)
      .send({ email: resetAccount.email, locale: 'en' })
      .expect(429, { error: { code: 'RATE_LIMITED' } });

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await supertest(environment.app.app.callback())
        .post('/api/auth/login')
        .set('Origin', TEST_ORIGIN)
        .send({ email: resetAccount.email, password: 'WrongPass!123' })
        .expect(401);
    }
    await supertest(environment.app.app.callback())
      .post('/api/auth/login')
      .set('Origin', TEST_ORIGIN)
      .send({ email: resetAccount.email, password: 'WrongPass!123' })
      .expect(429, { error: { code: 'RATE_LIMITED' } });
  });
});

describe('password policy', () => {
  it.each([
    ['too short', 'Short!123'],
    ['too long', 'a'.repeat(129)],
    ['space', 'Has Space!123'],
    ['tab', 'Has\tTab!123'],
    ['newline', 'Has\nLine!123'],
    ['Unicode', 'Password密码123'],
  ])('rejects %s', (_label, password) => {
    expect(() => validatePassword(password)).toThrow();
  });

  it('accepts printable non-space ASCII and never trims', () => {
    expect(validatePassword('~Printable!123')).toBe('~Printable!123');
    expect(() => validatePassword(' Printable!123')).toThrow();
    expect(() => validatePassword('Printable!123 ')).toThrow();
  });
});
