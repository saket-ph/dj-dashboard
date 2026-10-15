import type { RequestHandler } from 'express';

/**
 * Defense-in-depth headers. The app renders all user text as plain text already (FR-058);
 * the CSP additionally forbids inline/remote script even if a rendering bug were introduced.
 * The built web app uses only same-origin scripts, styles, and fetch/EventSource calls.
 */
export function securityHeaders(): RequestHandler {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}
