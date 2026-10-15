// What the refactor still tolerates (constants, ADR 059): nothing. Both lists emptied when
// the server and client branches merged, and `strict` makes a stale entry fail, so a new
// entry is a visible, reviewed exception with the step that removes it.

import type { Allowlist } from './ratchet';

/** The allowlist the real tree is checked against. */
export const RATCHET_ALLOWLIST: Allowlist = {
  strict: true,
  sizes: {},
  rules: {},
};
