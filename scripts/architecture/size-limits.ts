// The SPEC's file size limits: which limit applies to which file, the exempt data
// tables with their reasons, and the check (constants + util, ADR 059).

import { isTestFile, lineCount, type SourceFile, VENDOR_ROOT, type Violation } from './source-file';

/** The limit on one file, in lines, and why it is not the default for its layer. */
export interface SizeLimit {
  max: number;
  reason: string;
}

/** App, server, CLI, config, pty and script source (aim 200). */
export const SOURCE_LIMIT = 300;
/** Vendored ghostty-web source (aim 400). */
export const VENDOR_LIMIT = 600;
/** Test files (aim 600). */
export const TEST_LIMIT = 800;

/**
 * Files with limits of their own: the browser entry, which only starts the composition
 * root (ADR 060), and the vendored facades and two engine files (ADR 061).
 */
export const OWN_LIMITS: Record<string, number> = {
  'src/client/index.ts': 20,
  [`${VENDOR_ROOT}ghostty.ts`]: 300,
  [`${VENDOR_ROOT}terminal.ts`]: 600,
  [`${VENDOR_ROOT}renderer.ts`]: 500,
  [`${VENDOR_ROOT}input-handler.ts`]: 300,
  [`${VENDOR_ROOT}selection-manager.ts`]: 300,
  [`${VENDOR_ROOT}engine/official-terminal.ts`]: 500,
  // The per-cell decode hot path, kept as one unit so its calls stay direct.
  [`${VENDOR_ROOT}engine/render-state.ts`]: 700,
};

/** Data tables with no size limit: splitting a table across files would not help a reader. */
export const EXEMPT: Record<string, string> = {
  [`${VENDOR_ROOT}input/key-map.ts`]: 'data table: one entry per browser key code',
  [`${VENDOR_ROOT}input/key-types.ts`]:
    "data table: the Key enum, one member per key, translated to libghostty-vt's by name",
  [`${VENDOR_ROOT}engine/official-layout.ts`]:
    "data table: libghostty-vt's struct field offsets, one entry per field",
};

/** The limit that applies to `file`. */
export function limitFor(file: string): SizeLimit {
  if (file in EXEMPT) return { max: Number.POSITIVE_INFINITY, reason: EXEMPT[file] };
  if (isTestFile(file)) return { max: TEST_LIMIT, reason: 'test file' };
  if (file in OWN_LIMITS)
    return {
      max: OWN_LIMITS[file],
      reason: 'entry, facade or engine file, limit in the SPEC tree',
    };
  if (file.startsWith(VENDOR_ROOT)) return { max: VENDOR_LIMIT, reason: 'vendored source' };
  return { max: SOURCE_LIMIT, reason: 'source' };
}

/** Every file over its limit, keyed `size <file>`, with its line count for the ratchet. */
export function checkSizes(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = lineCount(file.text);
    const limit = limitFor(file.path);
    if (lines <= limit.max) continue;
    violations.push({
      rule: 'size',
      file: file.path,
      key: `size ${file.path}`,
      message: `${file.path} has ${lines} lines, over its limit of ${limit.max} (${limit.reason})`,
      lines,
    });
  }
  return violations;
}
