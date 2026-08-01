import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import type { VerificationPurpose } from '../email/types.js';

export const createID = (): string => randomUUID();
export const createOpaqueToken = (): string => randomBytes(32).toString('base64url');
export const createCsrfSecret = (): string => randomBytes(32).toString('base64url');
export const createVerificationCode = (): string =>
  String(randomInt(0, 1_000_000)).padStart(6, '0');

export const hmac = (secret: string, value: string): string =>
  createHmac('sha256', secret).update(value).digest('base64url');

export const hashSessionToken = (secret: string, token: string): string =>
  hmac(secret, `session:${token}`);

export const hashVerificationCode = (
  pepper: string,
  input: {
    challengeID: string;
    normalizedEmail: string;
    purpose: VerificationPurpose;
    code: string;
  },
): string =>
  hmac(
    pepper,
    `verification:${input.challengeID}:${input.normalizedEmail}:${input.purpose}:${input.code}`,
  );

export const constantTimeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    timingSafeEqual(leftBuffer, Buffer.alloc(leftBuffer.length));
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
};
