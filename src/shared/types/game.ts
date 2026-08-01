export type GemColor = 'white' | 'blue' | 'green' | 'red' | 'black';
export type TokenColor = GemColor | 'gold';
export type Tier = 1 | 2 | 3;
export type PlayerID = string;

export type GemCounts = Record<GemColor, number>;
export type TokenCounts = Record<TokenColor, number>;

export interface DevelopmentCard {
  id: string;
  tier: Tier;
  bonus: GemColor;
  points: number;
  cost: GemCounts;
}

export interface Noble {
  id: string;
  points: number;
  requirement: GemCounts;
}

export interface ReservedDevelopmentCard {
  cardId: string | null;
  tier: Tier;
  source: 'market' | 'deck';
}

export interface PlayerState {
  tokens: TokenCounts;
  purchasedCardIds: string[];
  reservedCards: ReservedDevelopmentCard[];
  nobleIds: string[];
}

export interface ActionLogEntry {
  id: number;
  kind:
    | 'tokens'
    | 'reserve'
    | 'purchase'
    | 'discard'
    | 'noble'
    | 'final-round'
    | 'game-over';
  message: string;
  i18n?: {
    key: string;
    values: Record<string, unknown>;
  };
}

export type PendingResolution =
  | {
      type: 'discard';
      playerID: PlayerID;
      count: number;
    }
  | {
      type: 'noble';
      playerID: PlayerID;
      eligibleNobleIds: string[];
    };

export interface FinalRoundState {
  triggeredBy: PlayerID;
  triggeredAtCompletedTurn: number;
}

export interface FinalStanding {
  playerID: PlayerID;
  score: number;
  purchasedCardCount: number;
}

export interface GameResult {
  winners: PlayerID[];
  standings: FinalStanding[];
}

export interface SplendorState {
  bank: TokenCounts;
  decks: Record<Tier, string[]>;
  market: Record<Tier, string[]>;
  availableNobleIds: string[];
  players: Record<PlayerID, PlayerState>;
  playerOrder: PlayerID[];
  initialFirstPlayer: PlayerID;
  pending: PendingResolution | null;
  turnReady: boolean;
  completedTurns: number;
  turnCounts: Record<PlayerID, number>;
  finalRound: FinalRoundState | null;
  actionLog: ActionLogEntry[];
  nextLogID: number;
  result: GameResult | null;
}

export type CardLocation =
  | {
      source: 'market';
      tier: Tier;
      cardId: string;
    }
  | {
      source: 'reserved';
      cardId: string;
    };

export type MainAction =
  | {
      type: 'takeDifferent';
      colors: TokenColor[];
    }
  | {
      type: 'takeSame';
      color: TokenColor;
    }
  | {
      type: 'reserveMarket';
      tier: Tier;
      cardId: string;
    }
  | {
      type: 'reserveDeck';
      tier: Tier;
    }
  | {
      type: 'purchase';
      location: CardLocation;
      payment: TokenCounts;
    };

export interface RuleError {
  code: string;
  message: string;
}

export type RuleResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      errors: RuleError[];
    };

export interface PaymentAnalysis {
  effectiveCost: GemCounts;
  suggestedPayment: TokenCounts;
  errors: RuleError[];
}

export interface GameSetupRandom {
  Shuffle<T>(items: T[]): T[];
  Die(sides: number): number;
}
