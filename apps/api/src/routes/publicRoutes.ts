import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { SongRequestRepository } from '../db/requestRepository.js';
import { AppError, persistenceError } from '../http/errors.js';
import type { Logger } from '../logger.js';
import type { SongRequest } from '../types.js';
import { validateSongRequest } from '../validation.js';

export interface PublicRouteDeps {
  config: AppConfig;
  repo: SongRequestRepository;
  logger: Logger;
  /** Called only after a new row has been committed. */
  onCreated?: (request: SongRequest) => void;
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

    // Success is returned only after the transaction has committed.
    deps.onCreated?.(result.request);
    res.status(201).json({ request: toPublicRequest(result.request) });
  });

  return router;
}
