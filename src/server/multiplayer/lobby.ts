import { randomBytes } from 'node:crypto';

import type { Server as BoardgameServer, StorageAPI } from 'boardgame.io';
import { createMatch as createBoardgameMatch } from 'boardgame.io/dist/cjs/internal.js';

import { SplendorGame } from '../../game/SplendorGame.js';
import { SPECTATOR_CAPACITY, type RoomMatch } from '../../shared/types/room.js';
import type { AuthenticatedSession } from '../auth/session.js';
import { ApiError, invalidInput } from '../errors.js';
import {
  createMatchSchema,
  credentialSchema,
  gameAccessSchema,
  joinMatchSchema,
  parseBody,
  roomSettingsSchema,
  spectatorJoinSchema,
  switchToPlayerSchema,
} from '../validation/auth.js';
import type { GameAccessTicketService } from './access-tickets.js';
import type { SeatCredentialService, SeatMetadata } from './credentials.js';
import {
  RoomRegistry,
  SPECTATOR_DISCONNECT_GRACE_MS,
} from './room-registry.js';

export type MatchDatabase = StorageAPI.Async | StorageAPI.Sync;
export type MatchMetadata = BoardgameServer.MatchData;

const locks = new Map<string, Promise<void>>();
export const withMatchLock = async <T>(
  matchID: string,
  operation: () => Promise<T>,
): Promise<T> => {
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

export const fetchMetadata = async (
  db: MatchDatabase,
  matchID: string,
): Promise<MatchMetadata> => {
  const result = await resolveResult(db.fetch(matchID, { metadata: true }));
  if (!result.metadata) throw new ApiError(404, 'MATCH_NOT_FOUND');
  return result.metadata;
};

const nextMatchID = (): string =>
  randomBytes(9).toString('base64url').slice(0, 11);

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

const playerForUser = (metadata: MatchMetadata, userId: string) =>
  Object.values(metadata.players).find(
    (player) => (player.data as SeatMetadata | undefined)?.userId === userId,
  );

const occupiedPlayers = (metadata: MatchMetadata) =>
  Object.values(metadata.players)
    .filter((player) => Boolean(player.name))
    .sort((left, right) => Number(left.id) - Number(right.id));

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
  rooms: RoomRegistry;
  accessTickets: GameAccessTicketService;
}

export class LobbyService {
  constructor(private readonly options: LobbyServiceOptions) {
    this.options.rooms.setExpirationHandler((matchID, userId) =>
      this.expireSpectator(matchID, userId),
    );
    this.options.rooms.setPlayerExpirationHandler((matchID, playerID) =>
      this.expireInactivePlayer(matchID, playerID),
    );
  }

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
    try {
      this.options.rooms.create({ matchID, hostUserId: session.user.id });
    } catch (caught) {
      await resolveResult(this.options.db.wipe(matchID));
      throw caught;
    }
    return { matchID, visibility: input.unlisted ? 'private' : 'public' };
  }

  async list(
    session: AuthenticatedSession,
    query: Record<string, string | string[] | undefined>,
  ): Promise<{ matches: RoomMatch[] }> {
    const rawGameover = Array.isArray(query.isGameover)
      ? query.isGameover[0]
      : query.isGameover;
    const isGameover =
      rawGameover === 'true'
        ? true
        : rawGameover === 'false'
          ? false
          : undefined;
    const ids = await resolveResult(
      this.options.db.listMatches({
        gameName: SplendorGame.name,
        where: { isGameover },
      }),
    );
    const matches: RoomMatch[] = [];
    for (const matchID of ids) {
      const metadata = await fetchMetadata(this.options.db, matchID);
      if (!metadata.unlisted) matches.push(this.publicMatch(session, matchID, metadata));
    }
    return { matches };
  }

  async get(session: AuthenticatedSession, matchID: string): Promise<RoomMatch> {
    return this.publicMatch(
      session,
      matchID,
      await fetchMetadata(this.options.db, matchID),
    );
  }

  async join(session: AuthenticatedSession, matchID: string, body: unknown) {
    const input = parseBody(joinMatchSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
      await this.removeExpiredSpectators(matchID, metadata);
      if (room.startedAt !== null) throw new ApiError(409, 'MATCH_ALREADY_STARTED');
      if (this.options.rooms.isSpectator(matchID, session.user.id)) {
        throw new ApiError(409, 'ALREADY_A_SPECTATOR');
      }
      if (playerForUser(metadata, session.user.id)) {
        throw new ApiError(409, 'SEAT_ALREADY_CLAIMED');
      }
      const playerID = input.playerID ?? findOpenSeat(metadata);
      if (playerID === undefined) throw new ApiError(409, 'MATCH_FULL');
      const player = metadata.players[Number(playerID)];
      if (!player) throw new ApiError(404, 'MATCH_NOT_FOUND');
      if (player.name) throw new ApiError(409, 'SEAT_ALREADY_CLAIMED');
      this.options.credentials.revokeSeat(matchID, playerID);
      const playerCredentials = this.issueSeatCredential(session, matchID, playerID);
      player.name = session.user.username;
      player.data = seatData(session, matchID, playerID);
      player.credentials = playerCredentials;
      if (room.preferredHostUserId === session.user.id) {
        room.hostUserId = session.user.id;
        delete room.preferredHostUserId;
      }
      touchMetadata(metadata);
      await resolveResult(this.options.db.setMetadata(matchID, metadata));
      return { playerID, playerCredentials };
    });
  }

  async reclaim(session: AuthenticatedSession, matchID: string) {
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const player = playerForUser(metadata, session.user.id);
      if (!player) throw new ApiError(403, 'FORBIDDEN');
      const playerID = String(player.id);
      const playerCredentials = this.issueSeatCredential(session, matchID, playerID);
      this.options.rooms.removeSpectator(matchID, session.user.id);
      player.name = session.user.username;
      player.data = seatData(session, matchID, playerID);
      player.credentials = playerCredentials;
      touchMetadata(metadata);
      await resolveResult(this.options.db.setMetadata(matchID, metadata));
      return {
        playerID,
        playerCredentials,
        playerName: session.user.username,
      };
    });
  }

  async leave(
    session: AuthenticatedSession,
    matchID: string,
    body: unknown,
  ): Promise<{}> {
    const input = parseBody(credentialSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
      if (room.startedAt !== null) throw new ApiError(409, 'ROLE_CHANGE_LOCKED');
      await assertSeatCredential(
        this.options.credentials,
        session,
        metadata,
        input.playerID,
        input.credentials,
      );
      const player = metadata.players[Number(input.playerID)];
      this.options.credentials.revokeSeat(matchID, input.playerID);
      delete player.name;
      delete player.credentials;
      delete player.data;
      delete player.isConnected;
      touchMetadata(metadata);
      if (room.hostUserId === session.user.id) {
        const nextHost = this.nextHost(metadata, matchID);
        if (nextHost) room.hostUserId = nextHost;
      }
      await this.persistOrDeleteEmpty(matchID, metadata);
      return {};
    });
  }

  async updateRoomSettings(
    session: AuthenticatedSession,
    matchID: string,
    body: unknown,
  ) {
    const input = parseBody(roomSettingsSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
      await this.removeExpiredSpectators(matchID, metadata);
      this.assertHost(room.hostUserId, session.user.id);
      if (room.startedAt !== null) throw new ApiError(409, 'MATCH_ALREADY_STARTED');
      if (!input.allowSpectators && room.spectators.size > 0) {
        if (!input.confirmRemoval) {
          throw new ApiError(409, 'SPECTATORS_CONFIRMATION_REQUIRED');
        }
        if (room.spectators.has(room.hostUserId)) {
          const nextHost = occupiedPlayers(metadata)
            .map((player) => (player.data as SeatMetadata | undefined)?.userId)
            .find((userId): userId is string => Boolean(userId));
          if (nextHost) room.hostUserId = nextHost;
        }
        this.options.rooms.clearSpectators(matchID);
      }
      this.options.rooms.setAllowSpectators(matchID, input.allowSpectators);
      if (!this.hasParticipants(metadata, matchID)) {
        await this.deleteMatch(matchID);
        return { deleted: true, removedSpectators: 0 };
      }
      return {
        deleted: false,
        removedSpectators: input.allowSpectators ? 0 : room.evictions.size,
      };
    });
  }

  async start(session: AuthenticatedSession, matchID: string) {
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
      this.assertHost(room.hostUserId, session.user.id);
      if (room.startedAt !== null) throw new ApiError(409, 'MATCH_ALREADY_STARTED');
      if (occupiedPlayers(metadata).length !== Object.keys(metadata.players).length) {
        throw new ApiError(409, 'PLAYER_SEATS_NOT_FULL');
      }
      const players = occupiedPlayers(metadata).map((player) => ({
        userId: (player.data as SeatMetadata).userId,
        playerID: String(player.id),
      }));
      return { startedAt: this.options.rooms.start(matchID, players) };
    });
  }

  async switchToSpectator(
    session: AuthenticatedSession,
    matchID: string,
    body: unknown,
  ) {
    const input = parseBody(credentialSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
      await this.removeExpiredSpectators(matchID, metadata);
      if (room.startedAt !== null) throw new ApiError(409, 'ROLE_CHANGE_LOCKED');
      if (!room.allowSpectators) throw new ApiError(409, 'SPECTATING_DISABLED');
      await assertSeatCredential(
        this.options.credentials,
        session,
        metadata,
        input.playerID,
        input.credentials,
      );
      this.options.rooms.addSpectator(matchID, {
        userId: session.user.id,
        username: session.user.username,
      });
      const player = metadata.players[Number(input.playerID)];
      this.options.credentials.revokeSeat(matchID, input.playerID);
      delete player.name;
      delete player.credentials;
      delete player.data;
      delete player.isConnected;
      touchMetadata(metadata);
      await resolveResult(this.options.db.setMetadata(matchID, metadata));
      return { viewerName: session.user.username };
    });
  }

  async switchToPlayer(
    session: AuthenticatedSession,
    matchID: string,
    body: unknown,
  ) {
    const input = parseBody(switchToPlayerSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
      if (room.startedAt !== null) throw new ApiError(409, 'ROLE_CHANGE_LOCKED');
      if (!this.options.rooms.isSpectator(matchID, session.user.id)) {
        throw new ApiError(403, 'NOT_A_SPECTATOR');
      }
      if (playerForUser(metadata, session.user.id)) {
        throw new ApiError(409, 'ALREADY_A_PLAYER');
      }
      const playerID = input.playerID ?? findOpenSeat(metadata);
      if (playerID === undefined) throw new ApiError(409, 'MATCH_FULL');
      const player = metadata.players[Number(playerID)];
      if (!player || player.name) throw new ApiError(409, 'SEAT_ALREADY_CLAIMED');
      this.options.credentials.revokeSeat(matchID, playerID);
      const playerCredentials = this.issueSeatCredential(session, matchID, playerID);
      this.options.rooms.removeSpectator(matchID, session.user.id);
      player.name = session.user.username;
      player.data = seatData(session, matchID, playerID);
      player.credentials = playerCredentials;
      touchMetadata(metadata);
      await resolveResult(this.options.db.setMetadata(matchID, metadata));
      return {
        playerID,
        playerCredentials,
        playerName: session.user.username,
      };
    });
  }

  async spectate(
    session: AuthenticatedSession,
    matchID: string,
    body: unknown,
  ) {
    const input = parseBody(spectatorJoinSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
      await this.removeExpiredSpectators(matchID, metadata);
      if (playerForUser(metadata, session.user.id)) {
        throw new ApiError(409, 'ALREADY_A_PLAYER');
      }
      const existing = this.options.rooms.isSpectator(matchID, session.user.id);
      if (!existing && room.startedAt === null) {
        const previous = input.previousMatchID
          ? this.options.rooms.get(input.previousMatchID)
          : undefined;
        const validRematchAdmission =
          input.previousMatchID === room.previousMatchID &&
          previous?.spectators.has(session.user.id);
        if (!validRematchAdmission) throw new ApiError(409, 'MATCH_NOT_STARTED');
      }
      if (!room.allowSpectators) throw new ApiError(409, 'SPECTATING_DISABLED');
      this.options.rooms.addSpectator(matchID, {
        userId: session.user.id,
        username: session.user.username,
      });
      return { viewerName: session.user.username };
    });
  }

  async leaveSpectator(session: AuthenticatedSession, matchID: string): Promise<{}> {
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
      if (!this.options.rooms.removeSpectator(matchID, session.user.id)) {
        throw new ApiError(403, 'NOT_A_SPECTATOR');
      }
      if (room.hostUserId === session.user.id) {
        const nextHost = this.nextHost(metadata, matchID);
        if (nextHost) room.hostUserId = nextHost;
      }
      await this.persistOrDeleteEmpty(matchID, metadata);
      return {};
    });
  }

  async heartbeat(session: AuthenticatedSession, matchID: string): Promise<{}> {
    return withMatchLock(matchID, async () => {
      await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
      if (room.startedAt !== null) throw new ApiError(409, 'MATCH_ALREADY_STARTED');
      this.options.rooms.touchSpectator(matchID, session.user.id);
      return {};
    });
  }

  async issueGameAccess(
    session: AuthenticatedSession,
    matchID: string,
    body: unknown,
  ) {
    const input = parseBody(gameAccessSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
      if (room.startedAt === null) throw new ApiError(409, 'MATCH_NOT_STARTED');
      if (input.role === 'player') {
        await assertSeatCredential(
          this.options.credentials,
          session,
          metadata,
          input.playerID,
          input.credentials,
        );
        return this.options.accessTickets.issue(session, {
          matchID,
          role: 'player',
          playerID: input.playerID,
        });
      }
      if (!room.allowSpectators) throw new ApiError(409, 'SPECTATING_DISABLED');
      if (!room.spectators.has(session.user.id)) {
        throw new ApiError(403, 'NOT_A_SPECTATOR');
      }
      this.options.rooms.touchSpectator(matchID, session.user.id);
      return this.options.accessTickets.issue(session, {
        matchID,
        role: 'spectator',
      });
    });
  }

  async playAgain(
    session: AuthenticatedSession,
    matchID: string,
    body: unknown,
  ) {
    const input = parseBody(credentialSchema, body);
    return withMatchLock(matchID, async () => {
      const metadata = await fetchMetadata(this.options.db, matchID);
      const room = this.options.rooms.require(matchID);
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
      try {
        this.options.rooms.create({
          matchID: nextID,
          hostUserId: session.user.id,
          allowSpectators: room.allowSpectators,
          previousMatchID: matchID,
          preferredHostUserId: room.hostUserId,
        });
      } catch (caught) {
        await resolveResult(this.options.db.wipe(nextID));
        throw caught;
      }
      metadata.nextMatchID = nextID;
      touchMetadata(metadata);
      await resolveResult(this.options.db.setMetadata(matchID, metadata));
      return { nextMatchID: nextID };
    });
  }

  async updatePlayer(
    session: AuthenticatedSession,
    matchID: string,
    body: unknown,
  ): Promise<{}> {
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

  async expireSpectator(matchID: string, userId: string): Promise<void> {
    await withMatchLock(matchID, async () => {
      const room = this.options.rooms.get(matchID);
      if (!room) return;
      const spectator = room.spectators.get(userId);
      if (
        !spectator ||
        spectator.connections.size > 0 ||
        spectator.lastSeenAt + SPECTATOR_DISCONNECT_GRACE_MS > Date.now()
      ) {
        return;
      }
      const metadataResult = await resolveResult(
        this.options.db.fetch(matchID, { metadata: true }),
      );
      if (!metadataResult.metadata) {
        this.options.rooms.delete(matchID);
        return;
      }
      this.options.rooms.removeSpectator(matchID, userId);
      if (room.hostUserId === userId) {
        const nextHost = this.nextHost(metadataResult.metadata, matchID);
        if (nextHost) room.hostUserId = nextHost;
      }
      await this.persistOrDeleteEmpty(matchID, metadataResult.metadata);
    });
  }

  async expireInactivePlayer(matchID: string, playerID: string): Promise<void> {
    await withMatchLock(matchID, async () => {
      if (!this.options.rooms.isPlayerExpired(matchID, playerID)) return;
      const metadataResult = await resolveResult(
        this.options.db.fetch(matchID, { metadata: true }),
      );
      if (!metadataResult.metadata) {
        this.options.rooms.delete(matchID);
        this.options.credentials.revokeMatch(matchID);
        return;
      }
      if (!this.options.rooms.isPlayerExpired(matchID, playerID)) return;
      await this.deleteMatch(matchID);
    });
  }

  private publicMatch(
    session: AuthenticatedSession,
    matchID: string,
    metadata: MatchMetadata,
  ): RoomMatch {
    const room = this.options.rooms.require(matchID);
    const viewerPlayer = playerForUser(metadata, session.user.id);
    const viewerIsSpectator = room.spectators.has(session.user.id);
    const spectators = this.options.rooms.orderedSpectators(matchID);
    const hostPlayer = playerForUser(metadata, room.hostUserId);
    const hostSpectator = room.spectators.get(room.hostUserId);
    const nextRoom = metadata.nextMatchID
      ? this.options.rooms.get(metadata.nextMatchID)
      : undefined;
    return {
      matchID,
      gameName: metadata.gameName,
      players: Object.values(metadata.players).map((player) => {
        const data = player.data as SeatMetadata | undefined;
        return {
          id: Number(player.id),
          ...(player.name ? { name: player.name } : {}),
          ...(room.startedAt !== null && data
            ? {
                connectionStatus: this.options.rooms.playerConnectionStatus(
                  matchID,
                  String(player.id),
                ),
              }
            : {}),
          ...(data
            ? {
                data: {
                  avatarUrl: data.avatarUrl,
                  isHost: data.userId === room.hostUserId,
                  isViewer: data.userId === session.user.id,
                },
              }
            : {}),
        };
      }),
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      ...(metadata.unlisted !== undefined ? { unlisted: metadata.unlisted } : {}),
      ...(metadata.gameover !== undefined ? { gameover: metadata.gameover } : {}),
      ...(metadata.nextMatchID ? { nextMatchID: metadata.nextMatchID } : {}),
      room: {
        allowSpectators: room.allowSpectators,
        startedAt: room.startedAt,
        hostUsername: hostPlayer?.name ?? hostSpectator?.username ?? '',
        spectatorCount: spectators.length,
        spectatorCapacity: SPECTATOR_CAPACITY,
        spectators: spectators.map((spectator) => ({
          username: spectator.username,
          isHost: spectator.userId === room.hostUserId,
          isViewer: spectator.userId === session.user.id,
        })),
        nextMatch:
          metadata.nextMatchID && nextRoom
            ? {
                matchID: metadata.nextMatchID,
                allowSpectators: nextRoom.allowSpectators,
              }
            : null,
      },
      viewer: {
        role: viewerPlayer
          ? 'player'
          : viewerIsSpectator
            ? 'spectator'
            : 'none',
        ...(viewerPlayer ? { playerID: String(viewerPlayer.id) } : {}),
        isHost: room.hostUserId === session.user.id,
        ...(this.options.rooms.removalReason(matchID, session.user.id)
          ? {
              removalReason: this.options.rooms.removalReason(
                matchID,
                session.user.id,
              ),
            }
          : {}),
      },
    };
  }

  private issueSeatCredential(
    session: AuthenticatedSession,
    matchID: string,
    playerID: string,
  ): string {
    return this.options.credentials.issue({
      userId: session.user.id,
      sessionId: session.id,
      matchId: matchID,
      playerId: playerID,
      sessionExpiresAt: session.expiresAt,
    });
  }

  private assertHost(hostUserId: string, userId: string): void {
    if (hostUserId !== userId) throw new ApiError(403, 'NOT_ROOM_HOST');
  }

  private nextHost(metadata: MatchMetadata, matchID: string): string | undefined {
    const playerHost = occupiedPlayers(metadata)
      .map((player) => (player.data as SeatMetadata | undefined)?.userId)
      .find((userId): userId is string => Boolean(userId));
    return (
      playerHost ?? this.options.rooms.orderedSpectators(matchID)[0]?.userId
    );
  }

  private hasParticipants(metadata: MatchMetadata, matchID: string): boolean {
    return (
      occupiedPlayers(metadata).length > 0 ||
      this.options.rooms.require(matchID).spectators.size > 0
    );
  }

  private async persistOrDeleteEmpty(
    matchID: string,
    metadata: MatchMetadata,
  ): Promise<void> {
    if (this.hasParticipants(metadata, matchID)) {
      await resolveResult(this.options.db.setMetadata(matchID, metadata));
    } else {
      await this.deleteMatch(matchID);
    }
  }

  private async deleteMatch(matchID: string): Promise<void> {
    this.options.credentials.revokeMatch(matchID);
    this.options.rooms.delete(matchID);
    await resolveResult(this.options.db.wipe(matchID));
  }

  private async removeExpiredSpectators(
    matchID: string,
    metadata: MatchMetadata,
  ): Promise<void> {
    const room = this.options.rooms.require(matchID);
    for (const userId of this.options.rooms.expiredSpectatorIDs(matchID)) {
      this.options.rooms.removeSpectator(matchID, userId);
      if (room.hostUserId === userId) {
        const nextHost = this.nextHost(metadata, matchID);
        if (nextHost) room.hostUserId = nextHost;
      }
    }
  }
}
