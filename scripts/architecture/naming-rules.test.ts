import { describe, expect, test } from 'bun:test';
import { checkNaming } from './naming-rules';

const named = (...paths: string[]) => paths.map((path) => ({ path, text: '' }));

function rulesBroken(...paths: string[]): string[] {
  return checkNaming(named(...paths)).map((violation) => `${violation.rule} ${violation.file}`);
}

describe('checkNaming', () => {
  const cases: [string, string, string[]][] = [
    ['kebab-case file', 'src/client/output-ack.ts', []],
    ['kebab-case test', 'src/client/output-ack.test.ts', []],
    ['camelCase file', 'src/client/outputAck.ts', ['kebab-case src/client/outputAck.ts']],
    ['snake_case file', 'src/client/output_ack.ts', ['kebab-case src/client/output_ack.ts']],
    [
      'capitalised folder',
      'src/client/Layout/fitter.ts',
      ['kebab-case src/client/Layout/fitter.ts'],
    ],
    ['utils.ts', 'src/server/utils.ts', ['banned-name src/server/utils.ts']],
    ['utils.test.ts', 'src/utils.test.ts', ['banned-name src/utils.test.ts']],
    ['helpers.ts', 'src/cli/helpers.ts', ['banned-name src/cli/helpers.ts']],
    ['misc.ts', 'scripts/misc.ts', ['banned-name scripts/misc.ts']],
    ['types.ts', 'src/pty/types.ts', ['banned-name src/pty/types.ts']],
    ['common folder', 'src/client/common/x.ts', ['banned-name src/client/common/x.ts']],
    ['a types file named for its subject', 'src/client/engine-types.ts', []],
    ['client entry', 'src/client/index.ts', []],
    ['vendor barrel', 'src/client/vendor/ghostty-web/index.ts', []],
    ['pty facade and its test', 'src/pty/index.test.ts', []],
    [
      'index.ts in a domain folder',
      'src/client/layout/index.ts',
      ['index-file src/client/layout/index.ts'],
    ],
    ['test helper', 'src/client/test-support/fake-socket.ts', []],
    [
      'test helper named *.test.ts',
      'src/client/test-support/fake-socket.test.ts',
      ['test-support-name src/client/test-support/fake-socket.test.ts'],
    ],
    [
      'vendor test helper named *.test.ts',
      'src/client/vendor/tests/support/wasm.test.ts',
      ['test-support-name src/client/vendor/tests/support/wasm.test.ts'],
    ],
  ];
  for (const [name, path, expected] of cases) {
    test(name, () => expect(rulesBroken(path)).toEqual(expected));
  }

  test('client source basenames are unique', () => {
    expect(rulesBroken('src/client/fit.ts', 'src/client/vendor/ghostty-web/addons/fit.ts')).toEqual(
      [
        'duplicate-basename src/client/fit.ts',
        'duplicate-basename src/client/vendor/ghostty-web/addons/fit.ts',
      ],
    );
  });

  test('tests, index files and other layers may share a basename', () => {
    expect(
      rulesBroken(
        'src/client/a/x.test.ts',
        'src/client/b/x.test.ts',
        'src/client/index.ts',
        'src/client/vendor/ghostty-web/index.ts',
        'src/server/session.ts',
        'src/client/session.ts',
      ),
    ).toEqual([]);
  });

  test('a duplicate names the other file', () => {
    const [violation] = checkNaming(named('src/client/a/x.ts', 'src/client/b/x.ts'));
    expect(violation.message).toBe('src/client/a/x.ts shares its name with src/client/b/x.ts');
    expect(violation.key).toBe('duplicate-basename src/client/a/x.ts');
  });
});
