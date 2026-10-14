import { describe, expect, test } from 'bun:test';
import { waitForServer, waitForServerDown } from './server-harness';

describe('test-helpers', () => {
  test('waitForServer throws when server never responds', async () => {
    await expect(waitForServer('http://127.0.0.1:1', 50)).rejects.toThrow(
      'Server did not start in time',
    );
  });

  test('waitForServerDown throws when server keeps responding', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    await expect(waitForServerDown('http://127.0.0.1:1', 50)).rejects.toThrow(
      'Server did not shut down in time',
    );
    globalThis.fetch = realFetch;
  });
});
