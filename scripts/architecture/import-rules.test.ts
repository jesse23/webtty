import { describe, expect, test } from 'bun:test';
import { checkImports, IMPORT_RULES } from './import-rules';
import type { SourceFile } from './source-file';

const file = (path: string, ...lines: string[]): SourceFile => ({
  path,
  text: `${lines.join('\n')}\n`,
});

// Files the fixtures import, so relative specifiers resolve as they do in the tree.
const TREE = [
  file('src/server/flow.ts'),
  file('src/cli/http.ts'),
  file('src/pty/index.ts'),
  file('src/config.ts'),
  file('src/client/ack.ts'),
  file('src/client/vendor/ghostty-web/index.ts'),
  file('src/client/vendor/ghostty-web/glide.ts'),
  file('src/client/vendor/ghostty-web/terminal.ts'),
  file('src/client/vendor/ghostty-web/core/host-types.ts'),
  file('src/client/features/find/find-bar.ts'),
  file('src/helpers.test.ts'),
];

function rulesBroken(path: string, line: string): string[] {
  return checkImports([...TREE, file(path, line)])
    .filter((violation) => violation.file === path)
    .map((violation) => violation.rule);
}

describe('checkImports', () => {
  const cases: [string, string, string, string[]][] = [
    ['node in the client', 'src/client/a.ts', "import fs from 'node:fs';", ['client-node']],
    [
      'bare node built-in in the vendor',
      'src/client/vendor/ghostty-web/a.ts',
      "const fs = await import('fs/promises');",
      ['client-node'],
    ],
    [
      'client imports the server',
      'src/client/a.ts',
      "import { x } from '../server/flow';",
      ['client-server'],
    ],
    [
      'client imports the CLI',
      'src/client/a.ts',
      "import { x } from '../cli/http';",
      ['client-server'],
    ],
    [
      'client imports the PTY',
      'src/client/a.ts',
      "import type { P } from '../pty';",
      ['client-server'],
    ],
    [
      'client imports config values',
      'src/client/a.ts',
      "import { loadConfig } from '../config';",
      ['client-config-value'],
    ],
    [
      'client imports config values in commented multi-line braces',
      'src/client/a.ts',
      "import {\n  loadConfig, // why\n} from '../config';",
      ['client-config-value'],
    ],
    [
      'client without semicolons imports config values after a type re-export',
      'src/client/a.ts',
      "export type { Config } from '../config'\nimport { loadConfig } from '../config'",
      ['client-config-value'],
    ],
    [
      'client imports config types',
      'src/client/a.ts',
      "import type { Config } from '../config';",
      [],
    ],
    [
      'server imports the client',
      'src/server/a.ts',
      "import { OutputAck } from '../client/ack';",
      ['server-client'],
    ],
    [
      'config imports the vendor',
      'src/config/a.ts',
      "import type { T } from '../client/vendor/ghostty-web';",
      ['server-client'],
    ],
    [
      'cli imports the server',
      'src/cli/a.ts',
      "import { x } from '../server/flow';",
      ['cli-server'],
    ],
    ['server imports the pty', 'src/server/a.ts', "import { spawnPty } from '../pty';", []],
    [
      'vendor imports app code',
      'src/client/vendor/ghostty-web/a.ts',
      "import { OutputAck } from '../../ack';",
      ['vendor-outside'],
    ],
    [
      'vendor imports a package',
      'src/client/vendor/ghostty-web/a.ts',
      "import x from 'left-pad';",
      ['vendor-outside'],
    ],
    [
      'vendor imports itself',
      'src/client/vendor/ghostty-web/a.ts',
      "import { Glide } from './glide';",
      [],
    ],
    [
      'deep vendor import',
      'src/client/a.ts',
      "import { Glide } from './vendor/ghostty-web/glide';",
      ['vendor-deep'],
    ],
    [
      'deep vendor type import',
      'src/client/a.ts',
      "import type { Glide } from './vendor/ghostty-web/glide';",
      ['vendor-deep'],
    ],
    ['barrel import', 'src/client/a.ts', "import { Terminal } from './vendor/ghostty-web';", []],
    [
      'feature imports a feature',
      'src/client/features/scroll/a.ts',
      "import { FindBar } from '../find/find-bar';",
      ['feature-feature'],
    ],
    [
      'feature imports its own folder',
      'src/client/features/find/a.ts',
      "import { FindBar } from './find-bar';",
      [],
    ],
    [
      'app module imports a feature',
      'src/client/app/platform.ts',
      "import { FindBar } from '../features/find/find-bar';",
      ['below-feature'],
    ],
    [
      'connection module imports a feature',
      'src/client/connection/a.ts',
      "import type { FindBar } from '../features/find/find-bar';",
      ['below-feature'],
    ],
    [
      'the composition root imports a feature',
      'src/client/app/start-client.ts',
      "import { FindBar } from '../features/find/find-bar';",
      [],
    ],
    [
      'split part imports a facade',
      'src/client/vendor/ghostty-web/core/a.ts',
      "import { Terminal } from '../terminal';",
      ['facade-value-import'],
    ],
    [
      'split part imports a facade type',
      'src/client/vendor/ghostty-web/core/a.ts',
      "import type { Terminal } from '../terminal';",
      [],
    ],
    [
      'split part imports a host type',
      'src/client/vendor/ghostty-web/core/a.ts',
      "import type { TerminalHost } from './host-types';",
      [],
    ],
    ['source imports a test', 'src/a.ts', "import { h } from './helpers.test';", ['test-import']],
    [
      'test imports a test',
      'src/a.test.ts',
      "import { h } from './helpers.test';",
      ['test-import'],
    ],
    [
      'client test imports the server',
      'src/client/a.test.ts',
      "import { x } from '../server/flow';",
      [],
    ],
    [
      'vendor test deep-imports',
      'src/client/vendor/tests/a.test.ts',
      "import { Glide } from '../ghostty-web/glide';",
      [],
    ],
    [
      'client test-support uses node',
      'src/client/test-support/a.ts',
      "import fs from 'node:fs';",
      [],
    ],
    [
      'vendor test support uses node',
      'src/client/vendor/tests/support/wasm.ts',
      "import fs from 'node:fs';",
      [],
    ],
    ['server uses node', 'src/server/a.ts', "import fs from 'node:fs';", []],
  ];
  for (const [name, path, line, expected] of cases) {
    test(name, () => expect(rulesBroken(path, line)).toEqual(expected));
  }

  test('keys a violation by rule, file and target, and says where it is', () => {
    const [violation] = checkImports([
      ...TREE,
      file('src/client/a.ts', '', "import { x } from '../server/flow';"),
    ]);
    expect(violation.key).toBe('client-server src/client/a.ts -> src/server/flow.ts');
    expect(violation.message).toStartWith('src/client/a.ts:2 imports src/server/flow.ts');
  });

  test('every rule has a distinct id', () => {
    const ids = IMPORT_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
