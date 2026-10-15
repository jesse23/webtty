// Golden tests for the page and asset routes: the `GET /` redirect, `/s/:id`, `/p/:pid`,
// `/dist/*`, the wasm and the 404 fall-through, each pinned as status, headers and body before
// the routes move into the ordered route table (ADR 062, ADR 064).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  CLIENT_HTML,
  CORS,
  NOT_FOUND,
  plain,
  RouteHarness,
  WASM_BYTES,
} from '../test-support/route-harness';

const h = new RouteHarness();
const { call, running, idle, rawGet } = h;

beforeAll(() => h.start());
afterAll(() => h.stop());
beforeEach(() => h.reset());

describe('routes golden — pages', () => {
  const redirect = (location: string) => ({
    status: 302,
    headers: { ...CORS, 'content-length': '0', location },
    body: '',
  });

  test('GET / and /index.html create "main" when nothing was used and redirect to it', async () => {
    expect(await call('GET', '/')).toEqual(redirect('/s/main'));
    expect(h.store.list().map((s) => s.id)).toEqual(['main']);
    expect(await call('GET', '/index.html')).toEqual(redirect('/s/main'));
    expect(h.store.size).toBe(1);
  });

  test('GET / redirects to the last-used session while it exists', async () => {
    idle('work');
    h.store.markUsed('work');
    expect(await call('GET', '/')).toEqual(redirect('/s/work'));
    expect(h.store.has('main')).toBe(false);
    h.store.removeExited('work');
    expect(await call('GET', '/')).toEqual(redirect('/s/main'));
  });

  test('POST / is 404', async () => {
    expect(await call('POST', '/')).toEqual(NOT_FOUND);
    expect(h.store.size).toBe(0);
  });

  test('GET /s/:id serves client.html for a known valid id, else 404', async () => {
    idle('a b');
    idle('work');
    expect(await call('GET', '/s/work')).toEqual({
      status: 200,
      headers: { ...plain(CLIENT_HTML.length), 'content-type': 'text/html' },
      body: CLIENT_HTML,
    });
    expect(await call('GET', '/s/nope')).toEqual(NOT_FOUND);
    expect(await call('GET', '/s/%E0%A4%A')).toEqual(NOT_FOUND);
    // Registered but not a valid id: the page refuses it.
    expect(await call('GET', '/s/a%20b')).toEqual(NOT_FOUND);
    expect(await call('POST', '/s/work')).toEqual(NOT_FOUND);
  });

  test('GET /p/:pid redirects to the session whose shell has that pid', async () => {
    idle('idle');
    running('busy', 31337);
    expect(await call('GET', '/p/31337')).toEqual(redirect('/s/busy'));
    for (const url of ['/p/1', '/p/0', '/p/abc', '/p/-1', '/p/']) {
      expect(await call('GET', url)).toEqual(NOT_FOUND);
    }
    expect(await call('POST', '/p/31337')).toEqual(NOT_FOUND);
  });
});

describe('routes golden — static assets', () => {
  test('/dist/* serves files from the client dist with their MIME type', async () => {
    expect(await call('GET', '/dist/client-browser.js')).toEqual({
      status: 200,
      headers: { ...plain(15), 'content-type': 'application/javascript' },
      body: 'console.log(1);',
    });
    expect(await call('GET', '/dist/client.css')).toEqual({
      status: 200,
      headers: { ...plain(6), 'content-type': 'text/css' },
      body: 'body{}',
    });
    // Any method: the /dist/ prefix is matched before the method is looked at.
    expect((await call('POST', '/dist/client.css')).status).toBe(200);
    expect(await call('GET', '/dist/missing.js')).toEqual(NOT_FOUND);
  });

  test('/dist/ refuses the directory itself and paths that resolve outside it', async () => {
    for (const url of ['/dist/', '/dist//etc/passwd', `/dist/${h.tmpHome}/secret.txt`]) {
      expect(await call('GET', url)).toEqual(NOT_FOUND);
    }
  });

  test('/dist traversal sent raw (not normalised by fetch) stays inside the dist', async () => {
    for (const raw of ['/dist/../secret.txt', '/dist/..%2Fsecret.txt', '/dist/%2e%2e/secret.txt']) {
      const reply = await rawGet(raw);
      expect(reply.status).toBe(404);
      expect(reply.body).toBe('Not Found');
      expect(reply.headers['access-control-allow-origin']).toBe('*');
    }
  });

  test('GET /ghostty-vt-small.wasm serves the wasm byte for byte; neighbours are 404', async () => {
    expect(await call('GET', '/ghostty-vt-small.wasm')).toEqual({
      status: 200,
      headers: { ...plain(WASM_BYTES.length), 'content-type': 'application/wasm' },
      body: WASM_BYTES.toString(),
    });
    for (const url of [
      '/ghostty-vt.wasm',
      '/ghostty-vt-small.wasm.json',
      '/dist/ghostty-vt-small.wasm',
    ]) {
      expect(await call('GET', url)).toEqual(NOT_FOUND);
    }
    expect((await call('POST', '/ghostty-vt-small.wasm')).status).toBe(200);
  });

  test('unknown paths and unsupported methods are 404 with CORS', async () => {
    for (const [method, url] of [
      ['GET', '/unknown'],
      ['GET', '/api'],
      ['GET', '/api/unknown'],
      ['DELETE', '/'],
      ['PATCH', '/api/config'],
      ['PUT', '/s/x/publish'],
      ['GET', '/s/x/execute'],
      ['GET', '/client.html'],
    ]) {
      expect(await call(method, url)).toEqual(NOT_FOUND);
    }
  });
});
