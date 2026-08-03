/// <reference types="node" />

import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SplendorGame } from '../src/game/SplendorGame.js';
import { PLAYER_ABANDON_TIMEOUT_MS } from '../src/server/multiplayer/room-registry.js';
import {
  createTestApplication,
  mutate,
  registerAccount,
  type RegisteredAccount,
  type TestApplication,
} from './server-test-kit.js';

const gamePath = `/games/${SplendorGame.name}`;

const createMatch = async (
  account: RegisteredAccount,
  numPlayers = 2,
  unlisted = false,
) => {
  const response = await account.agent
    .post(`${gamePath}/create`)
    .set(mutate(account))
    .send({ numPlayers, unlisted })
    .expect(200);
  return response.body.matchID as string;
};

const join = async (
  account: RegisteredAccount,
  matchID: string,
  playerID: string,
) =>
  account.agent
    .post(`${gamePath}/${matchID}/join`)
    .set(mutate(account))
    .send({ playerID, playerName: 'ignored' })
    .expect(200);

describe('server-owned room lifecycle and role changes', () => {
  let environment: TestApplication;
  let alice: RegisteredAccount;
  let bob: RegisteredAccount;
  let carol: RegisteredAccount;

  beforeAll(async () => {
    environment = await createTestApplication('room-lifecycle');
    alice = await registerAccount(environment, 'RoomAlice');
    bob = await registerAccount(environment, 'RoomBob');
    carol = await registerAccount(environment, 'RoomCarol');
  });

  afterAll(async () => {
    await environment.cleanup();
  });

  it('defaults to spectator-friendly, keeps full rooms waiting, and starts only by the host', async () => {
    const matchID = await createMatch(alice);
    const created = await alice.agent.get(`${gamePath}/${matchID}`).expect(200);
    expect(created.body.room).toMatchObject({
      allowSpectators: true,
      startedAt: null,
      spectatorCount: 0,
      spectatorCapacity: 10,
    });
    expect(created.body.viewer).toMatchObject({ role: 'none', isHost: true });

    await join(alice, matchID, '0');
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(409, { error: { code: 'PLAYER_SEATS_NOT_FULL' } });
    await bob.agent
      .patch(`/api/matches/${matchID}/room`)
      .set(mutate(bob))
      .send({ allowSpectators: false })
      .expect(403, { error: { code: 'NOT_ROOM_HOST' } });
    await bob.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(bob))
      .expect(403, { error: { code: 'NOT_ROOM_HOST' } });

    await alice.agent
      .patch(`/api/matches/${matchID}/room`)
      .set(mutate(alice))
      .send({ allowSpectators: false })
      .expect(200);
    await alice.agent
      .patch(`/api/matches/${matchID}/room`)
      .set(mutate(alice))
      .send({ allowSpectators: true })
      .expect(200);

    await join(bob, matchID, '1');
    const fullButWaiting = await alice.agent
      .get(`${gamePath}/${matchID}`)
      .expect(200);
    expect(fullButWaiting.body.room.startedAt).toBeNull();

    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(200);
    const started = await bob.agent.get(`${gamePath}/${matchID}`).expect(200);
    expect(started.body.room.startedAt).toEqual(expect.any(Number));
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(409, { error: { code: 'MATCH_ALREADY_STARTED' } });
    await alice.agent
      .patch(`/api/matches/${matchID}/room`)
      .set(mutate(alice))
      .send({ allowSpectators: false })
      .expect(409, { error: { code: 'MATCH_ALREADY_STARTED' } });
    await carol.agent
      .post(`${gamePath}/${matchID}/join`)
      .set(mutate(carol))
      .send({ playerID: '0', playerName: 'ignored' })
      .expect(409, { error: { code: 'MATCH_ALREADY_STARTED' } });
    const aliceReclaimed = await alice.agent
      .post(`/api/matches/${matchID}/reclaim`)
      .set(mutate(alice))
      .expect(200);
    await alice.agent
      .post(`/api/matches/${matchID}/roles/spectator`)
      .set(mutate(alice))
      .send({
        playerID: '0',
        credentials: aliceReclaimed.body.playerCredentials,
      })
      .expect(409, { error: { code: 'ROLE_CHANGE_LOCKED' } });

    const publicList = await carol.agent.get(gamePath).expect(200);
    expect(
      publicList.body.matches.find(
        (match: { matchID: string }) => match.matchID === matchID,
      ).room.startedAt,
    ).toEqual(expect.any(Number));
  });

  it('switches roles atomically, revokes the old seat credential, and preserves host identity', async () => {
    const matchID = await createMatch(alice);
    const aliceSeat = await join(alice, matchID, '0');
    await join(bob, matchID, '1');

    await alice.agent
      .post(`/api/matches/${matchID}/roles/spectator`)
      .set(mutate(alice))
      .send({
        playerID: '0',
        credentials: aliceSeat.body.playerCredentials,
      })
      .expect(200, { viewerName: alice.username });
    const spectatorView = await alice.agent
      .get(`${gamePath}/${matchID}`)
      .expect(200);
    expect(spectatorView.body.viewer).toMatchObject({
      role: 'spectator',
      isHost: true,
    });
    expect(spectatorView.body.players[0].name).toBeUndefined();
    expect(spectatorView.body.room.spectators).toEqual([
      { username: alice.username, isHost: true, isViewer: true },
    ]);
    expect(JSON.stringify(spectatorView.body.room)).not.toContain(alice.userID);

    await alice.agent
      .post(`${gamePath}/${matchID}/leave`)
      .set(mutate(alice))
      .send({
        playerID: '0',
        credentials: aliceSeat.body.playerCredentials,
      })
      .expect(403, { error: { code: 'SEAT_CREDENTIAL_INVALID' } });

    const reclaimedRole = await alice.agent
      .post(`/api/matches/${matchID}/roles/player`)
      .set(mutate(alice))
      .send({})
      .expect(200);
    expect(reclaimedRole.body).toMatchObject({
      playerID: '0',
      playerName: alice.username,
    });
    const playerView = await alice.agent.get(`${gamePath}/${matchID}`).expect(200);
    expect(playerView.body.viewer).toMatchObject({ role: 'player', isHost: true });
    expect(playerView.body.room.spectatorCount).toBe(0);
  });

  it('requires confirmation when disabling spectating and transfers a spectator host before removal', async () => {
    const matchID = await createMatch(alice);
    const aliceSeat = await join(alice, matchID, '0');
    await join(bob, matchID, '1');
    await alice.agent
      .post(`/api/matches/${matchID}/roles/spectator`)
      .set(mutate(alice))
      .send({
        playerID: '0',
        credentials: aliceSeat.body.playerCredentials,
      })
      .expect(200);

    await alice.agent
      .patch(`/api/matches/${matchID}/room`)
      .set(mutate(alice))
      .send({ allowSpectators: false })
      .expect(409, {
        error: { code: 'SPECTATORS_CONFIRMATION_REQUIRED' },
      });
    await alice.agent
      .patch(`/api/matches/${matchID}/room`)
      .set(mutate(alice))
      .send({ allowSpectators: false, confirmRemoval: true })
      .expect(200);

    const aliceRemoved = await alice.agent
      .get(`${gamePath}/${matchID}`)
      .expect(200);
    expect(aliceRemoved.body.viewer).toMatchObject({
      role: 'none',
      isHost: false,
      removalReason: 'spectating-disabled',
    });
    expect(aliceRemoved.body.room).toMatchObject({
      allowSpectators: false,
      hostUsername: bob.username,
      spectatorCount: 0,
    });
    const bobView = await bob.agent.get(`${gamePath}/${matchID}`).expect(200);
    expect(bobView.body.viewer.isHost).toBe(true);
  });

  it('requires authentication, Origin, and CSRF on every room mutation', async () => {
    const matchID = await createMatch(alice);
    const anonymous = supertest(environment.app.app.callback());
    await anonymous
      .post(`/api/matches/${matchID}/spectators/join`)
      .set('Origin', 'http://localhost:5173')
      .send({})
      .expect(401);
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .expect(403, { error: { code: 'ORIGIN_INVALID' } });
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set('Origin', 'http://localhost:5173')
      .expect(403, { error: { code: 'CSRF_INVALID' } });
  });

  it('transfers host authority on leave and removes both match and room when empty', async () => {
    const matchID = await createMatch(alice);
    const aliceSeat = await join(alice, matchID, '0');
    const bobSeat = await join(bob, matchID, '1');
    await alice.agent
      .post(`${gamePath}/${matchID}/leave`)
      .set(mutate(alice))
      .send({ playerID: '0', credentials: aliceSeat.body.playerCredentials })
      .expect(200);
    const transferred = await bob.agent.get(`${gamePath}/${matchID}`).expect(200);
    expect(transferred.body.viewer.isHost).toBe(true);
    expect(transferred.body.room.hostUsername).toBe(bob.username);

    await bob.agent
      .post(`${gamePath}/${matchID}/leave`)
      .set(mutate(bob))
      .send({ playerID: '1', credentials: bobSeat.body.playerCredentials })
      .expect(200);
    await bob.agent.get(`${gamePath}/${matchID}`).expect(404);
    expect(environment.app.rooms.get(matchID)).toBeUndefined();
  });

  it('creates an unstarted rematch with inherited spectator policy and no copied spectators', async () => {
    const matchID = await createMatch(alice);
    const aliceSeat = await join(alice, matchID, '0');
    await join(bob, matchID, '1');
    await alice.agent
      .patch(`/api/matches/${matchID}/room`)
      .set(mutate(alice))
      .send({ allowSpectators: false })
      .expect(200);
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(200);
    const rematch = await alice.agent
      .post(`${gamePath}/${matchID}/playAgain`)
      .set(mutate(alice))
      .send({ playerID: '0', credentials: aliceSeat.body.playerCredentials })
      .expect(200);
    const nextID = rematch.body.nextMatchID as string;
    const next = await alice.agent.get(`${gamePath}/${nextID}`).expect(200);
    expect(next.body.room).toMatchObject({
      allowSpectators: false,
      startedAt: null,
      spectatorCount: 0,
    });
    expect(next.body.viewer).toMatchObject({ role: 'none', isHost: true });
  });

  it('keeps started private rooms unlisted while admitting an authenticated invitation spectator', async () => {
    const matchID = await createMatch(alice, 2, true);
    await join(alice, matchID, '0');
    await join(bob, matchID, '1');
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(200);
    const list = await carol.agent.get(gamePath).expect(200);
    expect(
      list.body.matches.map((match: { matchID: string }) => match.matchID),
    ).not.toContain(matchID);
    const invitation = await carol.agent
      .get(`${gamePath}/${matchID}`)
      .expect(200);
    expect(invitation.body).toMatchObject({
      matchID,
      unlisted: true,
      viewer: { role: 'none' },
    });
    expect(invitation.body.room.startedAt).toEqual(expect.any(Number));
    await carol.agent
      .post(`/api/matches/${matchID}/spectators/join`)
      .set(mutate(carol))
      .send({})
      .expect(200, { viewerName: carol.username });
  });

  it('publishes tolerant player connection status and destroys a match after three minutes offline', async () => {
    const matchID = await createMatch(alice);
    await join(alice, matchID, '0');
    await join(bob, matchID, '1');
    await alice.agent
      .post(`/api/matches/${matchID}/start`)
      .set(mutate(alice))
      .expect(200);

    const initiallyConnecting = await alice.agent
      .get(`${gamePath}/${matchID}`)
      .expect(200);
    expect(initiallyConnecting.body.players.map(
      (player: { connectionStatus?: string }) => player.connectionStatus,
    )).toEqual(['reconnecting', 'reconnecting']);

    environment.app.rooms.connectPlayer(matchID, alice.userID, '0', 'alice-tab');
    const connected = await bob.agent.get(`${gamePath}/${matchID}`).expect(200);
    expect(connected.body.players[0].connectionStatus).toBe('online');
    environment.app.rooms.disconnectPlayer(matchID, '0', 'alice-tab');

    const disconnectedAt = environment.app.rooms
      .get(matchID)
      ?.players.get('0')?.disconnectedAt;
    expect(disconnectedAt).toEqual(expect.any(Number));
    const now = vi.spyOn(Date, 'now').mockReturnValue(
      disconnectedAt! + PLAYER_ABANDON_TIMEOUT_MS,
    );
    try {
      const offline = await bob.agent.get(`${gamePath}/${matchID}`).expect(200);
      expect(offline.body.players[0].connectionStatus).toBe('offline');
      await environment.app.lobby.expireInactivePlayer(matchID, '0');
    } finally {
      now.mockRestore();
    }

    await bob.agent.get(`${gamePath}/${matchID}`).expect(404);
    expect(environment.app.rooms.get(matchID)).toBeUndefined();
  });
});
