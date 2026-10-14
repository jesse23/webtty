// Tests for the NDJSON LineSplitter: lines split across chunks, CRLF and blank lines, the
// partial last line, the optional CR strip and the maxLength cap (ADR 062, ADR 063).
import { describe, expect, test } from 'bun:test';
import { LineSplitter } from './ndjson';

describe('LineSplitter', () => {
  test.each([
    ['one line per chunk', ['a\n', 'b\n'], [['a'], ['b']]],
    ['several lines in one chunk', ['a\nb\nc\n'], [['a', 'b', 'c']]],
    ['a line split across chunks', ['{"a"', ':1}\n'], [[], ['{"a":1}']]],
    ['CRLF endings', ['a\r\nb\r\n'], [['a', 'b']]],
    ['empty and bare-CR lines skipped', ['\n\r\na\n\n'], [['a']]],
  ])('%s', (_name, chunks, expected) => {
    const s = new LineSplitter();
    expect(chunks.map((c) => s.push(c))).toEqual(expected);
    expect(s.flush()).toBeNull();
  });

  test('flush returns the partial last line once, CR stripped', () => {
    const s = new LineSplitter();
    expect(s.push('a\nb\r')).toEqual(['a']);
    expect(s.flush()).toBe('b');
    expect(s.flush()).toBeNull();
  });

  test('keeps the CR when asked to', () => {
    const s = new LineSplitter({ stripCarriageReturn: false });
    expect(s.push('a\r\n\r\n')).toEqual(['a\r', '\r']);
    s.push('b\r');
    expect(s.flush()).toBe('b\r');
  });

  test('drops a partial line longer than maxLength, then carries on', () => {
    const s = new LineSplitter({ maxLength: 4 });
    expect(s.push('ok\nabcde')).toEqual(['ok']);
    expect(s.push('f\nnext\n')).toEqual(['f', 'next']);
    s.push('abcd');
    expect(s.flush()).toBe('abcd');
  });
});
