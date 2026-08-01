import type {
  EmailService,
  VerificationEmailInput,
  VerificationPurpose,
} from './types.js';

export class FakeEmailService implements EmailService {
  readonly messages: VerificationEmailInput[] = [];
  failNext = false;

  async sendVerificationCode(input: VerificationEmailInput): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('EMAIL_DELIVERY_FAILED');
    }
    this.messages.push(structuredClone(input));
  }

  latestCode(email: string, purpose: VerificationPurpose): string | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (
        message.to.toLowerCase() === email.toLowerCase() &&
        message.purpose === purpose
      ) {
        return message.code;
      }
    }
    return undefined;
  }
}
