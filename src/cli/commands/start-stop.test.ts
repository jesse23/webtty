// Tests for `webtty start` and `webtty stop` over fake CLI deps: each lifecycle step and its
// already-in-that-state message (ADR 063).
import { describe, expect, test } from 'bun:test';
import { fakeCliDeps, RUNNING, STOPPED } from '../test-support/fake-cli-deps';
import { start, stop } from './start-stop';

describe('start', () => {
  test('starts a stopped server', async () => {
    const fake = fakeCliDeps(STOPPED);
    await start(fake.deps);
    expect(fake.server).toEqual(['start']);
    expect(fake.out).toEqual(['webtty started']);
  });

  test('reports a running server and leaves it alone', async () => {
    const fake = fakeCliDeps(RUNNING);
    await start(fake.deps);
    expect(fake.server).toEqual([]);
    expect(fake.out).toEqual(['webtty is already running']);
  });
});

describe('stop', () => {
  test('stops a running server', async () => {
    const fake = fakeCliDeps(RUNNING);
    await stop(fake.deps);
    expect(fake.server).toEqual(['stop']);
    expect(fake.out).toEqual(['webtty stopped']);
    expect(fake.exits).toEqual([]);
  });

  test('exits 1 when the server does not stop', async () => {
    const fake = fakeCliDeps(RUNNING, { stopResult: false });
    await stop(fake.deps);
    expect(fake.err).toEqual(['webtty stop failed']);
    expect(fake.out).toEqual([]);
    expect(fake.exits).toEqual([1]);
  });

  test('reports a stopped server with exit 0', async () => {
    const fake = fakeCliDeps(STOPPED);
    await stop(fake.deps);
    expect(fake.server).toEqual([]);
    expect(fake.out).toEqual(['webtty is not running']);
    expect(fake.exits).toEqual([]);
  });
});
