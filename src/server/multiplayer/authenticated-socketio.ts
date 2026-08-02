import type { Game, Server as BoardgameServer } from 'boardgame.io';
import { SocketIO as BoardgameSocketIO } from 'boardgame.io/dist/cjs/server.js';
import type { Socket } from 'socket.io';

import type { GameAccessTicketPayload, GameAccessTicketService } from './access-tickets.js';
import type { SeatMetadata } from './credentials.js';
import type { MatchDatabase, MatchMetadata } from './lobby.js';
import type { RoomRegistry } from './room-registry.js';

interface SocketData {
  access?: GameAccessTicketPayload;
  accessTicket?: string;
  accessCheck?: ReturnType<typeof setInterval>;
}

type AuthenticatedSocket = Socket & { data: SocketData };

export class AuthenticatedSocketIO extends BoardgameSocketIO {
  private readonly socketsBySession = new Map<string, Set<AuthenticatedSocket>>();

  constructor(
    private readonly dependencies: {
      db: MatchDatabase;
      rooms: RoomRegistry;
      tickets: GameAccessTicketService;
    },
  ) {
    super();
    this.dependencies.rooms.setDeletionHandler((matchID) =>
      this.disconnectMatch(matchID),
    );
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
        const payload = await this.dependencies.tickets.verify(accessTicket);
        if (!payload || !(await this.isAuthorized(payload))) {
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
        const sessionSockets = this.socketsBySession.get(access.sid) ?? new Set();
        sessionSockets.add(socket);
        this.socketsBySession.set(access.sid, sessionSockets);

        socket.use(async (packet, next) => {
          const refreshed = await this.dependencies.tickets.verify(
            socket.data.accessTicket,
          );
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
                  refreshed.uid,
                  socket.id,
                );
              } else {
                this.dependencies.rooms.connectPlayer(
                  refreshed.mid,
                  refreshed.uid,
                  refreshed.pid!,
                  socket.id,
                );
              }
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
            });
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
          }
          if (current) {
            const sockets = this.socketsBySession.get(current.sid);
            sockets?.delete(socket);
            if (sockets?.size === 0) this.socketsBySession.delete(current.sid);
          }
        });
      });
    }
  }

  disconnectSession(sessionID: string): void {
    for (const socket of this.socketsBySession.get(sessionID) ?? []) {
      socket.disconnect(true);
    }
    this.socketsBySession.delete(sessionID);
  }

  disconnectUser(userID: string): void {
    for (const sockets of this.socketsBySession.values()) {
      for (const socket of sockets) {
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
  }

  private async isAuthorized(payload: GameAccessTicketPayload): Promise<boolean> {
    const room = this.dependencies.rooms.get(payload.mid);
    if (!room || room.startedAt === null) return false;
    if (payload.role === 'spectator') {
      return room.allowSpectators && room.spectators.has(payload.uid);
    }
    const result = await Promise.resolve(
      this.dependencies.db.fetch(payload.mid, { metadata: true }),
    );
    const metadata = result.metadata as MatchMetadata | undefined;
    const player = payload.pid
      ? metadata?.players[Number(payload.pid)]
      : undefined;
    const data = player?.data as SeatMetadata | undefined;
    return Boolean(
      player &&
        data?.userId === payload.uid &&
        data.matchId === payload.mid &&
        data.playerId === payload.pid,
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
      if (payload.role === 'spectator') return false;
      const [, , matchID, playerID] = args;
      return matchID === payload.mid && playerID === payload.pid;
    }
    if (event === 'chat') {
      if (payload.role === 'spectator') return false;
      const [matchID, message] = args as [unknown, { sender?: unknown } | undefined];
      return matchID === payload.mid && message?.sender === payload.pid;
    }
    return false;
  }
}
