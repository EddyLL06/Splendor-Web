/// <reference types="node" />

import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { io as createSocket, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SplendorGame } from '../src/game/SplendorGame.js';
import type { SplendorState } from '../src/shared/types/game.js';
import type { RoomMatch } from '../src/shared/types/room.js';
import {
  createTestApplication,
  mutate,
  registerAccount,
  type RegisteredAccount,
  type TestApplication,
} from './server-test-kit.js';

type GameClient = ReturnType<typeof Client<SplendorState>>;

describe('room event channel', () => {
  let environment: TestApplication;
  let alice: RegisteredAccount;
  let bob: RegisteredAccount;
  let carol: RegisteredAccount;
  let matchID: string;
  let aliceSeat: string;
  const sockets: Socket[] = [];
  const clients: GameClient[] = [];

  beforeAll(async () => {
    environment = await createTestApplication('room-events');
    await environment.app.start();
    alice = await registerAccount(environment, 'RoomAlice');
    bob = await registerAccount(environment, 'RoomBob');
    carol = await registerAccount(environment, 'RoomCarol');
    const created = await alice.agent
      .post(`/games/${SplendorGame.name}/create`)
      .set(mutate(alice))
      .send({ numPlayers: 3, unlisted: false })
      .expect(200);
    matchID = created.body.matchID as string;
    const aliceJoined = await alice.agent
      .post(`/games/${SplendorGame.name}/${matchID}/join`)
      .set(mutate(alice))
      .send({ playerID: '0', playerName: 'RoomAlice' })
      .expect(200);
    aliceSeat = aliceJoined.body.playerCredentials as string;
    await bob.agent
      .post(`/games/${SplendorGame.name}/${matchID}/join`)
      .set(mutate(bob))
      .send({ playerID: '1', playerName: 'RoomBob' })
      .expect(200);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const client of clients) client.stop();
    await environment.cleanup();
  });

  const openRoomSocket = async (account: RegisteredAccount): Promise<Socket> => {
    const issued = await account.agent
      .post(`/api/matches/${matchID}/room-ticket`)
      .set(mutate(account))
      .send({})
      .expect(200);
    const socket = createSocket(
      `http://localhost:${environment.config.port}/room`,
      {
        transports: ['websocket'],
        auth: { roomTicket: issued.body.roomTicket },
      },
    );
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', (error: Error) => reject(error));
    });
    return socket;
  };

  const waitForUpdate = (
    socket: Socket,
    predicate: (room: RoomMatch) => boolean,
  ): Promise<RoomMatch> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for room:update.')),
        5000,
      );
      const handler = (payload: { version?: number; room: RoomMatch }) => {
        if (predicate(payload.room)) {
          clearTimeout(timer);
          socket.off('room:update', handler);
          resolve(payload.room);
        }
      };
      socket.on('room:update', handler);
    });

  it('pushes room changes to a connected room socket without polling', async () => {
    const aliceRoom = await openRoomSocket(alice);

    const botAdd = waitForUpdate(
      aliceRoom,
      (room) => room.players[2]?.kind === 'bot',
    );
    await alice.agent
      .post(`/api/matches/${matchID}/bots`)
      .set(mutate(alice))
      .send({ playerID: '2', difficulty: 'easy' })
      .expect(200);
    const afterAdd = await botAdd;
    expect(afterAdd.players[2]).toMatchObject({
      kind: 'bot',
      difficulty: 'easy',
    });

    const botUpdate = waitForUpdate(
      aliceRoom,
      (room) => room.players[2]?.difficulty === 'hard',
    );
    await alice.agent
      .patch(`/api/matches/${matchID}/bots/2`)
      .set(mutate(alice))
      .send({ playerID: '2', difficulty: 'hard' })
      .expect(200);
    const afterUpdate = await botUpdate;
    expect(afterUpdate.players[2].difficulty).toBe('hard');

    const startUpdate = waitForUpdate(
      aliceRoom,
      (room) => room.room.startedAt !== null,
    );
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(200);
    const afterStart = await startUpdate;
    expect(afterStart.room.startedAt).toEqual(expect.any(Number));

    const spectatorJoin = waitForUpdate(
      aliceRoom,
      (room) => room.room.spectatorCount === 1,
    );
    await carol.agent
      .post(`/api/matches/${matchID}/spectators/join`)
      .set(mutate(carol))
      .send({})
      .expect(200);
    const afterSpectate = await spectatorJoin;
    expect(
      afterSpectate.room.spectators.map((spectator) => spectator.username),
    ).toContain(carol.username);

    const onlineUpdate = waitForUpdate(
      aliceRoom,
      (room) => room.players[0]?.connectionStatus === 'online',
    );
    const access = await alice.agent
      .post(`/api/matches/${matchID}/access-ticket`)
      .set(mutate(alice))
      .send({
        role: 'player',
        playerID: '0',
        credentials: aliceSeat,
      })
      .expect(200);
    const client = Client<SplendorState>({
      game: SplendorGame,
      matchID,
      playerID: '0',
      credentials: aliceSeat,
      multiplayer: SocketIO({
        server: `http://localhost:${environment.config.port}`,
        socketOpts: {
          auth: { accessTicket: access.body.accessTicket },
          transports: ['websocket'],
        },
      }),
    });
    clients.push(client);
    client.start();
    const afterOnline = await onlineUpdate;
    expect(afterOnline.players[0].connectionStatus).toBe('online');
  });

  it('rejects room tickets for outsiders and rejects room tickets on the game namespace', async () => {
    const dave = await registerAccount(environment, 'RoomDave');
    await dave.agent
      .post(`/api/matches/${matchID}/room-ticket`)
      .set(mutate(dave))
      .send({})
      .expect(403, { error: { code: 'NOT_IN_ROOM' } });

    const issued = await alice.agent
      .post(`/api/matches/${matchID}/room-ticket`)
      .set(mutate(alice))
      .send({})
      .expect(200);

    const gameSocket = createSocket(
      `http://localhost:${environment.config.port}/${SplendorGame.name}`,
      {
        transports: ['websocket'],
        auth: { accessTicket: issued.body.roomTicket },
      },
    );
    sockets.push(gameSocket);
    await new Promise<void>((resolve) => {
      gameSocket.once('connect_error', (error: Error) => {
        expect(error.message).toBe('GAME_ACCESS_INVALID');
        gameSocket.close();
        resolve();
      });
    });

    const access = await alice.agent
      .post(`/api/matches/${matchID}/access-ticket`)
      .set(mutate(alice))
      .send({
        role: 'player',
        playerID: '0',
        credentials: aliceSeat,
      })
      .expect(200);
    const roomSocket = createSocket(
      `http://localhost:${environment.config.port}/room`,
      {
        transports: ['websocket'],
        auth: { roomTicket: access.body.accessTicket },
      },
    );
    sockets.push(roomSocket);
    await new Promise<void>((resolve) => {
      roomSocket.once('connect_error', (error: Error) => {
        expect(error.message).toBe('ROOM_ACCESS_INVALID');
        roomSocket.close();
        resolve();
      });
    });
  });
});
