import { Router, type RequestHandler } from 'express';
import { verifyPassword } from '../auth/password.js';
import {
  clearSessionCookie,
  createSession,
  getSession,
  loadSession,
  requireCsrf,
  requireSession,
  setSessionCookie,
  type Clock,
} from '../auth/session.js';
import type { AppConfig } from '../config.js';
import type { SessionRepository } from '../db/sessionRepository.js';
import { AppError, persistenceError } from '../http/errors.js';
import type { Logger } from '../logger.js';

export interface AuthRouteDeps {
  config: AppConfig;
  sessions: SessionRepository;
  logger: Logger;
  clock: Clock;
  /** Optional middleware in front of login (failed-attempt rate limiting). */
  loginGuard?: RequestHandler;
  /** Called with the client key after a failed login (rate-limit accounting). */
  onLoginFailure?: (req: import('express').Request) => void;
  /** Called after a successful login (resets rate-limit accounting). */
  onLoginSuccess?: (req: import('express').Request) => void;
  /** Called after a session has been deleted (closes that session's live streams). */
  onLogout?: (sessionId: string) => void;
}

const MAX_PASSWORD_LENGTH = 256;

export function authRoutes(deps: AuthRouteDeps): Router {
  const { config, sessions, logger, clock } = deps;
  const router = Router();
  const guard: RequestHandler = deps.loginGuard ?? ((_req, _res, next) => next());

  router.post('/login', guard, async (req, res) => {
    const password = (req.body as { password?: unknown } | undefined)?.password;
    const valid =
      typeof password === 'string' &&
      password.length > 0 &&
      password.length <= MAX_PASSWORD_LENGTH &&
      (await verifyPassword(password, config.djPasswordHash));

    if (!valid) {
      deps.onLoginFailure?.(req);
      // Generic on purpose: never reveal whether the hash is missing or the password was close.
      throw new AppError(401, 'UNAUTHENTICATED', 'Incorrect password.');
    }

    let record;
    try {
      sessions.deleteExpired(clock().toISOString());
      record = createSession(config, sessions, clock);
    } catch (err) {
      throw persistenceError(logger, err, 'create_session');
    }
    deps.onLoginSuccess?.(req);
    setSessionCookie(res, config, record, clock);
    res.json({ csrfToken: record.csrfToken });
  });

  router.post('/logout', requireSession(config, sessions, clock), requireCsrf(), (_req, res) => {
    const session = getSession(res);
    try {
      sessions.delete(session.id);
    } catch (err) {
      throw persistenceError(logger, err, 'delete_session');
    }
    deps.onLogout?.(session.id);
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  router.get('/session', (req, res) => {
    const session = loadSession(req, config, sessions, clock);
    if (!session) {
      res.json({ authenticated: false });
      return;
    }
    res.json({ authenticated: true, csrfToken: session.csrfToken });
  });

  return router;
}
