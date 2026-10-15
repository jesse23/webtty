import { describe, expect, test } from 'bun:test';
import { ControlScanner, clearsPlacements } from './control-scanner';

describe('placement clearing', () => {
  test.each(['\x1b[2J', '\x1b[3J', '\x1b[?1049h', '\x1b[?1049l', '\x1b[?47h', '\x1bc'])(
    '%j clears',
    (seq) => {
      expect(clearsPlacements(`text${seq}more`)).toBe(true);
    },
  );

  test.each(['\x1b[J', '\x1b[1J', '\x1b[?25h', '\x1b[2K', 'plain'])('%j does not', (seq) => {
    expect(clearsPlacements(seq)).toBe(false);
  });
});

describe('ControlScanner', () => {
  test('a clear split across chunks is seen once it completes', () => {
    const s = new ControlScanner();
    expect(s.scan('text\x1b[')).toBe(false);
    expect(s.scan('2Jmore')).toBe(true);
  });

  test('split at every position', () => {
    const full = 'a\x1b[?1049hb\x1b[16tc';
    for (let cut = 1; cut < full.length; cut++) {
      const s = new ControlScanner();
      const a = s.scan(full.slice(0, cut));
      const b = s.scan(full.slice(cut));
      expect(a || b).toBe(true);
    }
  });

  test('a lone trailing ESC is carried, so ESC c split in two is a reset', () => {
    const s = new ControlScanner();
    expect(s.scan('x\x1b')).toBe(false);
    expect(s.scan('cy')).toBe(true);
  });

  test('a completed sequence is not counted again with the next chunk', () => {
    const s = new ControlScanner();
    expect(s.scan('\x1b[2J')).toBe(true);
    expect(s.scan('plain')).toBe(false);
  });

  test('an unrelated unfinished sequence is dropped once it turns into something else', () => {
    const s = new ControlScanner();
    s.scan('\x1b[3');
    expect(s.scan('1m text')).toBe(false);
    expect(s.scan('plain')).toBe(false);
  });
});
