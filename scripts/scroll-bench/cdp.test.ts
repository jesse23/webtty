import { describe, expect, test } from 'bun:test';
import { withTimeout } from './cdp';

describe('withTimeout', () => {
  test('passes on what settles in time', async () => {
    expect(await withTimeout(Promise.resolve(7), 50, 'x')).toBe(7);
    await expect(withTimeout(Promise.reject(new Error('no')), 50, 'x')).rejects.toThrow('no');
  });

  test('rejects, naming the call, when nothing comes', async () => {
    const never = new Promise<number>(() => {});
    await expect(withTimeout(never, 5, 'Page.navigate')).rejects.toThrow(
      'Page.navigate: no reply in 5 ms',
    );
  });
});
