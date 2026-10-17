import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !full.includes(`${join('src', 'test')}`)
      ? [full]
      : [];
  });
}

/** Source with comments removed, so prose that merely mentions a forbidden API is not flagged. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
}

describe('frontend source hygiene (FR-058, FR-028)', () => {
  const files = sourceFiles(SRC);

  it('finds the source files it is meant to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('never injects HTML or evaluates strings', () => {
    for (const file of files) {
      const text = code(file);
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
    }
  });

  it('never persists tokens or passwords in browser storage', () => {
    for (const file of files) {
      const text = code(file);
      expect(text, file).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    }
  });

  it('ships no secrets or server env names to the browser bundle', () => {
    for (const file of files) {
      const text = code(file);
      expect(text, file).not.toMatch(/SESSION_SECRET|DJ_PASSWORD_HASH|YOUTUBE_API_KEY|process\.env/);
    }
  });
});
