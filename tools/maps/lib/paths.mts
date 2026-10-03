import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** games/doom/ */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
