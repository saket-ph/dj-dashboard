/**
 * Minimal structured logger.
 *
 * Rule (NFR-012 / FR-028): never pass passwords, password hashes, cookies, session ids,
 * secrets, request bodies, SQL, or file paths to the logger. Log safe categories only.
 */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function format(level: string, message: string, fields?: Record<string, unknown>): string {
  const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  return `${new Date().toISOString()} ${level} ${message}${extra}`;
}

export const consoleLogger: Logger = {
  info: (m, f) => console.log(format('INFO', m, f)),
  warn: (m, f) => console.warn(format('WARN', m, f)),
  error: (m, f) => console.error(format('ERROR', m, f)),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Collects log lines in memory; used by tests to assert nothing sensitive is logged. */
export function createMemoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m, f) => void lines.push(format('INFO', m, f)),
    warn: (m, f) => void lines.push(format('WARN', m, f)),
    error: (m, f) => void lines.push(format('ERROR', m, f)),
  };
}
