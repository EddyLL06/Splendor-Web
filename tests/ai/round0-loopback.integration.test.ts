/// <reference types="node" />

import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { io as createSocket, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SplendorGame } from '../../src/game/SplendorGame.js';
import type { SplendorState } from '../../src/shared/types/game.js';
import {
  createTestApplication,
  mutate,
  registerAccount,
  type RegisteredAccount,
  type TestApplication,
} from '../server-test-kit.js';

type GameClient = ReturnType<typeof Client<SplendorState>>;

const waitFor = async (predicate: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for multiplayer state.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('round 0: loopback bot move spike', () => {
  let environment: TestApplication;
  let alice: RegisteredAccount;
  let bob: RegisteredAccount;
  let matchID: string;
  let aliceSeat: { playerCredentials: string };
  let bobSeat: { playerCredentials: string };
  let aliceAccess: { accessTicket: string };
  let bobAccess: { accessTicket: string };
  const clients: GameClient[] = [];
  const rawSockets: Socket[] = [];

  const connectClient = (
    playerID: string,
    credentials: string,
    accessTicket: string,
  ): GameClient => {
    const client = Client<SplendorState>({
      game: SplendorGame,
      matchID,
      playerID,
      credentials,
      multiplayer: SocketIO({
        server: `http://localhost:${environment.config.port}`,
        socketOpts: { auth: { accessTicket } },
      }),
    });
    clients.push(client);
    client.start();
    return client;
  };

  const connectRawSocket = (
    playerID: string,
    accessTicket: string,
  ): Socket => {
    const socket = createSocket(
      `http://localhost:${environment.config.port}/${SplendorGame.name}`,
      { auth: { accessTicket } },
    );
    rawSockets.push(socket);
    return socket;
  };

  beforeAll(async () => {
    environment = await createTestApplication('ai-round0');
    await environment.app.start();
    alice = await registerAccount(environment, 'AiAlice');
    bob = await registerAccount(environment, 'AiBob');

    const created = await alice.agent
      .post(`/games/${SplendorGame.name}/create`)
      .set(mutate(alice))
      .send({ numPlayers: 2, unlisted: false })
      .expect(200);
    matchID = created.body.matchID as string;
    aliceSeat = (
      await alice.agent
        .post(`/games/${SplendorGame.name}/${matchID}/join`)
        .set(mutate(alice))
        .send({ playerID: '0', playerName: 'ignored' })
        .expect(200)
    ).body;
    bobSeat = (
      await bob.agent
        .post(`/games/${SplendorGame.name}/${matchID}/join`)
        .set(mutate(bob))
        .send({ playerID: '1', playerName: 'ignored' })
        .expect(200)
    ).body;
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(200);
    aliceAccess = (
      await alice.agent
        .post(`/api/matches/${matchID}/access-ticket`)
        .set(mutate(alice))
        .send({
          role: 'player',
          playerID: '0',
          credentials: aliceSeat.playerCredentials,
        })
        .expect(200)
    ).body;
    bobAccess = (
      await bob.agent
        .post(`/api/matches/${matchID}/access-ticket`)
        .set(mutate(bob))
        .send({
          role: 'player',
          playerID: '1',
          credentials: bobSeat.playerCredentials,
        })
        .expect(200)
    ).body;
  });

  afterAll(async () => {
    for (const socket of rawSockets) socket.disconnect();
    for (const client of clients) client.stop();
    await environment.cleanup();
  });

  it('submits a fixed legal move through the authoritative Socket.IO queue with filtered playerView', async () => {
    const aliceClient = connectClient('0', aliceSeat.playerCredentials, aliceAccess.accessTicket);
    const bobClient = connectClient('1', bobSeat.playerCredentials, bobAccess.accessTicket);
    await waitFor(() => Boolean(aliceClient.getState()?.isConnected && bobClient.getState()?.isConnected));

    const initial = aliceClient.getState()!;
    const loopbackPlayer = initial.ctx.currentPlayer;
    const loopbackSeat =
      loopbackPlayer === '0'
        ? { credentials: aliceSeat.playerCredentials, access: aliceAccess.accessTicket }
        : { credentials: bobSeat.playerCredentials, access: bobAccess.accessTicket };
    const observerClient = loopbackPlayer === '0' ? bobClient : aliceClient;
    const staleStateID = initial._stateID;
    const fixedAction = { type: 'reserveDeck', tier: 1 } as const;

    const loopbackClient = loopbackPlayer === '0' ? aliceClient : bobClient;
    loopbackClient.moves.mainAction(fixedAction);

    await waitFor(
      () => observerClient.getState()!._stateID > staleStateID,
    );

    const observerState = observerClient.getState()!;
    const loopbackState = loopbackClient.getState()!;

    // The move landed in both clients (same authoritative update queue).
    expect(observerState._stateID).toBe(staleStateID + 1);
    expect(loopbackState._stateID).toBe(staleStateID + 1);
    expect(observerState.G.players[loopbackPlayer].reservedCards).toHaveLength(1);
    expect(observerState.G.players[loopbackPlayer].tokens.gold).toBe(1);

    // PlayerView fairness: decks are hidden for every client.
    for (const tier of [1, 2, 3] as const) {
      expect(new Set(observerState.G.decks[tier])).toEqual(new Set(['__hidden__']));
      expect(new Set(loopbackState.G.decks[tier])).toEqual(new Set(['__hidden__']));
    }

    // The acting Bot sees its own blind reservation; the observer sees null.
    const ownReserved = loopbackState.G.players[loopbackPlayer].reservedCards[0];
    expect(ownReserved.source).toBe('deck');
    expect(typeof ownReserved.cardId).toBe('string');
    const observedReserved = observerState.G.players[loopbackPlayer].reservedCards[0];
    expect(observedReserved.source).toBe('deck');
    expect(observedReserved.cardId).toBeNull();

    // Action logs reached both clients.
    const lastLog = observerState.G.actionLog.at(-1);
    expect(lastLog?.kind).toBe('reserve');
    expect(lastLog?.animation).toMatchObject({
      type: 'reserve-deck',
      playerID: loopbackPlayer,
      tier: 1,
    });

    // A fresh connection re-syncs the same move from the authoritative store.
    const fresh = connectClient(
      loopbackPlayer,
      loopbackSeat.credentials,
      loopbackSeat.access,
    );
    await waitFor(() => fresh.getState()?._stateID === staleStateID + 1);
    const freshState = fresh.getState()!;
    expect(freshState.G.players[loopbackPlayer].reservedCards).toHaveLength(1);
    expect(freshState.G.actionLog.at(-1)?.kind).toBe('reserve');
    fresh.stop();
    clients.splice(clients.indexOf(fresh), 1);

    // A stale update carrying an old stateID must not overwrite the new state.
    const rawSocket = connectRawSocket(loopbackPlayer, loopbackSeat.access);
    await new Promise<void>((resolve) => rawSocket.once('connect', () => resolve()));
    rawSocket.emit('update', {
      type: 'MAKE_MOVE',
      payload: {
        type: 'mainAction',
        args: [fixedAction],
        playerID: loopbackPlayer,
        credentials: loopbackSeat.credentials,
      },
    }, staleStateID, matchID, loopbackPlayer);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const afterStale = observerClient.getState()!;
    expect(afterStale._stateID).toBe(staleStateID + 1);
    expect(afterStale.G.actionLog.at(-1)?.kind).toBe('reserve');
    expect(afterStale.G.actionLog).toHaveLength(observerState.G.actionLog.length);
  }, 30_000);
});
