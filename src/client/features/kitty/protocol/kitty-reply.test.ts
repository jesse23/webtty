import { describe, expect, test } from 'bun:test';
import { kittyReply } from './kitty-reply';

describe('kittyReply', () => {
  test('OK reply carries the id', () => {
    expect(kittyReply({ i: '31' }, 31)).toBe('\x1b_Gi=31;OK\x1b\\');
  });

  test('includes placement id and image number when present', () => {
    expect(kittyReply({ i: '5', p: '2' }, 5)).toBe('\x1b_Gi=5,p=2;OK\x1b\\');
    expect(kittyReply({ I: '9' }, 1000009)).toBe('\x1b_Gi=1000009,I=9;OK\x1b\\');
  });

  test('no id → no reply', () => {
    expect(kittyReply({ a: 'T' }, 0)).toBeNull();
  });

  test('q=1 suppresses OK but not errors', () => {
    expect(kittyReply({ i: '1', q: '1' }, 1)).toBeNull();
    expect(kittyReply({ i: '1', q: '1' }, 1, { code: 'EINVAL', message: 'x' })).toBe(
      '\x1b_Gi=1;EINVAL:x\x1b\\',
    );
  });

  test('q=2 suppresses everything', () => {
    expect(kittyReply({ i: '1', q: '2' }, 1)).toBeNull();
    expect(kittyReply({ i: '1', q: '2' }, 1, { code: 'EINVAL', message: 'x' })).toBeNull();
  });
});
