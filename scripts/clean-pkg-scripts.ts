#!/usr/bin/env bun
// Publish-time package.json cleanup: `strip` (prepack) backs package.json up and drops its
// scripts and devDependencies from the packed tarball, `restore` (postpack) puts it back
// (entry, ADR 059). The transform is a pure function and the commands take their folder,
// so both are tested on a tmp dir.

import fs from 'node:fs';
import path from 'node:path';

const PKG_PATH = 'package.json';
const BACKUP_PATH = 'package.json.bak';

/** Where the commands report problems; console.error in the script. */
export type ErrorFn = (...args: unknown[]) => void;

/** package.json text without `scripts` and `devDependencies`, two-space indented. */
export function stripPackageJson(text: string): string {
  const pkg = JSON.parse(text);
  delete pkg.scripts;
  delete pkg.devDependencies;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Runs `strip` or `restore` in `dir` and returns the exit code. */
export function cleanPkgScripts(
  command: string | undefined,
  dir = '.',
  error: ErrorFn = console.error,
): number {
  const pkgPath = path.join(dir, PKG_PATH);
  const backupPath = path.join(dir, BACKUP_PATH);
  if (command === 'strip') {
    if (fs.existsSync(backupPath)) {
      error(
        'Error: package.json.bak already exists — a previous publish may have failed. Run restore first.',
      );
      return 1;
    }
    const original = fs.readFileSync(pkgPath, 'utf8');
    fs.writeFileSync(backupPath, original);
    fs.writeFileSync(pkgPath, stripPackageJson(original));
    return 0;
  }
  if (command === 'restore') {
    try {
      const original = fs.readFileSync(backupPath, 'utf8');
      fs.writeFileSync(pkgPath, original);
      fs.unlinkSync(backupPath);
    } catch (err) {
      error(
        'Warning: failed to restore package.json from backup — restore manually if needed.',
        err,
      );
    }
    return 0;
  }
  error('Usage: clean-pkg-scripts.ts strip | restore');
  return 1;
}

if (import.meta.main) {
  const code = cleanPkgScripts(process.argv[2]);
  if (code !== 0) process.exit(code);
}
