#!/usr/bin/env bun
// Checks the code organisation rules of docs/specs/architecture.md: file sizes with a
// ratchet allowlist, import rules, runtime cycles and naming (entry, ADR 059). It runs
// under `bun test` through check-architecture.test.ts, and alone with
// `bun scripts/check-architecture.ts`.

import fs from 'node:fs';
import path from 'node:path';
import { checkCycles } from './architecture/import-cycles';
import { checkImports } from './architecture/import-rules';
import { checkNaming } from './architecture/naming-rules';
import { type Allowlist, applyAllowlist } from './architecture/ratchet';
import { RATCHET_ALLOWLIST } from './architecture/ratchet-allowlist';
import { checkSizes } from './architecture/size-limits';
import type { SourceFile, Violation } from './architecture/source-file';

/** The folders the checker walks, relative to the repo root. */
export const CHECKED_ROOTS = ['src', 'scripts'];

const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'coverage']);

/** A file the checker counts: `.ts` source, not a `.d.ts` declaration. */
export function isCheckedFile(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.d.ts');
}

function walk(root: string, folder: string, out: SourceFile[]): void {
  for (const entry of fs.readdirSync(path.join(root, folder), { withFileTypes: true })) {
    const rel = `${folder}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_FOLDERS.has(entry.name) && !entry.name.startsWith('.')) walk(root, rel, out);
    } else if (entry.isFile() && isCheckedFile(entry.name)) {
      out.push({ path: rel, text: fs.readFileSync(path.join(root, rel), 'utf8') });
    }
  }
}

/** Every checked file under `src/` and `scripts/` of the repo at `root`, sorted by path. */
export function readSourceTree(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  for (const folder of CHECKED_ROOTS) {
    if (fs.existsSync(path.join(root, folder))) walk(root, folder, files);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every rule broken in `files` that `allowlist` does not tolerate. */
export function checkArchitecture(
  files: readonly SourceFile[],
  allowlist: Allowlist = RATCHET_ALLOWLIST,
): Violation[] {
  const found = [
    ...checkSizes(files),
    ...checkImports(files),
    ...checkCycles(files),
    ...checkNaming(files),
  ];
  return applyAllowlist(found, files, allowlist);
}

/** Prints the violations and returns the exit code. */
export function runCheck(root: string, print: (line: string) => void = console.error): number {
  const violations = checkArchitecture(readSourceTree(root));
  for (const violation of violations) print(`${violation.rule}: ${violation.message}`);
  if (violations.length > 0) {
    print(`${violations.length} architecture violation(s); see docs/specs/architecture.md`);
  }
  return violations.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(runCheck(path.join(import.meta.dir, '..')));
}
