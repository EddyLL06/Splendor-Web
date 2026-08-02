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

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for socket state.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe('authenticated read-only spectator transport', () => {
  let environment: TestApplication;
  let host: RegisteredAccount;
  let player: RegisteredAccount;
  let viewer: RegisteredAccount;
  const clients: GameClient[] = [];

  beforeAll(async () => {
    environment = await createTestApplication('spectator-socket');
    await environment.app.start();
    host = await registerAccount(environment, 'SocketHost');
    player = await registerAccount(environment, 'SocketPlayer');
    viewer = await registerAccount(environment, 'SocketViewer');
  });

  afterAll(async () => {
    for (const client of clients) client.stop();
    await environment.cleanup();
  });

  it('rejects anonymous/cross-role sync, admits one authenticated spectator, and blocks spectator moves', async () => {
    const created = await host.agent
      .post(`/games/${SplendorGame.name}/create`)
      .set(mutate(host))
      .send({ numPlayers: 2, unlisted: false })
      .expect(200);
    const matchID = created.body.matchID as string;
    const hostSeat = await host.agent
      .post(`/games/${SplendorGame.name}/${matchID}/join`)
      .set(mutate(host))
      .send({ playerID: '0', playerName: 'ignored' })
      .expect(200);
    await player.agent
      .post(`/games/${SplendorGame.name}/${matchID}/join`)
      .set(mutate(player))
      .send({ playerID: '1', playerName: 'ignored' })
      .expect(200);
    await host.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(host))
      .expect(200);
    await viewer.agent
      .post(`/api/matches/${matchID}/spectators/join`)
      .set(mutate(viewer))
      .send({})
      .expect(200, { viewerName: viewer.username });

    const spectatorAccess = await viewer.agent
      .post(`/api/matches/${matchID}/access-ticket`)
      .set(mutate(viewer))
      .send({ role: 'spectator' })
      .expect(200);
    const hostAccess = await host.agent
      .post(`/api/matches/${matchID}/access-ticket`)
      .set(mutate(host))
      .send({
        role: 'player',
        playerID: '0',
        credentials: hostSeat.body.playerCredentials,
      })
      .expect(200);
    const server = `http://localhost:${environment.config.port}`;
    const makeClient = (input: {
      matchID?: string;
      playerID?: string;
      credentials?: string;
      accessTicket?: string;
    }): GameClient => {
      const client = Client<SplendorState>({
        game: SplendorGame,
        matchID: input.matchID ?? matchID,
        playerID: input.playerID,
        credentials: input.credentials,
        multiplayer: SocketIO({
          server,
          socketOpts: input.accessTicket
            ? { auth: { accessTicket: input.accessTicket } }
            : undefined,
        }),
      });
      clients.push(client);
      client.start();
      return client;
    };

    const anonymous = makeClient({});
    const crossMatch = makeClient({
      matchID: 'different-match',
      accessTicket: spectatorAccess.body.accessTicket,
    });
    const spectatorImpersonatingPlayer = makeClient({
      playerID: '0',
      credentials: hostSeat.body.playerCredentials,
      accessTicket: spectatorAccess.body.accessTicket,
    });
    const playerChangingSeat = makeClient({
      playerID: '1',
      credentials: hostSeat.body.playerCredentials,
      accessTicket: hostAccess.body.accessTicket,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(anonymous.getState()).toBeNull();
    expect(crossMatch.getState()).toBeNull();
    expect(spectatorImpersonatingPlayer.getState()).toBeNull();
    expect(playerChangingSeat.getState()).toBeNull();

    const spectator = makeClient({
      accessTicket: spectatorAccess.body.accessTicket,
    });
    const spectatorSecondTab = makeClient({
      accessTicket: spectatorAccess.body.accessTicket,
    });
    const hostClient = makeClient({
      playerID: '0',
      credentials: hostSeat.body.playerCredentials,
      accessTicket: hostAccess.body.accessTicket,
    });
    await waitFor(() =>
      Boolean(
        spectator.getState()?.isConnected &&
          spectatorSecondTab.getState()?.isConnected &&
          hostClient.getState()?.isConnected,
      ),
    );
    const spectatorState = spectator.getState()!;
    expect(new Set(spectatorState.G.decks[1])).toEqual(new Set(['__hidden__']));
    expect(JSON.stringify(spectatorState.G)).not.toContain(viewer.userID);
    expect(JSON.stringify(spectatorState.G.actionLog)).not.toContain(viewer.username);
    const before = hostClient.getState()!._stateID;
    spectator.moves.mainAction({
      type: 'takeDifferent',
      colors: ['white', 'blue', 'green'],
    });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(hostClient.getState()!._stateID).toBe(before);

    const room = await host.agent
      .get(`/games/${SplendorGame.name}/${matchID}`)
      .expect(200);
    expect(room.body.room).toMatchObject({
      spectatorCount: 1,
      spectators: [
        { username: viewer.username, isHost: false, isViewer: false },
      ],
    });
    expect(room.body.players[0].connectionStatus).toBe('online');
    expect(room.body.players[1].connectionStatus).toBe('reconnecting');

    await viewer.agent
      .post('/api/auth/logout')
      .set(mutate(viewer))
      .expect(200);
    await waitFor(() => spectator.getState()?.isConnected === false);
  }, 25_000);
});
