import { describe, expect, test } from 'bun:test';
import { isTextMime } from '../../ghostty-web/engine/text-mime';

// Ghostty's plain-text MIME names for clipboard writes (ADR 052).

describe('isTextMime', () => {
  test.each([
    ['text/plain', true],
    ['text/plain;charset=utf-8', true],
    ['UTF8_STRING', true],
    ['TEXT', true],
    ['STRING', true],
    ['text/html', false],
    ['image/png', false],
    ['Text/Plain', false],
    ['', false],
  ])('%p is %p', (mime, text) => {
    expect(isTextMime(mime)).toBe(text);
  });
});
