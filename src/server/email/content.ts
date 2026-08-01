import type { VerificationEmailInput } from './types.js';

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export const renderVerificationEmail = (
  input: VerificationEmailInput,
): EmailContent => {
  const isRegistration = input.purpose === 'registration';
  if (input.locale === 'zh-CN') {
    const action = isRegistration ? '完成 Gem Council 注册' : '重置 Gem Council 密码';
    return {
      subject: `${action}的验证码`,
      text: `${action}\n\n验证码：${input.code}\n\n验证码将在 ${input.expiresInMinutes} 分钟后失效。如果这不是你的操作，请忽略此邮件。`,
      html: `<div lang="zh-CN"><h1>${action}</h1><p>你的六位验证码是：</p><p style="font-size:32px;font-weight:700;letter-spacing:0.18em">${input.code}</p><p>验证码将在 ${input.expiresInMinutes} 分钟后失效。</p><p>如果这不是你的操作，请忽略此邮件。</p></div>`,
    };
  }
  const action = isRegistration
    ? 'Complete your Gem Council registration'
    : 'Reset your Gem Council password';
  return {
    subject: `${action} verification code`,
    text: `${action}\n\nYour six-digit verification code is: ${input.code}\n\nThis code expires in ${input.expiresInMinutes} minutes. If you did not request this, ignore this email.`,
    html: `<div lang="en"><h1>${action}</h1><p>Your six-digit verification code is:</p><p style="font-size:32px;font-weight:700;letter-spacing:0.18em">${input.code}</p><p>This code expires in ${input.expiresInMinutes} minutes.</p><p>If you did not request this, ignore this email.</p></div>`,
  };
};
