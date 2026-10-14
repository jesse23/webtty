// Finds the import specifiers in a TypeScript file with plain pattern matching and
// resolves relative ones against the tree (util, ADR 059: no parser dependency).

import { builtinModules } from 'node:module';
import path from 'node:path';

/** One import, re-export, dynamic `import()` or `require()` found in a file. */
export interface ImportRef {
  specifier: string;
  /** 1-based line of the statement, for messages. */
  line: number;
  /** Erased at build time: `import type`, `export type`, all-`type` braces, `typeof import()`. */
  typeOnly: boolean;
  /** A dynamic `import()`, which loads lazily and so cannot form an init-order cycle. */
  dynamic: boolean;
}

// An import or re-export head holds only names, braces, commas, `*` and `as`; keeping
// `;`, `=`, `(` and quotes out of it stops a match from running into ordinary code.
const STATIC_RE =
  /^[ \t]*(import|export)\s+(type\s+)?([\w$\s{},*]*?)\s*from\s*['"]([^'"\n]+)['"]/gm;
const SIDE_EFFECT_RE = /^[ \t]*import\s*['"]([^'"\n]+)['"]/gm;
const DYNAMIC_RE = /(\btypeof\s+)?\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < index; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** `{ type A, type B }`: every named binding is a type, so the import is erased. */
function allInlineTypes(head: string): boolean {
  const braces = /^\{([\s\S]*)\}$/.exec(head.trim());
  if (!braces) return false;
  const names = braces[1]
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => name.startsWith('type '));
}

/** Every import specifier in `text`, in no particular order. */
export function scanImports(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const m of text.matchAll(STATIC_RE)) {
    const typeOnly = m[2] !== undefined || allInlineTypes(m[3]);
    refs.push({ specifier: m[4], line: lineAt(text, m.index), typeOnly, dynamic: false });
  }
  for (const m of text.matchAll(SIDE_EFFECT_RE)) {
    refs.push({ specifier: m[1], line: lineAt(text, m.index), typeOnly: false, dynamic: false });
  }
  for (const m of text.matchAll(DYNAMIC_RE)) {
    const typeOnly = m[1] !== undefined;
    refs.push({ specifier: m[2], line: lineAt(text, m.index), typeOnly, dynamic: true });
  }
  for (const m of text.matchAll(REQUIRE_RE)) {
    refs.push({ specifier: m[1], line: lineAt(text, m.index), typeOnly: false, dynamic: false });
  }
  return refs;
}

// Bun's list also names its own modules and the npm packages it ships built in.
const NOT_NODE = new Set(['bun', 'ws', 'undici']);
const BUILTINS = new Set(
  builtinModules.filter((name) => !NOT_NODE.has(name) && !name.startsWith('bun:')),
);

/** A Node built-in, with or without the `node:` prefix (`fs/promises` counts). */
export function isNodeBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0]);
}

/** A path relative to the importing file, as opposed to a package or built-in. */
export function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * The repo-relative path a relative specifier points at: the `.ts` file or folder
 * `index.ts` when it is in `known`, else the bare joined path (a `.d.ts`, a wasm, a
 * missing file), which still says which layer it is in. Packages resolve to null.
 */
export function resolveImport(
  from: string,
  specifier: string,
  known: ReadonlySet<string>,
): string | null {
  if (!isRelative(specifier)) return null;
  const base = path.posix.join(path.posix.dirname(from), specifier);
  const candidates = [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, '.ts')];
  return candidates.find((candidate) => known.has(candidate)) ?? base;
}
