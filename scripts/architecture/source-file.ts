// The files the architecture checker reads, the findings it reports and the path
// predicates every rule shares (types + util, ADR 059).

import path from 'node:path';

/** One `.ts` source file under `src/` or `scripts/`, by repo-relative POSIX path. */
export interface SourceFile {
  path: string;
  text: string;
}

/** The rules the checker enforces; a violation's `rule` and the allowlist keys use these ids. */
export type RuleId =
  | 'size'
  | 'test-import'
  | 'client-node'
  | 'client-server'
  | 'client-config-value'
  | 'server-client'
  | 'cli-server'
  | 'vendor-outside'
  | 'vendor-deep'
  | 'feature-feature'
  | 'below-feature'
  | 'facade-import'
  | 'cycle'
  | 'kebab-case'
  | 'banned-name'
  | 'index-file'
  | 'test-support-name'
  | 'duplicate-basename'
  | 'stale-allowlist';

/**
 * One broken rule. `key` is how the ratchet allowlist names it; `lines` is set for
 * size violations so the ratchet can tell a shrinking file from a growing one.
 */
export interface Violation {
  rule: RuleId;
  file: string;
  key: string;
  message: string;
  lines?: number;
}

/** The vendored ghostty-web root, the one layer with its own size limits and import rule. */
export const VENDOR_ROOT = 'src/client/vendor/ghostty-web/';
/** The vendored layer's public barrel, the only vendor path app code may import. */
export const VENDOR_BARREL = `${VENDOR_ROOT}index.ts`;

/** The layers the import rules talk about; `shared` is src/version.ts and its kin. */
export type Layer =
  | 'vendor'
  | 'client'
  | 'server'
  | 'cli'
  | 'pty'
  | 'config'
  | 'scripts'
  | 'shared';

const LAYER_PREFIXES: [string, Layer][] = [
  [VENDOR_ROOT, 'vendor'],
  ['src/client/', 'client'],
  ['src/server/', 'server'],
  ['src/cli/', 'cli'],
  ['src/pty/', 'pty'],
  ['src/config/', 'config'],
  ['scripts/', 'scripts'],
];

/** Which layer a file (or an unresolved import target) belongs to. */
export function layerOf(file: string): Layer {
  if (file === 'src/config' || file === 'src/config.ts') return 'config';
  for (const [prefix, layer] of LAYER_PREFIXES) {
    if (file.startsWith(prefix) || `${file}/` === prefix) return layer;
  }
  return 'shared';
}

/** A test file, by its `*.test.ts` name. */
export function isTestFile(file: string): boolean {
  return file.endsWith('.test.ts');
}

/** A shared test helper: under a `test-support/` folder or the vendor tests' `support/`. */
export function isTestSupport(file: string): boolean {
  return /(^|\/)test-support\//.test(file) || file.startsWith('src/client/vendor/tests/support/');
}

/**
 * Test code: tests, their helpers and the vendor test mirror. The import rules skip it,
 * so contract tests may cross the client/server line (SPEC "Layers and dependency rules").
 */
export function isTestCode(file: string): boolean {
  return isTestFile(file) || isTestSupport(file) || file.startsWith('src/client/vendor/tests/');
}

/** The file name without `.ts` and without a `.test` suffix: `ack.test.ts` → `ack`. */
export function stemOf(file: string): string {
  return path.posix
    .basename(file)
    .replace(/\.ts$/, '')
    .replace(/\.test$/, '');
}

/** Lines as `wc -l` counts them: a final newline does not start another line. */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}
