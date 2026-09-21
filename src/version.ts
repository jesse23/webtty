import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * Returns the webtty version from the nearest `package.json` above this file.
 *
 * Read at runtime (not inlined at build time) because semantic-release bumps
 * `package.json` after `bun run build`. Walking up keeps it working from both
 * `src/` and the bundled `dist/cli` / `dist/server` entries.
 * Dev checkouts report `0.0.0-development`.
 */
export function getVersion(): string {
  if (cached) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'webtty' && pkg.version) {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // no readable package.json at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
}
