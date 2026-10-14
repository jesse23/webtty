// Tests for `webtty rm` over fake CLI deps: the replies for each status, and stopping the server
// when the last session goes (ADR 063).
import { describe, expect, test } from 'bun:test';
import { fakeCliDeps } from '../test-support/fake-cli-deps';
import { json, refused } from '../test-support/scripted-fetch';
import { remove } from './remove';

const removed = (remaining: string) => () =>
  new Response(null, { status: 204, headers: { 'X-Sessions-Remaining': remaining } });

describe('remove', () => {
  test('without an id prints usage and exits 1 without a request', async () => {
    const fake = fakeCliDeps();
    await remove({}, fake.deps);
    expect(fake.err).toEqual(['webtty: rm requires a session id']);
    expect(fake.exits).toEqual([1]);
    expect(fake.requests).toEqual([]);
  });

  test('removes the session and leaves the server running while sessions remain', async () => {
    const fake = fakeCliDeps({ 'DELETE /api/sessions/a%2Fb': removed('2') });
    await remove({ id: 'a/b' }, fake.deps);
    expect(fake.out).toEqual(['removed a/b']);
    expect(fake.server).toEqual([]);
    expect(fake.exits).toEqual([]);
  });

  test('stops the server after removing the last session', async () => {
    const fake = fakeCliDeps({ 'DELETE /api/sessions/last': removed('0') }, { stopResult: false });
    await remove({ id: 'last' }, fake.deps);
    expect(fake.out).toEqual(['removed last', 'no sessions remaining — webtty stopped']);
    expect(fake.server).toEqual(['stop']);
    expect(fake.exits).toEqual([]);
  });

  test('a missing session prints not found and exits 1', async () => {
    const fake = fakeCliDeps({ 'DELETE /api/sessions/ghost': () => json({}, 404) });
    await remove({ id: 'ghost' }, fake.deps);
    expect(fake.err).toEqual(['session ghost not found']);
    expect(fake.exits).toEqual([1]);
  });

  test('any other status prints it and exits 1', async () => {
    const fake = fakeCliDeps({ 'DELETE /api/sessions/bad': () => json({}, 500) });
    await remove({ id: 'bad' }, fake.deps);
    expect(fake.err).toEqual(['webtty rm failed (status: 500)']);
    expect(fake.exits).toEqual([1]);
  });

  test('prints `webtty is not running` to stdout and exits 1 when the server is down', async () => {
    const fake = fakeCliDeps({ 'DELETE /api/sessions/any': refused });
    await remove({ id: 'any' }, fake.deps);
    expect(fake.out).toEqual(['webtty is not running']);
    expect(fake.exits).toEqual([1]);
  });

  test('an error that is not about reaching the server propagates', async () => {
    const fake = fakeCliDeps();
    fake.deps.client.removeSession = async () => {
      throw new RangeError('boom');
    };
    await expect(remove({ id: 'x' }, fake.deps)).rejects.toThrow('boom');
  });
});
