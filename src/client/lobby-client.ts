import { LobbyClient } from 'boardgame.io/client';

export class AuthenticatedLobbyClient extends LobbyClient {
  constructor(
    server: string,
    private readonly csrf: () => string | null,
  ) {
    super({ server });
  }

  private init(mutation = false): RequestInit {
    const token = this.csrf();
    return {
      credentials: 'include',
      headers: mutation && token ? { 'X-CSRF-Token': token } : undefined,
    };
  }

  override listGames() {
    return super.listGames(this.init());
  }

  override listMatches(gameName: string, where?: Parameters<LobbyClient['listMatches']>[1]) {
    return super.listMatches(gameName, where, this.init());
  }

  override getMatch(gameName: string, matchID: string) {
    return super.getMatch(gameName, matchID, this.init());
  }

  override createMatch(gameName: string, body: Parameters<LobbyClient['createMatch']>[1]) {
    return super.createMatch(gameName, body, this.init(true));
  }

  override joinMatch(gameName: string, matchID: string, body: Parameters<LobbyClient['joinMatch']>[2]) {
    return super.joinMatch(gameName, matchID, body, this.init(true));
  }

  override leaveMatch(gameName: string, matchID: string, body: Parameters<LobbyClient['leaveMatch']>[2]) {
    return super.leaveMatch(gameName, matchID, body, this.init(true));
  }

  override updatePlayer(gameName: string, matchID: string, body: Parameters<LobbyClient['updatePlayer']>[2]) {
    return super.updatePlayer(gameName, matchID, body, this.init(true));
  }

  override playAgain(gameName: string, matchID: string, body: Parameters<LobbyClient['playAgain']>[2]) {
    return super.playAgain(gameName, matchID, body, this.init(true));
  }
}
