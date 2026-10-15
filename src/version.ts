// The webtty package version, shared by `webtty -v` and `GET /api/server/status`. A util that
// walks up from this file to the package's package.json, read at runtime and cached (ADR 062).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * Returns the version in the nearest `package.json` named `webtty` at or above `startDir`, or
 * `'unknown'` when the walk reaches the filesystem root without one. Unreadable or unrelated
 * `package.json` files are skipped. Kept apart from getVersion so the walk is tested on a
 * temporary tree.
 */
export function findPackageVersion(startDir: string): string {
  let dir = startDir;
  while (true) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === 'webtty' && pkg.version) return pkg.version;
    } catch {
      // no readable package.json at this level — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return 'unknown';
    dir = parent;
  }
}

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
  const version = findPackageVersion(path.dirname(fileURLToPath(import.meta.url)));
  // As before, 'unknown' is not cached, so a later call walks again.
  if (version !== 'unknown') cached = version;
  return version;
}
