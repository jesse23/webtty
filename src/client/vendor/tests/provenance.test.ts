import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The vendored layer's licence trail (ADR 041, ADR 061): every source file names where it
// came from in its first line, PROVENANCE.md lists the webtty-original files exactly, and
// every file the "Moves and splits" table moved code to still exists.

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ghostty-web');
const PROVENANCE = fs.readFileSync(path.join(WEB_DIR, 'PROVENANCE.md'), 'utf8');

const DERIVED =
  /^\/\/ Derived from coder\/ghostty-web lib\/[\w/.-]+\.ts( and lib\/[\w/.-]+\.ts)* \(MIT, see LICENSE and PROVENANCE\.md in ghostty-web\/\)\.$/;
const ORIGINAL = /^\/\/ webtty \(ADR \d{3}(, ADR \d{3})*\), not from upstream\.$/;

/** Every vendored `.ts` file, as a path relative to ghostty-web/. */
function sourceFiles(dir = WEB_DIR): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [path.relative(WEB_DIR, full)] : [];
  });
}

function firstLine(file: string): string {
  return fs.readFileSync(path.join(WEB_DIR, file), 'utf8').split('\n', 1)[0] ?? '';
}

/** The `.ts` paths each bullet of one `## ` section names before its first ': '. */
function listedInSection(heading: string): string[] {
  const start = PROVENANCE.indexOf(`## ${heading}\n`);
  const end = PROVENANCE.indexOf('\n## ', start + 1);
  return PROVENANCE.slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .flatMap((line) => [...(line.split(': ')[0] ?? '').matchAll(/`([\w/.-]+\.ts)`/g)])
    .map((m) => m[1] ?? '');
}

const files = sourceFiles();

describe('vendored provenance', () => {
  test('finds the vendored sources', () => {
    expect(files).toContain('terminal.ts');
    expect(files).toContain('engine/official-terminal.ts');
  });

  test.each(files)('%s starts with its origin header', (file) => {
    const line = firstLine(file);
    if (file === 'fn-table.ts') {
      expect(fs.readFileSync(path.join(WEB_DIR, file), 'utf8')).toContain(
        'Copied from gkoreli/ghostty-vt-js',
      );
      return;
    }
    expect(DERIVED.test(line) || ORIGINAL.test(line)).toBe(true);
  });

  test('PROVENANCE.md lists exactly the webtty-original files', () => {
    const original = files.filter((file) => ORIGINAL.test(firstLine(file))).sort();
    expect(listedInSection('webtty-original files').sort()).toEqual(original);
  });

  test('every file the moves table names exists', () => {
    const table = PROVENANCE.slice(PROVENANCE.indexOf('## Moves and splits'));
    const targets = table
      .split('\n')
      .filter((row) => row.startsWith('| `'))
      .flatMap((row) => [...(row.split('|')[2] ?? '').matchAll(/`([\w/.-]+\.ts)`/g)])
      .map((m) => m[1] ?? '');
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((target) => !files.includes(target))).toEqual([]);
  });

  // The commit column is how a reader finds the move in `git log`, so it must be a commit
  // subject. Whether that subject exists is checked by hand: git history is not stable in a test.
  test('every moves table row names a conventional commit subject', () => {
    const table = PROVENANCE.slice(PROVENANCE.indexOf('## Moves and splits'));
    const commits = table
      .split('\n')
      .filter((row) => row.startsWith('| `'))
      .map((row) => (row.split('|')[3] ?? '').trim());
    expect(commits.length).toBeGreaterThan(0);
    expect(commits.filter((c) => !/^(refactor|fix)\(client\): \S/.test(c))).toEqual([]);
  });
});
