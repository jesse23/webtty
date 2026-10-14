import { describe, expect, test } from 'bun:test';
import { type ConfigFetch, loadClientConfig } from './client-config';

describe('loadClientConfig', () => {
  test('fetches /api/config and returns its body as is', async () => {
    const body = { cols: 80, rows: 24, padding: 4, scrollback: 1024 };
    const urls: string[] = [];
    const fetch: ConfigFetch = async (url) => {
      urls.push(url);
      return { json: async () => body };
    };
    const config: object = await loadClientConfig(fetch);
    expect(urls).toEqual(['/api/config']);
    expect(config).toBe(body);
  });

  test('a failed fetch rejects, so the page stays blank as before', async () => {
    const fetch: ConfigFetch = async () => {
      throw new Error('offline');
    };
    await expect(loadClientConfig(fetch)).rejects.toThrow('offline');
  });
});
