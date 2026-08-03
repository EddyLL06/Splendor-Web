import type { Game, Server as BoardgameServer } from 'boardgame.io';
import { SocketIO as BoardgameSocketIO } from 'boardgame.io/dist/cjs/server.js';
import type { Socket } from 'socket.io';

import type { GameAccessTicketPayload, GameAccessTicketService } from './access-tickets.js';
import type { SeatMetadata } from './credentials.js';
import {
  isBotSeatMetadata,
  type BotSeatMetadata,
} from '../ai/bot-seat.js';
import type { MatchDatabase, MatchMetadata } from './lobby.js';
import type { RoomRegistry } from './room-registry.js';
import type { RoomMatch } from '../../shared/types/room.js';

interface SocketData {
  access?: GameAccessTicketPayload;
  accessTicket?: string;
  accessCheck?: ReturnType<typeof setInterval>;
}

type AuthenticatedSocket = Socket & { data: SocketData };

export class AuthenticatedSocketIO extends BoardgameSocketIO {
  private readonly socketsBySession = new Map<string, Set<AuthenticatedSocket>>();
  private readonly socketsByMatch = new Map<string, Set<AuthenticatedSocket>>();
  private snapshotProvider?: (access: GameAccessTicketPayload) => Promise<RoomMatch>;

  constructor(
    private readonly dependencies: {
      db: MatchDatabase;
      rooms: RoomRegistry;
      tickets: GameAccessTicketService;
    },
  ) {
    // boardgame.io's SocketOpts type marks socket.io ServerOptions as fully
    // required; only the fields we set are applied at runtime.
    super({
      socketOpts: { transports: ['websocket'] } as unknown as import('socket.io').ServerOptions,
    });
    this.dependencies.rooms.setDeletionHandler((matchID) =>
      this.disconnectMatch(matchID),
    );
  }

  setRoomSnapshotProvider(
    provider: (access: GameAccessTicketPayload) => Promise<RoomMatch>,
  ): void {
    this.snapshotProvider = provider;
  }

  override init(
    app: BoardgameServer.App & { _io?: import('socket.io').Server },
    games: Game[],
    origins?: Parameters<InstanceType<typeof BoardgameSocketIO>['init']>[2],
  ): void {
    super.init(app, games, origins);
    for (const game of games) {
      const namespace = app._io?.of(game.name!);
      if (!namespace) throw new Error('Socket.IO namespace was not initialized.');
      namespace.use(async (rawSocket, next) => {
        const socket = rawSocket as AuthenticatedSocket;
        const accessTicket = socket.handshake.auth?.accessTicket;
        let payload: GameAccessTicketPayload | null = null;
        try {
          payload = await this.dependencies.tickets.verify(accessTicket);
        } catch {
          next(new Error('GAME_ACCESS_INVALID'));
          return;
        }
        if (
          !payload ||
          payload.role === 'room' ||
          !(await this.isAuthorized(payload))
        ) {
          next(new Error('GAME_ACCESS_INVALID'));
          return;
        }
        socket.data.access = payload;
        socket.data.accessTicket = accessTicket;
        next();
      });
      namespace.on('connection', (rawSocket) => {
        const socket = rawSocket as AuthenticatedSocket;
        const access = socket.data.access;
        if (!access) {
          socket.disconnect(true);
          return;
        }
        const sessionKey = access.sid ?? `bot:${access.bid}`;
        const sessionSockets = this.socketsBySession.get(sessionKey) ?? new Set();
        sessionSockets.add(socket);
        this.socketsBySession.set(sessionKey, sessionSockets);

        socket.use(async (packet, next) => {
          let refreshed: GameAccessTicketPayload | null = null;
          try {
            refreshed = await this.dependencies.tickets.verify(
              socket.data.accessTicket,
            );
          } catch {
            next(new Error('GAME_ACCESS_INVALID'));
            socket.disconnect(true);
            return;
          }
          if (!refreshed || !(await this.isAuthorized(refreshed))) {
            next(new Error('GAME_ACCESS_INVALID'));
            socket.disconnect(true);
            return;
          }
          if (!this.packetMatchesAccess(packet, refreshed)) {
            next(new Error('GAME_ACCESS_INVALID'));
            return;
          }
          if (packet[0] === 'sync') {
            try {
              if (refreshed.role === 'spectator') {
                this.dependencies.rooms.connectSpectator(
                  refreshed.mid,
                  refreshed.uid!,
                  socket.id,
                );
              } else if (refreshed.role === 'bot') {
                this.dependencies.rooms.connectBotPlayer(
                  refreshed.mid,
                  refreshed.bid!,
                  refreshed.pid!,
                  socket.id,
                );
              } else {
                this.dependencies.rooms.connectPlayer(
                  refreshed.mid,
                  refreshed.uid!,
                  refreshed.pid!,
                  socket.id,
                );
              }
              this.broadcastMatch(refreshed.mid);
            } catch {
              next(new Error('GAME_ACCESS_INVALID'));
              socket.disconnect(true);
              return;
            }
          }
          next();
        });

        socket.data.accessCheck = setInterval(() => {
          void this.dependencies.tickets
            .verify(socket.data.accessTicket)
            .then(async (payload) => {
              if (!payload || !(await this.isAuthorized(payload))) {
                socket.disconnect(true);
              }
            })
            .catch(() => undefined);
        }, 5_000);
        socket.data.accessCheck.unref?.();

        socket.on('disconnect', () => {
          if (socket.data.accessCheck) clearInterval(socket.data.accessCheck);
          const current = socket.data.access;
          if (current?.role === 'spectator') {
            this.dependencies.rooms.disconnectSpectator(
              current.mid,
              current.uid,
              socket.id,
            );
          } else if (current?.role === 'player' && current.pid) {
            this.dependencies.rooms.disconnectPlayer(
              current.mid,
              current.pid,
              socket.id,
            );
          } else if (current?.role === 'bot' && current.pid) {
            this.dependencies.rooms.disconnectPlayer(
              current.mid,
              current.pid,
              socket.id,
            );
          }
          if (current) this.broadcastMatch(current.mid);
          if (current) {
            const sessionKey = current.sid ?? `bot:${current.bid}`;
            const sockets = this.socketsBySession.get(sessionKey);
            sockets?.delete(socket);
            if (sockets?.size === 0) this.socketsBySession.delete(sessionKey);
          }
        });
      });
    }

    const roomNamespace = app._io?.of('/room');
    if (!roomNamespace) {
      throw new Error('Socket.IO room namespace was not initialized.');
    }
    roomNamespace.use(async (rawSocket, next) => {
      const socket = rawSocket as AuthenticatedSocket;
      const roomTicket = socket.handshake.auth?.roomTicket;
      let payload: GameAccessTicketPayload | null = null;
      try {
        payload = await this.dependencies.tickets.verify(roomTicket);
      } catch {
        next(new Error('ROOM_ACCESS_INVALID'));
        return;
      }
      if (
        !payload ||
        payload.role !== 'room' ||
        !(await this.isAuthorizedRoom(payload))
      ) {
        next(new Error('ROOM_ACCESS_INVALID'));
        return;
      }
      socket.data.access = payload;
      socket.data.accessTicket = roomTicket;
      next();
    });
    roomNamespace.on('connection', (rawSocket) => {
      const socket = rawSocket as AuthenticatedSocket;
      const access = socket.data.access;
      if (!access || access.role !== 'room') {
        socket.disconnect(true);
        return;
      }
      const matchSockets = this.socketsByMatch.get(access.mid) ?? new Set();
      matchSockets.add(socket);
      this.socketsByMatch.set(access.mid, matchSockets);

      // A live room socket doubles as spectator presence so no HTTP
      // heartbeat is needed while the channel is open.
      if (this.dependencies.rooms.get(access.mid)?.spectators.has(access.uid)) {
        try {
          this.dependencies.rooms.connectSpectator(
            access.mid,
            access.uid,
            socket.id,
          );
        } catch {
          // The spectator may have been removed between the checks.
        }
      }

      socket.data.accessCheck = setInterval(() => {
        void this.dependencies.tickets
          .verify(socket.data.accessTicket)
          .then(async (payload) => {
            if (
              !payload ||
              payload.role !== 'room' ||
              !(await this.isAuthorizedRoom(payload))
            ) {
              socket.disconnect(true);
            }
          })
          .catch(() => undefined);
      }, 5_000);
      socket.data.accessCheck.unref?.();

      socket.on('disconnect', () => {
        if (socket.data.accessCheck) clearInterval(socket.data.accessCheck);
        const current = socket.data.access;
        if (current?.role === 'room') {
          if (this.dependencies.rooms.get(current.mid)?.spectators.has(current.uid)) {
            this.dependencies.rooms.disconnectSpectator(
              current.mid,
              current.uid,
              socket.id,
            );
          }
          const sockets = this.socketsByMatch.get(current.mid);
          sockets?.delete(socket);
          if (sockets?.size === 0) this.socketsByMatch.delete(current.mid);
        }
      });
    });
  }

  disconnectSession(sessionID: string): void {
    for (const socket of this.socketsBySession.get(sessionID) ?? []) {
      socket.disconnect(true);
    }
    this.socketsBySession.delete(sessionID);
    for (const sockets of this.socketsByMatch.values()) {
      for (const socket of [...sockets]) {
        if (socket.data.access?.sid === sessionID) socket.disconnect(true);
      }
    }
  }

  disconnectUser(userID: string): void {
    for (const sockets of this.socketsBySession.values()) {
      for (const socket of sockets) {
        if (socket.data.access?.uid === userID) socket.disconnect(true);
      }
    }
    for (const sockets of this.socketsByMatch.values()) {
      for (const socket of [...sockets]) {
        if (socket.data.access?.uid === userID) socket.disconnect(true);
      }
    }
  }

  disconnectMatch(matchID: string): void {
    for (const sockets of this.socketsBySession.values()) {
      for (const socket of [...sockets]) {
        if (socket.data.access?.mid === matchID) socket.disconnect(true);
      }
    }
    for (const socket of this.socketsByMatch.get(matchID) ?? []) {
      socket.disconnect(true);
    }
    this.socketsByMatch.delete(matchID);
  }

  /**
   * Pushes the current public room snapshot to every live /room socket for
   * the match. Each socket receives the viewer-specific projection for its
   * own user.
   */
  broadcastMatch(matchID: string): void {
    const sockets = this.socketsByMatch.get(matchID);
    if (!sockets || sockets.size === 0 || !this.snapshotProvider) return;
    for (const socket of sockets) {
      const access = socket.data.access;
      if (!access) continue;
      void this.snapshotProvider(access)
        .then((room) => {
          if (socket.connected) {
            socket.emit('room:update', { version: Date.now(), room });
          }
        })
        .catch((error: unknown) => {
          if (process.env.NODE_ENV !== 'production') {
            console.error('Room broadcast failed:', error);
          }
        });
    }
  }

  private async isAuthorizedRoom(
    payload: GameAccessTicketPayload,
  ): Promise<boolean> {
    if (payload.role !== 'room') return false;
    const room = this.dependencies.rooms.get(payload.mid);
    if (!room) return false;
    if (room.spectators.has(payload.uid!)) return true;
    const result = await Promise.resolve(
      this.dependencies.db.fetch(payload.mid, { metadata: true }),
    );
    const metadata = result.metadata as MatchMetadata | undefined;
    return Boolean(
      metadata &&
        Object.values(metadata.players).some((player) => {
          const data = player.data as SeatMetadata | BotSeatMetadata | undefined;
          return !isBotSeatMetadata(data) && data?.userId === payload.uid;
        }),
    );
  }

  private async isAuthorized(payload: GameAccessTicketPayload): Promise<boolean> {
    const room = this.dependencies.rooms.get(payload.mid);
    if (!room || room.startedAt === null) return false;
    if (payload.role === 'bot') {
      const result = await Promise.resolve(
        this.dependencies.db.fetch(payload.mid, { metadata: true }),
      );
      const metadata = result.metadata as MatchMetadata | undefined;
      const player = payload.pid
        ? metadata?.players[Number(payload.pid)]
        : undefined;
      const data = player?.data as SeatMetadata | BotSeatMetadata | undefined;
      if (!isBotSeatMetadata(data)) return false;
      return (
        data.botId === payload.bid && data.playerId === payload.pid
      );
    }
    if (payload.role === 'spectator') {
      return room.allowSpectators && room.spectators.has(payload.uid!);
    }
    const result = await Promise.resolve(
      this.dependencies.db.fetch(payload.mid, { metadata: true }),
    );
    const metadata = result.metadata as MatchMetadata | undefined;
    const player = payload.pid
      ? metadata?.players[Number(payload.pid)]
      : undefined;
    const data = player?.data as SeatMetadata | undefined;
    if (!player || !data) return false;
    return (
      data.userId === payload.uid &&
      data.matchId === payload.mid &&
      data.playerId === payload.pid
    );
  }

  private packetMatchesAccess(
    packet: Parameters<Parameters<AuthenticatedSocket['use']>[0]>[0],
    payload: GameAccessTicketPayload,
  ): boolean {
    const [event, ...args] = packet;
    if (event === 'sync') {
      const [matchID, playerID] = args;
      return (
        matchID === payload.mid &&
        (payload.role === 'spectator'
          ? playerID === null || playerID === undefined
          : playerID === payload.pid)
      );
    }
    if (event === 'update') {
      if (payload.role !== 'player' && payload.role !== 'bot') return false;
      const [, , matchID, playerID] = args;
      return matchID === payload.mid && playerID === payload.pid;
    }
    if (event === 'chat') {
      if (payload.role !== 'player') return false;
      const [matchID, message] = args as [unknown, { sender?: unknown } | undefined];
      return matchID === payload.mid && message?.sender === payload.pid;
    }
    return false;
  }
}
