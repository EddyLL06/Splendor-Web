export type ApiErrorCode =
  | 'AUTH_INVALID_CREDENTIALS'
  | 'ALREADY_A_PLAYER'
  | 'ALREADY_A_SPECTATOR'
  | 'AVATAR_INVALID'
  | 'AVATAR_TOO_LARGE'
  | 'CODE_INVALID'
  | 'CSRF_INVALID'
  | 'EMAIL_REQUEST_ACCEPTED'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'MATCH_FULL'
  | 'MATCH_ALREADY_STARTED'
  | 'MATCH_ID_UNAVAILABLE'
  | 'MATCH_NOT_FOUND'
  | 'MATCH_NOT_STARTED'
  | 'NOT_A_SPECTATOR'
  | 'NOT_ROOM_HOST'
  | 'ORIGIN_INVALID'
  | 'RATE_LIMITED'
  | 'SEAT_ALREADY_CLAIMED'
  | 'SEAT_CREDENTIAL_INVALID'
  | 'PLAYER_SEATS_NOT_FULL'
  | 'ROLE_CHANGE_LOCKED'
  | 'SPECTATING_DISABLED'
  | 'SPECTATORS_CONFIRMATION_REQUIRED'
  | 'SPECTATOR_LIMIT_REACHED'
  | 'GAME_ACCESS_INVALID'
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
