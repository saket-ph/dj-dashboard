import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** WCAG 2.x relative luminance / contrast ratio. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');

/** Reads `--name: #hex;` declarations from the block that starts at `selector {`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const block = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]!] = m[2]!;
  return out;
}

const light = tokens(':root');
const dark = { ...light, ...tokens('body.theme-dj') };

const AA_TEXT = 4.5;
const AA_UI = 3;

describe.each([
  ['audience (light)', light],
  ['DJ (dark)', dark],
] as const)('%s theme contrast (NFR-008, §13.3)', (_name, t) => {
  it('body and muted text are readable on the page and card backgrounds', () => {
    for (const bg of [t.bg!, t.surface!]) {
      expect(ratio(t.text!, bg)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(ratio(t.muted!, bg)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('primary button text is readable on the accent color', () => {
    expect(ratio(t['accent-text']!, t.accent!)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('accent links are readable on the card', () => {
    expect(ratio(t.accent!, t.surface!)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('error and success messages are readable on their tinted backgrounds', () => {
    expect(ratio(t.danger!, t['danger-bg']!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(ratio(t.success!, t['success-bg']!)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keyboard focus ring is clearly visible against the page and card', () => {
    expect(ratio(t.focus!, t.bg!)).toBeGreaterThanOrEqual(AA_UI);
    expect(ratio(t.focus!, t.surface!)).toBeGreaterThanOrEqual(AA_UI);
  });
});

describe('DJ queue status colors on the dark card', () => {
  it('pending, played, and skipped badges are readable', () => {
    expect(ratio('#ffe066', dark.surface!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(ratio(dark.success!, dark.surface!)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(ratio(dark.danger!, dark.surface!)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('Played / Skip action buttons are readable', () => {
    expect(ratio('#0b0d14', '#7be3a2')).toBeGreaterThanOrEqual(AA_TEXT); // Played
    expect(ratio(dark.text!, dark.surface!)).toBeGreaterThanOrEqual(AA_TEXT); // Skip (transparent on card)
    expect(ratio(dark.danger!, dark.surface!)).toBeGreaterThanOrEqual(AA_UI); // Skip border
  });

  it('secondary buttons are readable on the dark secondary surface', () => {
    expect(ratio(dark.text!, dark['surface-2']!)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('touch targets (NFR-006, §13.2)', () => {
  it('inputs and buttons are at least 48px tall, row actions 52px', () => {
    expect(css).toMatch(/input\[type='text'\],\s*input\[type='password'\]\s*\{[^}]*min-height:\s*48px/);
    expect(css).toMatch(/\.button\s*\{[^}]*min-height:\s*48px/);
    expect(css).toMatch(/\.row__actions \.button\s*\{[^}]*min-height:\s*52px/);
  });

  it('inputs use at least 16px text so iOS does not zoom on focus', () => {
    expect(css).toMatch(/input\[type='text'\],\s*input\[type='password'\]\s*\{[^}]*font-size:\s*1rem/);
  });
});
