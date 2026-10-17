import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './paths.js';

export interface RateLimitConfig {
  max: number;
  windowMs: number;
}

export interface AppConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  /** Absolute path of the SQLite file. */
  databasePath: string;
  /** Stable public origin (no trailing slash). The QR code encodes this plus "/". */
  publicBaseUrl: string;
  eventTitle: string;
  /** scrypt hash string; never logged or returned. */
  djPasswordHash: string;
  /** Signs the session cookie; never logged or returned. */
  sessionSecret: string;
  sessionTtlHours: number;
  submissionRateLimit: RateLimitConfig;
  loginRateLimit: RateLimitConfig;
  /** Express "trust proxy" setting (hosts that terminate TLS in front of the app). */
  trustProxy: boolean;
  /** Interface to listen on. null = all interfaces. Use 127.0.0.1 when a local reverse proxy fronts the app. */
  host: string | null;
  /** Directory with the built web app, or null to serve the API only. */
  webDistDir: string | null;
  /** YouTube Data API key. Null disables lookup; song requests are still saved. Never logged. */
  youtubeApiKey: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Loads <repo>/.env into process.env if present (development convenience; real env wins). */
export function loadDotEnv(): void {
  const file = path.join(REPO_ROOT, '.env');
  if (fs.existsSync(file)) {
    process.loadEnvFile(file);
  }
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer.`);
  }
  return n;
}

/** Normalizes the public base URL: absolute http(s), no trailing slash, not pointing at /dj. */
export function normalizePublicBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('PUBLIC_BASE_URL must be an absolute http or https URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('PUBLIC_BASE_URL must be an absolute http or https URL.');
  }
  const cleaned = url.origin + url.pathname.replace(/\/+$/, '');
  if (/\/dj$/i.test(cleaned)) {
    throw new ConfigError('PUBLIC_BASE_URL must point at the audience page, not the DJ dashboard.');
  }
  return cleaned;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const v = env[name];
    if (v === undefined || v.trim() === '') {
      missing.push(name);
      return '';
    }
    return v.trim();
  };

  const publicBaseUrlRaw = need('PUBLIC_BASE_URL');
  const djPasswordHash = need('DJ_PASSWORD_HASH');
  const sessionSecret = need('SESSION_SECRET');
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variable(s): ${missing.join(', ')}.`);
  }

  const nodeEnvRaw = env.NODE_ENV?.trim() || 'development';
  if (nodeEnvRaw !== 'development' && nodeEnvRaw !== 'production' && nodeEnvRaw !== 'test') {
    throw new ConfigError('NODE_ENV must be development, production, or test.');
  }

  const databaseRaw = env.DATABASE_PATH?.trim() || './data/dj-requests.sqlite';
  if (databaseRaw === ':memory:' || databaseRaw.startsWith('file::memory:')) {
    throw new ConfigError('DATABASE_PATH must be a file path; in-memory databases are not allowed.');
  }

  if (sessionSecret.length < 16) {
    throw new ConfigError('SESSION_SECRET must be at least 16 characters.');
  }

  return {
    port: positiveInt(env, 'PORT', 3000),
    nodeEnv: nodeEnvRaw,
    databasePath: path.resolve(REPO_ROOT, databaseRaw),
    publicBaseUrl: normalizePublicBaseUrl(publicBaseUrlRaw),
    eventTitle: env.EVENT_TITLE?.trim() || 'DJ Night',
    djPasswordHash,
    sessionSecret,
    sessionTtlHours: positiveInt(env, 'SESSION_TTL_HOURS', 12),
    submissionRateLimit: {
      max: positiveInt(env, 'SUBMISSION_RATE_LIMIT_MAX', 30),
      windowMs: positiveInt(env, 'SUBMISSION_RATE_LIMIT_WINDOW_MS', 60_000),
    },
    loginRateLimit: {
      max: positiveInt(env, 'LOGIN_RATE_LIMIT_MAX', 5),
      windowMs: positiveInt(env, 'LOGIN_RATE_LIMIT_WINDOW_MS', 10 * 60_000),
    },
    trustProxy: env.TRUST_PROXY?.trim().toLowerCase() === 'true',
    host: env.HOST?.trim() || null,
    webDistDir: null,
    youtubeApiKey: env.YOUTUBE_API_KEY?.trim() || null,
  };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

/**
 * Deployment mistakes that do not stop the app from starting but break it at the event.
 * Logged once at startup. Never includes secret values.
 */
export function deploymentWarnings(config: AppConfig): string[] {
  if (config.nodeEnv !== 'production') return [];
  const warnings: string[] = [];
  const url = new URL(config.publicBaseUrl);

  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    warnings.push(
      'PUBLIC_BASE_URL is not HTTPS. In production the DJ session cookie is Secure, so browsers will not keep it over plain HTTP and DJ login will appear to do nothing. Serve the public URL over HTTPS.',
    );
  }

  if (!config.youtubeApiKey) {
    warnings.push(
      'YOUTUBE_API_KEY is not set, so new song requests will not get a YouTube link. Requests themselves are still saved.',
    );
  }

  if (url.protocol === 'https:' && !config.trustProxy) {
    warnings.push(
      'PUBLIC_BASE_URL is HTTPS but TRUST_PROXY is not set. This server speaks plain HTTP, so HTTPS means a proxy in front of it. Without TRUST_PROXY=true every visitor shares the proxy address, and the per-client rate limits would apply to the whole audience at once. Set TRUST_PROXY=true if the host terminates TLS and strips client-supplied X-Forwarded-For.',
    );
  }

  if (url.protocol === 'http:' && config.trustProxy) {
    warnings.push(
      'TRUST_PROXY=true is set while PUBLIC_BASE_URL is plain HTTP. Only enable it behind a trusted proxy; otherwise clients can spoof their address and dodge rate limits.',
    );
  }

  return warnings;
}

/** The single audience URL encoded in the QR code. */
export function audienceUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}/`;
}
