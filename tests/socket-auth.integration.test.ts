/// <reference types="node" />

import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SplendorGame } from '../src/game/SplendorGame.js';
import type { SplendorState } from '../src/shared/types/game.js';
import {
  createTestApplication,
  mutate,
  registerAccount,
  type RegisteredAccount,
  type TestApplication,
} from './server-test-kit.js';

type GameClient = ReturnType<typeof Client<SplendorState>>;

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for multiplayer state.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('Socket.IO account-session enforcement', () => {
  let environment: TestApplication;
  let alice: RegisteredAccount;
  let bob: RegisteredAccount;
  const clients: GameClient[] = [];

  beforeAll(async () => {
    environment = await createTestApplication('socket-auth');
    await environment.app.start();
    alice = await registerAccount(environment, 'SocketAlice');
    bob = await registerAccount(environment, 'SocketBob');
  });

  afterAll(async () => {
    for (const client of clients) client.stop();
    await environment.cleanup();
  });

  it('rejects moves from revoked account sessions and invalid seat credentials', async () => {
    const created = await alice.agent
      .post(`/games/${SplendorGame.name}/create`)
      .set(mutate(alice))
      .send({ numPlayers: 2, unlisted: false })
      .expect(200);
    const matchID = created.body.matchID as string;
    const aliceSeat = await alice.agent
      .post(`/games/${SplendorGame.name}/${matchID}/join`)
      .set(mutate(alice))
      .send({ playerID: '0', playerName: 'forged' })
      .expect(200);
    const bobSeat = await bob.agent
      .post(`/games/${SplendorGame.name}/${matchID}/join`)
      .set(mutate(bob))
      .send({ playerID: '1', playerName: 'forged' })
      .expect(200);
    const server = `http://localhost:${environment.config.port}`;
    const makeClient = (playerID: string, credentials: string): GameClient => {
      const client = Client<SplendorState>({
        game: SplendorGame,
        matchID,
        playerID,
        credentials,
        multiplayer: SocketIO({ server }),
      });
      clients.push(client);
      client.start();
      return client;
    };
    const aliceClient = makeClient('0', aliceSeat.body.playerCredentials as string);
    const bobClient = makeClient('1', bobSeat.body.playerCredentials as string);
    await waitFor(() => Boolean(aliceClient.getState()?.isConnected && bobClient.getState()?.isConnected));
    const currentPlayer = aliceClient.getState()!.ctx.currentPlayer;
    const actor = currentPlayer === '0' ? alice : bob;
    const actorClient = currentPlayer === '0' ? aliceClient : bobClient;
    const observerClient = currentPlayer === '0' ? bobClient : aliceClient;
    const validCredential = currentPlayer === '0'
      ? aliceSeat.body.playerCredentials as string
      : bobSeat.body.playerCredentials as string;
    const before = observerClient.getState()!._stateID;

    actorClient.updateCredentials('invalid-seat-credential');
    actorClient.moves.mainAction({ type: 'takeDifferent', colors: ['white', 'blue', 'green'] });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(observerClient.getState()!._stateID).toBe(before);
    actorClient.updateCredentials(validCredential);

    await environment.app.database.prisma.session.updateMany({
      where: { userId: actor.userID },
      data: { revokedAt: new Date() },
    });
    actorClient.moves.mainAction({ type: 'takeDifferent', colors: ['white', 'blue', 'green'] });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(observerClient.getState()!._stateID).toBe(before);
    const publicState = observerClient.getState();
    expect(JSON.stringify(publicState)).not.toContain(environment.config.sessionSecret);
    expect(JSON.stringify(publicState)).not.toContain(actor.cookie);
    expect(JSON.stringify(publicState?.G.actionLog)).not.toContain('credentials');
  }, 20_000);
});
