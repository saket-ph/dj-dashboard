import type { RequestHandler } from 'express';
import type { Logger } from '../logger.js';

/**
 * Logs method, path, status, and duration only (NFR-012).
 * Never logs bodies, query strings, cookies, headers, or session identifiers.
 */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info('http', {
        method: req.method,
        // Path only: the query string is deliberately dropped.
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
      });
    });
    next();
  };
}
