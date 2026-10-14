import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EMPTY_ALLOWLIST } from './architecture/ratchet';
import type { SourceFile } from './architecture/source-file';
import { checkArchitecture, isCheckedFile, readSourceTree, runCheck } from './check-architecture';

const REPO_ROOT = path.join(import.meta.dir, '..');

const file = (filePath: string, ...lines: string[]): SourceFile => ({
  path: filePath,
  text: `${lines.join('\n')}\n`,
});

let tmpRoots: string[] = [];

function tmpTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-arch-'));
  tmpRoots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

afterEach(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
  tmpRoots = [];
});

describe('the real tree', () => {
  test('breaks no rule the ratchet allowlist does not cover', () => {
    const violations = checkArchitecture(readSourceTree(REPO_ROOT));
    expect(violations.map((violation) => violation.message)).toEqual([]);
  });
});

describe('isCheckedFile', () => {
  const cases: [string, boolean][] = [
    ['a.ts', true],
    ['a.test.ts', true],
    ['node-pty.d.ts', false],
    ['less.bin', false],
    ['ghostty-vt-small.wasm', false],
    ['ghostty-vt-small.wasm.json', false],
    ['PROVENANCE.md', false],
    ['client.html', false],
    ['index.css', false],
  ];
  for (const [name, expected] of cases) {
    test(`${name} → ${expected}`, () => expect(isCheckedFile(name)).toBe(expected));
  }
});

describe('readSourceTree', () => {
  test('reads .ts files under src/ and scripts/ only, sorted', () => {
    const root = tmpTree({
      'src/b.ts': 'b',
      'src/a/a.ts': 'a',
      'src/pty/node-pty.d.ts': 'declare',
      'src/client/vendor/tests/fixtures/ls.bin': 'bytes',
      'src/node_modules/x/index.ts': 'skipped',
      'src/.hidden/x.ts': 'skipped',
      'scripts/build.ts': 'build',
      'docs/x.ts': 'not walked',
    });
    expect(readSourceTree(root)).toEqual([
      { path: 'scripts/build.ts', text: 'build' },
      { path: 'src/a/a.ts', text: 'a' },
      { path: 'src/b.ts', text: 'b' },
    ]);
  });

  test('a tree without scripts/ is fine', () => {
    expect(readSourceTree(tmpTree({ 'src/a.ts': '' }))).toEqual([{ path: 'src/a.ts', text: '' }]);
  });
});

describe('checkArchitecture', () => {
  test('runs the size, import, cycle and naming rules together', () => {
    const files = [
      file('src/client/big-file.ts', ...Array<string>(301).fill('')),
      file('src/client/a.ts', "import fs from 'node:fs';", "import { b } from './b';"),
      file('src/client/b.ts', "import { a } from './a';"),
      file('src/client/myFile.ts'),
    ];
    expect(checkArchitecture(files, EMPTY_ALLOWLIST).map((violation) => violation.rule)).toEqual([
      'size',
      'client-node',
      'cycle',
      'kebab-case',
    ]);
  });

  test('an allowlisted file that grows fails', () => {
    const files = [file('src/client/big-file.ts', ...Array<string>(320).fill(''))];
    const allowlist = {
      ...EMPTY_ALLOWLIST,
      sizes: { 'src/client/big-file.ts': { lines: 310, step: 'S' } },
    };
    const [violation] = checkArchitecture(files, allowlist);
    expect(violation.message).toContain('grew from 310 to 320 lines');
  });
});

describe('runCheck', () => {
  test('returns 0 and prints nothing for a clean tree', () => {
    const printed: string[] = [];
    expect(
      runCheck(tmpTree({ 'src/client/output-ack.ts': '' }), (line) => printed.push(line)),
    ).toBe(0);
    expect(printed).toEqual([]);
  });

  test('returns 1 and prints each violation and a total', () => {
    const printed: string[] = [];
    const root = tmpTree({ 'src/client/a.ts': "import fs from 'node:fs';\n" });
    expect(runCheck(root, (line) => printed.push(line))).toBe(1);
    expect(printed).toEqual([
      "client-node: src/client/a.ts:1 imports the Node module 'node:fs'",
      '1 architecture violation(s); see docs/specs/architecture.md',
    ]);
  });
});
