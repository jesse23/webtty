// What the refactor still tolerates (constants, ADR 059): each file over its size limit
// at the commit that added the checker, with its line count, and each rule broken then,
// with the step that removes it. Entries may only be removed or lowered; the merge of
// the server and client branches empties both lists and sets `strict`.

import type { Allowlist } from './ratchet';

const SERVER_HARNESS =
  'server track: src/utils.test.ts becomes src/test-support/server-harness.ts (ADR 064)';
const CLI_COMMANDS = 'server track: CLI command modules (ADR 063)';

/** The allowlist the real tree is checked against. */
export const RATCHET_ALLOWLIST: Allowlist = {
  strict: false,
  sizes: {
    'src/cli/commands.test.ts': { lines: 1020, step: CLI_COMMANDS },
    'src/cli/commands.ts': { lines: 369, step: CLI_COMMANDS },
    'src/client/vendor/ghostty-web/terminal.ts': {
      lines: 1248,
      step: 'vendor terminal split into core/ (ADR 061)',
    },
    'src/config.ts': { lines: 369, step: 'server track: src/config/ split (ADR 062)' },
    'src/server/routes.ts': { lines: 485, step: 'server track: routes/ and http/ (ADR 062)' },
  },
  rules: {
    'test-import src/cli/commands.test.ts -> src/utils.test.ts': SERVER_HARNESS,
    'test-import src/server/routes.test.ts -> src/utils.test.ts': SERVER_HARNESS,
    'test-import src/server/websocket.test.ts -> src/utils.test.ts': SERVER_HARNESS,
    'test-import src/version.test.ts -> src/utils.test.ts': SERVER_HARNESS,
    'banned-name src/utils.test.ts': SERVER_HARNESS,
    'banned-name src/pty/types.ts': 'server track: pty/pty-process.ts (ADR 062)',
    'banned-name src/client/vendor/ghostty-web/types.ts':
      'V15: the vendor types.ts shim is removed (ADR 061)',
  },
};
