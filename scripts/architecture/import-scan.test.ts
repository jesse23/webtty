import { describe, expect, test } from 'bun:test';
import { isNodeBuiltin, isRelative, resolveImport, scanImports } from './import-scan';

describe('scanImports', () => {
  const cases: [string, string, { specifier: string; typeOnly: boolean; dynamic: boolean }[]][] = [
    [
      'default import',
      "import fs from 'node:fs';",
      [{ specifier: 'node:fs', typeOnly: false, dynamic: false }],
    ],
    [
      'named import',
      "import { a, b } from './x';",
      [{ specifier: './x', typeOnly: false, dynamic: false }],
    ],
    [
      'import type',
      "import type { A } from './x';",
      [{ specifier: './x', typeOnly: true, dynamic: false }],
    ],
    [
      'all inline types',
      "import { type A, type B } from './x';",
      [{ specifier: './x', typeOnly: true, dynamic: false }],
    ],
    [
      'mixed inline types',
      "import { type A, b } from './x';",
      [{ specifier: './x', typeOnly: false, dynamic: false }],
    ],
    [
      'default plus types',
      "import X, { type A } from './x';",
      [{ specifier: './x', typeOnly: false, dynamic: false }],
    ],
    [
      'namespace',
      'import * as ns from "./x";',
      [{ specifier: './x', typeOnly: false, dynamic: false }],
    ],
    [
      're-export',
      "export { a } from './x';",
      [{ specifier: './x', typeOnly: false, dynamic: false }],
    ],
    [
      'export star',
      "export * from './x';",
      [{ specifier: './x', typeOnly: false, dynamic: false }],
    ],
    [
      'export type',
      "export type { A } from './x';",
      [{ specifier: './x', typeOnly: true, dynamic: false }],
    ],
    [
      'multi-line braces',
      "import {\n  a,\n  b,\n} from './x';",
      [{ specifier: './x', typeOnly: false, dynamic: false }],
    ],
    [
      'line comment inside multi-line braces',
      "import {\n  loadConfig, // why: it's import-time\n} from '../config';",
      [{ specifier: '../config', typeOnly: false, dynamic: false }],
    ],
    [
      'block comment inside braces',
      "import { a, /* (webtty, ADR 065) */ b } from './x';",
      [{ specifier: './x', typeOnly: false, dynamic: false }],
    ],
    [
      'commented inline types stay type-only',
      "import {\n  type A, // note\n  type B,\n} from './x';",
      [{ specifier: './x', typeOnly: true, dynamic: false }],
    ],
    [
      'no semicolons: export type does not swallow the next import',
      "export type { A }\nimport x from '../config'",
      [{ specifier: '../config', typeOnly: false, dynamic: false }],
    ],
    [
      'side effect',
      "import './x.css';",
      [{ specifier: './x.css', typeOnly: false, dynamic: false }],
    ],
    [
      'dynamic',
      "const m = await import('./x');",
      [{ specifier: './x', typeOnly: false, dynamic: true }],
    ],
    [
      'typeof import',
      "let m: typeof import('./x');",
      [{ specifier: './x', typeOnly: true, dynamic: true }],
    ],
    [
      'require',
      "const m = require('./x');",
      [{ specifier: './x', typeOnly: false, dynamic: false }],
    ],
    ['prose is not an import', '// copied from the upstream file', []],
    ['code is not an import head', "export const from = 'x';", []],
  ];
  for (const [name, text, expected] of cases) {
    test(name, () => {
      const found = scanImports(text).map(({ specifier, typeOnly, dynamic }) => ({
        specifier,
        typeOnly,
        dynamic,
      }));
      expect(found).toEqual(expected);
    });
  }

  test('reports the line of each import', () => {
    const text = "// header\n\nimport a from './a';\nimport b from './b';\n";
    expect(scanImports(text).map((ref) => ref.line)).toEqual([3, 4]);
  });
});

describe('isNodeBuiltin', () => {
  const cases: [string, boolean][] = [
    ['node:fs', true],
    ['fs', true],
    ['fs/promises', true],
    ['path', true],
    ['ws', false],
    ['bun:test', false],
    ['./fs', false],
    ['@lydell/node-pty', false],
  ];
  for (const [specifier, expected] of cases) {
    test(`${specifier} → ${expected}`, () => expect(isNodeBuiltin(specifier)).toBe(expected));
  }
});

describe('isRelative', () => {
  test('only ./ and ../ are relative', () => {
    expect(['./a', '../a', 'a', '/a', 'node:a'].map(isRelative)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('resolveImport', () => {
  const known = new Set(['src/a.ts', 'src/b/index.ts', 'src/c.ts', 'src/d.test.ts']);
  const cases: [string, string | null][] = [
    ['./a', 'src/a.ts'],
    ['./b', 'src/b/index.ts'],
    ['./c.ts', 'src/c.ts'],
    ['./c.js', 'src/c.ts'],
    ['./d.test', 'src/d.test.ts'],
    ['../outside/x', 'outside/x'],
    ['ws', null],
  ];
  for (const [specifier, expected] of cases) {
    test(`${specifier} from src/z.ts`, () =>
      expect(resolveImport('src/z.ts', specifier, known)).toBe(expected));
  }
});
