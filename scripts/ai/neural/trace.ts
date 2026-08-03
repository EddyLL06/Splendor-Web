/**
 * Generates deterministic game traces (first-legal-action policy) for the
 * Python environment parity suite (guide §2.4). Every step records the
 * canonical legal-action key, the full move, and a sorted-key state hash.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createInitialState } from '../../../src/shared/rules/setup.js';
import { createSeededRNG } from '../../../src/shared/ai/seeded-rng.js';
import { enumerateLegalActions } from '../../../src/shared/ai/legal-actions.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from '../../../src/shared/ai/simulate.js';
import { createObservation } from '../../../src/shared/ai/observation.js';
import { createPlayerView } from '../../../src/game/playerView.js';
import type {
  MainAction,
  SplendorState,
  TokenCounts,
} from '../../../src/shared/types/game.js';

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => canonical(entry));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
};

const stateHash = (state: SplendorState): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(state)))
    .digest('hex');

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument pair: ${key ?? '(missing)'}`);
    }
    values.set(key.slice(2), value);
  }
  const seed = values.get('seed') ?? 'parity-v1';
  const games = Number(values.get('games') ?? '20');
  const players = (values.get('players') ?? '2,3,4')
    .split(',')
    .map((value) => Number(value.trim()));
  const output = resolve(
    values.get('output') ?? '.local-data/ai-bot/neural-traces/parity-v1',
  );
  await mkdir(output, { recursive: true });

  let written = 0;
  for (let gameIndex = 0; gameIndex < games; gameIndex += 1) {
    const numPlayers = players[gameIndex % players.length];
    const rng = createSeededRNG(`game:${seed}:${gameIndex}`);
    const initialState = createInitialState(numPlayers, {
      Shuffle: (items) => rng.shuffle(items),
      Die: (sides) => rng.int(sides) + 1,
    });
    const sim = createSimulation(
      initialState,
      {
        currentPlayer: initialState.initialFirstPlayer,
        playOrder: initialState.playerOrder,
        playOrderPos: initialState.playerOrder.indexOf(
          initialState.initialFirstPlayer,
        ),
      },
      0,
    );
    const entries: Array<Record<string, unknown>> = [];
    const observations: Array<Record<string, unknown>> = [];
    let guard = 0;
    while (sim.G.result === null && guard < 3000) {
      guard += 1;
      const playerID = sim.currentPlayer;
      const ctx = {
        currentPlayer: sim.currentPlayer,
        playOrder: sim.playOrder,
        playOrderPos: sim.playOrderPos,
      };
      const observation = createObservation(
        createPlayerView(sim.G, playerID),
        playerID,
        ctx,
      );
      if (gameIndex === 0) observations.push(observation as never);
      const legal = enumerateLegalActions(sim.G, playerID, sim.currentPlayer);
      const candidate = legal[0];
      if (!candidate) {
        throw new Error(`No legal action at step ${guard} (game ${gameIndex}).`);
      }
      const [argument] = candidate.move.args;
      const result =
        candidate.move.move === 'mainAction'
          ? applySimulationMainAction(sim, playerID, argument as MainAction)
          : candidate.move.move === 'discardTokens'
            ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
            : applySimulationNoble(sim, playerID, argument as string);
      if (!result.ok) {
        throw new Error(
          `First legal action rejected at step ${guard}: ${result.errors
            .map((error) => error.code)
            .join(',')}`,
        );
      }
      entries.push({
        step: guard,
        playerID,
        actionKey: candidate.actionKey,
        move: candidate.move,
        stateHash: stateHash(sim.G),
      });
    }
    const header = {
      seed,
      gameIndex,
      numPlayers,
      initialHash: stateHash(initialState),
      finalResult: sim.G.result,
      actions: guard,
    };
    await writeFile(
      join(output, `game-${gameIndex}.jsonl`),
      `${JSON.stringify(header)}\n${entries
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
    );
    if (gameIndex === 0) {
      await writeFile(
        join(output, 'observations-game-0.json'),
        JSON.stringify(observations, null, 2),
      );
    }
    written += 1;
  }
  process.stdout.write(`wrote ${written} trace games to ${output}\n`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
