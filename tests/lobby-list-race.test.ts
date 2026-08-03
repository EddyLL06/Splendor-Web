/// <reference types="node" />

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SplendorGame } from '../src/game/SplendorGame.js';
import type { MemoryMatchStore } from '../src/server/multiplayer/memory-store.js';
import {
  createTestApplication,
  mutate,
  registerAccount,
  type RegisteredAccount,
  type TestApplication,
} from './server-test-kit.js';

const gamePath = `/games/${SplendorGame.name}`;

const createMatch = async (account: RegisteredAccount): Promise<string> => {
  const response = await account.agent
    .post(`${gamePath}/create`)
    .set(mutate(account))
    .send({ numPlayers: 2 })
    .expect(200);
  return response.body.matchID as string;
};

const listMatchIDs = async (account: RegisteredAccount): Promise<string[]> => {
  const response = await account.agent.get(`${gamePath}?isGameover=false`).expect(200);
  return response.body.matches.map((match: { matchID: string }) => match.matchID);
};

describe('lobby list stays available when matches disappear mid-listing', () => {
  let environment: TestApplication;
  let account: RegisteredAccount;

  beforeAll(async () => {
    environment = await createTestApplication('lobby-list-race');
    account = await registerAccount(environment, 'ListRace');
  });

  afterAll(async () => {
    await environment.cleanup();
  });

  it('skips a match whose metadata was wiped after listing instead of returning 404', async () => {
    const wipedMatch = await createMatch(account);
    const survivor = await createMatch(account);

    const store = (
      environment.app.app as unknown as { context: { db: MemoryMatchStore } }
    ).context.db;
    const originalFetch = store.fetch.bind(store);
    let armed = true;
    store.fetch = ((matchID: string, options: { metadata?: boolean }) => {
      if (armed && options.metadata && matchID === wipedMatch) {
        armed = false;
        store.wipe(wipedMatch);
      }
      return originalFetch(matchID, options);
    }) as unknown as typeof store.fetch;

    try {
      const ids = await listMatchIDs(account);
      expect(ids).not.toContain(wipedMatch);
      expect(ids).toContain(survivor);
    } finally {
      store.fetch = originalFetch;
    }
  });

  it('skips a match whose room is gone while metadata still exists', async () => {
    const roomlessMatch = await createMatch(account);
    const survivor = await createMatch(account);

    environment.app.rooms.delete(roomlessMatch);

    const ids = await listMatchIDs(account);
    expect(ids).not.toContain(roomlessMatch);
    expect(ids).toContain(survivor);
  });
});
