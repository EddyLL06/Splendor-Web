import { randomBytes } from 'node:crypto';

import type { Server as BoardgameServer, StorageAPI } from 'boardgame.io';
import { createMatch as createBoardgameMatch } from 'boardgame.io/dist/cjs/internal.js';

import { SplendorGame } from '../../game/SplendorGame.js';
import { ApiError, invalidInput } from '../errors.js';
import type { AuthenticatedSession } from '../auth/session.js';
import type { SeatCredentialService, SeatMetadata } from './credentials.js';
import {
  createMatchSchema,
  credentialSchema,
  joinMatchSchema,
  parseBody,
} from '../validation/auth.js';

type MatchDatabase = StorageAPI.Async | StorageAPI.Sync;
type MatchMetadata = BoardgameServer.MatchData;

const locks = new Map<string, Promise<void>>();
const withMatchLock = async <T>(matchID: string, operation: () => Promise<T>): Promise<T> => {
  const previous = locks.get(matchID) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(matchID, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(matchID) === queued) locks.delete(matchID);
  }
};

const resolveResult = async <T>(value: T | Promise<T>): Promise<T> => value;

const fetchMetadata = async (
  db: MatchDatabase,
  matchID: string,
): Promise<MatchMetadata> => {
  const result = await resolveResult(db.fetch(matchID, { metadata: true }));
  if (!result.metadata) throw new ApiError(404, 'MATCH_NOT_FOUND');
  return result.metadata;
};

const publicMatch = (matchID: string, metadata: MatchMetadata) => ({
  ...metadata,
  matchID,
  players: Object.values(metadata.players).map(({ credentials: _credentials, ...player }) => player),
});

const nextMatchID = (): string => randomBytes(9).toString('base64url').slice(0, 11);

const createUniqueMatchID = async (db: MatchDatabase): Promise<string> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const matchID = nextMatchID();
    const existing = await resolveResult(db.fetch(matchID, { metadata: true }));
    if (!existing.metadata) return matchID;
  }
  throw new ApiError(503, 'MATCH_ID_UNAVAILABLE');
};

const touchMetadata = (metadata: MatchMetadata): void => {
  metadata.updatedAt = Date.now();
};

const seatData = (
  session: AuthenticatedSession,
  matchID: string,
  playerID: string,
): SeatMetadata => ({
  userId: session.user.id,
  matchId: matchID,
  playerId: playerID,
  avatarUrl: session.user.avatarUrl,
});

const findOpenSeat = (metadata: MatchMetadata): string | undefined =>
  Object.values(metadata.players)
    .map((player) => String(player.id))
    .find((playerID) => !metadata.players[Number(playerID)]?.name);

const assertSeatCredential = async (
  credentials: SeatCredentialService,
  session: AuthenticatedSession,
  metadata: MatchMetadata,
  playerID: string,
  supplied: string,
): Promise<void> => {
  const player = metadata.players[Number(playerID)];
  if (
    !player ||
    (player.data as SeatMetadata | undefined)?.userId !== session.user.id ||
    !(await credentials.authenticate(supplied, player))
  ) {
    throw new ApiError(403, 'SEAT_CREDENTIAL_INVALID');
  }
};

export interface LobbyServiceOptions {
  db: MatchDatabase;
  credentials: SeatCredentialService;
}

export class LobbyService {
  constructor(private readonly options: LobbyServiceOptions) {}

  async listGames(): Promise<string[]> {
    return [SplendorGame.name!];
  }

  async create(session: AuthenticatedSession, body: unknown) {
    const input = parseBody(createMatchSchema, body);
    const matchID = await createUniqueMatchID(this.options.db);
    const created = createBoardgameMatch({
      game: SplendorGame,
      numPlayers: input.numPlayers,
      setupData: undefined,
      unlisted: input.unlisted,
    });
    if ('setupDataError' in created) throw invalidInput();
    await resolveResult(this.options.db.createMatch(matchID, created));
    return { matchID, visibility: input.unlisted ? 'private' : 'public' };
  }

  async list(query: Record<string, string | string[] | undefined>) {
    const rawGameover = Array.isArray(query.isGameover)
      ? query.isGameover[0]
      : query.isGameover;
    const isGameover = rawGameover === 'true' ? true : rawGameover === 'false' ? false : undefined;
    const ids = await resolveResult(
      this.options.db.listMatches({
        gameName: SplendorGame.name,
        where: { isGameover },
      }),
    );
    const matches = [];
    for (const matchID of ids) {
      const metadata = await fetchMetadata(this.options.db, matchID);
      if (!metadata.unlisted) matches.push(publicMatch(matchID, metadata));
    }
    return { matches };
  }

  async get(matchID: string) {
    return publicMatch(matchID, await fetchMetadata(this.options.db, matchID));
  }

  async join(session: AuthenticatedSession, matchID: string, body: unknown) {
    const input = parseBody(joinMatchSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const duplicate = Object.values(metadata.players).some(
        (player) => (player.data as SeatMetadata | undefined)?.userId === session.user.id,
      );
      if (duplicate) throw new ApiError(409, 'SEAT_ALREADY_CLAIMED');
      const playerID = input.playerID ?? findOpenSeat(metadata);
      if (playerID === undefined) throw new ApiError(409, 'MATCH_FULL');
      const player = metadata.players[Number(playerID)];
      if (!player) throw new ApiError(404, 'MATCH_NOT_FOUND');
      if (player.name) throw new ApiError(409, 'SEAT_ALREADY_CLAIMED');
      const playerCredentials = this.options.credentials.issue({
        userId: session.user.id,
        sessionId: session.id,
        matchId: matchID,
        playerId: playerID,
        sessionExpiresAt: session.expiresAt,
      });
      player.name = session.user.username;
      player.data = seatData(session, matchID, playerID);
      player.credentials = playerCredentials;
      touchMetadata(metadata);
      await resolveResult(this.options.db.setMetadata(matchID, metadata));
      return { playerID, playerCredentials };
    });
  }

  async reclaim(session: AuthenticatedSession, matchID: string) {
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const player = Object.values(metadata.players).find(
        (candidate) =>
          (candidate.data as SeatMetadata | undefined)?.userId === session.user.id,
      );
      if (!player) throw new ApiError(403, 'FORBIDDEN');
      const playerID = String(player.id);
      const playerCredentials = this.options.credentials.issue({
        userId: session.user.id,
        sessionId: session.id,
        matchId: matchID,
        playerId: playerID,
        sessionExpiresAt: session.expiresAt,
      });
      player.name = session.user.username;
      player.data = seatData(session, matchID, playerID);
      player.credentials = playerCredentials;
      touchMetadata(metadata);
      await resolveResult(this.options.db.setMetadata(matchID, metadata));
      return { playerID, playerCredentials, playerName: session.user.username };
    });
  }

  async leave(session: AuthenticatedSession, matchID: string, body: unknown): Promise<{}> {
    const input = parseBody(credentialSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      await assertSeatCredential(
        this.options.credentials,
        session,
        metadata,
        input.playerID,
        input.credentials,
      );
      const player = metadata.players[Number(input.playerID)];
      delete player.name;
      delete player.credentials;
      delete player.data;
      delete player.isConnected;
      touchMetadata(metadata);
      const hasPlayers = Object.values(metadata.players).some((candidate) => candidate.name);
      if (hasPlayers) await resolveResult(this.options.db.setMetadata(matchID, metadata));
      else await resolveResult(this.options.db.wipe(matchID));
      return {};
    });
  }

  async playAgain(session: AuthenticatedSession, matchID: string, body: unknown) {
    const input = parseBody(credentialSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      await assertSeatCredential(
        this.options.credentials,
        session,
        metadata,
        input.playerID,
        input.credentials,
      );
      if (metadata.nextMatchID) return { nextMatchID: metadata.nextMatchID };
      const nextID = await createUniqueMatchID(this.options.db);
      const created = createBoardgameMatch({
        game: SplendorGame,
        numPlayers: Object.keys(metadata.players).length,
        setupData: undefined,
        unlisted: Boolean(metadata.unlisted),
      });
      if ('setupDataError' in created) throw invalidInput();
      await resolveResult(this.options.db.createMatch(nextID, created));
      metadata.nextMatchID = nextID;
      touchMetadata(metadata);
      await resolveResult(this.options.db.setMetadata(matchID, metadata));
      return { nextMatchID: nextID };
    });
  }

  async updatePlayer(session: AuthenticatedSession, matchID: string, body: unknown): Promise<{}> {
    const input = parseBody(credentialSchema, body);
    await withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      await assertSeatCredential(
        this.options.credentials,
        session,
        metadata,
        input.playerID,
        input.credentials,
      );
      const player = metadata.players[Number(input.playerID)];
      player.name = session.user.username;
      player.data = seatData(session, matchID, input.playerID);
      touchMetadata(metadata);
      await resolveResult(this.options.db.setMetadata(matchID, metadata));
    });
    return {};
  }
}
