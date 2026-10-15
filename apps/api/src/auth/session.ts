import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config.js';
import type { SessionRecord, SessionRepository } from '../db/sessionRepository.js';
import { AppError } from '../http/errors.js';

export const SESSION_COOKIE = 'dj_session';
export const CSRF_HEADER = 'x-csrf-token';

export interface SessionContext {
  id: string;
  csrfToken: string;
}

export type Clock = () => Date;

function sign(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('base64url');
}

function safeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Cookie value: "<sessionId>.<hmac>". The id is random; the HMAC stops forged/guessed ids early. */
export function encodeSessionCookie(sessionId: string, secret: string): string {
  return `${sessionId}.${sign(sessionId, secret)}`;
}

export function decodeSessionCookie(value: string | undefined, secret: string): string | undefined {
  if (!value) return undefined;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const id = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  return safeEqualStrings(mac, sign(id, secret)) ? id : undefined;
}

/** Minimal Cookie header parser (no extra dependency). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function cookieOptions(config: AppConfig): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/',
  };
}

export function createSession(config: AppConfig, sessions: SessionRepository, clock: Clock): SessionRecord {
  const now = clock();
  const record: SessionRecord = {
    id: randomBytes(32).toString('base64url'),
    csrfToken: randomBytes(32).toString('base64url'),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.sessionTtlHours * 3_600_000).toISOString(),
  };
  sessions.create(record);
  return record;
}

export function setSessionCookie(res: Response, config: AppConfig, record: SessionRecord, clock: Clock): void {
  const maxAge = Math.max(0, new Date(record.expiresAt).getTime() - clock().getTime());
  res.cookie(SESSION_COOKIE, encodeSessionCookie(record.id, config.sessionSecret), {
    ...cookieOptions(config),
    maxAge,
  });
}

export function clearSessionCookie(res: Response, config: AppConfig): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(config));
}

/** Loads the session for a request from the signed cookie and SQLite, or undefined. */
export function loadSession(
  req: Request,
  config: AppConfig,
  sessions: SessionRepository,
  clock: Clock,
): SessionContext | undefined {
  const id = decodeSessionCookie(readCookie(req, SESSION_COOKIE), config.sessionSecret);
  if (!id) return undefined;
  const record = sessions.getValid(id, clock().toISOString());
  return record ? { id: record.id, csrfToken: record.csrfToken } : undefined;
}

export function getSession(res: Response): SessionContext {
  return res.locals.session as SessionContext;
}

/** Rejects requests without a live server-side session. Hiding UI is not authorization. */
export function requireSession(config: AppConfig, sessions: SessionRepository, clock: Clock): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const session = loadSession(req, config, sessions, clock);
    if (!session) {
      next(new AppError(401, 'UNAUTHENTICATED', 'Please log in.'));
      return;
    }
    res.locals.session = session;
    next();
  };
}

/** Requires X-CSRF-Token to match the session's token. Must run after requireSession. */
export function requireCsrf(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const session = res.locals.session as SessionContext | undefined;
    const sent = req.get(CSRF_HEADER);
    if (!session || !sent || !safeEqualStrings(sent, session.csrfToken)) {
      next(new AppError(403, 'FORBIDDEN', 'Your session could not be verified. Please refresh and try again.'));
      return;
    }
    next();
  };
}
