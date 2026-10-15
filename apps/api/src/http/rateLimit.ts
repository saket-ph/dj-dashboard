import type { Request, RequestHandler } from 'express';
import { AppError } from './errors.js';

export interface RateLimiterOptions {
  max: number;
  windowMs: number;
  now?: () => number;
}

export interface HitResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Fixed-window, in-memory limiter keyed by client (IP).
 *
 * Counters live in this process only: they reset when the process restarts and are not shared
 * between processes. That is acceptable for the single-process MVP (documented in the README).
 */
export interface RateLimiter {
  /** Counts one event for `key`. `allowed` is false once the count exceeds `max`. */
  hit(key: string): HitResult;
  /** True when `key` has already used up its budget in the current window (does not count). */
  isLimited(key: string): boolean;
  retryAfterSec(key: string): number;
  reset(key: string): void;
}

interface Entry {
  count: number;
  resetAt: number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function live(key: string): Entry | undefined {
    const e = entries.get(key);
    if (e && e.resetAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return e;
  }

  function prune(): void {
    if (entries.size < 5000) return;
    const t = now();
    for (const [k, e] of entries) if (e.resetAt <= t) entries.delete(k);
  }

  function retryAfter(e: Entry | undefined): number {
    return e ? Math.max(1, Math.ceil((e.resetAt - now()) / 1000)) : 1;
  }

  return {
    hit(key) {
      prune();
      let e = live(key);
      if (!e) {
        e = { count: 0, resetAt: now() + options.windowMs };
        entries.set(key, e);
      }
      e.count += 1;
      return { allowed: e.count <= options.max, retryAfterSec: retryAfter(e) };
    },
    isLimited(key) {
      const e = live(key);
      return e !== undefined && e.count >= options.max;
    },
    retryAfterSec: (key) => retryAfter(live(key)),
    reset(key) {
      entries.delete(key);
    },
  };
}

export function clientKey(req: Request): string {
  return req.ip ?? 'unknown';
}

/** Limits every call (valid or not) to the route it guards. Over the limit: 429, no handler runs. */
export function limitEveryRequest(limiter: RateLimiter, message: string): RequestHandler {
  return (req, _res, next) => {
    const result = limiter.hit(clientKey(req));
    if (!result.allowed) {
      next(new AppError(429, 'RATE_LIMITED', message, { 'Retry-After': String(result.retryAfterSec) }));
      return;
    }
    next();
  };
}

/** Blocks callers that already exhausted their failed-attempt budget. Counting is done by the route. */
export function blockWhenLimited(limiter: RateLimiter, message: string): RequestHandler {
  return (req, _res, next) => {
    const key = clientKey(req);
    if (limiter.isLimited(key)) {
      next(new AppError(429, 'RATE_LIMITED', message, { 'Retry-After': String(limiter.retryAfterSec(key)) }));
      return;
    }
    next();
  };
}
