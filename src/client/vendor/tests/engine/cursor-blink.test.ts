import { describe, expect, test } from 'bun:test';
import { scanCursorBlink } from '../../ghostty-web/engine/cursor-blink';

// The cursor blink scan (ADR 049): the last DECSCUSR, DECSTR or RIS in output, across chunks.

describe('scanCursorBlink', () => {
  test.each([
    { name: 'plain text', data: 'hello', ps: undefined, carry: '' },
    { name: 'DECSCUSR Ps', data: 'a\x1b[5 qb', ps: 5, carry: '' },
    { name: 'DECSCUSR with no Ps is 0', data: '\x1b[ q', ps: 0, carry: '' },
    { name: 'DECSTR is 0', data: '\x1b[2 q\x1b[!p', ps: 0, carry: '' },
    { name: 'RIS is 0', data: '\x1b[1 q\x1bc', ps: 0, carry: '' },
    { name: 'the last one wins', data: '\x1b[1 q\x1b[4 q', ps: 4, carry: '' },
    { name: 'a Ps over 6 is ignored', data: '\x1b[3 q\x1b[7 q', ps: 3, carry: '' },
    { name: 'an unfinished sequence is carried', data: 'x\x1b[2', ps: undefined, carry: '\x1b[2' },
    { name: 'a lone ESC is carried', data: 'x\x1b', ps: undefined, carry: '\x1b' },
    { name: 'a finished other sequence is not', data: 'x\x1b[2J', ps: undefined, carry: '' },
    { name: 'a long tail is not', data: '\x1b[1234 ', ps: undefined, carry: '' },
  ])('$name', ({ data, ps, carry }) => {
    expect(scanCursorBlink(data)).toEqual({ ps, carry });
  });

  test('a sequence split across chunks is found with the carry', () => {
    const first = scanCursorBlink('out\x1b[6');
    expect(first).toEqual({ ps: undefined, carry: '\x1b[6' });
    expect(scanCursorBlink(' qmore', first.carry)).toEqual({ ps: 6, carry: '' });
  });

  test('a split DECSTR is found too', () => {
    const first = scanCursorBlink('\x1b[!');
    expect(first.carry).toBe('\x1b[!');
    expect(scanCursorBlink('p', first.carry).ps).toBe(0);
  });
});
