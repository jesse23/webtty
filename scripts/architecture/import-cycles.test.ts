import { describe, expect, test } from 'bun:test';
import { checkCycles, findCycles, runtimeImportGraph } from './import-cycles';
import type { SourceFile } from './source-file';

const file = (path: string, ...lines: string[]): SourceFile => ({
  path,
  text: `${lines.join('\n')}\n`,
});

describe('runtimeImportGraph', () => {
  test('keeps value imports of files in the tree only', () => {
    const graph = runtimeImportGraph([
      file(
        'src/a.ts',
        "import { b } from './b';",
        "import type { C } from './c';",
        "const d = await import('./d');",
        "import fs from 'node:fs';",
        "import { e } from './e.test';",
      ),
      file('src/b.ts'),
      file('src/c.ts'),
      file('src/d.ts'),
      file('src/e.test.ts', "import { a } from './a';"),
    ]);
    expect(graph.get('src/a.ts')).toEqual(['src/b.ts']);
    expect(graph.has('src/e.test.ts')).toBe(false);
  });
});

describe('findCycles', () => {
  const cases: [string, Record<string, string[]>, string[][]][] = [
    ['no cycle', { a: ['b'], b: ['c'], c: [] }, []],
    ['two files', { a: ['b'], b: ['a'] }, [['a', 'b']]],
    ['three files', { a: ['b'], b: ['c'], c: ['a'] }, [['a', 'b', 'c']]],
    ['self import', { a: ['a'] }, [['a']]],
    [
      'two separate cycles',
      { a: ['b'], b: ['a'], c: ['d'], d: ['c'] },
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ],
    ['diamond', { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] }, []],
    ['edge to a file outside the graph', { a: ['z'] }, []],
  ];
  for (const [name, edges, expected] of cases) {
    test(name, () => {
      const found = findCycles(new Map(Object.entries(edges)));
      expect(found.sort((x, y) => x[0].localeCompare(y[0]))).toEqual(expected);
    });
  }
});

describe('checkCycles', () => {
  test('reports a runtime cycle once, keyed by its sorted members', () => {
    const violations = checkCycles([
      file('src/b.ts', "import { a } from './a';"),
      file('src/a.ts', "import { b } from './b';"),
    ]);
    expect(violations).toEqual([
      {
        rule: 'cycle',
        file: 'src/a.ts',
        key: 'cycle src/a.ts src/b.ts',
        message: 'runtime import cycle: src/a.ts → src/b.ts',
      },
    ]);
  });

  test('a cycle through a type import is not a runtime cycle', () => {
    const violations = checkCycles([
      file('src/a.ts', "import { b } from './b';"),
      file('src/b.ts', "import type { A } from './a';"),
    ]);
    expect(violations).toEqual([]);
  });
});
