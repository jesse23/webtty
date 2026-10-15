// Tests for `webtty mv` over fake CLI deps: success, the server's refusals, and the
// not-running and usage messages (ADR 063).
import { describe, expect, test } from 'bun:test';
import { fakeCliDeps } from '../test-support/fake-cli-deps';
import { json, refused } from '../test-support/scripted-fetch';
import { rename } from './rename';

describe('rename', () => {
  for (const args of [{}, { id: 'a' }, { newId: 'b' }]) {
    test(`${JSON.stringify(args)} prints usage and exits 1 without a request`, async () => {
      const fake = fakeCliDeps();
      await rename(args, fake.deps);
      expect(fake.err).toEqual(['webtty: rename requires two arguments: [id] [new-id]']);
      expect(fake.exits).toEqual([1]);
      expect(fake.requests).toEqual([]);
    });
  }

  test('renames and prints old → new', async () => {
    const fake = fakeCliDeps({ 'PATCH /api/sessions/old': () => json({ id: 'new' }) });
    await rename({ id: 'old', newId: 'new' }, fake.deps);
    expect(fake.requests[0]?.body).toEqual({ id: 'new' });
    expect(fake.out).toEqual(['renamed old → new']);
    expect(fake.exits).toEqual([]);
  });

  test('a missing session prints not found and exits 1', async () => {
    const fake = fakeCliDeps({
      'PATCH /api/sessions/x': () => new Response(null, { status: 404 }),
    });
    await rename({ id: 'x', newId: 'y' }, fake.deps);
    expect(fake.err).toEqual(['session x not found']);
    expect(fake.exits).toEqual([1]);
  });

  test("another refusal prints the server's error", async () => {
    const fake = fakeCliDeps({ 'PATCH /api/sessions/x': () => json({ error: 'conflict' }, 409) });
    await rename({ id: 'x', newId: 'y' }, fake.deps);
    expect(fake.err).toEqual(['webtty: conflict']);
    expect(fake.exits).toEqual([1]);
  });

  test('a refusal without an error names the status', async () => {
    const fake = fakeCliDeps({ 'PATCH /api/sessions/x': () => json({}, 400) });
    await rename({ id: 'x', newId: 'y' }, fake.deps);
    expect(fake.err).toEqual(['webtty: rename failed (400)']);
    expect(fake.exits).toEqual([1]);
  });

  test('prints `webtty is not running` to stdout and exits 1 when the server is down', async () => {
    const fake = fakeCliDeps({ 'PATCH /api/sessions/x': refused });
    await rename({ id: 'x', newId: 'y' }, fake.deps);
    expect(fake.out).toEqual(['webtty is not running']);
    expect(fake.exits).toEqual([1]);
  });

  test('an error that is not about reaching the server propagates', async () => {
    const fake = fakeCliDeps();
    fake.deps.client.renameSession = async () => {
      throw new RangeError('boom');
    };
    await expect(rename({ id: 'x', newId: 'y' }, fake.deps)).rejects.toThrow('boom');
  });
});
