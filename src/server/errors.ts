export type ApiErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AVATAR_INVALID'
  | 'AVATAR_TOO_LARGE'
  | 'CODE_INVALID'
  | 'CSRF_INVALID'
  | 'EMAIL_REQUEST_ACCEPTED'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'MATCH_FULL'
  | 'MATCH_ID_UNAVAILABLE'
  | 'MATCH_NOT_FOUND'
  | 'ORIGIN_INVALID'
  | 'RATE_LIMITED'
  | 'SEAT_ALREADY_CLAIMED'
  | 'SEAT_CREDENTIAL_INVALID'
  | 'UNAUTHENTICATED'
  | 'USERNAME_UNAVAILABLE';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export const invalidInput = (): ApiError => new ApiError(400, 'INVALID_INPUT');
