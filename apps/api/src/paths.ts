import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/api/src (or apps/api/dist) -> repository root. Relative paths in config resolve from here.
const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const WEB_DIST_DIR = path.join(REPO_ROOT, 'apps', 'web', 'dist');
