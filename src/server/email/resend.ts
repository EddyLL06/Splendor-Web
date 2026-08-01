import { Resend } from 'resend';

import { renderVerificationEmail } from './content.js';
import type { EmailService, VerificationEmailInput } from './types.js';

export interface ResendEmailOptions {
  apiKey: string;
  from: string;
  replyTo?: string;
  timeoutMs?: number;
}

export class ResendEmailService implements EmailService {
  private readonly resend: Resend;
  private readonly timeoutMs: number;

  constructor(private readonly options: ResendEmailOptions) {
    this.resend = new Resend(options.apiKey);
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async sendVerificationCode(input: VerificationEmailInput): Promise<void> {
    const content = renderVerificationEmail(input);
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.resend.emails.send(
          {
            from: this.options.from,
            to: input.to,
            replyTo: this.options.replyTo,
            subject: content.subject,
            text: content.text,
            html: content.html,
          },
          { idempotencyKey: `verification/${input.idempotencyKey}` },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('EMAIL_PROVIDER_TIMEOUT')), this.timeoutMs);
        }),
      ]);
      if (result.error) throw new Error('EMAIL_PROVIDER_REJECTED');
    } catch {
      throw new Error('EMAIL_DELIVERY_FAILED');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
