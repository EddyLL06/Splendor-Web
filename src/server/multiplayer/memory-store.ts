import type { LogEntry, Server, State, StorageAPI } from 'boardgame.io';

export class MemoryMatchStore implements StorageAPI.Sync {
  private readonly states = new Map<string, State>();
  private readonly initialStates = new Map<string, State>();
  private readonly metadata = new Map<string, Server.MatchData>();
  private readonly logs = new Map<string, LogEntry[]>();

  type(): StorageAPI.Type {
    return 0 as StorageAPI.Type;
  }

  connect(): void {}

  createMatch(matchID: string, options: StorageAPI.CreateMatchOpts): void {
    this.initialStates.set(matchID, options.initialState);
    this.states.set(matchID, options.initialState);
    this.metadata.set(matchID, options.metadata);
    this.logs.set(matchID, []);
  }

  setState(matchID: string, state: State, deltaLog: LogEntry[] = []): void {
    this.states.set(matchID, state);
    this.logs.set(matchID, [...(this.logs.get(matchID) ?? []), ...deltaLog]);
  }

  setMetadata(matchID: string, metadata: Server.MatchData): void {
    this.metadata.set(matchID, metadata);
  }

  fetch<O extends StorageAPI.FetchOpts>(
    matchID: string,
    options: O,
  ): StorageAPI.FetchResult<O> {
    const result: Partial<StorageAPI.FetchFields> = {};
    if (options.state) result.state = this.states.get(matchID)!;
    if (options.initialState) result.initialState = this.initialStates.get(matchID)!;
    if (options.metadata) result.metadata = this.metadata.get(matchID)!;
    if (options.log) result.log = this.logs.get(matchID) ?? [];
    return result as StorageAPI.FetchResult<O>;
  }

  wipe(matchID: string): void {
    this.states.delete(matchID);
    this.initialStates.delete(matchID);
    this.metadata.delete(matchID);
    this.logs.delete(matchID);
  }

  listMatches(options: StorageAPI.ListMatchesOpts = {}): string[] {
    return [...this.metadata.entries()]
      .filter(([, metadata]) => {
        if (options.gameName && metadata.gameName !== options.gameName) return false;
        if (options.where?.isGameover !== undefined) {
          const isGameover = metadata.gameover !== undefined;
          if (isGameover !== options.where.isGameover) return false;
        }
        if (
          options.where?.updatedBefore !== undefined &&
          metadata.updatedAt >= options.where.updatedBefore
        ) {
          return false;
        }
        if (
          options.where?.updatedAfter !== undefined &&
          metadata.updatedAt <= options.where.updatedAfter
        ) {
          return false;
        }
        return true;
      })
      .map(([matchID]) => matchID);
  }
}
