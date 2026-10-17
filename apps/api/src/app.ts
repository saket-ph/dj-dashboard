import fs from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import type { Clock } from './auth/session.js';
import type { AppConfig } from './config.js';
import type { SongRequestRepository } from './db/requestRepository.js';
import type { SessionRepository } from './db/sessionRepository.js';
import { AppError, errorHandler, notFoundHandler } from './http/errors.js';
import { blockWhenLimited, clientKey, createRateLimiter, limitEveryRequest } from './http/rateLimit.js';
import { requestLogger } from './http/requestLogger.js';
import { securityHeaders } from './http/securityHeaders.js';
import type { Logger } from './logger.js';
import { createHub, type RealtimeHub } from './realtime/hub.js';
import { authRoutes } from './routes/authRoutes.js';
import { djRoutes } from './routes/djRoutes.js';
import { publicRoutes } from './routes/publicRoutes.js';
import { mountStream } from './routes/streamRoutes.js';
import { attachYoutubeMatch, createYoutubeClient, type YoutubeClient } from './youtube.js';

export interface AppDeps {
  config: AppConfig;
  repo: SongRequestRepository;
  sessions: SessionRepository;
  logger: Logger;
  clock?: Clock;
  /** Live-update hub. Created automatically when omitted. */
  hub?: RealtimeHub;
  /** SSE heartbeat interval (also re-checks the session). Default 15 s. */
  heartbeatMs?: number;
  /**
   * YouTube search. Omit to build one from `YOUTUBE_API_KEY` (or disable lookup when that is unset).
   * Pass null to force lookup off.
   */
  youtube?: YoutubeClient | null;
}

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const clock: Clock = deps.clock ?? (() => new Date());
  const hub = deps.hub ?? createHub((reason) => logger.warn('realtime hub issue', { reason }));
  const youtube =
    deps.youtube === undefined ? (config.youtubeApiKey ? createYoutubeClient(config.youtubeApiKey) : null) : deps.youtube;
  let youtubeTail: Promise<void> = Promise.resolve();

  // Per-client (IP) limits, in memory. Tests drive them through the injected clock.
  const nowMs = (): number => clock().getTime();
  const submissionLimiter = createRateLimiter({ ...config.submissionRateLimit, now: nowMs });
  const loginLimiter = createRateLimiter({ ...config.loginRateLimit, now: nowMs });

  const app = express();
  app.disable('x-powered-by');
  app.locals.whenYoutubeIdle = () => youtubeTail;
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(securityHeaders());
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '10kb' }));

  app.use(
    '/api/auth',
    authRoutes({
      config,
      sessions: deps.sessions,
      logger,
      clock,
      // Only FAILED attempts are counted; a success clears the caller's count.
      loginGuard: blockWhenLimited(loginLimiter, 'Too many failed attempts. Please wait a few minutes and try again.'),
      onLoginFailure: (req) => void loginLimiter.hit(clientKey(req)),
      onLoginSuccess: (req) => loginLimiter.reset(clientKey(req)),
      onLogout: (sessionId) => hub.closeSession(sessionId),
    }),
  );

  app.use(
    '/api/dj',
    djRoutes({
      config,
      repo: deps.repo,
      sessions: deps.sessions,
      logger,
      clock,
      // Published only after the status change has been committed.
      onUpdated: (request) => hub.publish('request.updated', request),
      onDeleted: (ids) => hub.publishDeleted(ids),
      mount: (router) =>
        mountStream(router, {
          hub,
          repo: deps.repo,
          sessions: deps.sessions,
          logger,
          clock,
          heartbeatMs: deps.heartbeatMs ?? 15_000,
        }),
    }),
  );

  app.use(
    '/api',
    publicRoutes({
      config,
      repo: deps.repo,
      logger,
      // Published only after the new request has been committed. The YouTube lookup runs after that
      // and must not delay or fail the audience response.
      onCreated: (request) => {
        hub.publish('request.created', request);
        if (!youtube) return;
        const job = attachYoutubeMatch({
          request,
          client: youtube,
          repo: deps.repo,
          logger,
          onUpdated: (updated) => hub.publish('request.updated', updated),
        });
        youtubeTail = youtubeTail.then(() => job);
      },
      onUpdated: (request) => hub.publish('request.updated', request),
      submissionGuard: limitEveryRequest(
        submissionLimiter,
        'You are sending requests too quickly. Please wait a minute and try again.',
      ),
    }),
  );

  // Unknown /api/* paths are JSON 404s, never the SPA shell.
  app.use('/api', notFoundHandler());

  serveWebApp(app, config);

  app.use(errorHandler(logger));
  return app;
}

/** Serves the built web app (production, single origin) with SPA fallback for non-API paths. */
function serveWebApp(app: Express, config: AppConfig): void {
  const dist = config.webDistDir;
  if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) return;
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next(new AppError(404, 'NOT_FOUND', 'Not found.'));
      return;
    }
    res.sendFile(path.join(dist, 'index.html'));
  });
}
