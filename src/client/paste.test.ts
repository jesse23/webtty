import { describe, expect, test } from 'bun:test';
import { encodePaste } from './paste';

describe('encodePaste', () => {
  test('sends single-line text literally in either mode', () => {
    expect(encodePaste('hello', false)).toBe('hello');
    expect(encodePaste('hello', true)).toBe('hello');
  });

  test('brackets multiline text only when mode 2004 is on', () => {
    expect(encodePaste('one\ntwo', true)).toBe('\x1b[200~one\ntwo\x1b[201~');
    expect(encodePaste('one\r\ntwo', true)).toBe('\x1b[200~one\r\ntwo\x1b[201~');
  });

  test('sends multiline text rather than Ctrl+V or bracket delimiters when mode 2004 is off', () => {
    expect(encodePaste('one\ntwo', false)).toBe('one\ntwo');
    expect(encodePaste('one\r\ntwo', false)).toBe('one\r\ntwo');
  });

  test('forwards Ctrl+V for an image-only clipboard (empty text/plain)', () => {
    expect(encodePaste('', false)).toBe('\x16');
    expect(encodePaste('', true)).toBe('\x16');
  });
});
