import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from '../logger.js';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PERSISTENCE_ERROR'
  | 'SERVICE_UNAVAILABLE';

/** An error that is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function sendError(res: Response, err: AppError): void {
  for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
  res.status(err.status).json({ error: { code: err.code, message: err.message } });
}

/** Maps any storage-layer failure to a safe, generic persistence error. */
export function persistenceError(logger: Logger, err: unknown, context: string): AppError {
  const sqliteCode =
    typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'UNKNOWN';
  // Safe category only: never the SQL text, file path, or row contents.
  logger.error('persistence failure', { context, reason: sqliteCode });
  const busy = sqliteCode === 'SQLITE_BUSY' || sqliteCode === 'SQLITE_LOCKED';
  return busy
    ? new AppError(503, 'SERVICE_UNAVAILABLE', 'The service is busy. Please try again in a moment.')
    : new AppError(500, 'PERSISTENCE_ERROR', 'We could not save your request. Please try again.');
}

export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Not found.'));
}

/** Final error middleware. Never leaks stacks, SQL, paths, or config (FR-061). */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof AppError) {
      sendError(res, err);
      return;
    }
    const type = typeof err === 'object' && err !== null ? (err as { type?: unknown }).type : undefined;
    if (type === 'entity.parse.failed' || type === 'entity.too.large' || type === 'encoding.unsupported') {
      sendError(res, new AppError(400, 'VALIDATION_ERROR', 'Please send a valid request.'));
      return;
    }
    logger.error('unhandled error', { name: err instanceof Error ? err.name : 'unknown' });
    sendError(res, new AppError(500, 'PERSISTENCE_ERROR', 'Something went wrong. Please try again.'));
  };
}
