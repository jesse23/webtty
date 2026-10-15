import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  coverageFailures,
  coverageLayerOf,
  type FileCoverage,
  formatLayer,
  LAYER_TARGETS,
  NOT_LOADED,
  PURE_MODULES,
  parseLcov,
  ratio,
  runCoverageCheck,
  sourceFiles,
  totalsByLayer,
} from './check-coverage';

const REPO_ROOT = path.join(import.meta.dir, '..');

const covered = (file: string, lines = 10, functions = 2): FileCoverage => ({
  file,
  linesFound: lines,
  linesHit: lines,
  functionsFound: functions,
  functionsHit: functions,
});

/** Every pure module fully covered, so a test sees only the failure it sets up. */
const allPure = (): FileCoverage[] => PURE_MODULES.map((file) => covered(file));

const lcov = (...records: FileCoverage[]): string =>
  records
    .map((r) =>
      [
        `SF:${r.file}`,
        'FN:1,f',
        `FNF:${r.functionsFound}`,
        `FNH:${r.functionsHit}`,
        'DA:1,1',
        `LF:${r.linesFound}`,
        `LH:${r.linesHit}`,
        'end_of_record',
      ].join('\n'),
    )
    .join('\n');

let tmpRoots: string[] = [];

function tmpRepo(report?: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-cov-'));
  tmpRoots.push(root);
  if (report !== undefined) {
    fs.mkdirSync(path.join(root, 'coverage'));
    fs.writeFileSync(path.join(root, 'coverage', 'lcov.info'), report);
  }
  return root;
}

afterEach(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
  tmpRoots = [];
});

describe('parseLcov', () => {
  test('reads each record with its line and function counts', () => {
    const record = {
      file: 'src/a.ts',
      linesFound: 4,
      linesHit: 3,
      functionsFound: 2,
      functionsHit: 1,
    };
    expect(parseLcov(lcov(record), '/repo')).toEqual([record]);
  });

  test('makes absolute paths relative to the root', () => {
    const [file] = parseLcov('SF:/repo/src/b.ts\nLF:1\nLH:1\nend_of_record\n', '/repo');
    expect(file?.file).toBe('src/b.ts');
  });

  test('a record without end_of_record, and stray lines, are dropped', () => {
    expect(parseLcov('TN:\nLF:3\nSF:src/c.ts\nLF:2\n', '/repo')).toEqual([]);
  });

  test('missing counters read as zero', () => {
    expect(parseLcov('SF:src/d.ts\nend_of_record', '/repo')).toEqual([
      { file: 'src/d.ts', linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0 },
    ]);
  });
});

describe('coverageLayerOf', () => {
  const cases: [string, string | undefined][] = [
    ['src/client/vendor/ghostty-web/terminal.ts', 'vendor'],
    ['src/client/vendor/tests/support/wasm.ts', undefined],
    ['src/client/app/start-client.ts', 'client'],
    ['src/client/test-support/fake-socket.ts', undefined],
    ['src/client/features/kitty/graphics/test-support/graphics-harness.ts', undefined],
    ['src/server/app.ts', 'server'],
    ['src/server/app.test.ts', undefined],
    ['src/cli/main.ts', 'cli'],
    ['src/config/index.ts', 'config'],
    ['src/pty/index.ts', 'pty'],
    ['src/runtime.ts', 'shared'],
    ['src/test-support/fake-pty.ts', undefined],
    ['scripts/build.ts', undefined],
  ];
  for (const [file, layer] of cases) {
    test(`${file} → ${layer}`, () => {
      expect(coverageLayerOf(file)?.name).toBe(layer);
    });
  }
});

describe('the targets (architecture SPEC "Testing")', () => {
  test('vendor 85/80, every other layer 95/90', () => {
    for (const layer of LAYER_TARGETS) {
      const expected = layer.name === 'vendor' ? [0.85, 0.8] : [0.95, 0.9];
      expect([layer.lines, layer.functions]).toEqual(expected);
    }
  });

  test('every pure module exists and belongs to a layer', () => {
    for (const file of PURE_MODULES) {
      expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
      expect(coverageLayerOf(file)).toBeDefined();
    }
  });
});

describe('ratio', () => {
  test('a share of what was found; nothing found is all of it', () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratio(0, 0)).toBe(1);
  });
});

describe('totalsByLayer and formatLayer', () => {
  test('sums each layer and skips test code', () => {
    const totals = totalsByLayer([
      covered('src/server/a.ts', 10, 2),
      { ...covered('src/server/b.ts', 10, 2), linesHit: 5, functionsHit: 1 },
      covered('src/server/c.test.ts', 100, 100),
    ]);
    const server = totals.find((layer) => layer.name === 'server');
    expect(server?.totals).toEqual({
      linesFound: 20,
      linesHit: 15,
      functionsFound: 4,
      functionsHit: 3,
    });
    expect(totals.map((layer) => layer.name)).toEqual(LAYER_TARGETS.map((layer) => layer.name));
    expect(server && formatLayer(server)).toBe(
      'server   lines  75.00% (≥ 95.00%)  functions  75.00% (≥ 90.00%)',
    );
  });
});

describe('coverageFailures', () => {
  test('none when every layer and pure module meets its target', () => {
    expect(coverageFailures(allPure())).toEqual([]);
  });

  test('a layer under its line or function share', () => {
    const low = { ...covered('src/cli/x.ts', 100, 10), linesHit: 90, functionsHit: 8 };
    expect(coverageFailures([...allPure(), low])).toEqual([
      'cli: lines 92.31% < 95.00%',
      'cli: functions 87.50% < 90.00%',
    ]);
  });

  test('the vendor layer passes at its lower share', () => {
    const vendor = {
      ...covered('src/client/vendor/ghostty-web/x.ts', 100, 10),
      linesHit: 90,
      functionsHit: 9,
    };
    expect(coverageFailures([...allPure(), vendor])).toEqual([]);
  });

  test('a pure module not at 100% lines, or not loaded at all', () => {
    const [partial, missing] = PURE_MODULES;
    const files = allPure()
      .filter((file) => file.file !== missing)
      .map((file) => (file.file === partial ? { ...file, linesHit: 9 } : file));
    expect(coverageFailures(files)).toEqual([
      `${partial}: pure module at 9/10 lines, not 100%`,
      `${missing}: pure module not loaded by any test`,
    ]);
  });
});

describe('source files no test loads', () => {
  const cases: [string, string[], string[]][] = [
    // name, sources, failures
    ['a loaded source passes', ['src/server/a.ts'], []],
    [
      'a source with no record fails',
      ['src/server/new.ts'],
      ['src/server/new.ts: not loaded by any test (add a test, or list it in NOT_LOADED)'],
    ],
    ['a listed type-only module or entry passes', [...NOT_LOADED], []],
  ];
  for (const [name, sources, failures] of cases) {
    test(name, () => {
      expect(coverageFailures([...allPure(), covered('src/server/a.ts')], sources)).toEqual(
        failures,
      );
    });
  }

  test('every NOT_LOADED entry exists and counts toward a layer', () => {
    for (const file of NOT_LOADED) {
      expect(fs.existsSync(path.join(REPO_ROOT, file))).toBe(true);
      expect(coverageLayerOf(file)).toBeDefined();
    }
  });

  test('sourceFiles lists src/ .ts sources, skipping test code and .d.ts', () => {
    const root = tmpRepo();
    for (const file of [
      'src/a.ts',
      'src/server/b.ts',
      'src/server/b.test.ts',
      'src/server/test-support/fake.ts',
      'src/client/types.d.ts',
      'src/client/c.css',
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), '');
    }
    expect(sourceFiles(root)).toEqual(['src/a.ts', 'src/server/b.ts']);
    expect(sourceFiles(tmpRepo())).toEqual([]);
  });

  test('runCoverageCheck fails on a source file missing from the report', () => {
    const root = tmpRepo(lcov(...allPure()));
    fs.mkdirSync(path.join(root, 'src', 'pty'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'pty', 'x.ts'), '');
    const lines: string[] = [];
    expect(runCoverageCheck(root, (line) => lines.push(line))).toBe(1);
    expect(lines).toContain(
      'coverage: src/pty/x.ts: not loaded by any test (add a test, or list it in NOT_LOADED)',
    );
  });
});

describe('runCoverageCheck', () => {
  test('fails with a hint when there is no report', () => {
    const lines: string[] = [];
    expect(runCoverageCheck(tmpRepo(), (line) => lines.push(line))).toBe(1);
    expect(lines[0]).toEndWith('not found; run bun test --coverage --coverage-reporter=lcov first');
  });

  test('prints each layer and passes when the targets are met', () => {
    const lines: string[] = [];
    expect(runCoverageCheck(tmpRepo(lcov(...allPure())), (line) => lines.push(line))).toBe(0);
    expect(lines).toHaveLength(LAYER_TARGETS.length + 1);
    expect(lines.at(-1)).toBe(
      `coverage targets met (${PURE_MODULES.length} pure modules at 100% lines)`,
    );
  });

  test('prints each failure and returns 1', () => {
    const lines: string[] = [];
    const report = lcov(...allPure(), { ...covered('src/pty/x.ts'), linesHit: 0 });
    expect(runCoverageCheck(tmpRepo(report), (line) => lines.push(line))).toBe(1);
    expect(lines).toContain('coverage: pty: lines 0.00% < 95.00%');
    expect(lines.at(-1)).toStartWith('1 coverage target(s) missed');
  });
});
