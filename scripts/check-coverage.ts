#!/usr/bin/env bun
// Enforces the per-layer coverage targets of docs/specs/architecture.md over bun's lcov
// report (entry, ADR 064). Bun's coverageThreshold is one global floor (bunfig.toml), so
// this script reads coverage/lcov.info, written by `bun test --coverage
// --coverage-reporter=lcov`, and checks each layer and the listed pure modules.

import fs from 'node:fs';
import path from 'node:path';
import { isTestCode } from './architecture/source-file';

/** One source file's counts from an lcov record. */
export interface FileCoverage {
  file: string;
  linesFound: number;
  linesHit: number;
  functionsFound: number;
  functionsHit: number;
}

/** A layer of the tree and the share of its lines and functions the tests must run. */
export interface LayerTarget {
  name: string;
  /** Matches a repo-relative source path of this layer. */
  pattern: RegExp;
  lines: number;
  functions: number;
}

/** The layers, in report order; a file belongs to the first that matches (ADR 064). */
export const LAYER_TARGETS: readonly LayerTarget[] = [
  { name: 'vendor', pattern: /^src\/client\/vendor\//, lines: 0.85, functions: 0.8 },
  { name: 'client', pattern: /^src\/client\//, lines: 0.95, functions: 0.9 },
  { name: 'server', pattern: /^src\/server\//, lines: 0.95, functions: 0.9 },
  { name: 'cli', pattern: /^src\/cli\//, lines: 0.95, functions: 0.9 },
  { name: 'config', pattern: /^src\/config\//, lines: 0.95, functions: 0.9 },
  { name: 'pty', pattern: /^src\/pty\//, lines: 0.95, functions: 0.9 },
  { name: 'shared', pattern: /^src\/[^/]+\.ts$/, lines: 0.95, functions: 0.9 },
];

/** Pure modules: table-driven tests run every line, and a test must load each one. */
export const PURE_MODULES: readonly string[] = [
  'src/cli/cli-args.ts',
  'src/cli/commands/key-format.ts',
  'src/cli/help-text.ts',
  'src/client/app/terminal-options.ts',
  'src/client/app/terminal-theme.ts',
  'src/client/connection/close-policy.ts',
  'src/client/connection/status-line.ts',
  'src/client/features/compose/composer-geometry.ts',
  'src/client/features/find/find-format.ts',
  'src/client/features/find/find-keys.ts',
  'src/client/features/keyboard/font-zoom.ts',
  'src/client/features/keyboard/key-bindings.ts',
  'src/client/features/kitty/graphics/placement-geometry.ts',
  'src/client/features/kitty/protocol/apc-command.ts',
  'src/client/features/kitty/protocol/apc-splitter.ts',
  'src/client/features/kitty/protocol/cell-geometry.ts',
  'src/client/features/kitty/protocol/chunk-assembler.ts',
  'src/client/features/kitty/protocol/control-scanner.ts',
  'src/client/features/kitty/protocol/kitty-reply.ts',
  'src/client/features/kitty/protocol/png-size.ts',
  'src/client/features/paste/non-text-paste.ts',
  'src/client/features/scroll/scroll-split.ts',
  'src/client/layout/edge-rects.ts',
  'src/client/layout/fit-insets.ts',
  'src/client/vendor/ghostty-web/core/terminal-geometry.ts',
  'src/client/vendor/ghostty-web/engine/kitty-keyboard-reply.ts',
  'src/client/vendor/ghostty-web/engine/text-mime.ts',
  'src/client/vendor/ghostty-web/engine/vt-layout.ts',
  'src/client/vendor/ghostty-web/input/key-encoding.ts',
  'src/client/vendor/ghostty-web/render/cell-range.ts',
  'src/client/vendor/ghostty-web/render/frame-lines.ts',
  'src/client/vendor/ghostty-web/render/row-band.ts',
  'src/client/vendor/ghostty-web/render/scrollbar-geometry.ts',
  'src/client/vendor/ghostty-web/selection/selection-coords.ts',
  'src/config/client-view.ts',
  'src/config/keyboard-bindings.ts',
  'src/config/parse-config.ts',
  'src/server/sessions/session-banner.ts',
  'src/server/sessions/session-id.ts',
  'src/server/ws/client-message.ts',
];

/**
 * Source files no test loads, so bun writes no lcov record for them: type-only modules
 * (nothing runs) and the thin entries (they only call the tested root). Any other source
 * file missing from the report fails, so a new untested module cannot hide from its layer.
 */
export const NOT_LOADED: readonly string[] = [
  'src/cli/index.ts',
  'src/client/app/client-context.ts',
  'src/client/index.ts',
  'src/client/vendor/ghostty-web/core/host-types.ts',
  'src/client/vendor/ghostty-web/engine/engine-types.ts',
  'src/client/vendor/ghostty-web/engine/wasm-exports.ts',
  'src/client/vendor/ghostty-web/interfaces.ts',
  'src/client/vendor/ghostty-web/link-types.ts',
  'src/client/vendor/ghostty-web/render/renderable.ts',
  'src/pty/pty-process.ts',
  'src/server/index.ts',
];

const ZERO = { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 };

/** The lcov tags this check reads, by the field each one fills. */
const COUNTERS = { LF: 'linesFound', LH: 'linesHit', FNF: 'functionsFound', FNH: 'functionsHit' };

/** The records of an lcov report, with paths made relative to `root` and `/`-separated. */
export function parseLcov(text: string, root: string): FileCoverage[] {
  const out: FileCoverage[] = [];
  let current: FileCoverage | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const colon = line.indexOf(':');
    const tag = colon < 0 ? line : line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (tag === 'SF') {
      const file = path.isAbsolute(value) ? path.relative(root, value) : value;
      current = { file: file.split(path.sep).join('/'), ...ZERO };
    } else if (current && tag in COUNTERS) {
      current[COUNTERS[tag as keyof typeof COUNTERS] as keyof typeof ZERO] = Number(value);
    } else if (current && tag === 'end_of_record') {
      out.push(current);
      current = undefined;
    }
  }
  return out;
}

/** The coverage target a source file counts toward, or undefined for test code and scripts. */
export function coverageLayerOf(file: string): LayerTarget | undefined {
  if (isTestCode(file)) return undefined;
  return LAYER_TARGETS.find((layer) => layer.pattern.test(file));
}

/** A share of `found` that was hit; nothing to hit counts as all of it. */
export function ratio(hit: number, found: number): number {
  return found === 0 ? 1 : hit / found;
}

/** A layer's summed counts, for the report and the check. */
export interface LayerTotals extends LayerTarget {
  totals: Omit<FileCoverage, 'file'>;
}

/** Sums the files of each layer; a layer no test loaded has zero counts. */
export function totalsByLayer(files: readonly FileCoverage[]): LayerTotals[] {
  const layers = LAYER_TARGETS.map((target) => ({ ...target, totals: { ...ZERO } }));
  for (const file of files) {
    const name = coverageLayerOf(file.file)?.name;
    const layer = layers.find((candidate) => candidate.name === name);
    if (!layer) continue;
    layer.totals.linesFound += file.linesFound;
    layer.totals.linesHit += file.linesHit;
    layer.totals.functionsFound += file.functionsFound;
    layer.totals.functionsHit += file.functionsHit;
  }
  return layers;
}

const percent = (share: number): string => `${(share * 100).toFixed(2)}%`;

/** One report line per layer: its lines and functions against the targets. */
export function formatLayer(layer: LayerTotals): string {
  const { linesHit, linesFound, functionsHit, functionsFound } = layer.totals;
  return `${layer.name.padEnd(8)} lines ${percent(ratio(linesHit, linesFound)).padStart(7)} (≥ ${percent(layer.lines)})  functions ${percent(ratio(functionsHit, functionsFound)).padStart(7)} (≥ ${percent(layer.functions)})`;
}

/**
 * Every target the report misses: a layer under its shares, a pure module not at 100%,
 * or one of `sources` (the tree's source files) with no record and not in NOT_LOADED.
 */
export function coverageFailures(
  files: readonly FileCoverage[],
  sources: readonly string[] = [],
): string[] {
  const failures: string[] = [];
  for (const layer of totalsByLayer(files)) {
    const { linesHit, linesFound, functionsHit, functionsFound } = layer.totals;
    if (ratio(linesHit, linesFound) < layer.lines) {
      failures.push(
        `${layer.name}: lines ${percent(ratio(linesHit, linesFound))} < ${percent(layer.lines)}`,
      );
    }
    if (ratio(functionsHit, functionsFound) < layer.functions) {
      failures.push(
        `${layer.name}: functions ${percent(ratio(functionsHit, functionsFound))} < ${percent(layer.functions)}`,
      );
    }
  }
  const byFile = new Map(files.map((file) => [file.file, file]));
  for (const pure of PURE_MODULES) {
    const file = byFile.get(pure);
    if (!file) failures.push(`${pure}: pure module not loaded by any test`);
    else if (file.linesHit < file.linesFound) {
      failures.push(`${pure}: pure module at ${file.linesHit}/${file.linesFound} lines, not 100%`);
    }
  }
  for (const source of sources) {
    if (!byFile.has(source) && !NOT_LOADED.includes(source)) {
      failures.push(`${source}: not loaded by any test (add a test, or list it in NOT_LOADED)`);
    }
  }
  return failures;
}

/** The source files under `root`/src that count toward a layer, repo-relative and sorted. */
export function sourceFiles(root: string): string[] {
  const src = path.join(root, 'src');
  if (!fs.existsSync(src)) return [];
  return fs
    .readdirSync(src, { recursive: true, encoding: 'utf8' })
    .map((entry) => `src/${entry.split(path.sep).join('/')}`)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .filter((file) => coverageLayerOf(file) !== undefined)
    .sort();
}

/** Reads the lcov report under `root`, prints the layers and failures, returns the exit code. */
export function runCoverageCheck(
  root: string,
  print: (line: string) => void = console.log,
): number {
  const report = path.join(root, 'coverage', 'lcov.info');
  if (!fs.existsSync(report)) {
    print(`${report} not found; run bun test --coverage --coverage-reporter=lcov first`);
    return 1;
  }
  const files = parseLcov(fs.readFileSync(report, 'utf8'), root);
  for (const layer of totalsByLayer(files)) print(formatLayer(layer));
  const failures = coverageFailures(files, sourceFiles(root));
  for (const failure of failures) print(`coverage: ${failure}`);
  print(
    failures.length === 0
      ? `coverage targets met (${PURE_MODULES.length} pure modules at 100% lines)`
      : `${failures.length} coverage target(s) missed; see docs/specs/architecture.md "Testing"`,
  );
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(runCoverageCheck(path.join(import.meta.dir, '..')));
}
