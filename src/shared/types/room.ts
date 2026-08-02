export const SPECTATOR_CAPACITY = 10;

export type RoomViewerRole = 'player' | 'spectator' | 'none';
export type PlayerConnectionStatus = 'online' | 'reconnecting' | 'offline';

export interface PublicSpectator {
  username: string;
  isHost: boolean;
  isViewer: boolean;
}

export interface PublicRoomState {
  allowSpectators: boolean;
  startedAt: number | null;
  hostUsername: string;
  spectatorCount: number;
  spectatorCapacity: number;
  spectators: PublicSpectator[];
  nextMatch: {
    matchID: string;
    allowSpectators: boolean;
  } | null;
}

export interface PublicMatchPlayer {
  id: number;
  name?: string;
  connectionStatus?: PlayerConnectionStatus;
  data?: {
    avatarUrl?: string;
    isHost: boolean;
    isViewer: boolean;
  };
}

export interface RoomMatch {
  matchID: string;
  gameName: string;
  players: PublicMatchPlayer[];
  createdAt: number;
  updatedAt: number;
  unlisted?: boolean;
  gameover?: unknown;
  nextMatchID?: string;
  room: PublicRoomState;
  viewer: {
    role: RoomViewerRole;
    playerID?: string;
    isHost: boolean;
    removalReason?: 'spectating-disabled';
  };
}

export interface PlayerAccessSession {
  mode: 'player';
  matchID: string;
  playerID: string;
  playerCredentials: string;
  playerName: string;
}

export interface SpectatorAccessSession {
  mode: 'spectator';
  matchID: string;
  viewerName: string;
}

export type MatchSession = PlayerAccessSession | SpectatorAccessSession;
