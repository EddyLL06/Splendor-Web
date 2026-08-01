import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send };
  },
}));

import { renderVerificationEmail } from '../src/server/email/content.js';
import { ResendEmailService } from '../src/server/email/resend.js';

describe('verification email content and Resend adapter', () => {
  beforeEach(() => send.mockReset());

  it('renders purpose-specific English and Chinese transactional content', () => {
    const registration = renderVerificationEmail({
      to: 'recipient@example.test', purpose: 'registration', code: '123456', expiresInMinutes: 10, idempotencyKey: 'one', locale: 'en',
    });
    expect(registration.subject).toContain('registration');
    expect(registration.text).toContain('123456');
    expect(registration.text).toContain('10 minutes');
    expect(registration.text).toContain('ignore');
    const reset = renderVerificationEmail({
      to: 'recipient@example.test', purpose: 'password-reset', code: '654321', expiresInMinutes: 8, idempotencyKey: 'two', locale: 'zh-CN',
    });
    expect(reset.subject).toContain('重置');
    expect(reset.text).toContain('654321');
    expect(reset.text).toContain('8 分钟');
    expect(reset.text).toContain('忽略');
  });

  it('sends through Resend with the configured identity and idempotency key', async () => {
    send.mockResolvedValue({ data: { id: 'message-id' }, error: null });
    const service = new ResendEmailService({
      apiKey: 'test-only-key',
      from: 'Gem Council <no-reply@auth.example.com>',
      replyTo: 'help@auth.example.com',
    });
    await service.sendVerificationCode({
      to: 'recipient@example.test', purpose: 'registration', code: '123456', expiresInMinutes: 10, idempotencyKey: 'challenge-id', locale: 'en',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'Gem Council <no-reply@auth.example.com>',
        to: 'recipient@example.test',
        replyTo: 'help@auth.example.com',
      }),
      { idempotencyKey: 'verification/challenge-id' },
    );
  });

  it('converts provider errors to a stable internal delivery failure', async () => {
    send.mockResolvedValue({ data: null, error: { message: 'sensitive provider response' } });
    const service = new ResendEmailService({ apiKey: 'test-only-key', from: 'Gem Council <no-reply@auth.example.com>' });
    await expect(service.sendVerificationCode({
      to: 'recipient@example.test', purpose: 'password-reset', code: '123456', expiresInMinutes: 10, idempotencyKey: 'challenge-id', locale: 'en',
    })).rejects.toThrow('EMAIL_DELIVERY_FAILED');
  });
});
