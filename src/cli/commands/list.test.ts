import { describe, expect, test } from 'bun:test';
import { fakeCliDeps, STOPPED } from '../test-support/fake-cli-deps';
import { json } from '../test-support/scripted-fetch';
import { list } from './list';

const CREATED = 1700000000000;
const SESSIONS = [
  { id: 'main', connected: true, createdAt: CREATED },
  { id: 'other', connected: false, createdAt: CREATED },
];
const created = new Date(CREATED).toLocaleString();
const listing = { 'GET /api/sessions': () => json(SESSIONS) };

describe('list', () => {
  test('prints the header and one row per session', async () => {
    const fake = fakeCliDeps(listing);
    await list({}, fake.deps);
    expect(fake.out).toEqual([
      'id\t\t\tconnected\tcreated',
      `main\t\t\ttrue\t\t${created}`,
      `other\t\t\tfalse\t\t${created}`,
    ]);
    expect(fake.exits).toEqual([]);
  });

  test('a filter keeps the sessions whose id contains it', async () => {
    const fake = fakeCliDeps(listing);
    await list({ filter: 'th' }, fake.deps);
    expect(fake.out).toEqual(['id\t\t\tconnected\tcreated', `other\t\t\tfalse\t\t${created}`]);
  });

  test('prints `no sessions` when none match', async () => {
    const fake = fakeCliDeps(listing);
    await list({ filter: 'zzz' }, fake.deps);
    expect(fake.out).toEqual(['no sessions']);
    const empty = fakeCliDeps({ 'GET /api/sessions': () => json([]) });
    await list({}, empty.deps);
    expect(empty.out).toEqual(['no sessions']);
  });

  test('prints `webtty is not running` to stdout and exits 1 when the server is down', async () => {
    const fake = fakeCliDeps(STOPPED);
    await list({}, fake.deps);
    expect(fake.out).toEqual(['webtty is not running']);
    expect(fake.err).toEqual([]);
    expect(fake.exits).toEqual([1]);
  });

  test('a reply that is not JSON is an error, not "not running"', async () => {
    const fake = fakeCliDeps({ 'GET /api/sessions': () => new Response('<html>') });
    await expect(list({}, fake.deps)).rejects.toThrow(SyntaxError);
    expect(fake.out).toEqual([]);
  });
});
