/**
 * Golden-vector generator: encodes a fixed mid-game observation (with all
 * legal actions) using the TS encoder and writes the expected tensors for
 * the Python mirror test (guide §8.1 hidden-state/parity suite).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createInitialState } from '../../../src/shared/rules/setup.js';
import { createSeededRNG } from '../../../src/shared/ai/seeded-rng.js';
import { enumerateLegalActions } from '../../../src/shared/ai/legal-actions.js';
import {
  applySimulationMainAction,
  createSimulation,
} from '../../../src/shared/ai/simulate.js';
import { createObservation } from '../../../src/shared/ai/observation.js';
import { createPlayerView } from '../../../src/game/playerView.js';
import {
  encodeAIMove,
  encodeObservation,
} from '../../../src/shared/ai/neural/encode.js';

const main = async (): Promise<void> => {
  const rng = createSeededRNG('golden:vector');
  const state = createInitialState(2, {
    Shuffle: (items) => rng.shuffle(items),
    Die: (sides) => rng.int(sides) + 1,
  });
  const sim = createSimulation(
    state,
    {
      currentPlayer: state.initialFirstPlayer,
      playOrder: state.playerOrder,
      playOrderPos: state.playerOrder.indexOf(state.initialFirstPlayer),
    },
    0,
  );
  // Advance a few turns so the fixture includes tokens/reserves.
  const actor = sim.currentPlayer;
  applySimulationMainAction(sim, actor, {
    type: 'takeDifferent',
    colors: ['white', 'blue', 'green'],
  });
  const second = sim.currentPlayer;
  applySimulationMainAction(sim, second, {
    type: 'takeDifferent',
    colors: ['green', 'red', 'black'],
  });
  applySimulationMainAction(sim, sim.currentPlayer, {
    type: 'reserveDeck',
    tier: 2,
  });

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
  const legal = enumerateLegalActions(sim.G, playerID, sim.currentPlayer);
  const golden = {
    observation: Array.from(encodeObservation(observation)),
    legalKeys: legal.map((candidate) => candidate.actionKey),
    actions: legal.map((candidate) =>
      Array.from(encodeAIMove(candidate.move, observation)),
    ),
    dims: {
      obs: encodeObservation(observation).length,
      action: legal.length > 0 ? encodeAIMove(legal[0].move, observation).length : 0,
    },
  };
  const output = resolve(
    import.meta.dirname,
    '../../../ai_bot/neural/tests/golden-vectors.json',
  );
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(golden, null, 2));
  process.stdout.write(
    `golden vectors: obs=${golden.dims.obs} actions=${golden.actions.length} -> ${output}\n`,
  );
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
