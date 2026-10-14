import { describe, expect, test } from 'bun:test';
import type http from 'node:http';
import { recordResponse } from '../../test-support/response-recorder';
import {
  CORS_HEADERS,
  redirect,
  sendBadRequest,
  sendJson,
  sendNotFound,
  sendText,
  setCors,
} from './respond';

describe('respond', () => {
  test('setCors sets the three CORS headers', () => {
    const { res, calls } = recordResponse();
    setCors(res);
    expect(calls).toEqual(Object.entries(CORS_HEADERS).map(([k, v]) => ['setHeader', k, v]));
  });

  test.each<[string, (res: http.ServerResponse) => void, unknown[][]]>([
    [
      'sendJson',
      (r) => sendJson(r, 201, { a: 1 }),
      [
        ['writeHead', 201, { 'Content-Type': 'application/json' }],
        ['end', '{"a":1}'],
      ],
    ],
    [
      'sendText with a body',
      (r) => sendText(r, 409, 'x'),
      [
        ['writeHead', 409],
        ['end', 'x'],
      ],
    ],
    ['sendText with no body', (r) => sendText(r, 204), [['writeHead', 204], ['end']]],
    [
      'sendText with headers',
      (r) => sendText(r, 204, undefined, { 'X-A': '1' }),
      [['writeHead', 204, { 'X-A': '1' }], ['end']],
    ],
    [
      'sendNotFound',
      sendNotFound,
      [
        ['writeHead', 404],
        ['end', 'Not Found'],
      ],
    ],
    [
      'sendBadRequest',
      sendBadRequest,
      [
        ['writeHead', 400],
        ['end', 'Bad Request'],
      ],
    ],
    ['redirect', (r) => redirect(r, '/s/a'), [['writeHead', 302, { Location: '/s/a' }], ['end']]],
  ])('%s', (_name, send, expected) => {
    const { res, calls } = recordResponse();
    send(res);
    expect(calls).toEqual(expected);
  });
});
