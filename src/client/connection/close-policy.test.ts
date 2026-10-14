import { describe, expect, test } from 'bun:test';
import { CLOSE_WINDOW_MS, closeActionFor, RETRY_MS } from './close-policy';

describe('closeActionFor', () => {
  test.each([
    [4003, { kind: 'replay', message: 'Tab fell behind; replaying recent output.' }],
    [4001, { kind: 'close-window', message: 'Session removed.', delayMs: 500 }],
    [1001, { kind: 'close-window', message: 'Server stopped.', delayMs: 500 }],
    [1006, { kind: 'retry', message: 'Connection lost. Reconnecting in 2s...', delayMs: 2000 }],
    [1000, { kind: 'retry', message: 'Connection lost. Reconnecting in 2s...', delayMs: 2000 }],
    [4002, { kind: 'retry', message: 'Connection lost. Reconnecting in 2s...', delayMs: 2000 }],
    [1008, { kind: 'retry', message: 'Connection lost. Reconnecting in 2s...', delayMs: 2000 }],
  ])('code %d', (code, action) => {
    expect(closeActionFor(code)).toEqual(action as ReturnType<typeof closeActionFor>);
  });

  test('the delays', () => {
    expect(RETRY_MS).toBe(2000);
    expect(CLOSE_WINDOW_MS).toBe(500);
  });

  test('returns the same action object every time, allocating nothing', () => {
    expect(closeActionFor(1006)).toBe(closeActionFor(1000));
  });
});
