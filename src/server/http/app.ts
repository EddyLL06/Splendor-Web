import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { unlink } from 'node:fs/promises';

import type Koa from 'koa';
import { koaBody, type ScalarOrArrayFiles } from 'koa-body';
import { Server as BoardgameServer } from 'boardgame.io/dist/cjs/server.js';

import { SplendorGame } from '../../game/SplendorGame.js';
import type { AppConfig } from '../config.js';
import { createDatabase, type Database } from '../database/client.js';
import { createEmailService, FakeEmailService, type EmailService } from '../email/index.js';
import { ApiError } from '../errors.js';
import { AuthService } from '../auth/service.js';
import {
  assertCsrf,
  createSession,
  requireSession,
  resolveSession,
  revokeSession,
  SESSION_COOKIE_NAME,
  type AuthenticatedSession,
  type CreatedSession,
} from '../auth/session.js';
import { SeatCredentialService } from '../multiplayer/credentials.js';
import { LobbyService } from '../multiplayer/lobby.js';
import { MemoryMatchStore } from '../multiplayer/memory-store.js';
import { AvatarService, avatarLimits } from '../profile/avatar.js';
import { RateLimiter } from '../security/rate-limiter.js';
import { cleanupTemporaryUploads, prepareStorage } from '../storage/paths.js';
import {
  codeRequestSchema,
  loginSchema,
  parseBody,
  parsePurpose,
  passwordResetSchema,
  registrationSchema,
  usernameUpdateSchema,
} from '../validation/auth.js';

const jsonBody = koaBody({
  json: true,
  multipart: false,
  urlencoded: false,
  text: false,
  jsonLimit: '64kb',
});

type AppContext = Koa.ParameterizedContext<
  Koa.DefaultState,
  Koa.DefaultContext & { db: unknown; auth: unknown }
>;

type ParsedRequest = Koa.Request & {
  body?: unknown;
  files?: ScalarOrArrayFiles;
};

const runBodyParser = async (
  parser: ReturnType<typeof koaBody>,
  ctx: AppContext,
): Promise<void> => {
  const compatibleParser = parser as unknown as (
    context: AppContext,
    next: () => Promise<void>,
  ) => Promise<void>;
  await compatibleParser(ctx, async () => undefined);
};

const setSessionCookie = (ctx: AppContext, config: AppConfig, session: CreatedSession): void => {
  ctx.cookies.set(SESSION_COOKIE_NAME, session.rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production' || config.appBaseUrl.startsWith('https://'),
    path: '/',
    overwrite: true,
    maxAge: Math.max(0, session.expiresAt.getTime() - Date.now()),
  });
};

const clearSessionCookie = (ctx: AppContext, config: AppConfig): void => {
  ctx.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production' || config.appBaseUrl.startsWith('https://'),
    path: '/',
    overwrite: true,
    maxAge: 0,
  });
};

const assertOrigin = (ctx: AppContext, config: AppConfig): void => {
  const origin = ctx.get('Origin');
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new ApiError(403, 'ORIGIN_INVALID');
  }
};

const isMutation = (method: string): boolean =>
  ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

const routeMatch = (path: string, pattern: RegExp): RegExpMatchArray | null =>
  path.match(pattern);

const decodePathSegment = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(400, 'INVALID_INPUT');
  }
};

const cleanupParsedFiles = async (files: ScalarOrArrayFiles | undefined): Promise<void> => {
  if (!files) return;
  const entries = Object.values(files).flatMap((file) =>
    Array.isArray(file) ? file : [file],
  );
  await Promise.all(
    entries.map((file) => unlink(file.filepath).catch(() => undefined)),
  );
};

export interface GemCouncilApplicationOptions {
  config: AppConfig;
  email?: EmailService;
  database?: Database;
}

export interface GemCouncilApplication {
  app: ReturnType<typeof BoardgameServer>['app'];
  config: AppConfig;
  database: Database;
  email: EmailService;
  auth: AuthService;
  avatars: AvatarService;
  lobby: LobbyService;
  start: () => Promise<{ appServer: HttpServer; apiServer?: HttpServer }>;
  stop: () => Promise<void>;
}

export const createGemCouncilApplication = async (
  options: GemCouncilApplicationOptions,
): Promise<GemCouncilApplication> => {
  const { config } = options;
  await prepareStorage(config);
  await cleanupTemporaryUploads(config);
  const database = options.database ?? (await createDatabase(config));
  try {
    await database.prisma.user.count();
  } catch {
    await database.close();
    throw new Error(
      'Database migrations are not applied. Run npm run prisma:migrate:deploy before starting Gem Council.',
    );
  }
  const email = options.email ?? createEmailService(config);
  const rateLimiter = new RateLimiter();
  const auth = new AuthService({
    prisma: database.prisma,
    config,
    email,
    rateLimiter,
  });
  const avatars = new AvatarService(database.prisma, config);
  const seatCredentials = new SeatCredentialService(database.prisma, config);
  const matchStore = new MemoryMatchStore();
  const boardgame = BoardgameServer({
    games: [SplendorGame],
    db: matchStore,
    origins: config.allowedOrigins,
    apiOrigins: config.allowedOrigins,
    generateCredentials: () => {
      throw new Error('Built-in lobby credential issuance is disabled.');
    },
    authenticateCredentials: seatCredentials.authenticate,
  });
  const lobby = new LobbyService({ db: matchStore, credentials: seatCredentials });
  const app = boardgame.app;

  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (caught) {
      const uploadError = caught as { httpCode?: number; code?: number; status?: number };
      const error =
        caught instanceof ApiError
          ? caught
          : uploadError.httpCode === 413 || uploadError.code === 1009
            ? new ApiError(413, 'AVATAR_TOO_LARGE')
            : uploadError.status === 400 || uploadError.httpCode === 400
              ? new ApiError(400, 'INVALID_INPUT')
            : null;
      ctx.status = error?.status ?? 500;
      ctx.type = 'application/json';
      ctx.body = { error: { code: error?.code ?? 'INTERNAL_ERROR' } };
      if (!error && config.nodeEnv !== 'production') {
        console.error('Unhandled request failure.');
      }
    }
  });

  app.use(async (ctx, next) => {
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.set('Referrer-Policy', 'no-referrer');
    ctx.set('X-Frame-Options', 'DENY');
    ctx.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const origin = ctx.get('Origin');
    if (origin && config.allowedOrigins.includes(origin)) {
      ctx.set('Access-Control-Allow-Origin', origin);
      ctx.set('Access-Control-Allow-Credentials', 'true');
      ctx.vary('Origin');
    }
    if (ctx.method === 'OPTIONS') {
      assertOrigin(ctx, config);
      ctx.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      ctx.set('Access-Control-Allow-Headers', 'Content-Type,X-CSRF-Token');
      ctx.status = 204;
      return;
    }
    await next();
  });

  app.use(async (ctx, next) => {
    const handledSurface = ctx.path.startsWith('/api/') || ctx.path === '/games' || ctx.path.startsWith('/games/');
    if (!handledSurface) {
      await next();
      return;
    }

    const rawCookie = ctx.cookies.get(SESSION_COOKIE_NAME);
    const session = await resolveSession(database.prisma, config, rawCookie);
    const requireProtectedMutation = (): AuthenticatedSession => {
      const authenticated = requireSession(session);
      assertOrigin(ctx, config);
      assertCsrf(authenticated, ctx.get('X-CSRF-Token') || undefined);
      return authenticated;
    };
    const parseJsonBody = async (): Promise<unknown> => {
      await runBodyParser(jsonBody, ctx);
      return (ctx.request as ParsedRequest).body;
    };
    const sendSession = (created: CreatedSession): void => {
      setSessionCookie(ctx, config, created);
      ctx.body = {
        user: created.user,
        csrfToken: created.csrfToken,
        sessionExpiresAt: created.expiresAt.toISOString(),
      };
    };

    if (ctx.method === 'GET' && ctx.path === '/api/auth/me') {
      if (!session && rawCookie) clearSessionCookie(ctx, config);
      ctx.body = session
        ? {
            user: session.user,
            csrfToken: session.csrfToken,
            sessionExpiresAt: session.expiresAt.toISOString(),
          }
        : { user: null, csrfToken: null, sessionExpiresAt: null };
      return;
    }

    if (ctx.method === 'POST' && ctx.path === '/api/auth/register/request-code') {
      assertOrigin(ctx, config);
      const input = parseBody(codeRequestSchema, await parseJsonBody());
      await auth.requestVerificationCode({
        ...input,
        purpose: 'registration',
        ip: ctx.ip,
      });
      ctx.body = { ok: true, code: 'EMAIL_REQUEST_ACCEPTED' };
      return;
    }

    if (ctx.method === 'POST' && ctx.path === '/api/auth/register/complete') {
      assertOrigin(ctx, config);
      const input = parseBody(registrationSchema, await parseJsonBody());
      const userId = await auth.register({ ...input, ip: ctx.ip });
      const created = await createSession(database.prisma, config, userId, {
        revokeSessionID: session?.id,
      });
      sendSession(created);
      return;
    }

    if (ctx.method === 'POST' && ctx.path === '/api/auth/login') {
      assertOrigin(ctx, config);
      const input = parseBody(loginSchema, await parseJsonBody());
      const userId = await auth.login({ ...input, ip: ctx.ip });
      const created = await createSession(database.prisma, config, userId, {
        revokeSessionID: session?.id,
      });
      sendSession(created);
      return;
    }

    if (ctx.method === 'POST' && ctx.path === '/api/auth/logout') {
      const authenticated = requireProtectedMutation();
      await revokeSession(database.prisma, authenticated.id);
      clearSessionCookie(ctx, config);
      ctx.body = { ok: true };
      return;
    }

    if (ctx.method === 'POST' && ctx.path === '/api/auth/password-reset/request-code') {
      assertOrigin(ctx, config);
      const input = parseBody(codeRequestSchema, await parseJsonBody());
      await auth.requestVerificationCode({
        ...input,
        purpose: 'password-reset',
        ip: ctx.ip,
      });
      ctx.body = { ok: true, code: 'EMAIL_REQUEST_ACCEPTED' };
      return;
    }

    if (ctx.method === 'POST' && ctx.path === '/api/auth/password-reset/complete') {
      assertOrigin(ctx, config);
      const input = parseBody(passwordResetSchema, await parseJsonBody());
      const userId = await auth.resetPassword({ ...input, ip: ctx.ip });
      const created = await createSession(database.prisma, config, userId);
      sendSession(created);
      return;
    }

    if (ctx.method === 'PATCH' && ctx.path === '/api/profile') {
      const authenticated = requireProtectedMutation();
      const input = parseBody(usernameUpdateSchema, await parseJsonBody());
      await auth.updateUsername(authenticated.user.id, input.username);
      const refreshed = await resolveSession(database.prisma, config, rawCookie);
      ctx.body = { user: requireSession(refreshed).user };
      return;
    }

    if (ctx.method === 'POST' && ctx.path === '/api/profile/avatar') {
      const authenticated = requireProtectedMutation();
      rateLimiter.consume(`avatar:${authenticated.user.id}`, {
        limit: 20,
        windowMs: 60 * 60_000,
      });
      const parser = koaBody({
        multipart: true,
        json: false,
        urlencoded: false,
        text: false,
        formidable: {
          uploadDir: config.uploadTempDir,
          maxFileSize: avatarLimits.maxUploadBytes,
          maxTotalFileSize: avatarLimits.maxUploadBytes,
          maxFiles: 1,
          allowEmptyFiles: false,
          multiples: false,
          filename: () => `upload_${randomBytes(24).toString('hex')}`,
        },
      });
      await runBodyParser(parser, ctx);
      const parsedFiles = (ctx.request as ParsedRequest).files;
      const rawFile = parsedFiles?.avatar;
      const file = Array.isArray(rawFile) ? rawFile[0] : rawFile;
      if (!file || (Array.isArray(rawFile) && rawFile.length !== 1)) {
        await cleanupParsedFiles(parsedFiles);
        throw new ApiError(400, 'AVATAR_INVALID');
      }
      await avatars.upload(authenticated.user.id, file);
      const refreshed = await resolveSession(database.prisma, config, rawCookie);
      ctx.body = { user: requireSession(refreshed).user };
      return;
    }

    if (ctx.method === 'DELETE' && ctx.path === '/api/profile/avatar') {
      const authenticated = requireProtectedMutation();
      await avatars.remove(authenticated.user.id);
      const refreshed = await resolveSession(database.prisma, config, rawCookie);
      ctx.body = { user: requireSession(refreshed).user };
      return;
    }

    const avatarRoute = routeMatch(ctx.path, /^\/api\/users\/([^/]+)\/avatar$/);
    if (ctx.method === 'GET' && avatarRoute) {
      requireSession(session);
      const result = await avatars.readForUser(decodePathSegment(avatarRoute[1]));
      if (!result) {
        ctx.status = 404;
        ctx.body = { error: { code: 'INVALID_INPUT' } };
        return;
      }
      ctx.type = 'image/webp';
      ctx.set('Cache-Control', result.custom ? 'private, max-age=300, must-revalidate' : 'private, max-age=3600');
      ctx.body = result.body;
      return;
    }

    if (
      config.nodeEnv === 'test' &&
      email instanceof FakeEmailService &&
      ctx.method === 'GET' &&
      ctx.path === '/api/test/email-code'
    ) {
      const emailQuery = typeof ctx.query.email === 'string' ? ctx.query.email : '';
      const purpose = parsePurpose(ctx.query.purpose);
      const code = email.latestCode(emailQuery, purpose);
      ctx.body = code ? { code } : { code: null };
      return;
    }

    if (ctx.path === '/games' || ctx.path.startsWith('/games/')) {
      const authenticated = requireSession(session);
      if (isMutation(ctx.method)) {
        assertOrigin(ctx, config);
        assertCsrf(authenticated, ctx.get('X-CSRF-Token') || undefined);
      }
      if (ctx.method === 'GET' && ctx.path === '/games') {
        ctx.body = await lobby.listGames();
        return;
      }
      if (ctx.method === 'GET' && ctx.path === `/games/${SplendorGame.name}`) {
        ctx.body = await lobby.list(ctx.query);
        return;
      }
      if (ctx.method === 'POST' && ctx.path === `/games/${SplendorGame.name}/create`) {
        ctx.body = await lobby.create(authenticated, await parseJsonBody());
        return;
      }
      const matchRoute = routeMatch(
        ctx.path,
        new RegExp(`^/games/${SplendorGame.name}/([^/]+)(?:/(join|leave|playAgain|update|rename))?$`),
      );
      if (matchRoute) {
        const matchID = decodePathSegment(matchRoute[1]);
        const action = matchRoute[2];
        if (ctx.method === 'GET' && !action) {
          ctx.body = await lobby.get(matchID);
          return;
        }
        if (ctx.method === 'POST' && action === 'join') {
          ctx.body = await lobby.join(authenticated, matchID, await parseJsonBody());
          return;
        }
        if (ctx.method === 'POST' && action === 'leave') {
          ctx.body = await lobby.leave(authenticated, matchID, await parseJsonBody());
          return;
        }
        if (ctx.method === 'POST' && action === 'playAgain') {
          ctx.body = await lobby.playAgain(authenticated, matchID, await parseJsonBody());
          return;
        }
        if (ctx.method === 'POST' && (action === 'update' || action === 'rename')) {
          ctx.body = await lobby.updatePlayer(authenticated, matchID, await parseJsonBody());
          return;
        }
      }
    }

    const reclaimRoute = routeMatch(ctx.path, /^\/api\/matches\/([^/]+)\/reclaim$/);
    if (ctx.method === 'POST' && reclaimRoute) {
      const authenticated = requireProtectedMutation();
      ctx.body = await lobby.reclaim(authenticated, decodePathSegment(reclaimRoute[1]));
      return;
    }

    ctx.status = 404;
    ctx.body = { error: { code: 'INVALID_INPUT' } };
  });

  let running:
    | { appServer: HttpServer; apiServer?: HttpServer }
    | undefined;
  return {
    app,
    config,
    database,
    email,
    auth,
    avatars,
    lobby,
    start: async () => {
      if (running) return running;
      const started = await boardgame.run(config.port);
      running = {
        appServer: started.appServer,
        apiServer: started.apiServer,
      };
      return running;
    },
    stop: async () => {
      if (running) {
        boardgame.kill({
          appServer: running.appServer,
          apiServer: running.apiServer,
        });
        running = undefined;
      }
      await database.close();
    },
  };
};
