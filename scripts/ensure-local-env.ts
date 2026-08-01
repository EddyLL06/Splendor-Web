import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const present = new Set(
  existing
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
    .filter((key): key is string => Boolean(key)),
);

const secret = (): string => randomBytes(48).toString('base64url');
const defaults: Array<[string, string]> = [
  ['NODE_ENV', 'development'],
  ['APP_BASE_URL', 'http://localhost:5173'],
  ['APP_DATA_DIR', '.local-data'],
  ['DATABASE_URL', 'file:./.local-data/database/app.sqlite'],
  ['AVATAR_STORAGE_DIR', '.local-data/avatars'],
  ['UPLOAD_TEMP_DIR', '.local-data/tmp'],
  ['EMAIL_PROVIDER', 'resend'],
  ['RESEND_API_KEY', ''],
  ['EMAIL_FROM', 'Gem Council <no-reply@auth.example.com>'],
  ['EMAIL_REPLY_TO', ''],
  ['SESSION_SECRET', secret()],
  ['VERIFICATION_CODE_PEPPER', secret()],
  ['GAME_CREDENTIAL_SECRET', secret()],
  ['SESSION_DURATION_DAYS', '30'],
  ['VERIFICATION_CODE_TTL_MINUTES', '10'],
  ['VERIFICATION_CODE_RESEND_SECONDS', '60'],
  ['VERIFICATION_CODE_MAX_ATTEMPTS', '5'],
];

const additions = defaults.filter(([key]) => !present.has(key));
if (additions.length > 0) {
  const prefix = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const block = additions.map(([key, value]) => `${key}=${value}`).join('\n');
  writeFileSync(envPath, `${existing}${prefix}${block}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

console.log(
  additions.length === 0
    ? 'Local environment already contains every required variable.'
    : `Added ${additions.length} missing local environment variables without changing existing values.`,
);
