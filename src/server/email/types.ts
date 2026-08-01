export type VerificationPurpose = 'registration' | 'password-reset';
export type Locale = 'en' | 'zh-CN';

export interface VerificationEmailInput {
  to: string;
  purpose: VerificationPurpose;
  code: string;
  expiresInMinutes: number;
  idempotencyKey: string;
  locale: Locale;
}

export interface EmailService {
  sendVerificationCode(input: VerificationEmailInput): Promise<void>;
}
