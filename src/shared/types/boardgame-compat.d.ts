/**
 * boardgame.io 0.50.2 predates modern Node ESM package exports.
 * These declarations preserve its official public types while runtime imports
 * target the package's published CommonJS files for Node 20 compatibility.
 */
declare module 'boardgame.io/dist/cjs/core.js' {
  export const INVALID_MOVE: typeof import('boardgame.io/core').INVALID_MOVE;
}

declare module 'boardgame.io/dist/cjs/server.js' {
  export const Server: typeof import('boardgame.io/server').Server;
}
