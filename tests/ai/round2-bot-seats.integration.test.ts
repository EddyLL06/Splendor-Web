/// <reference types="node" />

import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SplendorGame } from '../../src/game/SplendorGame.js';
import { createObservation } from '../../src/shared/ai/observation.js';
import { chooseBotMove } from '../../src/shared/ai/policy.js';
import type { SplendorState } from '../../src/shared/types/game.js';
import {
  createTestApplication,
  mutate,
  registerAccount,
  type RegisteredAccount,
  type TestApplication,
} from '../server-test-kit.js';

type GameClient = ReturnType<typeof Client<SplendorState>>;

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for bot state.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const gamePath = `/games/${SplendorGame.name}`;

describe('round 2: bot seats, lifecycle and Easy bot play', () => {
  let environment: TestApplication;
  let alice: RegisteredAccount;
  let bob: RegisteredAccount;
  const clients: GameClient[] = [];

  beforeAll(async () => {
    environment = await createTestApplication('ai-round2');
    await environment.app.start();
    alice = await registerAccount(environment, 'BotHost');
    bob = await registerAccount(environment, 'BotObserver');
  });

  afterAll(async () => {
    for (const client of clients) client.stop();
    await environment.cleanup();
  });

  const createMatch = async (host: RegisteredAccount, numPlayers = 2) => {
    const created = await host.agent
      .post(`${gamePath}/create`)
      .set(mutate(host))
      .send({ numPlayers, unlisted: true })
      .expect(200);
    return created.body.matchID as string;
  };

  const joinSeat = async (account: RegisteredAccount, matchID: string, playerID: string) =>
    account.agent
      .post(`${gamePath}/${matchID}/join`)
      .set(mutate(account))
      .send({ playerID, playerName: 'ignored' })
      .expect(200);

  const addBot = async (account: RegisteredAccount, matchID: string, playerID: string, difficulty = 'easy') =>
    account.agent
      .post(`/api/matches/${matchID}/bots`)
      .set(mutate(account))
      .send({ playerID, difficulty })
      .expect(200);

  const connectPlayer = (
    matchID: string,
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

  /** Plays one legal move for the human seat so the game can reach the bot. */
  const playHumanTurn = (client: GameClient): void => {
    const state = client.getState()!;
    const ctx = {
      currentPlayer: '0',
      playOrder: state.ctx.playOrder,
      playOrderPos: state.ctx.playOrderPos,
    };
    const observation = createObservation(
      state.G as SplendorState,
      '0',
      ctx,
    );
    const decision = chooseBotMove(observation, ctx, {
      policy: 'uniform-random-v1',
      seed: `test-human:${state._stateID}`,
    });
    const [argument] = decision.move.args;
    if (decision.move.move === 'mainAction') {
      client.moves.mainAction(argument);
    } else if (decision.move.move === 'discardTokens') {
      client.moves.discardTokens(argument);
    } else {
      client.moves.chooseNoble(argument);
    }
  };

  const waitForBotMove = async (client: GameClient): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = client.getState();
      if (!state) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (state.ctx.currentPlayer === '1') {
        const before = state._stateID;
        const botDeadline = Date.now() + 10_000;
        while (Date.now() < botDeadline) {
          const current = client.getState()!;
          if (current._stateID > before) return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Bot did not move while it was its turn.');
      }
      playHumanTurn(client);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('Bot turn never arrived.');
  };

  it('enforces host-only, unstarted bot seat management', async () => {
    const matchID = await createMatch(alice);
    const joined = await joinSeat(alice, matchID, '0');

    await supertest(environment.app.app.callback())
      .post(`/api/matches/${matchID}/bots`)
      .send({ playerID: '1', difficulty: 'easy' })
      .expect(401);
    await bob.agent
      .post(`/api/matches/${matchID}/bots`)
      .set(mutate(bob))
      .send({ playerID: '1', difficulty: 'easy' })
      .expect(403);

    const added = await addBot(alice, matchID, '1', 'easy');
    expect(added.body.players[1]).toMatchObject({
      id: 1,
      name: 'Bot 2',
      kind: 'bot',
      difficulty: 'easy',
    });
    expect(added.body.players[1].connectionStatus).toBeUndefined();
    expect(added.body.players[1].data).toBeUndefined();

    const updated = await alice.agent
      .patch(`/api/matches/${matchID}/bots/1`)
      .set(mutate(alice))
      .send({ playerID: '1', difficulty: 'hard' })
      .expect(200);
    expect(updated.body.players[1].difficulty).toBe('hard');

    await alice.agent
      .post(`/api/matches/${matchID}/bots`)
      .set(mutate(alice))
      .send({ playerID: '1', difficulty: 'easy' })
      .expect(409);
    await alice.agent
      .delete(`/api/matches/${matchID}/bots/1`)
      .set(mutate(alice))
      .expect(200);
    const afterRemove = await alice.agent.get(`${gamePath}/${matchID}`).expect(200);
    expect(afterRemove.body.players[1].name).toBeUndefined();

    await alice.agent
      .post(`${gamePath}/${matchID}/leave`)
      .set(mutate(alice))
      .send({ playerID: '0', credentials: joined.body.playerCredentials })
      .expect(200);
    await alice.agent.get(`${gamePath}/${matchID}`).expect(404);
  }, 20_000);

  it('starts a mixed room and the Easy bot plays through the authoritative chain', async () => {
    const matchID = await createMatch(alice);
    const joined = await joinSeat(alice, matchID, '0');
    await addBot(alice, matchID, '1', 'easy');
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(200);

    const access = await alice.agent
      .post(`/api/matches/${matchID}/access-ticket`)
      .set(mutate(alice))
      .send({
        role: 'player',
        playerID: '0',
        credentials: joined.body.playerCredentials,
      })
      .expect(200);
    const aliceClient = connectPlayer(
      matchID,
      '0',
      joined.body.playerCredentials as string,
      access.body.accessTicket as string,
    );
    await waitFor(() => Boolean(aliceClient.getState()?.isConnected));
    const beforeFirstBotMove = aliceClient.getState()!._stateID;
    await waitForBotMove(aliceClient);
    const afterFirstBot = aliceClient.getState()!;
    expect(
      Object.values(afterFirstBot.G.players['1'].tokens).reduce(
        (sum, count) => sum + count,
        0,
      ),
    ).toBeGreaterThan(0);
    expect(afterFirstBot._stateID).toBeGreaterThan(beforeFirstBotMove);
    expect(afterFirstBot.G.actionLog.length).toBeGreaterThan(0);

    const beforeSecondBotMove = aliceClient.getState()!._stateID;
    await waitForBotMove(aliceClient);
    expect(aliceClient.getState()!.G.actionLog.length).toBeGreaterThan(
      afterFirstBot.G.actionLog.length,
    );
    expect(aliceClient.getState()!._stateID).toBeGreaterThan(
      beforeSecondBotMove,
    );
  }, 30_000);

  it('rematch retains bot seats and difficulty, then the new bot plays', async () => {
    const matchID = await createMatch(alice);
    const joined = await joinSeat(alice, matchID, '0');
    await addBot(alice, matchID, '1', 'normal');
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(200);

    const playAgain = await alice.agent
      .post(`${gamePath}/${matchID}/playAgain`)
      .set(mutate(alice))
      .send({ playerID: '0', credentials: joined.body.playerCredentials })
      .expect(200);
    const nextMatchID = playAgain.body.nextMatchID as string;
    const nextRoom = await alice.agent
      .get(`${gamePath}/${nextMatchID}`)
      .expect(200);
    expect(nextRoom.body.players[1]).toMatchObject({
      name: 'Bot 2',
      kind: 'bot',
      difficulty: 'normal',
    });

    const nextJoined = await alice.agent
      .post(`${gamePath}/${nextMatchID}/join`)
      .set(mutate(alice))
      .send({ playerID: '0', playerName: 'ignored' })
      .expect(200);
    await alice.agent
      .post(`/api/matches/${nextMatchID}/start`)
      .set(mutate(alice))
      .expect(200);
    const nextAccess = await alice.agent
      .post(`/api/matches/${nextMatchID}/access-ticket`)
      .set(mutate(alice))
      .send({
        role: 'player',
        playerID: '0',
        credentials: nextJoined.body.playerCredentials,
      })
      .expect(200);
    const client = connectPlayer(
      nextMatchID,
      '0',
      nextJoined.body.playerCredentials as string,
      nextAccess.body.accessTicket as string,
    );
    await waitFor(() => Boolean(client.getState()?.isConnected));
    const before = client.getState()!._stateID;
    await waitForBotMove(client);
    expect(client.getState()!._stateID).toBeGreaterThan(before);
    expect(client.getState()!.G.actionLog.length).toBeGreaterThan(0);
  }, 30_000);

  it('host transfer skips bot seats and room deletion stops controllers', async () => {
    const matchID = await createMatch(alice, 3);
    const aliceJoined = await joinSeat(alice, matchID, '0');
    const bobJoined = await joinSeat(bob, matchID, '1');
    await addBot(alice, matchID, '2', 'easy');

    await alice.agent
      .post(`${gamePath}/${matchID}/leave`)
      .set(mutate(alice))
      .send({ playerID: '0', credentials: aliceJoined.body.playerCredentials })
      .expect(200);

    const room = await bob.agent.get(`${gamePath}/${matchID}`).expect(200);
    expect(room.body.room.hostUsername).toBe('BotObserver');
    expect(room.body.players[2].kind).toBe('bot');

    await bob.agent
      .delete(`/api/matches/${matchID}/bots/2`)
      .set(mutate(bob))
      .expect(200);
    await bob.agent
      .post(`${gamePath}/${matchID}/leave`)
      .set(mutate(bob))
      .send({ playerID: '1', credentials: bobJoined.body.playerCredentials })
      .expect(200);
    const gone = await alice.agent.get(`${gamePath}/${matchID}`).catch(
      (caught) => caught.response,
    );
    expect(gone?.status).toBe(404);
  }, 30_000);
});
