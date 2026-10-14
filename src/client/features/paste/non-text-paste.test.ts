import { describe, expect, test } from 'bun:test';
import { nonTextPaste } from './non-text-paste';

describe('nonTextPaste', () => {
  test('forwards Ctrl+V for an image-only clipboard (empty text/plain)', () => {
    expect(nonTextPaste('')).toBe('\x16');
  });

  test('leaves any text to the terminal, never Ctrl+V', () => {
    expect(nonTextPaste('hello')).toBeNull();
    expect(nonTextPaste('one\ntwo')).toBeNull();
    expect(nonTextPaste(' ')).toBeNull();
  });
});
