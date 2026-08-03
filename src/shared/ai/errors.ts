export class NoLegalActionError extends Error {
  readonly playerID: string;
  readonly stateID: number;

  constructor(playerID: string, stateID: number) {
    super('NO_LEGAL_ACTION');
    this.name = 'NoLegalActionError';
    this.playerID = playerID;
    this.stateID = stateID;
  }
}

export class IllegalCandidateError extends Error {
  constructor(details: string) {
    super(`AI produced an illegal action: ${details}`);
    this.name = 'IllegalCandidateError';
  }
}
