import { Router } from 'express';
import { requireCsrf, requireSession, type Clock } from '../auth/session.js';
import type { AppConfig } from '../config.js';
import type { SongRequestRepository } from '../db/requestRepository.js';
import type { SessionRepository } from '../db/sessionRepository.js';
import { AppError, persistenceError } from '../http/errors.js';
import type { Logger } from '../logger.js';
import type { SongRequest } from '../types.js';

export interface DjRouteDeps {
  config: AppConfig;
  repo: SongRequestRepository;
  sessions: SessionRepository;
  logger: Logger;
  clock: Clock;
  /** Called only after a status change has been committed. */
  onUpdated?: (request: SongRequest) => void;
  /** Called only after rows have been deleted. */
  onDeleted?: (ids: string[]) => void;
  /** Extra routes that must sit behind the same session check (e.g. the SSE stream). */
  mount?: (router: Router) => void;
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DELETE_IDS = 200;

const ALLOWED_STATUSES = ['played', 'skipped'] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

/** Every route in this router requires a live server-side session (FR-026, FR-033). */
export function djRoutes(deps: DjRouteDeps): Router {
  const { config, repo, sessions, logger, clock } = deps;
  const router = Router();
  router.use(requireSession(config, sessions, clock));

  router.get('/requests', (_req, res) => {
    try {
      res.json({ requests: repo.list() });
    } catch (err) {
      throw persistenceError(logger, err, 'list_requests');
    }
  });

  router.patch('/requests/:id/status', requireCsrf(), (req, res) => {
    const status = (req.body as { status?: unknown } | undefined)?.status;
    if (typeof status !== 'string' || !(ALLOWED_STATUSES as readonly string[]).includes(status)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Status must be "played" or "skipped".');
    }

    let updated: SongRequest | undefined;
    try {
      updated = repo.updateStatus(String(req.params.id), status as AllowedStatus);
    } catch (err) {
      throw persistenceError(logger, err, 'update_status');
    }
    if (!updated) {
      throw new AppError(404, 'NOT_FOUND', 'That request no longer exists.');
    }
    deps.onUpdated?.(updated);
    res.json({ request: updated });
  });

  router.delete('/requests', requireCsrf(), (req, res) => {
    const body = (req.body ?? {}) as { all?: unknown; ids?: unknown };
    let deletedIds: string[];
    try {
      deletedIds = body.all === true ? repo.deleteAll() : repo.deleteByIds(parseDeleteIds(body.ids));
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw persistenceError(logger, err, 'delete_requests');
    }
    deps.onDeleted?.(deletedIds);
    res.json({ deletedIds });
  });

  deps.mount?.(router);
  return router;
}

function parseDeleteIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_DELETE_IDS) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Choose at least one song to delete.');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || !ID_PATTERN.test(item)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Choose at least one song to delete.');
    }
    if (!seen.has(item)) {
      seen.add(item);
      ids.push(item);
    }
  }
  return ids;
}
