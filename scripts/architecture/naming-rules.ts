// The SPEC's naming rules: kebab-case names, banned names, where index.ts may sit,
// test helpers never named *.test.ts, unique client basenames (util, ADR 059).

import path from 'node:path';
import {
  isTestCode,
  isTestFile,
  isTestSupport,
  type RuleId,
  type SourceFile,
  stemOf,
  type Violation,
} from './source-file';

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Names that say a file's kind, not its subject (SPEC "Naming"). */
export const BANNED_STEMS = new Set(['utils', 'helpers', 'misc', 'types']);
/** A folder named for a kind of code rather than a domain. */
export const BANNED_FOLDERS = new Set(['common']);

/** The folders whose index.ts is an entry, a facade or the vendor barrel. */
export const INDEX_FOLDERS = new Set([
  'src/client',
  'src/server',
  'src/cli',
  'src/pty',
  'src/config',
  'src/client/vendor/ghostty-web',
]);

function violation(rule: RuleId, file: string, message: string): Violation {
  return { rule, file, key: `${rule} ${file}`, message: `${file} ${message}` };
}

function checkName(file: string): Violation[] {
  const out: Violation[] = [];
  const stem = stemOf(file);
  const folders = path.posix.dirname(file).split('/');
  if (!KEBAB_RE.test(stem) || !folders.every((folder) => KEBAB_RE.test(folder))) {
    out.push(violation('kebab-case', file, 'is not kebab-case'));
  }
  if (BANNED_STEMS.has(stem) || folders.some((folder) => BANNED_FOLDERS.has(folder))) {
    out.push(violation('banned-name', file, 'has a banned name; name a file after its subject'));
  }
  if (stem === 'index' && !INDEX_FOLDERS.has(path.posix.dirname(file))) {
    out.push(violation('index-file', file, 'is an index.ts outside an entry or barrel folder'));
  }
  if (isTestSupport(file) && isTestFile(file)) {
    out.push(violation('test-support-name', file, 'is a test helper named *.test.ts'));
  }
  return out;
}

/** Source files in src/client sharing a basename, so tabs and traces stay unambiguous. */
function duplicateBasenames(files: readonly SourceFile[]): Violation[] {
  const byName = new Map<string, string[]>();
  for (const { path: file } of files) {
    if (!file.startsWith('src/client/') || isTestCode(file)) continue;
    const name = path.posix.basename(file);
    if (name === 'index.ts') continue;
    byName.set(name, [...(byName.get(name) ?? []), file]);
  }
  return [...byName.values()]
    .filter((same) => same.length > 1)
    .flatMap((same) =>
      same.map((file) =>
        violation(
          'duplicate-basename',
          file,
          `shares its name with ${same.filter((f) => f !== file).join(', ')}`,
        ),
      ),
    );
}

/** Every naming rule broken in the tree, keyed `<rule> <file>`. */
export function checkNaming(files: readonly SourceFile[]): Violation[] {
  return [...files.flatMap((file) => checkName(file.path)), ...duplicateBasenames(files)];
}
