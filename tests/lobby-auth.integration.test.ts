/// <reference types="node" />

import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SplendorGame } from '../src/game/SplendorGame.js';
import {
  createTestApplication,
  mutate,
  registerAccount,
  type RegisteredAccount,
  type TestApplication,
} from './server-test-kit.js';

const gamePath = `/games/${SplendorGame.name}`;

const createMatch = async (account: RegisteredAccount, numPlayers = 2, unlisted = false) => {
  const created = await account.agent
    .post(`${gamePath}/create`)
    .set(mutate(account))
    .send({ numPlayers, unlisted })
    .expect(200);
  return created.body.matchID as string;
};

const join = async (account: RegisteredAccount, matchID: string, playerID: string, forgedName = 'Forged') => {
  const result = await account.agent
    .post(`${gamePath}/${matchID}/join`)
    .set(mutate(account))
    .send({ playerID, playerName: forgedName, data: { userId: 'forged' } });
  return result;
};

describe('authenticated lobby and account-bound seats', () => {
  let environment: TestApplication;
  let alice: RegisteredAccount;
  let bob: RegisteredAccount;

  beforeAll(async () => {
    environment = await createTestApplication('lobby');
    alice = await registerAccount(environment, 'Alice_Table');
    bob = await registerAccount(environment, 'Bob_Table');
  });

  afterAll(async () => {
    await environment.cleanup();
  });

  it('rejects every unauthenticated lobby surface and mutation', async () => {
    const matchID = await createMatch(alice);
    const anonymous = supertest(environment.app.app.callback());
    await anonymous.get('/games').expect(401);
    await anonymous.get(gamePath).expect(401);
    await anonymous.get(`${gamePath}/${matchID}`).expect(401);
    await anonymous.post(`${gamePath}/create`).set('Origin', 'http://localhost:5173').send({ numPlayers: 2 }).expect(401);
    await anonymous.post(`${gamePath}/${matchID}/join`).set('Origin', 'http://localhost:5173').send({ playerID: '0', playerName: 'Guest' }).expect(401);
    await anonymous.post(`${gamePath}/${matchID}/leave`).set('Origin', 'http://localhost:5173').send({ playerID: '0', credentials: 'x' }).expect(401);
    await anonymous.post(`${gamePath}/${matchID}/playAgain`).set('Origin', 'http://localhost:5173').send({ playerID: '0', credentials: 'x' }).expect(401);
  });

  it('lists public matches, hides private matches, and permits authenticated invite lookup', async () => {
    const publicID = await createMatch(alice, 2, false);
    const privateID = await createMatch(alice, 2, true);
    const list = await bob.agent.get(gamePath).expect(200);
    expect(list.body.matches.map((match: { matchID: string }) => match.matchID)).toContain(publicID);
    expect(list.body.matches.map((match: { matchID: string }) => match.matchID)).not.toContain(privateID);
    const invite = await bob.agent.get(`${gamePath}/${privateID}`).expect(200);
    expect(invite.body).toMatchObject({ matchID: privateID, unlisted: true });
    expect(JSON.stringify(invite.body)).not.toContain('credentials');
  });

  it('uses authoritative account identity, prevents duplicate seats, allows two accounts, and reclaims only for the owner', async () => {
    const matchID = await createMatch(alice);
    const first = await join(alice, matchID, '0', '<b>Forged Alice</b>');
    expect(first.status).toBe(200);
    const originalCredential = first.body.playerCredentials as string;
    const metadata = await alice.agent.get(`${gamePath}/${matchID}`).expect(200);
    expect(metadata.body.players[0]).toMatchObject({
      name: alice.username,
      data: { isHost: true, isViewer: true },
    });
    expect(metadata.body.players[0].data).not.toHaveProperty('userId');
    expect(metadata.body.players[0].data).not.toHaveProperty('matchId');
    expect(metadata.body.players[0].data).not.toHaveProperty('playerId');
    expect(JSON.stringify(metadata.body)).not.toContain(originalCredential);
    expect(JSON.stringify(metadata.body)).not.toContain('gem_council_session');
    expect(JSON.stringify(metadata.body)).not.toContain('<b>Forged Alice</b>');

    await join(alice, matchID, '1').then((response) => {
      expect(response.status).toBe(409);
      expect(response.body).toEqual({ error: { code: 'SEAT_ALREADY_CLAIMED' } });
    });
    const second = await join(bob, matchID, '1', 'Forged Bob');
    expect(second.status).toBe(200);

    await bob.agent.post(`/api/matches/${matchID}/reclaim`).set(mutate(bob)).expect(200);
    const other = await registerAccount(environment, 'Other_Table');
    await other.agent.post(`/api/matches/${matchID}/reclaim`).set(mutate(other)).expect(403, { error: { code: 'FORBIDDEN' } });
    const reclaimed = await alice.agent.post(`/api/matches/${matchID}/reclaim`).set(mutate(alice)).expect(200);
    expect(reclaimed.body.playerID).toBe('0');
    expect(reclaimed.body.playerCredentials).toBe(originalCredential);
    expect(reclaimed.body.playerName).toBe(alice.username);

    const secondSessionAgent = supertest.agent(environment.app.app.callback());
    const secondLogin = await secondSessionAgent
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5173')
      .send({ email: alice.email, password: alice.password })
      .expect(200);
    const secondSession = {
      ...alice,
      agent: secondSessionAgent,
      csrfToken: secondLogin.body.csrfToken as string,
    };
    const secondReclaim = await secondSession.agent
      .post(`/api/matches/${matchID}/reclaim`)
      .set(mutate(secondSession))
      .expect(200);
    expect(secondReclaim.body.playerCredentials).not.toBe(originalCredential);

    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(200);
    await alice.agent
      .post(`/api/matches/${matchID}/access-ticket`)
      .set(mutate(alice))
      .send({
        role: 'player',
        playerID: '0',
        credentials: originalCredential,
      })
      .expect(200);
    await secondSession.agent
      .post(`/api/matches/${matchID}/access-ticket`)
      .set(mutate(secondSession))
      .send({
        role: 'player',
        playerID: '0',
        credentials: secondReclaim.body.playerCredentials,
      })
      .expect(200);
  });

  it('invalidates lobby actions after the account session is revoked', async () => {
    const revoked = await registerAccount(environment, 'Revoked_Table');
    const matchID = await createMatch(revoked);
    const joined = await join(revoked, matchID, '0');
    expect(joined.status).toBe(200);
    await environment.app.database.prisma.session.updateMany({
      where: { userId: revoked.userID },
      data: { revokedAt: new Date() },
    });
    await revoked.agent
      .post(`${gamePath}/${matchID}/leave`)
      .set(mutate(revoked))
      .send({ playerID: '0', credentials: joined.body.playerCredentials })
      .expect(401, { error: { code: 'UNAUTHENTICATED' } });
  });
});
