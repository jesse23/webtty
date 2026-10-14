import { afterEach, describe, expect, mock, test } from 'bun:test';
import { getBaseUrl, getPort, isServerRunning } from './http';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('getBaseUrl', () => {
  test('is always 127.0.0.1 on the configured port', () => {
    expect(getBaseUrl()).toBe(`http://127.0.0.1:${getPort()}`);
  });
});

describe('isServerRunning', () => {
  test('returns true when GET /api/sessions answers a JSON array', async () => {
    const fetchMock = mock(async () => new Response('[]', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect(await isServerRunning()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(`${getBaseUrl()}/api/sessions`);
  });

  test('returns false when the answer is not an array', async () => {
    globalThis.fetch = mock(async () => new Response('{}')) as unknown as typeof fetch;
    expect(await isServerRunning()).toBe(false);
  });

  test('returns false on a non-2xx status', async () => {
    globalThis.fetch = mock(
      async () => new Response('[]', { status: 500 }),
    ) as unknown as typeof fetch;
    expect(await isServerRunning()).toBe(false);
  });

  test('returns false when fetch throws', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    expect(await isServerRunning()).toBe(false);
  });
});
