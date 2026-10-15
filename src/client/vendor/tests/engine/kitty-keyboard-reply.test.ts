import { describe, expect, test } from 'bun:test';
import { isKittyKeyboardReply } from '../../ghostty-web/engine/kitty-keyboard-reply';

// The one WRITE_PTY reply the binding drops (ADR 042): the kitty keyboard query reply.

const bytes = (s: string) => new TextEncoder().encode(s);

describe('isKittyKeyboardReply', () => {
  test.each([
    ['ESC [ ? 0 u', '\x1b[?0u', true],
    ['ESC [ ? 31 u', '\x1b[?31u', true],
    ['no flags', '\x1b[?u', false],
    ['DECRQM', '\x1b[?2004;2$y', false],
    ['DA', '\x1b[?62;22c', false],
    ['no ?', '\x1b[10u', false],
    ['not ESC', 'x[?1u', false],
    ['not CSI', '\x1bO?1u', false],
    ['a non-digit flag', '\x1b[?1;u', false],
  ])('%s', (_name, reply, kitty) => {
    expect(isKittyKeyboardReply(bytes(reply))).toBe(kitty);
  });
});
