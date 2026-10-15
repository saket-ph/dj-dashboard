import path from 'node:path';
import { ConfigError, loadDotEnv, normalizePublicBaseUrl } from '../config.js';
import { REPO_ROOT } from '../paths.js';
import { generateAudienceQr } from '../qr.js';

// Only PUBLIC_BASE_URL is needed, so the QR can be generated before secrets are configured.
loadDotEnv();

try {
  const raw = process.env.PUBLIC_BASE_URL?.trim();
  if (!raw) throw new ConfigError('PUBLIC_BASE_URL is required.');
  const base = normalizePublicBaseUrl(raw);
  const outDir = path.join(REPO_ROOT, 'data');
  const result = await generateAudienceQr(base, outDir);
  console.log(`Encoded URL : ${result.url}`);
  console.log(`PNG         : ${result.pngPath}`);
  console.log(`SVG         : ${result.svgPath}`);
  console.log('\nScan the printed code with at least two phones before the event.');
  console.log('If PUBLIC_BASE_URL changes, this QR code must be regenerated and reprinted.');
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : 'Could not generate the QR code.');
  process.exit(1);
}
