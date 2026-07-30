import { Server } from 'boardgame.io/dist/cjs/server.js';

import { SplendorGame } from '../game/SplendorGame.js';

const parsePort = (raw: string | undefined): number => {
  const value = Number(raw ?? 8000);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error('GAME_SERVER_PORT must be an integer between 1 and 65535.');
  }
  return value;
};

const port = parsePort(process.env.GAME_SERVER_PORT);
const origins = (
  process.env.GAME_ALLOWED_ORIGINS ?? 'http://localhost:5173'
)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const server = Server({
  games: [SplendorGame],
  origins,
  apiOrigins: origins,
});

server
  .run(port, () => {
    console.log(`Gem Council multiplayer server: http://localhost:${port}`);
    console.log(
      'Match storage: in-memory only (all matches disappear on restart).',
    );
  })
  .catch((error: unknown) => {
    console.error('Could not start the multiplayer server.', error);
    process.exitCode = 1;
  });
