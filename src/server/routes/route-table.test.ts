// The route precedence test: the table lists every route in the old handleRequest if-chain's
// order, and paths that look alike resolve to the route the if-chain picked (ADR 062, ADR 064).
import { describe, expect, test } from 'bun:test';
import { DEFAULT_CONFIG } from '../../config';
import { matchRoute } from '../http/router';
import { SessionStore } from '../sessions/session-store';
import { createRouteTable } from './route-table';

const table = createRouteTable({
  store: new SessionStore(),
  loadConfig: () => ({ ...DEFAULT_CONFIG }),
  wasmPath: '/w.wasm',
  clientDistPath: '/dist',
  onStop: () => {},
});

const label = (i: number) => `${table[i].method} ${String(table[i].path)}`;

describe('route table', () => {
  test('lists the routes in the old if-chain order', () => {
    expect(table.map((_, i) => label(i))).toEqual([
      'OPTIONS /^/',
      'POST /api/server/stop',
      'GET /api/server/status',
      'GET /api/config',
      'GET /api/sessions',
      'POST /api/sessions',
      '* /^\\/api\\/sessions\\/([^/]+)$/',
      'GET /',
      'GET /index.html',
      'GET /^\\/s\\/([^/]+)$/',
      'POST /^\\/s\\/([^/]+)\\/publish$/',
      'POST /^\\/s\\/([^/]+)\\/execute$/',
      'GET /^\\/p\\/(\\d+)$/',
      '* /^\\/dist\\/(.*)$/',
      '* /ghostty-vt-small.wasm',
    ]);
  });

  test.each<[string, string, string | null]>([
    ['OPTIONS', '/api/server/stop', 'OPTIONS /^/'],
    ['GET', '/api/server/stop', null],
    ['PUT', '/api/sessions', null],
    ['PUT', '/api/sessions/x', '* /^\\/api\\/sessions\\/([^/]+)$/'],
    ['GET', '/api/sessions/', null],
    ['POST', '/', null],
    ['GET', '/s/x/publish', null],
    ['POST', '/s/x', null],
    ['GET', '/p/abc', null],
    ['HEAD', '/dist/client.css', '* /^\\/dist\\/(.*)$/'],
    ['POST', '/ghostty-vt-small.wasm', '* /ghostty-vt-small.wasm'],
    ['GET', '/dist', null],
  ])('%s %s → %s', (method, path, expected) => {
    const match = matchRoute(table, method, path);
    expect(match ? label(table.indexOf(match.route)) : null).toBe(expected);
  });
});
