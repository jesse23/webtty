import { describe, expect, test } from 'bun:test';
import {
  isTestCode,
  isTestFile,
  isTestSupport,
  type Layer,
  layerOf,
  lineCount,
  stemOf,
} from './source-file';

describe('layerOf', () => {
  const cases: [string, Layer][] = [
    ['src/client/vendor/ghostty-web/terminal.ts', 'vendor'],
    ['src/client/vendor/tests/support/wasm.ts', 'client'],
    ['src/client/output-ack.ts', 'client'],
    ['src/server/app.ts', 'server'],
    ['src/server', 'server'],
    ['src/cli/main.ts', 'cli'],
    ['src/pty/index.ts', 'pty'],
    ['src/pty', 'pty'],
    ['src/config.ts', 'config'],
    ['src/config', 'config'],
    ['src/config/defaults.ts', 'config'],
    ['scripts/build.ts', 'scripts'],
    ['src/version.ts', 'shared'],
    ['src/configuration.ts', 'shared'],
  ];
  for (const [file, layer] of cases) {
    test(`${file} → ${layer}`, () => expect(layerOf(file)).toBe(layer));
  }
});

describe('test code', () => {
  const cases: [string, boolean, boolean, boolean][] = [
    // file, isTestFile, isTestSupport, isTestCode
    ['src/client/output-ack.ts', false, false, false],
    ['src/client/output-ack.test.ts', true, false, true],
    ['src/client/test-support/fake-socket.ts', false, true, true],
    ['src/test-support/server-harness.ts', false, true, true],
    ['src/client/vendor/tests/support/wasm.ts', false, true, true],
    ['src/client/vendor/tests/engine/scratch.test.ts', true, false, true],
    ['src/client/vendor/ghostty-web/glide.ts', false, false, false],
  ];
  for (const [file, testFile, support, code] of cases) {
    test(file, () => {
      expect([isTestFile(file), isTestSupport(file), isTestCode(file)]).toEqual([
        testFile,
        support,
        code,
      ]);
    });
  }
});

describe('stemOf', () => {
  test('drops the folder, .ts and .test', () => {
    expect(['src/a/output-ack.ts', 'src/a/output-ack.test.ts', 'index.ts'].map(stemOf)).toEqual([
      'output-ack',
      'output-ack',
      'index',
    ]);
  });
});

describe('lineCount', () => {
  const cases: [string, number][] = [
    ['', 0],
    ['a', 1],
    ['a\n', 1],
    ['a\nb', 2],
    ['a\nb\n', 2],
    ['\n', 1],
  ];
  for (const [text, count] of cases) {
    test(JSON.stringify(text), () => expect(lineCount(text)).toBe(count));
  }
});
