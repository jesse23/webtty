// Table tests for how `webtty key` shows bytes: the readable form and the `chars` JSON string
// (ADR 063).
import { describe, expect, test } from 'bun:test';
import { bytesToChars, bytesToDisplay } from './key-format';

describe('bytesToDisplay', () => {
  const cases: Array<[string, number[], string]> = [
    ['ESC CR → legacy shift+enter', [0x1b, 0x0d], 'ESC CR'],
    [
      'ESC [ 1 3 ; 2 u → KKP shift+enter',
      [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75],
      'ESC [ 1 3 ; 2 u',
    ],
    ['tab', [0x09], 'TAB'],
    ['line feed', [0x0a], 'LF'],
    ['space', [0x20], 'SPC'],
    ['delete', [0x7f], 'DEL'],
    ['printable ASCII', [0x41, 0x7e], 'A ~'],
    ['an unnamed control byte', [0x00], '\\x00'],
    ['a byte above ASCII', [0xc3], '\\xc3'],
  ];
  for (const [name, bytes, expected] of cases) {
    test(name, () => {
      expect(bytesToDisplay(Buffer.from(bytes))).toBe(expected);
    });
  }
});

describe('bytesToChars', () => {
  const cases: Array<[string, number[], string]> = [
    ['ESC CR → legacy shift+enter', [0x1b, 0x0d], '"\\u001b\\r"'],
    [
      'ESC [ 1 3 ; 2 u → KKP shift+enter',
      [0x1b, 0x5b, 0x31, 0x33, 0x3b, 0x32, 0x75],
      '"\\u001b[13;2u"',
    ],
    ['printable ASCII passes through', [...Buffer.from('hello')], '"hello"'],
    ['tab', [0x09], '"\\t"'],
    ['line feed', [0x0a], '"\\n"'],
    ['double quote (a valid JSON escape)', [0x22], '"\\""'],
    ['backslash (a valid JSON escape)', [0x5c], '"\\\\"'],
    ['other control byte → \\uXXXX', [0x00], '"\\u0000"'],
    ['delete → \\u007f', [0x7f], '"\\u007f"'],
  ];
  for (const [name, bytes, expected] of cases) {
    test(name, () => {
      expect(bytesToChars(Buffer.from(bytes))).toBe(expected);
    });
  }

  test('every output is a JSON string that parses back to the input', () => {
    const bytes = Buffer.from([0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x22, 0x41, 0x5c, 0x7f]);
    expect(JSON.parse(bytesToChars(bytes))).toBe(bytes.toString('latin1'));
  });
});
