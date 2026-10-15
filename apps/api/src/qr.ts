import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { audienceUrl } from './config.js';

export interface QrOutput {
  url: string;
  pngPath: string;
  svgPath: string;
}

/**
 * Writes a print-ready QR code encoding ONLY the permanent audience URL
 * (FR-038/039/040/042): no tokens, request ids, or session data, and never /dj.
 */
export async function generateAudienceQr(publicBaseUrl: string, outDir: string): Promise<QrOutput> {
  const url = audienceUrl(publicBaseUrl);
  fs.mkdirSync(outDir, { recursive: true });
  const pngPath = path.join(outDir, 'qr-audience.png');
  const svgPath = path.join(outDir, 'qr-audience.svg');
  // Error correction "H" tolerates smudges on printed material; margin keeps the quiet zone.
  await QRCode.toFile(pngPath, url, { type: 'png', errorCorrectionLevel: 'H', margin: 4, width: 1024 });
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'H', margin: 4 });
  fs.writeFileSync(svgPath, svg);
  return { url, pngPath, svgPath };
}
