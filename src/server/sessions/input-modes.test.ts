// Tests for InputModes: which DEC private modes it follows through the output, across chunk
// boundaries and resets, and the one DECSET it restores them with (ADR 070).
import { describe, expect, test } from 'bun:test';
import { INPUT_MODES, InputModes } from './input-modes';

/** An InputModes that has read `chunks` in order. */
function after(...chunks: string[]): InputModes {
  const modes = new InputModes();
  for (const chunk of chunks) modes.observe(chunk);
  return modes;
}

describe('InputModes', () => {
  test('restores nothing before any mode is set', () => {
    expect(after().restore()).toBe('');
    expect(after('plain text\r\n').restore()).toBe('');
  });

  test('restores bracketed paste once the output sets it', () => {
    expect(after('\x1b[?2004h').restore()).toBe('\x1b[?2004h');
  });

  test('a later reset wins over an earlier set', () => {
    expect(after('\x1b[?2004h', 'text', '\x1b[?2004l').restore()).toBe('');
    expect(after('\x1b[?2004l\x1b[?2004h').restore()).toBe('\x1b[?2004h');
  });

  test('reads every mode in a multi-parameter sequence, and restores them in table order', () => {
    expect(after('\x1b[?2004;1006;1000;1004h').restore()).toBe('\x1b[?1000;1004;1006;2004h');
    expect(after('\x1b[?1000;1006h', '\x1b[?1000l').restore()).toBe('\x1b[?1006h');
  });

  test('ignores display modes such as the alternate screen and cursor visibility', () => {
    expect(after('\x1b[?1049h\x1b[?25l\x1b[?7h').restore()).toBe('');
  });

  test('ignores sequences that are not DEC private modes', () => {
    expect(after('\x1b[2004h\x1b[4h\x1b[1;2H\x1b[31m').restore()).toBe('');
  });

  test('follows every tracked mode', () => {
    const all = INPUT_MODES.join(';');
    expect(after(`\x1b[?${all}h`).restore()).toBe(`\x1b[?${all}h`);
  });

  test('a sequence split across chunks is still read', () => {
    expect(after('abc\x1b', '[?2004h').restore()).toBe('\x1b[?2004h');
    expect(after('\x1b[', '?20', '04h').restore()).toBe('\x1b[?2004h');
    expect(after('\x1b[?2004h', 'x\x1b[?20', '04l').restore()).toBe('');
  });

  test('a lone ESC that is not a partial sequence is not carried', () => {
    expect(after('\x1b[31', '?2004h').restore()).toBe('');
    expect(after('\x1bO', '[?2004h').restore()).toBe('');
  });

  test('RIS clears every mode', () => {
    expect(after('\x1b[?2004;1000h', '\x1bc').restore()).toBe('');
    expect(after('\x1b[?2004h\x1bc\x1b[?1004h').restore()).toBe('\x1b[?1004h');
  });

  test('DECSTR resets application cursor keys only', () => {
    expect(after('\x1b[?1;2004h', '\x1b[!p').restore()).toBe('\x1b[?2004h');
  });

  test('a chunk with no ESC leaves the modes as they were', () => {
    const modes = after('\x1b[?2004h');
    modes.observe('x'.repeat(1000));
    expect(modes.restore()).toBe('\x1b[?2004h');
  });
});
