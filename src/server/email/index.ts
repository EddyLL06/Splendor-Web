import type { AppConfig } from '../config.js';
import { FakeEmailService } from './fake.js';
import { ResendEmailService } from './resend.js';
import type { EmailService } from './types.js';

export const createEmailService = (config: AppConfig): EmailService =>
  config.emailProvider === 'fake'
    ? new FakeEmailService()
    : new ResendEmailService({
        apiKey: config.resendApiKey,
        from: config.emailFrom,
        replyTo: config.emailReplyTo,
      });

export { FakeEmailService } from './fake.js';
export type { EmailService, Locale, VerificationPurpose } from './types.js';
