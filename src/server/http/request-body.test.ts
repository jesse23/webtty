import { describe, expect, test } from 'bun:test';
import http from 'node:http';
import { Socket } from 'node:net';
import { recordResponse } from '../../test-support/response-recorder';
import {
  bodyErrorReply,
  decodeId,
  hasJsonContentType,
  MAX_BODY,
  readJson,
  readJsonOrReply,
} from './request-body';

/** A request whose body is `chunks`, with no socket behind it. */
function request(chunks: string[], headers: http.IncomingHttpHeaders = {}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.headers = headers;
  for (const c of chunks) req.push(c);
  req.push(null);
  return req;
}

describe('readJson', () => {
  test('parses a chunked body, and an empty body is {}', async () => {
    expect(await readJson(request(['{"a":', '1}']))).toEqual({ a: 1 });
    expect(await readJson(request([]))).toEqual({});
  });

  test('a body of exactly 64 KB is read, one byte more is 413', async () => {
    const atLimit = `"${'x'.repeat(MAX_BODY - 2)}"`;
    expect(await readJson(request([atLimit]))).toBe('x'.repeat(MAX_BODY - 2));
    await expect(readJson(request([`${atLimit} `]))).rejects.toMatchObject({ status: 413 });
  });

  test('invalid JSON rejects without a status', async () => {
    const err = await readJson(request(['{nope'])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: number }).status).toBeUndefined();
  });
});

describe('bodyErrorReply', () => {
  test.each([
    [
      'too large',
      Object.assign(new Error('payload too large'), { status: 413 }),
      413,
      'Payload Too Large',
    ],
    ['invalid JSON', new Error('invalid JSON'), 400, 'invalid JSON'],
    ['a socket error', new Error('ECONNRESET'), 400, 'invalid JSON'],
  ])('%s', (_name, err, status, body) => {
    expect(bodyErrorReply(err)).toEqual({ status, body } as ReturnType<typeof bodyErrorReply>);
  });
});

describe('readJsonOrReply', () => {
  test('returns the value and writes nothing', async () => {
    const { res, calls } = recordResponse();
    expect(await readJsonOrReply(request(['[1]']), res)).toEqual({ value: [1] });
    expect(calls).toEqual([]);
  });

  test('an oversized body is answered 413 and returns null', async () => {
    const { res, calls } = recordResponse();
    expect(await readJsonOrReply(request(['x'.repeat(MAX_BODY + 1)]), res)).toBeNull();
    expect(calls).toEqual([
      ['writeHead', 413],
      ['end', 'Payload Too Large'],
    ]);
  });

  test('an invalid body is answered 400 and returns null', async () => {
    const { res, calls } = recordResponse();
    expect(await readJsonOrReply(request(['{']), res)).toBeNull();
    expect(calls).toEqual([
      ['writeHead', 400],
      ['end', 'invalid JSON'],
    ]);
  });
});

describe('hasJsonContentType', () => {
  test.each([
    [undefined, false],
    ['text/plain', false],
    ['application/json', true],
    ['application/json; charset=utf-8', true],
  ])('%p → %p', (type, expected) => {
    const headers = type === undefined ? {} : { 'content-type': type };
    expect(hasJsonContentType(request([], headers))).toBe(expected);
  });
});

describe('decodeId', () => {
  test.each([
    ['main', 'main'],
    ['a%20b', 'a b'],
    ['%E0%A4%A', null],
  ])('%p → %p', (raw, expected) => {
    expect(decodeId(raw)).toBe(expected);
  });
});
