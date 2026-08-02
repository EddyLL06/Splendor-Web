import { ApiError } from '../errors.js';
import { SPECTATOR_CAPACITY } from '../../shared/types/room.js';

export const SPECTATOR_DISCONNECT_GRACE_MS = 10_000;
export const PLAYER_CONNECTION_TOLERANCE_MS = 15_000;
export const PLAYER_ABANDON_TIMEOUT_MS = 5 * 60_000;

export interface SpectatorMembership {
  userId: string;
  username: string;
  joinedAt: number;
  sequence: number;
  lastSeenAt: number;
  connections: Set<string>;
  expirationTimer?: ReturnType<typeof setTimeout>;
}

export interface PlayerPresence {
  userId: string;
  playerID: string;
  connections: Set<string>;
  disconnectedAt: number | null;
  expirationTimer?: ReturnType<typeof setTimeout>;
}

export interface MatchRoom {
  matchID: string;
  hostUserId: string;
  allowSpectators: boolean;
  startedAt: number | null;
  spectators: Map<string, SpectatorMembership>;
  players: Map<string, PlayerPresence>;
  evictions: Map<string, { reason: 'spectating-disabled'; expiresAt: number }>;
  previousMatchID?: string;
  preferredHostUserId?: string;
}

type ExpirationHandler = (matchID: string, userId: string) => void | Promise<void>;
type PlayerExpirationHandler = (
  matchID: string,
  playerID: string,
  userId: string,
) => void | Promise<void>;
type DeletionHandler = (matchID: string) => void;

export class RoomRegistry {
  private readonly rooms = new Map<string, MatchRoom>();
  private sequence = 0;
  private expirationHandler: ExpirationHandler = (matchID, userId) => {
    this.removeSpectator(matchID, userId);
  };
  private playerExpirationHandler: PlayerExpirationHandler = () => undefined;
  private deletionHandler: DeletionHandler = () => undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  setExpirationHandler(handler: ExpirationHandler): void {
    this.expirationHandler = handler;
  }

  setPlayerExpirationHandler(handler: PlayerExpirationHandler): void {
    this.playerExpirationHandler = handler;
  }

  setDeletionHandler(handler: DeletionHandler): void {
    this.deletionHandler = handler;
  }

  create(input: {
    matchID: string;
    hostUserId: string;
    allowSpectators?: boolean;
    previousMatchID?: string;
    preferredHostUserId?: string;
  }): MatchRoom {
    if (this.rooms.has(input.matchID)) throw new Error('Room already exists.');
    const room: MatchRoom = {
      matchID: input.matchID,
      hostUserId: input.hostUserId,
      allowSpectators: input.allowSpectators ?? true,
      startedAt: null,
      spectators: new Map(),
      players: new Map(),
      evictions: new Map(),
      previousMatchID: input.previousMatchID,
      preferredHostUserId: input.preferredHostUserId,
    };
    this.rooms.set(input.matchID, room);
    return room;
  }

  get(matchID: string): MatchRoom | undefined {
    return this.rooms.get(matchID);
  }

  require(matchID: string): MatchRoom {
    const room = this.rooms.get(matchID);
    if (!room) throw new ApiError(404, 'MATCH_NOT_FOUND');
    return room;
  }

  delete(matchID: string): void {
    const room = this.rooms.get(matchID);
    if (!room) return;
    for (const spectator of room.spectators.values()) {
      if (spectator.expirationTimer) clearTimeout(spectator.expirationTimer);
    }
    for (const player of room.players.values()) {
      if (player.expirationTimer) clearTimeout(player.expirationTimer);
    }
    this.rooms.delete(matchID);
    this.deletionHandler(matchID);
  }

  setHost(matchID: string, userId: string): void {
    this.require(matchID).hostUserId = userId;
  }

  setAllowSpectators(matchID: string, allowed: boolean): void {
    this.require(matchID).allowSpectators = allowed;
  }

  start(
    matchID: string,
    players: Array<{ userId: string; playerID: string }>,
  ): number {
    const room = this.require(matchID);
    if (room.startedAt !== null) throw new ApiError(409, 'MATCH_ALREADY_STARTED');
    room.startedAt = this.now();
    room.players.clear();
    for (const player of players) {
      const presence: PlayerPresence = {
        ...player,
        connections: new Set(),
        disconnectedAt: room.startedAt,
      };
      room.players.set(player.playerID, presence);
      this.schedulePlayerExpiration(room, presence);
    }
    return room.startedAt;
  }

  connectPlayer(
    matchID: string,
    userId: string,
    playerID: string,
    socketID: string,
  ): void {
    const room = this.require(matchID);
    const player = room.players.get(playerID);
    if (!player || player.userId !== userId) {
      throw new ApiError(403, 'GAME_ACCESS_INVALID');
    }
    if (player.expirationTimer) clearTimeout(player.expirationTimer);
    player.expirationTimer = undefined;
    player.disconnectedAt = null;
    player.connections.add(socketID);
  }

  disconnectPlayer(matchID: string, playerID: string, socketID: string): void {
    const room = this.rooms.get(matchID);
    const player = room?.players.get(playerID);
    if (!room || !player) return;
    player.connections.delete(socketID);
    if (player.connections.size === 0 && player.disconnectedAt === null) {
      player.disconnectedAt = this.now();
      this.schedulePlayerExpiration(room, player);
    }
  }

  playerConnectionStatus(
    matchID: string,
    playerID: string,
  ): 'online' | 'reconnecting' | 'offline' {
    const room = this.require(matchID);
    const player = room.players.get(playerID);
    if (player?.connections.size) return 'online';
    const disconnectedAt = player?.disconnectedAt ?? room.startedAt ?? this.now();
    return disconnectedAt + PLAYER_CONNECTION_TOLERANCE_MS > this.now()
      ? 'reconnecting'
      : 'offline';
  }

  isPlayerExpired(matchID: string, playerID: string): boolean {
    const room = this.rooms.get(matchID);
    const player = room?.players.get(playerID);
    return Boolean(
      player &&
        player.connections.size === 0 &&
        player.disconnectedAt !== null &&
        player.disconnectedAt + PLAYER_ABANDON_TIMEOUT_MS <= this.now(),
    );
  }

  isSpectator(matchID: string, userId: string): boolean {
    return this.rooms.get(matchID)?.spectators.has(userId) ?? false;
  }

  spectator(matchID: string, userId: string): SpectatorMembership | undefined {
    return this.rooms.get(matchID)?.spectators.get(userId);
  }

  orderedSpectators(matchID: string): SpectatorMembership[] {
    const room = this.require(matchID);
    return [...room.spectators.values()].sort(
      (left, right) => left.joinedAt - right.joinedAt || left.sequence - right.sequence,
    );
  }

  addSpectator(matchID: string, input: { userId: string; username: string }): SpectatorMembership {
    const room = this.require(matchID);
    const existing = room.spectators.get(input.userId);
    if (existing) {
      existing.username = input.username;
      this.touchSpectator(matchID, input.userId);
      return existing;
    }
    if (!room.allowSpectators) throw new ApiError(409, 'SPECTATING_DISABLED');
    if (room.spectators.size >= SPECTATOR_CAPACITY) {
      throw new ApiError(409, 'SPECTATOR_LIMIT_REACHED');
    }
    const timestamp = this.now();
    const spectator: SpectatorMembership = {
      userId: input.userId,
      username: input.username,
      joinedAt: timestamp,
      sequence: this.sequence++,
      lastSeenAt: timestamp,
      connections: new Set(),
    };
    room.evictions.delete(input.userId);
    room.spectators.set(input.userId, spectator);
    this.scheduleExpiration(room, spectator);
    if (room.preferredHostUserId === input.userId && room.startedAt === null) {
      room.hostUserId = input.userId;
      delete room.preferredHostUserId;
    }
    return spectator;
  }

  removeSpectator(matchID: string, userId: string): boolean {
    const room = this.rooms.get(matchID);
    const spectator = room?.spectators.get(userId);
    if (!room || !spectator) return false;
    if (spectator.expirationTimer) clearTimeout(spectator.expirationTimer);
    room.spectators.delete(userId);
    return true;
  }

  clearSpectators(matchID: string): string[] {
    const room = this.require(matchID);
    const removed = [...room.spectators.keys()];
    for (const userId of removed) {
      this.removeSpectator(matchID, userId);
      room.evictions.set(userId, {
        reason: 'spectating-disabled',
        expiresAt: this.now() + 60_000,
      });
    }
    return removed;
  }

  removalReason(matchID: string, userId: string): 'spectating-disabled' | undefined {
    const room = this.rooms.get(matchID);
    const eviction = room?.evictions.get(userId);
    if (!room || !eviction) return undefined;
    if (eviction.expiresAt <= this.now()) {
      room.evictions.delete(userId);
      return undefined;
    }
    return eviction.reason;
  }

  touchSpectator(matchID: string, userId: string): void {
    const room = this.require(matchID);
    const spectator = room.spectators.get(userId);
    if (!spectator) throw new ApiError(403, 'NOT_A_SPECTATOR');
    spectator.lastSeenAt = this.now();
    if (spectator.connections.size === 0) this.scheduleExpiration(room, spectator);
  }

  connectSpectator(matchID: string, userId: string, socketID: string): void {
    const room = this.require(matchID);
    const spectator = room.spectators.get(userId);
    if (!spectator) throw new ApiError(403, 'NOT_A_SPECTATOR');
    if (spectator.expirationTimer) clearTimeout(spectator.expirationTimer);
    spectator.expirationTimer = undefined;
    spectator.lastSeenAt = this.now();
    spectator.connections.add(socketID);
  }

  disconnectSpectator(matchID: string, userId: string, socketID: string): void {
    const room = this.rooms.get(matchID);
    const spectator = room?.spectators.get(userId);
    if (!room || !spectator) return;
    spectator.connections.delete(socketID);
    if (spectator.connections.size === 0) {
      spectator.lastSeenAt = this.now();
      this.scheduleExpiration(room, spectator);
    }
  }

  expiredSpectatorIDs(matchID: string): string[] {
    const room = this.require(matchID);
    const now = this.now();
    return [...room.spectators.values()]
      .filter(
        (spectator) =>
          spectator.connections.size === 0 &&
          spectator.lastSeenAt + SPECTATOR_DISCONNECT_GRACE_MS <= now,
      )
      .map((spectator) => spectator.userId);
  }

  private scheduleExpiration(room: MatchRoom, spectator: SpectatorMembership): void {
    if (spectator.expirationTimer) clearTimeout(spectator.expirationTimer);
    const delay = Math.max(
      0,
      spectator.lastSeenAt + SPECTATOR_DISCONNECT_GRACE_MS - this.now(),
    );
    spectator.expirationTimer = setTimeout(() => {
      spectator.expirationTimer = undefined;
      void this.expirationHandler(room.matchID, spectator.userId);
    }, delay);
    spectator.expirationTimer.unref?.();
  }

  private schedulePlayerExpiration(room: MatchRoom, player: PlayerPresence): void {
    if (player.expirationTimer) clearTimeout(player.expirationTimer);
    if (player.disconnectedAt === null) return;
    const delay = Math.max(
      0,
      player.disconnectedAt + PLAYER_ABANDON_TIMEOUT_MS - this.now(),
    );
    player.expirationTimer = setTimeout(() => {
      player.expirationTimer = undefined;
      void this.playerExpirationHandler(
        room.matchID,
        player.playerID,
        player.userId,
      );
    }, delay);
    player.expirationTimer.unref?.();
  }
}
