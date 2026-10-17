import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { cookieOptions, readCookie } from '../auth/session.js';
import type { AppConfig } from '../config.js';
import type { SongRequestRepository } from '../db/requestRepository.js';
import { AppError, persistenceError } from '../http/errors.js';
import type { Logger } from '../logger.js';
import type { SongRequest } from '../types.js';
import { validateSongRequest } from '../validation.js';

const VOTER_COOKIE = 'dj_voter';
const VOTER_ID = /^[A-Za-z0-9_-]{16,128}$/;
const SONG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicRouteDeps {
  config: AppConfig;
  repo: SongRequestRepository;
  logger: Logger;
  /** Called only after a new row has been committed. */
  onCreated?: (request: SongRequest) => void;
  /** Called after a like, unlike, move, or a merged title changes an existing row. */
  onUpdated?: (request: SongRequest) => void;
  /** Optional middleware applied to POST /api/requests (rate limiting). */
  submissionGuard?: import('express').RequestHandler;
}

/** Public shape returned to attendees (PRD §11.1): no updatedAt. */
function toPublicRequest(r: SongRequest) {
  return {
    id: r.id,
    sequenceNumber: r.sequenceNumber,
    requesterName: r.requesterName,
    songTitle: r.songTitle,
    artistName: r.artistName,
    status: r.status,
    createdAt: r.createdAt,
  };
}

function voterId(req: import('express').Request, res: import('express').Response, config: AppConfig): string {
  const existing = readCookie(req, VOTER_COOKIE);
  if (existing && VOTER_ID.test(existing)) return existing;
  const id = randomBytes(24).toString('base64url');
  res.cookie(VOTER_COOKIE, id, { ...cookieOptions(config), maxAge: 30 * 24 * 60 * 60 * 1000 });
  return id;
}

function cheerMessage(currentTitle: string, nextTitle: string): string {
  return `You can only cheer for one song at a time — you already picked “${currentTitle}”. Move your cheer to “${nextTitle}”?`;
}

export function publicRoutes(deps: PublicRouteDeps): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    try {
      deps.repo.ping();
      res.json({ status: 'ok' });
    } catch {
      deps.logger.error('health probe failed');
      res.status(503).json({ status: 'error' });
    }
  });

  router.get('/config', (_req, res) => {
    res.json({ eventTitle: deps.config.eventTitle });
  });

  const guard: import('express').RequestHandler = deps.submissionGuard ?? ((_req, _res, next) => next());

  router.get('/songs', (req, res) => {
    try {
      const voter = voterId(req, res, deps.config);
      res.json({ songs: deps.repo.popularSongs(voter) });
    } catch (err) {
      throw persistenceError(deps.logger, err, 'list_songs');
    }
  });

  router.post('/songs/:id/like', guard, (req, res) => {
    const songId = String(req.params.id ?? '');
    if (!SONG_ID.test(songId)) throw new AppError(404, 'NOT_FOUND', 'That song is not in the queue.');
    const move = Boolean(req.body && typeof req.body === 'object' && (req.body as { move?: unknown }).move === true);
    const voter = voterId(req, res, deps.config);
    let outcome;
    try {
      outcome = deps.repo.cheer(voter, songId, move);
    } catch (err) {
      throw persistenceError(deps.logger, err, 'cheer_song');
    }
    if (outcome.status === 'missing') {
      throw new AppError(404, 'NOT_FOUND', 'That song is no longer open for cheers.');
    }
    if (outcome.status === 'conflict') {
      throw new AppError(409, 'CONFLICT', cheerMessage(outcome.currentTitle, outcome.nextTitle));
    }
    for (const song of outcome.songs) deps.onUpdated?.(song);
    res.json({ liked: outcome.status === 'liked', songTitle: outcome.songTitle });
  });

  router.post('/requests', guard, (req, res) => {
    const validated = validateSongRequest(req.body);
    if (!validated.ok) {
      throw new AppError(400, 'VALIDATION_ERROR', validated.message);
    }

    let result;
    try {
      result = deps.repo.create(validated.value);
    } catch (err) {
      throw persistenceError(deps.logger, err, 'create_request');
    }

    if (result.replayed) {
      if (!result.payloadMatches) {
        throw new AppError(
          409,
          'CONFLICT',
          'This request key was already used for a different request. Please submit again.',
        );
      }
      // Safe retry of an already-committed request: return the original, create nothing.
      res.status(200).json({ request: toPublicRequest(result.request) });
      return;
    }

    if (result.merged) {
      deps.onUpdated?.(result.request);
      res.status(200).json({ request: toPublicRequest(result.request) });
      return;
    }

    // Success is returned only after the transaction has committed.
    deps.onCreated?.(result.request);
    res.status(201).json({ request: toPublicRequest(result.request) });
  });

  return router;
}
