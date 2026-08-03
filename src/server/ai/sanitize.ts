/**
 * Log/error sanitization helpers (DEVELOPMENT_GUIDE.md §17). Logs may
 * contain an irreversible short hash of a match ID, never the raw match ID,
 * access tickets, seat credentials, session data or hidden card IDs.
 */

import { createHash } from 'node:crypto';

export const shortHash = (value: string, length = 12): string =>
  createHash('sha256').update(value).digest('hex').slice(0, length);
