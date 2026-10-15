// Tests for the ordered router: first match wins, RegExp groups become params, `*` matches
// any method, and a request no route takes ends in a CORS-carrying 404 (ADR 062).
import { describe, expect, test } from 'bun:test';
import http from 'node:http';
import { Socket } from 'node:net';
import { recordResponse } from '../../test-support/response-recorder';
import { CORS_HEADERS } from './respond';
import { ANY_PATH, createRouter, matchRoute, type Route, type RouteContext } from './router';

/** A request with `method` and `url`; `host` is the Host header (default 127.0.0.1). */
function request(method: string, url: string, host = '127.0.0.1'): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = url;
  req.headers = { host };
  return req;
}

/** A route that records its name and params into `log`. */
const route = (name: string, method: string, path: string | RegExp, log: string[]): Route => ({
  method,
  path,
  handle: ({ params }: RouteContext) => {
    log.push(`${name}(${params.join(',')})`);
  },
});

const corsCalls = Object.entries(CORS_HEADERS).map(([k, v]) => ['setHeader', k, v]);

describe('matchRoute', () => {
  const log: string[] = [];
  const routes = [
    route('exact', 'GET', '/a', log),
    route('any', '*', '/a', log),
    route('re', 'POST', /^\/s\/([^/]+)\/(\w+)$/, log),
    route('all', 'OPTIONS', ANY_PATH, log),
  ];

  test.each<[string, string, string | null, string[]]>([
    ['GET', '/a', 'exact', []],
    ['PUT', '/a', 'any', []],
    ['POST', '/s/x/run', 're', ['x', 'run']],
    ['GET', '/s/x/run', null, []],
    ['OPTIONS', '/anything/at/all', 'all', []],
    ['GET', '/a/', null, []],
    ['GET', '/b', null, []],
  ])('%s %s → %s', (method, path, name, params) => {
    const match = matchRoute(routes, method, path);
    if (name === null) {
      expect(match).toBeNull();
      return;
    }
    expect(match?.route).toBe(routes[['exact', 'any', 're', 'all'].indexOf(name)]);
    expect(match?.params).toEqual(params);
  });

  test('an undefined method only matches `*` routes', () => {
    expect(matchRoute(routes, undefined, '/a')?.route).toBe(routes[1]);
  });
});

describe('createRouter', () => {
  test('the first matching route runs, and no later one', async () => {
    const log: string[] = [];
    const handler = createRouter([
      route('first', 'GET', /^\/x\/(\d+)$/, log),
      route('second', 'GET', /^\/x\/(.*)$/, log),
    ]);
    const { res, calls } = recordResponse();
    await handler(request('GET', '/x/42?q=1'), res);
    expect(log).toEqual(['first(42)']);
    expect(calls).toEqual(corsCalls);
  });

  test('the query string is not part of the pathname matched', async () => {
    const log: string[] = [];
    const { res } = recordResponse();
    await createRouter([route('a', 'GET', '/a', log)])(request('GET', '/a?x=/b'), res);
    expect(log).toEqual(['a()']);
  });

  test('no match is a 404 after the CORS headers', async () => {
    const log: string[] = [];
    const { res, calls } = recordResponse();
    await createRouter([route('a', 'GET', '/a', log)])(request('POST', '/a'), res);
    expect(log).toEqual([]);
    expect(calls).toEqual([...corsCalls, ['writeHead', 404], ['end', 'Not Found']]);
  });

  test('the handler receives the request, response and pathname, and is awaited', async () => {
    const seen: RouteContext[] = [];
    let finished = false;
    const handler = createRouter([
      {
        method: '*',
        path: '/p',
        handle: async (ctx) => {
          seen.push(ctx);
          await Promise.resolve();
          finished = true;
        },
      },
    ]);
    const req = request('DELETE', '/p');
    const { res } = recordResponse();
    await handler(req, res);
    expect(finished).toBe(true);
    expect(seen).toEqual([{ req, res, pathname: '/p', params: [] }]);
  });

  test('a missing URL is treated as `/`', async () => {
    const log: string[] = [];
    const req = request('GET', '/');
    req.url = undefined;
    const { res } = recordResponse();
    await createRouter([route('root', 'GET', '/', log)])(req, res);
    expect(log).toEqual(['root()']);
  });

  test('a malformed Host header rejects before any header is set', async () => {
    const { res, calls } = recordResponse();
    const handler = createRouter([]);
    await expect(handler(request('GET', '/', 'bad host:x'), res)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
